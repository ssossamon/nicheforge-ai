// NicheForge AI — niche-scan.js (v1.0)
//
// Pulls REAL YouTube search/video/channel data for a topic and computes a
// transparent, deterministic Opportunity Score from it. Then hands that real
// evidence (never fabricated numbers) to the buyer's own AI provider (BYOK)
// to synthesize ranked sub-niche angles, video title ideas, and a content
// gap callout. Every AI-derived field is labeled as an estimate; every
// evidence field is labeled as coming directly from YouTube's API.

const { getStore } = require('@netlify/blobs');
const http = require('./_shared/http');
const license = require('./_shared/license');

const FREE_SCAN_LIMIT = 3;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

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

  const query = String(payload.query || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  const licenseKey = payload.licenseKey ? String(payload.licenseKey).trim() : '';
  const aiProvider = String(payload.aiProvider || '').trim().toLowerCase();
  const aiApiKey = String(payload.aiApiKey || '').trim();
  const aiModel = payload.aiModel ? String(payload.aiModel).trim() : '';

  if (!query) {
    return http.fail(400, 'missing_query', 'Enter a topic, niche, or keyword to research.');
  }
  if (!http.validEmail(email)) {
    return http.fail(400, 'missing_email', 'A valid email is required to run a scan.', 'Enter your email above — it unlocks your free scans and is how we deliver your license key if you upgrade.');
  }
  if (!aiProvider || !aiApiKey) {
    return http.fail(400, 'missing_ai_key', 'Choose an AI provider and paste your API key before running a scan.', 'NicheForge uses your own OpenAI, Anthropic, or Gemini key to write up the results — it is never stored on our server.');
  }

  // ---- 1. Usage gating (free tier vs licensed) ----------------------------
  let usageStore;
  let unlimited = false;
  let tier = null;
  try {
    usageStore = getStore('nforge-usage');

    if (licenseKey) {
      if (license.isOwnerKey(licenseKey)) {
        unlimited = true;
        tier = 'ADM';
      } else {
        const licensesStore = getStore('nforge-licenses');
        const rec = await licensesStore.get(licenseKey.trim().toUpperCase(), { type: 'json' });
        if (rec && rec.status === 'active') {
          unlimited = true;
          tier = rec.tier;
        }
      }
    }

    if (!unlimited) {
      const usageRaw = await usageStore.get(email, { type: 'json' });
      const usedCount = usageRaw && usageRaw.count ? usageRaw.count : 0;
      if (usedCount >= FREE_SCAN_LIMIT) {
        return http.fail(
          402,
          'free_limit_reached',
          'You have used all ' + FREE_SCAN_LIMIT + ' free scans for this email.',
          'Upgrade to a paid plan for unlimited scans, or enter a license key if you already purchased one.',
          { scansUsed: usedCount, scansAllowed: FREE_SCAN_LIMIT }
        );
      }
    }
  } catch (e) {
    // Blobs unavailable — fail open on usage tracking rather than blocking
    // the whole feature, but say so plainly rather than pretending it works.
    unlimited = unlimited || false;
  }

  // ---- 2. Real YouTube data -------------------------------------------
  const ytKey = process.env.YOUTUBE_API_KEY;
  if (!ytKey) {
    return http.fail(
      500,
      'youtube_key_not_configured',
      'The site owner has not configured a YouTube Data API key yet.',
      'Set the YOUTUBE_API_KEY environment variable in Netlify (Google Cloud Console → enable "YouTube Data API v3" → create an API key).'
    );
  }

  let evidence;
  try {
    evidence = await gatherYoutubeEvidence(query, ytKey);
  } catch (e) {
    return http.fail(
      e.statusCode || 502,
      e.code || 'youtube_fetch_failed',
      e.message || 'Could not retrieve YouTube data for this topic right now.',
      e.whatToDoNext || 'Try again in a minute, or try a slightly different phrasing of the topic.'
    );
  }

  if (evidence.videoCount === 0) {
    return http.fail(
      200,
      'no_results',
      'YouTube returned no videos published in the last 12 months for "' + query + '".',
      'Try a broader or differently-worded topic — very new or extremely narrow phrases sometimes return nothing.'
    );
  }

  // ---- 3. AI synthesis (BYOK) -------------------------------------------
  let aiResult;
  try {
    aiResult = await runAiSynthesis(aiProvider, aiApiKey, aiModel, query, evidence);
  } catch (e) {
    return http.fail(
      e.statusCode || 502,
      e.code || 'ai_call_failed',
      e.message || 'The AI provider call failed.',
      e.whatToDoNext || 'Check that your API key is correct and has available credit, then try again.',
      e.rawResponse ? { _diagnostics: { rawAiResponse: e.rawResponse } } : undefined
    );
  }

  // ---- 4. Record usage + scan log ----------------------------------------
  try {
    if (!unlimited) {
      const usageRaw = await usageStore.get(email, { type: 'json' });
      const usedCount = (usageRaw && usageRaw.count ? usageRaw.count : 0) + 1;
      await usageStore.setJSON(email, { count: usedCount, lastScanAt: new Date().toISOString() });
    }
    const scansStore = getStore('nforge-scans');
    const logKey = new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 8);
    await scansStore.setJSON(logKey, {
      email: email,
      query: query,
      tier: tier,
      opportunityScore: evidence.opportunityScore,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    // Non-fatal — never block a real result just because logging failed.
  }

  let scansRemaining = null;
  if (!unlimited) {
    try {
      const usageRaw = await usageStore.get(email, { type: 'json' });
      const usedCount = usageRaw && usageRaw.count ? usageRaw.count : 1;
      scansRemaining = Math.max(0, FREE_SCAN_LIMIT - usedCount);
    } catch (e) {
      scansRemaining = null;
    }
  }

  return http.json(200, {
    success: true,
    query: query,
    evidence: evidence,
    ai: aiResult,
    meta: {
      unlimited: unlimited,
      tier: tier,
      scansRemaining: scansRemaining,
      freeScanLimit: FREE_SCAN_LIMIT
    }
  });
};

// ===========================================================================
// Real YouTube data gathering + transparent scoring
// ===========================================================================

async function gatherYoutubeEvidence(query, ytKey) {
  const publishedAfter = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

  const searchUrl =
    YT_BASE +
    '/search?part=snippet&type=video&order=viewCount&maxResults=25&relevanceLanguage=en' +
    '&publishedAfter=' + encodeURIComponent(publishedAfter) +
    '&q=' + encodeURIComponent(query) +
    '&key=' + ytKey;

  const searchRes = await fetchJson(searchUrl);
  throwOnYoutubeError(searchRes, 'search.list');

  const items = (searchRes.data.items || []).filter(function (it) {
    return it.id && it.id.videoId;
  });

  if (items.length === 0) {
    return { videoCount: 0 };
  }

  const videoIds = items.map(function (it) { return it.id.videoId; });
  const channelIdSet = {};
  items.forEach(function (it) { channelIdSet[it.snippet.channelId] = true; });
  const channelIds = Object.keys(channelIdSet);

  const videosUrl =
    YT_BASE + '/videos?part=statistics,snippet,contentDetails&id=' + videoIds.join(',') + '&key=' + ytKey;
  const videosRes = await fetchJson(videosUrl);
  throwOnYoutubeError(videosRes, 'videos.list');

  const channelsUrl =
    YT_BASE + '/channels?part=statistics&id=' + channelIds.join(',') + '&key=' + ytKey;
  const channelsRes = await fetchJson(channelsUrl);
  throwOnYoutubeError(channelsRes, 'channels.list');

  const channelSubs = {};
  (channelsRes.data.items || []).forEach(function (ch) {
    channelSubs[ch.id] = ch.statistics && ch.statistics.hiddenSubscriberCount !== true
      ? parseInt(ch.statistics.subscriberCount || '0', 10)
      : null;
  });

  const videos = (videosRes.data.items || []).map(function (v) {
    return {
      id: v.id,
      title: v.snippet.title,
      channelId: v.snippet.channelId,
      channelTitle: v.snippet.channelTitle,
      publishedAt: v.snippet.publishedAt,
      views: parseInt((v.statistics && v.statistics.viewCount) || '0', 10),
      likes: parseInt((v.statistics && v.statistics.likeCount) || '0', 10),
      isShort: isLikelyShort(v),
      channelSubs: channelSubs[v.snippet.channelId] === undefined ? null : channelSubs[v.snippet.channelId]
    };
  });

  const viewCounts = videos.map(function (v) { return v.views; }).sort(function (a, b) { return a - b; });
  const avgViews = Math.round(viewCounts.reduce(function (a, b) { return a + b; }, 0) / viewCounts.length);
  const medianViews = viewCounts[Math.floor(viewCounts.length / 2)];

  const knownSubChannels = videos.filter(function (v) { return typeof v.channelSubs === 'number'; });
  const bigChannelCount = knownSubChannels.filter(function (v) { return v.channelSubs >= 100000; }).length;
  const bigChannelRatio = knownSubChannels.length > 0 ? bigChannelCount / knownSubChannels.length : null;

  const sortedByDate = videos.slice().sort(function (a, b) {
    return new Date(b.publishedAt) - new Date(a.publishedAt);
  });
  const mostRecentPublishedAt = sortedByDate[0].publishedAt;
  const daysSinceMostRecent = Math.floor((Date.now() - new Date(mostRecentPublishedAt).getTime()) / 86400000);

  const dateSpanDays = Math.max(
    1,
    Math.floor(
      (new Date(sortedByDate[0].publishedAt) - new Date(sortedByDate[sortedByDate.length - 1].publishedAt)) / 86400000
    )
  );
  const uploadsPerWeek = Number(((videos.length / dateSpanDays) * 7).toFixed(2));

  // Per-channel breakout detection: a video that out-performs the other
  // sampled videos from the same channel by 2x+ is flagged as a breakout —
  // a real, in-sample signal, not an invented one.
  const byChannel = {};
  videos.forEach(function (v) {
    if (!byChannel[v.channelId]) byChannel[v.channelId] = [];
    byChannel[v.channelId].push(v);
  });
  const breakoutVideos = [];
  Object.keys(byChannel).forEach(function (chId) {
    const vids = byChannel[chId];
    if (vids.length < 2) return;
    const channelAvg = vids.reduce(function (a, v) { return a + v.views; }, 0) / vids.length;
    vids.forEach(function (v) {
      if (v.views >= channelAvg * 2) {
        breakoutVideos.push({ title: v.title, channelTitle: v.channelTitle, views: v.views, channelAvgViews: Math.round(channelAvg) });
      }
    });
  });

  const shortsCount = videos.filter(function (v) { return v.isShort; }).length;

  // ---- Transparent, deterministic Opportunity Score (0-100) --------------
  const demandPoints = Math.min(60, Math.log10(avgViews + 1) * 10);
  const saturationPenalty = bigChannelRatio === null ? 0 : bigChannelRatio * 30;
  const freshnessBonus = daysSinceMostRecent <= 14 ? 10 : daysSinceMostRecent <= 30 ? 5 : 0;
  const opportunityScore = Math.max(0, Math.min(100, Math.round(demandPoints - saturationPenalty + freshnessBonus)));

  return {
    videoCount: videos.length,
    totalResultsReportedByYoutube: searchRes.data.pageInfo ? searchRes.data.pageInfo.totalResults : null,
    avgViews: avgViews,
    medianViews: medianViews,
    bigChannelRatio: bigChannelRatio === null ? null : Number(bigChannelRatio.toFixed(2)),
    channelsWithKnownSubs: knownSubChannels.length,
    uploadsPerWeekInSample: uploadsPerWeek,
    daysSinceMostRecentUpload: daysSinceMostRecent,
    shortsShare: Number((shortsCount / videos.length).toFixed(2)),
    breakoutVideos: breakoutVideos.slice(0, 5),
    opportunityScore: opportunityScore,
    scoreFormula: 'min(60, log10(avgViews+1)*10) - (bigChannelRatio*30) + freshnessBonus(0/5/10). This is a transparent heuristic computed from real YouTube metadata — not a guarantee of results.',
    topVideos: videos
      .slice()
      .sort(function (a, b) { return b.views - a.views; })
      .slice(0, 12)
      .map(function (v) {
        return { title: v.title, channelTitle: v.channelTitle, views: v.views, publishedAt: v.publishedAt, channelSubs: v.channelSubs };
      }),
    dataSource: 'YouTube Data API v3 (search.list, videos.list, channels.list) — videos published in the last 12 months, ordered by view count.',
    fetchedAt: new Date().toISOString()
  };
}

function isLikelyShort(video) {
  try {
    const dur = video.contentDetails && video.contentDetails.duration;
    if (!dur) return false;
    const match = dur.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return false;
    const minutes = parseInt(match[1] || '0', 10);
    const seconds = parseInt(match[2] || '0', 10);
    return minutes === 0 && seconds > 0 && seconds <= 60;
  } catch (e) {
    return false;
  }
}

function throwOnYoutubeError(res, callName) {
  if (res.status >= 200 && res.status < 300) return;
  const reason = res.data && res.data.error && res.data.error.errors && res.data.error.errors[0]
    ? res.data.error.errors[0].reason
    : null;
  const err = new Error();
  if (res.status === 403 && reason === 'quotaExceeded') {
    err.statusCode = 429;
    err.code = 'youtube_quota_exceeded';
    err.message = "The site's daily YouTube API quota has been used up.";
    err.whatToDoNext = 'Try again after midnight Pacific time when the quota resets, or raise the quota in Google Cloud Console.';
  } else if (res.status === 400 && reason === 'keyInvalid') {
    err.statusCode = 500;
    err.code = 'youtube_key_invalid';
    err.message = 'The configured YouTube API key was rejected by Google.';
    err.whatToDoNext = 'Check the YOUTUBE_API_KEY environment variable in Netlify and confirm YouTube Data API v3 is enabled for it.';
  } else {
    err.statusCode = 502;
    err.code = 'youtube_' + callName.replace('.', '_') + '_failed';
    err.message = 'YouTube\u2019s ' + callName + ' endpoint returned an unexpected error (HTTP ' + res.status + ').';
    err.whatToDoNext = 'Try again in a moment. If this persists, check Google Cloud Console for API status.';
  }
  throw err;
}

// ===========================================================================
// AI synthesis (BYOK) — OpenAI / Anthropic / Google Gemini
// ===========================================================================

function buildSystemPrompt() {
  return (
    'You are a content-strategy research analyst working from REAL YouTube data provided below. ' +
    'You must not invent view counts, subscriber counts, or any other statistic beyond what is given. ' +
    'When you reference a number, it must come from the provided evidence. ' +
    'Respond with STRICT JSON only, no markdown code fences, no commentary before or after, matching this shape exactly: ' +
    '{"opportunities":[{"angle":string,"rationale":string,"titleIdeas":[string,string,string,string,string]}],' +
    '"contentGap":string}. ' +
    'Produce between 3 and 5 items in "opportunities". "rationale" must explicitly tie back to a real number from the evidence ' +
    '(e.g. "avg views of X across the sample" or "N of the top channels have 100k+ subscribers"). ' +
    '"titleIdeas" should be inspired by the style/phrasing of the real top-performing titles provided, but must be original wording, ' +
    'never a verbatim copy of any provided title. "contentGap" should name one specific, underserved angle visible in the data.'
  );
}

function buildUserPrompt(query, evidence) {
  const topTitles = evidence.topVideos.map(function (v) {
    return '- "' + v.title + '" (channel: ' + v.channelTitle + ', views: ' + v.views + ', subs: ' + (v.channelSubs === null ? 'unknown' : v.channelSubs) + ')';
  }).join('\n');
  const breakouts = evidence.breakoutVideos.length
    ? evidence.breakoutVideos.map(function (b) {
        return '- "' + b.title + '" by ' + b.channelTitle + ' got ' + b.views + ' views vs that channel\u2019s sampled average of ' + b.channelAvgViews;
      }).join('\n')
    : '(none detected in this sample)';

  return (
    'TOPIC: ' + query + '\n\n' +
    'REAL YOUTUBE EVIDENCE (last 12 months, ordered by view count):\n' +
    '- Videos sampled: ' + evidence.videoCount + '\n' +
    '- Average views: ' + evidence.avgViews + '\n' +
    '- Median views: ' + evidence.medianViews + '\n' +
    '- Share of sampled channels with 100k+ subscribers: ' + (evidence.bigChannelRatio === null ? 'unknown' : Math.round(evidence.bigChannelRatio * 100) + '%') + '\n' +
    '- Uploads per week in this sample: ' + evidence.uploadsPerWeekInSample + '\n' +
    '- Days since the most recent upload in this sample: ' + evidence.daysSinceMostRecentUpload + '\n' +
    '- Share of results that are Shorts: ' + Math.round(evidence.shortsShare * 100) + '%\n' +
    '- Opportunity Score (0-100, deterministic formula, not AI-generated): ' + evidence.opportunityScore + '\n\n' +
    'TOP PERFORMING VIDEOS IN THIS SAMPLE:\n' + topTitles + '\n\n' +
    'BREAKOUT VIDEOS (outperformed their own channel\u2019s sampled average by 2x+):\n' + breakouts + '\n\n' +
    'Using ONLY the evidence above, produce the JSON described in your instructions.'
  );
}

async function runAiSynthesis(provider, apiKey, model, query, evidence) {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(query, evidence);
  let rawText;

  if (provider === 'openai') {
    const res = await fetchJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' }
      })
    });
    throwOnAiError(res, 'openai');
    rawText = res.data.choices[0].message.content;
  } else if (provider === 'anthropic') {
    const res = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    throwOnAiError(res, 'anthropic');
    rawText = res.data.content[0].text;
  } else if (provider === 'gemini') {
    const modelName = model || 'gemini-2.0-flash';
    const res = await fetchJson(
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
    throwOnAiError(res, 'gemini');
    rawText = res.data.candidates[0].content.parts[0].text;
  } else {
    const err = new Error('Unsupported AI provider: ' + provider);
    err.statusCode = 400;
    err.code = 'unsupported_ai_provider';
    err.whatToDoNext = 'Choose OpenAI, Anthropic, or Gemini.';
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
    err.whatToDoNext = 'This can happen if the model got cut off. Try again, or switch to a different model.';
    err.rawResponse = cleaned.slice(0, 4000);
    throw err;
  }
  if (!parsed || !Array.isArray(parsed.opportunities)) {
    const err = new Error('The AI response was missing the expected "opportunities" field.');
    err.statusCode = 502;
    err.code = 'ai_response_malformed';
    err.whatToDoNext = 'Try again, or switch to a different AI model.';
    err.rawResponse = cleaned.slice(0, 4000);
    throw err;
  }
  return parsed;
}

function throwOnAiError(res, provider) {
  if (res.status >= 200 && res.status < 300) return;
  const err = new Error();
  err.statusCode = res.status;
  if (res.status === 401 || res.status === 403) {
    err.code = provider + '_invalid_key';
    err.message = 'Your ' + provider + ' API key was rejected (HTTP ' + res.status + ').';
    err.whatToDoNext = 'Double check you pasted the full key and that it has not been revoked.';
  } else if (res.status === 429) {
    err.code = provider + '_rate_limited';
    err.message = 'Your ' + provider + ' account is rate-limited or out of quota.';
    err.whatToDoNext = 'Check your usage/billing on the provider\u2019s dashboard, then try again.';
  } else if (res.status === 400) {
    err.code = provider + '_bad_request';
    err.message = 'The ' + provider + ' API rejected the request (HTTP 400) — often an invalid model name.';
    err.whatToDoNext = 'Try leaving the model field blank to use the default, or check the model name you entered.';
  } else {
    err.code = provider + '_error';
    err.message = 'The ' + provider + ' API returned HTTP ' + res.status + '.';
    err.whatToDoNext = 'Try again in a moment.';
  }
  throw err;
}

// ===========================================================================
// tiny fetch wrapper that always returns { status, data }
// ===========================================================================

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }
  return { status: res.status, data: data };
}
