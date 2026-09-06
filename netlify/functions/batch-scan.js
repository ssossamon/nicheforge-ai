// NicheForge AI — batch-scan.js (v1.2)
//
// Runs up to 5 topics through the same real-data + BYOK-AI pipeline as a
// single scan (via _shared/scan-core.js), sequentially to keep quota use
// predictable. A failure on one topic never kills the batch — each topic
// gets its own success/error result so partial progress is never lost.

const { getStore } = require('@netlify/blobs');
const http = require('./_shared/http');
const license = require('./_shared/license');
const core = require('./_shared/scan-core');

const MAX_BATCH_SIZE = 5;
const FREE_SCAN_LIMIT = 3;

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

  const rawQueries = Array.isArray(payload.queries) ? payload.queries : [];
  const queries = rawQueries
    .map(function (q) { return String(q || '').trim(); })
    .filter(function (q) { return q.length > 0; })
    .slice(0, MAX_BATCH_SIZE);

  const email = String(payload.email || '').trim().toLowerCase();
  const licenseKey = payload.licenseKey ? String(payload.licenseKey).trim() : '';
  const aiProvider = String(payload.aiProvider || '').trim().toLowerCase();
  const aiApiKey = String(payload.aiApiKey || '').trim();
  const aiModel = payload.aiModel ? String(payload.aiModel).trim() : '';
  const clientYoutubeKey = payload.youtubeApiKey ? String(payload.youtubeApiKey).trim() : '';
  const skipCache = payload.skipCache === true;

  if (queries.length === 0) {
    return http.fail(400, 'missing_queries', 'Enter at least one topic (up to ' + MAX_BATCH_SIZE + ').');
  }
  if (!http.validEmail(email)) {
    return http.fail(400, 'missing_email', 'A valid email is required to run a scan.');
  }
  if (!aiProvider || !aiApiKey) {
    return http.fail(400, 'missing_ai_key', 'Choose an AI provider and paste your API key in Settings before running a batch.');
  }

  // ---- Usage gating: a batch of N topics counts as N scans against the
  // free limit, same as running them one at a time. -----------------------
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
      if (usedCount + queries.length > FREE_SCAN_LIMIT) {
        return http.fail(
          402,
          'free_limit_reached',
          'This batch of ' + queries.length + ' topics would use more than your remaining free scans (' + Math.max(0, FREE_SCAN_LIMIT - usedCount) + ' left).',
          'Upgrade for unlimited scans, enter a license key, or run fewer topics at once.',
          { scansUsed: usedCount, scansAllowed: FREE_SCAN_LIMIT }
        );
      }
    }
  } catch (e) {
    unlimited = unlimited || false;
  }

  const ytKey = clientYoutubeKey || process.env.YOUTUBE_API_KEY;
  const ytKeySource = clientYoutubeKey ? 'settings' : 'server';
  if (!ytKey) {
    return http.fail(
      500,
      'youtube_key_not_configured',
      'No YouTube Data API key is available for this scan.',
      'Add your own key in Settings, or have the site owner set YOUTUBE_API_KEY in Netlify.'
    );
  }

  // ---- Run each topic sequentially — partial failures don't kill the batch
  const results = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    try {
      const r = await core.runFullScan(q, ytKey, ytKeySource, skipCache, aiProvider, aiApiKey, aiModel);
      if (r.evidence.videoCount === 0) {
        results.push({
          query: q,
          success: false,
          error: {
            code: 'no_results',
            message: 'No videos found for "' + q + '" in the last 12 months.',
            whatToDoNext: 'Try a broader phrasing.'
          }
        });
      } else {
        results.push({ query: q, success: true, evidence: r.evidence, ai: r.ai });
      }
    } catch (e) {
      results.push({
        query: q,
        success: false,
        error: {
          code: e.code || 'scan_failed',
          message: e.message || 'This topic could not be scanned.',
          whatToDoNext: e.whatToDoNext || 'Try running this topic on its own.'
        }
      });
    }
  }

  // ---- Record usage (count only successful scans) + log -------------------
  const successCount = results.filter(function (r) { return r.success; }).length;
  try {
    if (!unlimited && successCount > 0) {
      const usageRaw = await usageStore.get(email, { type: 'json' });
      const usedCount = (usageRaw && usageRaw.count ? usageRaw.count : 0) + successCount;
      await usageStore.setJSON(email, { count: usedCount, lastScanAt: new Date().toISOString() });
    }
    const scansStore = getStore('nforge-scans');
    for (let j = 0; j < results.length; j++) {
      if (!results[j].success) continue;
      const logKey = new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 8);
      await scansStore.setJSON(logKey, {
        email: email,
        query: results[j].query,
        tier: tier,
        opportunityScore: results[j].evidence.opportunityScore,
        timestamp: new Date().toISOString(),
        batch: true
      });
    }
  } catch (e) {
    // Non-fatal.
  }

  let scansRemaining = null;
  if (!unlimited) {
    try {
      const usageRaw = await usageStore.get(email, { type: 'json' });
      const usedCount = usageRaw && usageRaw.count ? usageRaw.count : successCount;
      scansRemaining = Math.max(0, FREE_SCAN_LIMIT - usedCount);
    } catch (e) {
      scansRemaining = null;
    }
  }

  return http.json(200, {
    success: true,
    results: results,
    meta: {
      unlimited: unlimited,
      tier: tier,
      scansRemaining: scansRemaining,
      freeScanLimit: FREE_SCAN_LIMIT,
      requested: queries.length,
      succeeded: successCount
    }
  });
};
