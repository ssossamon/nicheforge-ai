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
const outlineModule = require('./generate-outline');

const MAX_ITEMS_PER_REPORT = 12;
const MAX_LIST = 50;

exports.handler = async function (event) {
  // Top-level safety net: any uncaught exception anywhere below this point
  // (including in a required module) would otherwise reach the caller as
  // Netlify's own raw Lambda crash JSON, which doesn't match this API's
  // {success, error} shape — the frontend has no clean message to show and
  // falls back to a generic one. This turns that failure mode into a real,
  // diagnosable error response instead.
  try {
    return await handleRequest(event);
  } catch (e) {
    return http.fail(500, 'unexpected_error', 'Something went wrong generating or loading the report: ' + e.message);
  }
};

async function handleRequest(event) {
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

  // ---- create directly from the completed run -----------------------------
  // Reports are first-class outputs of every run. They no longer depend on
  // finding a just-written History record (which is eventually consistent).
  if (action === 'create_run') {
    const rawItems = Array.isArray(payload.items) ? payload.items.slice(0, MAX_ITEMS_PER_REPORT) : [];
    const title = String(payload.title || '').trim() || 'NicheForge Intelligence Report';
    const aiProvider = String(payload.aiProvider || '').trim().toLowerCase();
    const aiApiKey = String(payload.aiApiKey || '').trim();
    const aiModel = payload.aiModel ? String(payload.aiModel).trim() : '';
    if (rawItems.length === 0) return http.fail(400, 'missing_run', 'The completed run did not include report data.');
    if (!aiProvider || !aiApiKey) return http.fail(400, 'missing_ai_key', 'Add your AI provider and key in Settings first.');

    const items = rawItems.map(function (rec) {
      const evidence = rec && typeof rec.evidence === 'object' ? rec.evidence : {};
      const ai = rec && typeof rec.ai === 'object' ? rec.ai : {};
      return {
        contentType: String((rec && rec.contentType) || 'niche').slice(0, 30),
        query: String((rec && rec.query) || 'Untitled analysis').slice(0, 300),
        score: typeof rec.score === 'number' && isFinite(rec.score) ? Math.max(0, Math.min(100, Math.round(rec.score))) : null,
        avgViews: typeof rec.avgViews === 'number' && isFinite(rec.avgViews) ? rec.avgViews : null,
        timestamp: String((rec && rec.timestamp) || new Date().toISOString()),
        evidence: evidence,
        ai: ai
      };
    });

    let executiveSummary;
    try {
      executiveSummary = await generateExecutiveSummary(aiProvider, aiApiKey, aiModel, title, items);
    } catch (e) {
      return http.fail(e.statusCode || 502, e.code || 'ai_call_failed', e.message || 'Could not generate the visual report narrative.', e.whatToDoNext);
    }

    const reportId = http.safeKey(email) + '::' + Date.now() + '::' + Math.random().toString(36).slice(2, 8);
    const report = {
      id: reportId,
      email: email,
      title: title,
      reportKind: 'single-run',
      visualVersion: 2,
      items: items,
      executiveSummary: executiveSummary,
      topItemOutlines: [],
      competitiveLandscape: buildCompetitiveLandscape(items),
      keywordAppendix: buildKeywordAppendix(items),
      createdAt: new Date().toISOString()
    };
    try {
      await store.setJSON(reportId, report);
    } catch (e) {
      return http.fail(500, 'report_save_failed', 'The report was generated but could not be saved: ' + e.message);
    }
    return http.json(200, { success: true, report: report });
  }

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

    // Full outlines for the top 3 items per the AI's own priority ranking —
    // not just the title chips each item already had. The executive summary
    // has already succeeded by this point, so a failure in any one of these
    // three enrichment steps degrades that section rather than losing the
    // whole report — this is exactly the class of bug that once made the
    // entire report generation fail silently (see git history).
    let topItemOutlines = [];
    try {
      topItemOutlines = await generateTopItemOutlines(aiProvider, aiApiKey, aiModel, items, executiveSummary.rankedItems);
    } catch (e) {
      topItemOutlines = [];
    }

    let competitiveLandscape = { topChannels: [], breakoutVideos: [] };
    let keywordAppendix = [];
    try {
      competitiveLandscape = buildCompetitiveLandscape(items);
      keywordAppendix = buildKeywordAppendix(items);
    } catch (e) {
      // leave the safe empty defaults above
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
      topItemOutlines: topItemOutlines,
      competitiveLandscape: competitiveLandscape,
      keywordAppendix: keywordAppendix,
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
          summaries.push({ id: rec.id, title: rec.title, itemCount: Array.isArray(rec.items) ? rec.items.length : 0, createdAt: rec.createdAt });
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
}

// ===========================================================================
// AI executive summary — synthesizes across multiple items, grounded only
// in the scores/evidence each item already has (never invents new numbers).
// ===========================================================================

// ===========================================================================
// Full outlines for the top-ranked items — not just their existing title
// chips. Reuses the same AI-calling logic as the standalone "Outline"
// button (generate-outline.js) so there's one implementation, not two.
// ===========================================================================

const TOP_OUTLINE_COUNT = 3;

function pickSeedTitle(rec) {
  if (rec.contentType === 'video' && rec.ai && rec.ai.spinOffIdeas && rec.ai.spinOffIdeas.length) {
    return rec.ai.spinOffIdeas[0];
  }
  if (rec.contentType === 'channel' && rec.ai && rec.ai.contentOpportunities && rec.ai.contentOpportunities.length) {
    return rec.ai.contentOpportunities[0];
  }
  if (rec.contentType === 'transcript' && rec.ai && rec.ai.suggestedTitles && rec.ai.suggestedTitles.length) {
    return rec.ai.suggestedTitles[0];
  }
  if (rec.ai && rec.ai.opportunities && rec.ai.opportunities.length && rec.ai.opportunities[0].titleIdeas && rec.ai.opportunities[0].titleIdeas.length) {
    return rec.ai.opportunities[0].titleIdeas[0];
  }
  return rec.query;
}

async function generateTopItemOutlines(provider, apiKey, model, items, rankedItems) {
  // Follow the AI's own priority order when we have one; otherwise just
  // take the items in the order they were selected. Matching is
  // case/whitespace-insensitive since the AI sometimes paraphrases a query
  // slightly rather than echoing it back verbatim.
  function normalizeQuery(q) { return String(q || '').trim().toLowerCase(); }
  const orderedQueries = (rankedItems || []).map(function (r) { return normalizeQuery(r.query); });
  const ordered = items.slice().sort(function (a, b) {
    const ia = orderedQueries.indexOf(normalizeQuery(a.query));
    const ib = orderedQueries.indexOf(normalizeQuery(b.query));
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  const top = ordered.slice(0, TOP_OUTLINE_COUNT);
  const results = [];
  for (const rec of top) {
    const seedTitle = pickSeedTitle(rec);
    const systemPrompt = outlineModule.buildOutlineSystemPrompt();
    const userPrompt =
      'CHOSEN TITLE: "' + seedTitle + '"\n' +
      'SOURCE ITEM: [' + (rec.contentType || 'niche') + '] ' + rec.query + '\n' +
      'REAL SCORE FOR THIS ITEM: ' + rec.score + '\n' +
      (rec.evidence && rec.evidence.avgViews ? 'Average/real views: ' + rec.evidence.avgViews + '\n' : '') +
      '\nProduce the JSON outline described in your instructions for this exact title.';
    try {
      const outline = await outlineModule.callAiForOutline(provider, apiKey, model, systemPrompt, userPrompt);
      results.push({ query: rec.query, seedTitle: seedTitle, outline: outline });
    } catch (e) {
      // A single outline failing (rate limit, malformed response) never
      // blocks the rest of the report from being generated.
      results.push({ query: rec.query, seedTitle: seedTitle, outline: null, error: e.message });
    }
  }
  return results;
}

// ===========================================================================
// Competitive landscape — pure aggregation across items, no AI involved.
// Which channels keep showing up, and where the real breakout videos were.
// ===========================================================================

function buildCompetitiveLandscape(items) {
  const channelMap = {};

  function record(key, title, query) {
    if (!key || !title) return;
    if (!channelMap[key]) channelMap[key] = { title: title, appearances: 0, seenIn: [] };
    channelMap[key].appearances++;
    if (channelMap[key].seenIn.indexOf(query) === -1) channelMap[key].seenIn.push(query);
  }

  const breakoutVideos = [];

  items.forEach(function (rec) {
    const ev = rec.evidence;
    if (!ev) return;
    if (rec.contentType === 'channel' && ev.title) {
      record(ev.id || ev.title, ev.title, rec.query);
    } else if (rec.contentType === 'video' && ev.channelTitle) {
      record(ev.channelId || ev.channelTitle, ev.channelTitle, rec.query);
    } else if (rec.contentType === 'competitor' && ev.competitorPages) {
      // real, named competitors the user entered and RivalPulse-style
      // analysis actually fetched — not inferred from search results
      ev.competitorPages.forEach(function (cp) {
        record(cp.url || cp.name, cp.name, rec.query);
      });
    } else if (ev.topVideos) {
      // niche scans carry a real list of channels behind the top videos
      ev.topVideos.forEach(function (v) {
        record(v.channelId || v.channelTitle, v.channelTitle, rec.query);
      });
    }
    if (ev.breakoutVideos && ev.breakoutVideos.length) {
      ev.breakoutVideos.forEach(function (b) {
        breakoutVideos.push({ title: b.title, channelTitle: b.channelTitle, views: b.views, foundIn: rec.query });
      });
    }
  });

  const topChannels = Object.keys(channelMap)
    .map(function (k) { return channelMap[k]; })
    .sort(function (a, b) { return b.appearances - a.appearances; })
    .slice(0, 15);

  return { topChannels: topChannels, breakoutVideos: breakoutVideos.slice(0, 15) };
}

// ===========================================================================
// Keyword appendix — real autocomplete suggestions from every item that has
// them, deduped and counted by how many items surfaced each one.
// ===========================================================================

function buildKeywordAppendix(items) {
  const keywordMap = {};
  items.forEach(function (rec) {
    const suggestions = rec.evidence && rec.evidence.autocompleteSuggestions;
    if (!suggestions || !suggestions.length) return;
    suggestions.forEach(function (kw) {
      const norm = String(kw).toLowerCase().trim();
      if (!norm) return;
      if (!keywordMap[norm]) keywordMap[norm] = { keyword: kw, count: 0, seenIn: [] };
      keywordMap[norm].count++;
      if (keywordMap[norm].seenIn.indexOf(rec.query) === -1) keywordMap[norm].seenIn.push(rec.query);
    });
  });
  return Object.keys(keywordMap)
    .map(function (k) { return keywordMap[k]; })
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, 40);
}

async function generateExecutiveSummary(provider, apiKey, model, title, items) {
  const systemPrompt =
    'You are the presentation strategist for a premium market-intelligence report. You are turning one or more already-completed ' +
    'research runs (niche scans, video analyses, channel analyses, competitor analyses, or transcript playbooks) into a decisive, ' +
    'Gamma-style narrative. Every item already has real evidence and analysis — organize and explain it, never invent a number. ' +
    'Respond with STRICT JSON only, no markdown fences, matching exactly: ' +
    '{"overview":string,"verdict":{"label":"GO"|"CONDITIONAL GO"|"WATCH"|"NO-GO","reason":string},' +
    '"marketOpportunity":string,"audienceInsight":string,"keyRisks":[string,string,string],' +
    '"rankedItems":[{"query":string,"reason":string}],"crossCuttingThemes":[string,string],' +
    '"recommendedNextActions":[string,string,string],' +
    '"next30Days":[{"phase":string,"action":string,"successMeasure":string}],' +
    '"monetizationRoadmap":[{"query":string,"angle":string,"sequencing":string}],' +
    '"contentCalendar":[{"query":string,"dayOffset":number,"format":"Short"|"Long-form","rationale":string}]}. ' +
    '"overview" is a sharp 2-3 sentence executive opening, not filler. "verdict" gives a realistic decision and evidence-based reason. ' +
    '"marketOpportunity" explains the strongest opening; "audienceInsight" states the clearest audience need visible in the supplied findings. ' +
    '"keyRisks" lists three concrete risks. "next30Days" contains 3-5 sequenced phases with a measurable success signal. ' +
    '"rankedItems" must list the included items in the order you\u2019d prioritize acting on them, citing each one\u2019s real score in "reason". ' +
    '"crossCuttingThemes" are patterns visible across multiple items (shared content gaps, recurring monetization angles, etc.) — ' +
    'only include a theme if it genuinely shows up in two or more items. ' +
    '"monetizationRoadmap" is ONE cohesive plan across the whole set (not a repeat of each item\u2019s own angles) — sequence which niche/video/channel ' +
    'to monetize first and why, grounded in the real scores/evidence given. ' +
    '"contentCalendar" assigns every included item a "dayOffset" (0 = today, integers only, spread sensibly so not everything lands on day 0 — ' +
    'prioritize higher-scored or fresher items for earlier days) and a "format" — use "Short" if that item\u2019s evidence shows a high Shorts share ' +
    'or is itself a Short, otherwise "Long-form".';

  const itemsBlock = items
    .map(function (rec, i) {
      const scoreLabel =
        rec.contentType === 'video' ? 'Video Performance Score' :
        rec.contentType === 'channel' ? 'Channel Health Score' :
        rec.contentType === 'transcript' ? 'Script Quality Score (AI estimate)' :
        rec.contentType === 'competitor' ? 'Competitive Position Score' : 'Opportunity Score';
      const gap = rec.ai && rec.ai.contentGap ? rec.ai.contentGap : (rec.ai && rec.ai.hookAssessment ? rec.ai.hookAssessment : (rec.ai && rec.ai.verdict ? rec.ai.verdict : null));
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
  parsed.rankedItems = parsed.rankedItems
    .filter(function (e) { return e && typeof e.query === 'string'; })
    .map(function (e) { return { query: e.query, reason: typeof e.reason === 'string' ? e.reason : '' }; });

  if (!Array.isArray(parsed.crossCuttingThemes)) parsed.crossCuttingThemes = [];
  // A single-run report cannot logically have a theme that crosses items.
  if (items.length < 2) parsed.crossCuttingThemes = [];
  if (!Array.isArray(parsed.recommendedNextActions)) parsed.recommendedNextActions = [];
  if (!parsed.verdict || typeof parsed.verdict !== 'object') parsed.verdict = { label: 'WATCH', reason: parsed.overview };
  if (['GO', 'CONDITIONAL GO', 'WATCH', 'NO-GO'].indexOf(parsed.verdict.label) === -1) parsed.verdict.label = 'WATCH';
  parsed.verdict.reason = typeof parsed.verdict.reason === 'string' ? parsed.verdict.reason : parsed.overview;
  parsed.marketOpportunity = typeof parsed.marketOpportunity === 'string' ? parsed.marketOpportunity : parsed.overview;
  parsed.audienceInsight = typeof parsed.audienceInsight === 'string' ? parsed.audienceInsight : '';
  parsed.keyRisks = Array.isArray(parsed.keyRisks) ? parsed.keyRisks.filter(function (v) { return typeof v === 'string'; }).slice(0, 5) : [];
  parsed.next30Days = Array.isArray(parsed.next30Days) ? parsed.next30Days.filter(function (v) { return v && typeof v.action === 'string'; }).map(function (v) {
    return { phase: typeof v.phase === 'string' ? v.phase : 'Next', action: v.action, successMeasure: typeof v.successMeasure === 'string' ? v.successMeasure : '' };
  }).slice(0, 6) : [];

  // These two fields are new and have a stricter shape (numbers, an enum)
  // that smaller/faster models don't always honor exactly — validate and
  // coerce rather than trusting the AI's typing, so a string "0" or a
  // slightly-off format value can't silently break the calendar/roadmap.
  parsed.monetizationRoadmap = Array.isArray(parsed.monetizationRoadmap)
    ? parsed.monetizationRoadmap
        .filter(function (e) { return e && typeof e.query === 'string'; })
        .map(function (e) {
          return {
            query: e.query,
            angle: typeof e.angle === 'string' ? e.angle : '',
            sequencing: typeof e.sequencing === 'string' ? e.sequencing : ''
          };
        })
    : [];

  parsed.contentCalendar = Array.isArray(parsed.contentCalendar)
    ? parsed.contentCalendar
        .filter(function (e) { return e && typeof e.query === 'string'; })
        .map(function (e) {
          const parsedOffset = typeof e.dayOffset === 'number' && isFinite(e.dayOffset) ? e.dayOffset : parseInt(e.dayOffset, 10);
          return {
            query: e.query,
            dayOffset: isFinite(parsedOffset) ? Math.max(0, Math.round(parsedOffset)) : 0,
            format: e.format === 'Short' ? 'Short' : 'Long-form',
            rationale: typeof e.rationale === 'string' ? e.rationale : ''
          };
        })
    : [];

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
