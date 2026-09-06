// NicheForge AI — reports.js (v1.5)
//
// A Report is a named, persisted collection of History items (niche scans,
// video analyses, channel analyses, transcript reviews) plus an AI-written
// executive summary that ties them together — grounded only in the real
// evidence/scores already saved on each item, never inventing new numbers.
// This is what turns individual one-off scans into a single, exportable
// deliverable.

const { getStore, connectLambda } = require('@netlify/blobs');
const http = require('./_shared/http');
const core = require('./_shared/scan-core');

const MAX_ITEMS_PER_REPORT = 12;
const MAX_LIST = 50;

exports.handler = async function (event) {
  connectLambda(event);
  if (http.isPreflight(event)) return http.preflightResponse();
  if (event.httpMethod !== 'POST') {
    return http.fail(405, 'method_not_allowed', 'This endpoint only accepts POST requests.');
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return http.fail(400, 'bad_json', 'The request body was not valid JSON.');
  }

  const action = String(payload.action || 'list');
  const email = String(payload.email || '').trim().toLowerCase();
  if (!http.validEmail(email)) {
    return http.fail(400, 'missing_email', 'A valid email is required.');
  }

  let store;
  try {
    store = getStore('nforge-reports');
  } catch (e) {
    return http.fail(500, 'storage_unavailable', 'Report storage is not available right now: ' + e.message);
  }

  const emailKeyPrefix = http.safeKey(email) + '::';

  // ---- create --------------------------------------------------------------
  if (action === 'create') {
    const title = String(payload.title || '').trim() || 'Untitled report';
    const historyIds = Array.isArray(payload.historyIds) ? payload.historyIds.slice(0, MAX_ITEMS_PER_REPORT) : [];
    const aiProvider = String(payload.aiProvider || '').trim().toLowerCase();
    const aiApiKey = String(payload.aiApiKey || '').trim();
    const aiModel = payload.aiModel ? String(payload.aiModel).trim() : '';

    if (historyIds.length === 0) {
      return http.fail(400, 'missing_items', 'Select at least one History item to include in the report.');
    }
    if (!aiProvider || !aiApiKey) {
      return http.fail(400, 'missing_ai_key', 'Add your AI provider and key in Settings first.');
    }

    let historyStore;
    try {
      historyStore = getStore('nforge-history');
    } catch (e) {
      return http.fail(500, 'storage_unavailable', 'History storage is not available: ' + e.message);
    }

    const items = [];
    for (const id of historyIds) {
      const idStr = String(id);
      // Only allow items that actually belong to this email — a history id
      // is always {safeKey(email)}::{timestamp}::{rand}, so this is a real
      // ownership check, not just a formality.
      if (idStr.indexOf(http.safeKey(email) + '::') !== 0) continue;
      let rec;
      try {
        rec = await historyStore.get(idStr, { type: 'json' });
      } catch (e) {
        continue;
      }
      if (rec) items.push(rec);
    }

    if (items.length === 0) {
      return http.fail(404, 'items_not_found', 'None of the selected history items could be found — they may have been deleted.');
    }

    let executiveSummary;
    try {
      executiveSummary = await generateExecutiveSummary(aiProvider, aiApiKey, aiModel, title, items);
    } catch (e) {
      return http.fail(
        e.statusCode || 502,
        e.code || 'ai_call_failed',
        e.message || 'Could not generate the executive summary.',
        e.whatToDoNext,
        e.rawResponse ? { _diagnostics: { rawAiResponse: e.rawResponse } } : undefined
      );
    }

    // Store a self-contained snapshot of each item — a report should still
    // make sense even if the original History entry is later deleted.
    const snapshot = items.map(function (rec) {
      return {
        contentType: rec.contentType || 'niche',
        query: rec.query,
        score: rec.score,
        avgViews: rec.avgViews,
        timestamp: rec.timestamp,
        evidence: rec.evidence,
        ai: rec.ai
      };
    });

    const reportId = http.safeKey(email) + '::' + Date.now() + '::' + Math.random().toString(36).slice(2, 8);
    const report = {
      id: reportId,
      email: email,
      title: title,
      items: snapshot,
      executiveSummary: executiveSummary,
      createdAt: new Date().toISOString()
    };

    try {
      await store.setJSON(reportId, report);
    } catch (e) {
      return http.fail(500, 'report_save_failed', 'The report was generated but could not be saved: ' + e.message);
    }

    return http.json(200, { success: true, report: report });
  }

  // ---- list ------------------------------------------------------------
  if (action === 'list') {
    try {
      // list() returns keys in raw/decoded form; re-encode the email
      // segment before get() will find each record (see history.js/
      // watchlist.js for the same pattern and why it's needed).
      const rawPrefix = email + '::';
      const listing = await store.list({ prefix: rawPrefix });
      const summaries = [];
      for (const item of listing.blobs) {
        const sepIndex = item.key.indexOf('::');
        if (sepIndex === -1) continue;
        const encodedId = http.safeKey(item.key.slice(0, sepIndex)) + '::' + item.key.slice(sepIndex + 2);
        const rec = await store.get(encodedId, { type: 'json' });
        if (rec) {
          summaries.push({ id: rec.id, title: rec.title, itemCount: rec.items.length, createdAt: rec.createdAt });
        }
      }
      summaries.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
      return http.json(200, { success: true, reports: summaries.slice(0, MAX_LIST) });
    } catch (e) {
      return http.fail(500, 'reports_list_failed', 'Could not load reports: ' + e.message);
    }
  }

  // ---- get ---------------------------------------------------------------
  if (action === 'get') {
    const id = String(payload.id || '');
    if (!id || id.indexOf(emailKeyPrefix) !== 0) {
      return http.fail(400, 'invalid_id', 'That report does not belong to this email.');
    }
    try {
      const rec = await store.get(id, { type: 'json' });
      if (!rec) return http.fail(404, 'not_found', 'That report no longer exists.');
      return http.json(200, { success: true, report: rec });
    } catch (e) {
      return http.fail(500, 'report_get_failed', 'Could not load that report: ' + e.message);
    }
  }

  // ---- delete --------------------------------------------------------------
  if (action === 'delete') {
    const id = String(payload.id || '');
    if (!id || id.indexOf(emailKeyPrefix) !== 0) {
      return http.fail(400, 'invalid_id', 'That report does not belong to this email.');
    }
    try {
      await store.delete(id);
      return http.json(200, { success: true });
    } catch (e) {
      return http.fail(500, 'report_delete_failed', 'Could not delete that report: ' + e.message);
    }
  }

  return http.fail(400, 'unknown_action', 'Unknown action: ' + action);
};

// ===========================================================================
// AI executive summary — synthesizes across multiple items, grounded only
// in the scores/evidence each item already has (never invents new numbers).
// ===========================================================================

async function generateExecutiveSummary(provider, apiKey, model, title, items) {
  const systemPrompt =
    'You are compiling an executive summary across several already-completed pieces of YouTube research (niche scans, ' +
    'video analyses, channel analyses, or script reviews). Every item already has its own real evidence and score — you are ' +
    'synthesizing ACROSS them, not re-analyzing any one of them, and must never invent a number not already given. ' +
    'Respond with STRICT JSON only, no markdown fences, matching exactly: ' +
    '{"overview":string,"rankedItems":[{"query":string,"reason":string}],"crossCuttingThemes":[string,string],' +
    '"recommendedNextActions":[string,string,string]}. ' +
    '"rankedItems" must list the included items in the order you\u2019d prioritize acting on them, citing each one\u2019s real score in "reason". ' +
    '"crossCuttingThemes" are patterns visible across multiple items (shared content gaps, recurring monetization angles, etc.) — ' +
    'only include a theme if it genuinely shows up in two or more items.';

  const itemsBlock = items
    .map(function (rec, i) {
      const scoreLabel =
        rec.contentType === 'video' ? 'Video Performance Score' :
        rec.contentType === 'channel' ? 'Channel Health Score' :
        rec.contentType === 'transcript' ? 'Script Quality Score (AI estimate)' : 'Opportunity Score';
      const gap = rec.ai && rec.ai.contentGap ? rec.ai.contentGap : (rec.ai && rec.ai.hookAssessment ? rec.ai.hookAssessment : null);
      return (
        (i + 1) + '. [' + (rec.contentType || 'niche') + '] "' + rec.query + '" \u2014 ' + scoreLabel + ': ' + rec.score +
        (rec.avgViews ? ', avg/real views: ' + rec.avgViews : '') +
        (gap ? '. Notable finding: ' + gap : '')
      );
    })
    .join('\n');

  const userPrompt =
    'REPORT TITLE: ' + title + '\n\n' +
    'INCLUDED ITEMS (' + items.length + '):\n' + itemsBlock + '\n\n' +
    'Using ONLY the evidence above, produce the JSON described in your instructions.';

  let rawText;
  if (provider === 'openai') {
    const res = await core.fetchJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 0.6,
        response_format: { type: 'json_object' }
      })
    });
    throwIfBad(res, provider);
    rawText = res.data.choices[0].message.content;
  } else if (provider === 'anthropic') {
    const res = await core.fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: model || 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    throwIfBad(res, provider);
    rawText = res.data.content[0].text;
  } else if (provider === 'gemini') {
    const modelName = model || 'gemini-2.0-flash';
    const res = await core.fetchJson(
      'https://generativelanguage.googleapis.com/v1beta/models/' + modelName + ':generateContent?key=' + apiKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.6 }
        })
      }
    );
    throwIfBad(res, provider);
    rawText = res.data.candidates[0].content.parts[0].text;
  } else {
    const err = new Error('Unsupported AI provider: ' + provider);
    err.statusCode = 400;
    err.code = 'unsupported_ai_provider';
    throw err;
  }

  const cleaned = String(rawText).replace(/```json/gi, '').replace(/```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const err = new Error('The AI returned a response that was not valid JSON.');
    err.statusCode = 502;
    err.code = 'ai_response_not_json';
    err.whatToDoNext = 'Try again, or switch to a different model.';
    err.rawResponse = cleaned.slice(0, 4000);
    throw err;
  }
  if (!parsed || !parsed.overview) {
    const err = new Error('The AI response was missing the expected "overview" field.');
    err.statusCode = 502;
    err.code = 'ai_response_malformed';
    err.whatToDoNext = 'Try again, or switch to a different model.';
    err.rawResponse = cleaned.slice(0, 4000);
    throw err;
  }
  if (!Array.isArray(parsed.rankedItems)) parsed.rankedItems = [];
  if (!Array.isArray(parsed.crossCuttingThemes)) parsed.crossCuttingThemes = [];
  if (!Array.isArray(parsed.recommendedNextActions)) parsed.recommendedNextActions = [];
  return parsed;
}

function throwIfBad(res, provider) {
  if (res.status >= 200 && res.status < 300) return;
  const err = new Error();
  err.statusCode = res.status;
  if (res.status === 401 || res.status === 403) {
    err.code = provider + '_invalid_key';
    err.message = 'Your ' + provider + ' API key was rejected.';
    err.whatToDoNext = 'Check the key in Settings.';
  } else if (res.status === 429) {
    err.code = provider + '_rate_limited';
    err.message = 'Your ' + provider + ' account is rate-limited or out of quota.';
  } else {
    err.code = provider + '_error';
    err.message = 'The ' + provider + ' API returned HTTP ' + res.status + '.';
  }
  throw err;
}
