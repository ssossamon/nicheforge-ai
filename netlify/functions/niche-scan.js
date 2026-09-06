// NicheForge AI — niche-scan.js (v1.2)
//
// Single-topic scan endpoint. All the real work (YouTube evidence, caching,
// BYOK AI synthesis) lives in _shared/scan-core.js so it can be reused by
// batch-scan.js without duplicating logic.

const { getStore, connectLambda } = require('@netlify/blobs');
const http = require('./_shared/http');
const license = require('./_shared/license');
const core = require('./_shared/scan-core');

const FREE_SCAN_LIMIT = 3;

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

  const query = String(payload.query || '').trim();
  const email = String(payload.email || '').trim().toLowerCase();
  const licenseKey = payload.licenseKey ? String(payload.licenseKey).trim() : '';
  const aiProvider = String(payload.aiProvider || '').trim().toLowerCase();
  const aiApiKey = String(payload.aiApiKey || '').trim();
  const aiModel = payload.aiModel ? String(payload.aiModel).trim() : '';
  const clientYoutubeKey = payload.youtubeApiKey ? String(payload.youtubeApiKey).trim() : '';
  const skipCache = payload.skipCache === true;

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
    unlimited = unlimited || false;
  }

  // ---- 2. Real YouTube data + AI synthesis (shared core) -----------------
  const ytKey = clientYoutubeKey || process.env.YOUTUBE_API_KEY;
  const ytKeySource = clientYoutubeKey ? 'settings' : 'server';
  if (!ytKey) {
    return http.fail(
      500,
      'youtube_key_not_configured',
      'No YouTube Data API key is available for this scan.',
      'Add your own key in Settings, or have the site owner set the YOUTUBE_API_KEY environment variable in Netlify (Google Cloud Console → enable "YouTube Data API v3" → create an API key).'
    );
  }

  let result;
  try {
    result = await core.runFullScan(query, ytKey, ytKeySource, skipCache, aiProvider, aiApiKey, aiModel);
  } catch (e) {
    return http.fail(
      e.statusCode || 502,
      e.code || 'scan_failed',
      e.message || 'The scan could not be completed.',
      e.whatToDoNext || 'Try again in a minute.',
      e.rawResponse ? { _diagnostics: { rawAiResponse: e.rawResponse } } : undefined
    );
  }

  const evidence = result.evidence;

  if (evidence.videoCount === 0) {
    return http.fail(
      200,
      'no_results',
      'YouTube returned no videos published in the last 12 months for "' + query + '".',
      'Try a broader or differently-worded topic — very new or extremely narrow phrases sometimes return nothing.'
    );
  }

  // ---- 3. Record usage + save to history ----------------------------------
  try {
    if (!unlimited) {
      const usageRaw = await usageStore.get(email, { type: 'json' });
      const usedCount = (usageRaw && usageRaw.count ? usageRaw.count : 0) + 1;
      await usageStore.setJSON(email, { count: usedCount, lastScanAt: new Date().toISOString() });
    }
    await core.saveToHistory(email, query, evidence, result.ai);
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
    ai: result.ai,
    meta: {
      unlimited: unlimited,
      tier: tier,
      scansRemaining: scansRemaining,
      freeScanLimit: FREE_SCAN_LIMIT
    }
  });
};
