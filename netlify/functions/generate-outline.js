// NicheForge AI — generate-outline.js (v1.3)
//
// Takes one title idea plus the real evidence from the scan it came from,
// and asks the buyer's own AI provider to turn it into a structured video
// outline — grounded in the same real numbers, not a fresh invention.

const http = require('./_shared/http');
const core = require('./_shared/scan-core');

exports.handler = async function (event) {
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

  const titleIdea = String(payload.titleIdea || '').trim();
  const query = String(payload.query || '').trim();
  const evidence = payload.evidence;
  const aiProvider = String(payload.aiProvider || '').trim().toLowerCase();
  const aiApiKey = String(payload.aiApiKey || '').trim();
  const aiModel = payload.aiModel ? String(payload.aiModel).trim() : '';

  if (!titleIdea) return http.fail(400, 'missing_title', 'No title idea was provided.');
  if (!aiProvider || !aiApiKey) return http.fail(400, 'missing_ai_key', 'Add your AI key in Settings first.');
  if (!evidence || typeof evidence.avgViews !== 'number') {
    return http.fail(400, 'missing_evidence', 'This title needs its original scan evidence to generate a grounded outline.');
  }

  const systemPrompt =
    'You are a video-scripting assistant. You will be given ONE title the creator has chosen, plus real YouTube ' +
    'evidence about that niche. Produce a practical video outline grounded in that evidence — do not invent new ' +
    'statistics. Respond with STRICT JSON only, no markdown fences, matching this shape exactly: ' +
    '{"hook":string,"suggestedLengthMinutes":number,"sections":[{"title":string,"points":[string,string]}],"callToAction":string}. ' +
    'Produce 4-6 sections. "suggestedLengthMinutes" should be a reasonable estimate for this format/niche (a whole number). ' +
    '"hook" is the first 10-15 seconds of spoken script, written to be read aloud, not a description of a hook.';

  const userPrompt =
    'CHOSEN TITLE: "' + titleIdea + '"\n' +
    'NICHE: ' + query + '\n\n' +
    'REAL EVIDENCE FOR THIS NICHE:\n' +
    '- Average views in the sample: ' + evidence.avgViews + '\n' +
    '- Share of Shorts vs long-form: ' + Math.round((evidence.shortsShare || 0) * 100) + '% Shorts\n' +
    '- Opportunity Score: ' + evidence.opportunityScore + '\n' +
    (evidence.autocompleteSuggestions && evidence.autocompleteSuggestions.length
      ? '- What people actually search: ' + evidence.autocompleteSuggestions.join(', ') + '\n'
      : '') +
    '\nProduce the JSON outline described in your instructions for this exact title.';

  try {
    const result = await callAiForOutline(aiProvider, aiApiKey, aiModel, systemPrompt, userPrompt);
    return http.json(200, { success: true, outline: result });
  } catch (e) {
    return http.fail(
      e.statusCode || 502,
      e.code || 'outline_failed',
      e.message || 'Could not generate an outline right now.',
      e.whatToDoNext || 'Try again in a moment.',
      e.rawResponse ? { _diagnostics: { rawAiResponse: e.rawResponse } } : undefined
    );
  }
};

async function callAiForOutline(provider, apiKey, model, systemPrompt, userPrompt) {
  let rawText;
  if (provider === 'openai') {
    const res = await core.fetchJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 0.7,
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
        max_tokens: 1200,
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
          generationConfig: { temperature: 0.7 }
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
    err.rawResponse = cleaned.slice(0, 4000);
    throw err;
  }
  if (!parsed || !Array.isArray(parsed.sections)) {
    const err = new Error('The AI response was missing the expected "sections" field.');
    err.statusCode = 502;
    err.code = 'ai_response_malformed';
    err.rawResponse = cleaned.slice(0, 4000);
    throw err;
  }
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

module.exports.callAiForOutline = callAiForOutline;
