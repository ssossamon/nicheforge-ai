// NicheForge AI — analyze-content.js (v1.4)
//
// Accepts a pasted YouTube video URL (including Shorts), a channel URL, or
// raw transcript/script text, auto-detects which it is, and returns real
// evidence (or an honest note when there is none) plus a deterministic
// score and BYOK AI analysis grounded in that evidence.

const http = require('./_shared/http');
const contentAnalysis = require('./_shared/content-analysis');
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

  const input = String(payload.input || '').trim();
  const aiProvider = String(payload.aiProvider || '').trim().toLowerCase();
  const aiApiKey = String(payload.aiApiKey || '').trim();
  const aiModel = payload.aiModel ? String(payload.aiModel).trim() : '';
  const clientYoutubeKey = payload.youtubeApiKey ? String(payload.youtubeApiKey).trim() : '';

  if (!input) {
    return http.fail(400, 'missing_input', 'Paste a YouTube video URL, channel URL, or transcript text.');
  }
  if (!aiProvider || !aiApiKey) {
    return http.fail(400, 'missing_ai_key', 'Add your AI provider and key in Settings first.');
  }

  const detected = contentAnalysis.detectInputType(input);

  if (detected.type === 'empty' || detected.type === 'unrecognized') {
    return http.fail(
      400,
      'unrecognized_input',
      "That doesn't look like a YouTube video URL, channel URL, or a transcript.",
      'Paste a full youtube.com/watch, youtu.be, /shorts/, /channel/, or /@handle URL — or paste at least a few sentences of transcript/script text.'
    );
  }

  const ytKey = clientYoutubeKey || process.env.YOUTUBE_API_KEY;
  const ytKeySource = clientYoutubeKey ? 'settings' : 'server';

  // ---- Video URL (including Shorts) ---------------------------------------
  if (detected.type === 'video') {
    if (!ytKey) {
      return http.fail(500, 'youtube_key_not_configured', 'No YouTube Data API key is available.', 'Add your own key in Settings, or set YOUTUBE_API_KEY in Netlify.');
    }
    let evidence;
    try {
      evidence = await contentAnalysis.gatherVideoEvidence(detected.videoId, ytKey, ytKeySource);
    } catch (e) {
      return http.fail(e.statusCode || 502, e.code || 'video_analysis_failed', e.message, e.whatToDoNext || 'Try again in a moment.');
    }

    let ai;
    try {
      ai = await runVideoAi(aiProvider, aiApiKey, aiModel, evidence);
    } catch (e) {
      return http.fail(e.statusCode || 502, e.code || 'ai_call_failed', e.message, e.whatToDoNext, e.rawResponse ? { _diagnostics: { rawAiResponse: e.rawResponse } } : undefined);
    }

    return http.json(200, { success: true, contentType: 'video', evidence: evidence, ai: ai });
  }

  // ---- Channel URL ---------------------------------------------------------
  if (detected.type === 'channel') {
    if (!ytKey) {
      return http.fail(500, 'youtube_key_not_configured', 'No YouTube Data API key is available.', 'Add your own key in Settings, or set YOUTUBE_API_KEY in Netlify.');
    }
    let channelId;
    try {
      channelId = await contentAnalysis.resolveChannelId(detected, ytKey);
    } catch (e) {
      return http.fail(502, 'channel_resolve_failed', 'Could not resolve that channel URL: ' + e.message);
    }
    if (!channelId) {
      return http.fail(404, 'channel_not_resolved', 'Could not find a channel matching that URL.', 'Double-check the handle/URL, or try the full /channel/UC... URL instead.');
    }

    let evidence;
    try {
      evidence = await contentAnalysis.gatherChannelEvidence(channelId, ytKey, ytKeySource);
    } catch (e) {
      return http.fail(e.statusCode || 502, e.code || 'channel_analysis_failed', e.message, e.whatToDoNext || 'Try again in a moment.');
    }

    let ai;
    try {
      ai = await runChannelAi(aiProvider, aiApiKey, aiModel, evidence);
    } catch (e) {
      return http.fail(e.statusCode || 502, e.code || 'ai_call_failed', e.message, e.whatToDoNext, e.rawResponse ? { _diagnostics: { rawAiResponse: e.rawResponse } } : undefined);
    }

    return http.json(200, { success: true, contentType: 'channel', evidence: evidence, ai: ai });
  }

  // ---- Raw transcript / script text ---------------------------------------
  if (detected.type === 'transcript') {
    let ai;
    try {
      ai = await runTranscriptAi(aiProvider, aiApiKey, aiModel, detected.text);
    } catch (e) {
      return http.fail(e.statusCode || 502, e.code || 'ai_call_failed', e.message, e.whatToDoNext, e.rawResponse ? { _diagnostics: { rawAiResponse: e.rawResponse } } : undefined);
    }
    return http.json(200, {
      success: true,
      contentType: 'transcript',
      evidence: {
        characterCount: detected.text.length,
        wordCount: detected.text.split(/\s+/).filter(Boolean).length,
        note: 'No real YouTube data exists for pasted text — everything below is an AI assessment, not a measured performance metric.'
      },
      ai: ai
    });
  }

  return http.fail(400, 'unrecognized_input', "Could not determine what kind of input that was.");
};

// ===========================================================================
// AI analysis — video
// ===========================================================================

async function runVideoAi(provider, apiKey, model, ev) {
  const systemPrompt =
    'You are a YouTube content analyst working from REAL data about one specific video, provided below. ' +
    'Never invent statistics beyond what is given. Respond with STRICT JSON only, no markdown fences, matching exactly: ' +
    '{"whatIsWorking":string,"whyItsPerforming":string,"spinOffIdeas":[string,string,string,string,string],"contentGap":string,' +
    '"monetizationAngles":[{"type":string,"description":string}]}. ' +
    '"whyItsPerforming" must cite a real number from the evidence. "spinOffIdeas" are original title ideas inspired by (not copied from) ' +
    'this video\u2019s style. If a transcript is provided, ground "whatIsWorking" in its actual structure/hook; if not, say so and work from title/description/comments instead.';

  const userPrompt =
    'VIDEO: "' + ev.title + '" by ' + ev.channelTitle + (ev.isShort ? ' (a Short)' : '') + '\n' +
    'Published ' + ev.daysSincePublished + ' days ago.\n' +
    'REAL STATS: ' + ev.views + ' views, ' + ev.likes + ' likes, ' + ev.commentCount + ' comments.\n' +
    (ev.channelAvgRecentViews ? 'This channel\u2019s recent average views: ' + ev.channelAvgRecentViews + '.\n' : '') +
    'Video Performance Score (deterministic, not AI-generated): ' + ev.videoPerformanceScore + '/100.\n\n' +
    (ev.transcript
      ? 'REAL TRANSCRIPT (first portion):\n' + ev.transcript.slice(0, 4000) + '\n\n'
      : 'No transcript/captions were available for this video.\n\n') +
    (ev.topComments && ev.topComments.length
      ? 'REAL TOP COMMENTS:\n' + ev.topComments.slice(0, 6).map(function (c) { return '- "' + c.text + '" (' + c.likeCount + ' likes)'; }).join('\n') + '\n\n'
      : '') +
    'Using ONLY the evidence above, produce the JSON described in your instructions.';

  return callAi(provider, apiKey, model, systemPrompt, userPrompt, ['whatIsWorking']);
}

// ===========================================================================
// AI analysis — channel
// ===========================================================================

async function runChannelAi(provider, apiKey, model, ev) {
  const systemPrompt =
    'You are a YouTube channel strategist working from REAL data about one channel, provided below. ' +
    'Never invent statistics. Respond with STRICT JSON only, no markdown fences, matching exactly: ' +
    '{"assessment":string,"contentOpportunities":[string,string,string],"contentGap":string,' +
    '"monetizationAngles":[{"type":string,"description":string}]}. ' +
    '"assessment" must cite a real number from the evidence (subscriber count, upload cadence, or the Channel Health Score). ' +
    '"contentOpportunities" are specific video/series ideas grounded in what this channel already does well.';

  const topTitles = (ev.topVideosInSample || []).map(function (v) { return '- "' + v.title + '" (' + v.views + ' views)'; }).join('\n');

  const userPrompt =
    'CHANNEL: ' + ev.title + '\n' +
    'REAL STATS: ' + (ev.subscriberCount === null ? 'subscribers hidden' : ev.subscriberCount + ' subscribers') + ', ' + ev.totalVideoCount + ' total videos, ' + ev.totalViewCount + ' total views.\n' +
    'Uploads per week (recent sample): ' + ev.uploadsPerWeekRecent + '. Shorts share: ' + Math.round((ev.shortsShareRecent || 0) * 100) + '%.\n' +
    'Channel Health Score (deterministic, not AI-generated): ' + ev.channelHealthScore + '/100.\n\n' +
    'TOP VIDEOS IN RECENT SAMPLE:\n' + topTitles + '\n\n' +
    'Using ONLY the evidence above, produce the JSON described in your instructions.';

  return callAi(provider, apiKey, model, systemPrompt, userPrompt, ['contentOpportunities']);
}

// ===========================================================================
// AI analysis — raw transcript/script (no real YouTube data available)
// ===========================================================================

async function runTranscriptAi(provider, apiKey, model, text) {
  const systemPrompt =
    'You are a video-scripting coach reviewing a pasted transcript or script draft. There is NO real performance data — ' +
    'you are giving a subjective structural assessment, not measuring anything real. Respond with STRICT JSON only, no markdown fences: ' +
    '{"scriptQualityScore":number,"scoreRationale":string,"hookAssessment":string,"structureNotes":string,"suggestedTitles":[string,string,string],"improvementIdeas":[string,string,string]}. ' +
    '"scriptQualityScore" is 0-100, your own structural estimate (hook strength, pacing, clarity, CTA) — "scoreRationale" must say plainly that ' +
    'this is an AI estimate, not a measured or predicted performance outcome.';

  const userPrompt = 'PASTED TEXT:\n' + text.slice(0, 6000) + '\n\nProduce the JSON described in your instructions.';

  return callAi(provider, apiKey, model, systemPrompt, userPrompt, ['scriptQualityScore', 'hookAssessment']);
}

// ===========================================================================
// Shared AI call + defensive parsing
// ===========================================================================

async function callAi(provider, apiKey, model, systemPrompt, userPrompt, requiredFields) {
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
    err.whatToDoNext = 'Try again, or switch to a different model.';
    err.rawResponse = cleaned.slice(0, 4000);
    throw err;
  }
  for (const field of requiredFields) {
    if (!parsed || parsed[field] === undefined) {
      const err = new Error('The AI response was missing the expected "' + field + '" field.');
      err.statusCode = 502;
      err.code = 'ai_response_malformed';
      err.whatToDoNext = 'Try again, or switch to a different model.';
      err.rawResponse = cleaned.slice(0, 4000);
      throw err;
    }
  }
  if (!Array.isArray(parsed.monetizationAngles)) parsed.monetizationAngles = parsed.monetizationAngles || [];
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
