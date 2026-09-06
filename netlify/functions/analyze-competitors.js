// NicheForge AI — analyze-competitors.js (v1.0)
//
// Competitor analysis, folded into the same product as niche scans: same
// free-scan quota, same license system, same History (so these show up
// alongside niche/video/channel/transcript items when building a Report).

const { getStore, connectLambda } = require('@netlify/blobs');
const http = require('./_shared/http');
const license = require('./_shared/license');
const core = require('./_shared/scan-core');
const competitorCore = require('./_shared/competitor-core');

const FREE_SCAN_LIMIT = 3;
const MAX_COMPETITORS = 5;

exports.handler = async function (event) {
  try {
    return await handleRequest(event);
  } catch (e) {
    return http.fail(500, 'unexpected_error', 'Something went wrong running that analysis: ' + e.message);
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

  const email = String(payload.email || '').trim().toLowerCase();
  const licenseKey = payload.licenseKey ? String(payload.licenseKey).trim() : '';
  const businessName = String((payload.business && payload.business.name) || '').trim();
  const businessDescription = String((payload.business && payload.business.description) || '').trim();
  const competitorsInput = Array.isArray(payload.competitors) ? payload.competitors.slice(0, MAX_COMPETITORS) : [];
  const aiProvider = String(payload.aiProvider || '').trim().toLowerCase();
  const aiApiKey = String(payload.aiApiKey || '').trim();
  const aiModel = payload.aiModel ? String(payload.aiModel).trim() : '';
  const watchName = String(payload.watchName || businessName || 'Untitled').trim();

  if (!http.validEmail(email)) {
    return http.fail(400, 'missing_email', 'A valid email is required to run an analysis.');
  }
  if (!businessName || !businessDescription) {
    return http.fail(400, 'missing_business', 'Enter your business name and a short description.');
  }
  if (competitorsInput.length === 0) {
    return http.fail(400, 'missing_competitors', 'Add at least one competitor (name + URL).');
  }
  for (const c of competitorsInput) {
    if (!c || !c.name || !c.url) {
      return http.fail(400, 'bad_competitor', 'Every competitor needs both a name and a URL.');
    }
    if (!/^https?:\/\//i.test(c.url)) {
      return http.fail(400, 'bad_competitor_url', 'Competitor URL "' + c.url + '" must start with http:// or https://.');
    }
  }
  if (!aiProvider || !aiApiKey) {
    return http.fail(400, 'missing_ai_key', 'Choose an AI provider and paste your API key before running an analysis.');
  }

  // ---- 1. Usage gating — same free-scan quota as niche scans -------------
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
      const usageRaw = await usageStore.get(http.safeKey(email), { type: 'json' });
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

  // ---- 2. Real fetch, full AI analysis -------------------------------------
  const competitorPages = await Promise.all(
    competitorsInput.map(function (c) {
      return competitorCore.fetchCompetitorPage(c.url).then(function (page) {
        return Object.assign({ name: String(c.name).trim() }, page);
      });
    })
  );

  let analysis;
  try {
    analysis = await competitorCore.runCompetitorAnalysis(aiProvider, aiApiKey, aiModel, { name: businessName, description: businessDescription }, competitorPages);
  } catch (e) {
    return http.fail(e.statusCode || 502, e.code || 'ai_call_failed', e.message, e.whatToDoNext, e.rawResponse ? { _diagnostics: { rawAiResponse: e.rawResponse } } : undefined);
  }

  // ---- 3. Persist as a trackable watch, record usage, save to History ------
  let watchId = null;
  try {
    const watchStore = getStore('nforge-competitor-watches');
    watchId = http.safeKey(email) + '::' + Date.now() + '::' + Math.random().toString(36).slice(2, 8);
    await watchStore.setJSON(watchId, {
      id: watchId,
      email: email,
      watchName: watchName,
      business: { name: businessName, description: businessDescription },
      competitors: competitorPages.map(function (p) {
        return { name: p.name, url: p.url, lastFetched: p.fetchedAt, fetched: p.fetched, contentHash: p.contentHash || null, lastText: p.text || null };
      }),
      lastAnalysis: analysis,
      createdAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString()
    });
  } catch (e) {
    watchId = null;
  }

  try {
    if (!unlimited) {
      const usageRaw = await usageStore.get(http.safeKey(email), { type: 'json' });
      const usedCount = (usageRaw && usageRaw.count ? usageRaw.count : 0) + 1;
      await usageStore.setJSON(http.safeKey(email), { count: usedCount, lastScanAt: new Date().toISOString() });
    }
    const historyEvidence = {
      competitivePositionScore: analysis.competitivePositionScore,
      business: { name: businessName, description: businessDescription },
      competitorPages: competitorPages.map(function (p) {
        return { name: p.name, url: p.url, fetched: p.fetched, title: p.title };
      })
    };
    await core.saveToHistory(email, watchName, historyEvidence, analysis, 'competitor');
  } catch (e) {
    // Non-fatal — never block a real result just because logging failed.
  }

  let scansRemaining = null;
  if (!unlimited) {
    try {
      const usageRaw = await usageStore.get(http.safeKey(email), { type: 'json' });
      const usedCount = usageRaw && usageRaw.count ? usageRaw.count : 1;
      scansRemaining = Math.max(0, FREE_SCAN_LIMIT - usedCount);
    } catch (e) {
      scansRemaining = null;
    }
  }

  return http.json(200, {
    success: true,
    watchId: watchId,
    businessName: businessName,
    competitorPages: competitorPages.map(function (p) {
      return { name: p.name, url: p.url, fetched: p.fetched, error: p.error, title: p.title };
    }),
    analysis: analysis,
    meta: { unlimited: unlimited, tier: tier, scansRemaining: scansRemaining, freeScanLimit: FREE_SCAN_LIMIT }
  });
}
