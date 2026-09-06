// NicheForge AI — recheck-competitors.js (v1.0)
//
// Runs once a day (see netlify.toml). This is a background job with no
// user's BYOK AI key available to it, so it does NOT call any AI — it only
// re-fetches each tracked competitor's real page and compares the content
// hash to what was stored last time. A real hash mismatch is a fact, not a
// guess. When one is found, it stores both the old and new text on the
// alert so the AI summary (which needs a live key) can be generated
// on-demand when the user opens that alert in the app.

const { getStore, connectLambda } = require('@netlify/blobs');
const core = require('./_shared/competitor-core');
const http = require('./_shared/http');

exports.handler = async function (event) {
  connectLambda(event);

  let watchStore, alertStore;
  try {
    watchStore = getStore('nforge-competitor-watches');
    alertStore = getStore('nforge-competitor-alerts');
  } catch (e) {
    console.log('recheck-competitors: storage unavailable, skipping run: ' + e.message);
    return { statusCode: 200, body: 'skipped' };
  }

  let listing;
  try {
    listing = await watchStore.list();
  } catch (e) {
    console.log('recheck-competitors: could not list watches: ' + e.message);
    return { statusCode: 200, body: 'skipped' };
  }

  let checked = 0;
  let changed = 0;

  for (const item of listing.blobs) {
    let watch;
    try {
      watch = await watchStore.get(item.key, { type: 'json' });
    } catch (e) {
      continue;
    }
    if (!watch || !Array.isArray(watch.competitors)) continue;

    let anyChange = false;
    const updatedCompetitors = [];

    for (const comp of watch.competitors) {
      checked++;
      const fresh = await core.fetchCompetitorPage(comp.url);
      if (!fresh.fetched) {
        // Couldn't fetch this time — leave the stored state as-is rather
        // than treating a temporary failure as "no change".
        updatedCompetitors.push(comp);
        continue;
      }

      if (comp.contentHash && fresh.contentHash && comp.contentHash !== fresh.contentHash) {
        anyChange = true;
        changed++;
        try {
          const alertId = http.safeKey(watch.email) + '::' + Date.now() + '::' + Math.random().toString(36).slice(2, 8);
          await alertStore.setJSON(alertId, {
            id: alertId,
            email: watch.email,
            watchId: watch.id,
            watchName: watch.watchName,
            competitorName: comp.name,
            competitorUrl: comp.url,
            oldText: comp.lastText || '',
            newText: fresh.text || '',
            detectedAt: new Date().toISOString(),
            isRead: false
          });
        } catch (e) {
          // Non-fatal — still update the stored hash below so we don't
          // re-alert on the same change every day.
        }
      }

      updatedCompetitors.push({
        name: comp.name,
        url: comp.url,
        lastFetched: fresh.fetchedAt,
        fetched: true,
        contentHash: fresh.contentHash,
        lastText: fresh.text
      });
    }

    try {
      watch.competitors = updatedCompetitors;
      watch.lastCheckedAt = new Date().toISOString();
      await watchStore.setJSON(watch.id, watch);
    } catch (e) {
      // non-fatal, next run will just re-check against slightly stale state
    }

    if (anyChange) {
      // Be polite to the sites we're monitoring — small pause between watches.
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
    }
  }

  console.log('recheck-competitors: checked ' + checked + ' competitor pages, found ' + changed + ' real changes.');
  return { statusCode: 200, body: 'ok' };
};
