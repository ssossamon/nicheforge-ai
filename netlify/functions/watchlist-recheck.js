// NicheForge AI — watchlist-recheck.js (v1.3)
//
// Runs once a day (see the schedule in netlify.toml). Re-fetches REAL
// YouTube evidence for every watched topic (no AI call — this is a
// background job, there's no per-request BYOK key available) and flags
// anything whose Opportunity Score moved meaningfully or that picked up a
// new breakout video since the last check.

const { getStore, connectLambda } = require('@netlify/blobs');
const core = require('./_shared/scan-core');

const SCORE_MOVE_THRESHOLD = 10;

exports.handler = async function (event) {
  connectLambda(event);
  const ytKey = process.env.YOUTUBE_API_KEY;
  if (!ytKey) {
    console.log('watchlist-recheck: YOUTUBE_API_KEY not configured, skipping run.');
    return { statusCode: 200, body: 'skipped: no YOUTUBE_API_KEY' };
  }

  let store;
  try {
    store = getStore('nforge-watchlist', { consistency: 'strong' });
  } catch (e) {
    console.log('watchlist-recheck: Blobs unavailable: ' + e.message);
    return { statusCode: 200, body: 'skipped: storage unavailable' };
  }

  let listing;
  try {
    listing = await store.list();
  } catch (e) {
    return { statusCode: 200, body: 'skipped: could not list watchlist' };
  }

  let checked = 0;
  let flagged = 0;

  for (const item of listing.blobs) {
    let rec;
    try {
      rec = await store.get(item.key, { type: 'json' });
    } catch (e) {
      continue;
    }
    if (!rec || !rec.query) continue;

    try {
      const evidence = await core.gatherYoutubeEvidence(rec.query, ytKey, 'server', true);
      if (evidence.videoCount === 0) continue;

      let flagReason = null;
      if (typeof rec.lastKnownScore === 'number' && Math.abs(evidence.opportunityScore - rec.lastKnownScore) >= SCORE_MOVE_THRESHOLD) {
        flagReason = 'Opportunity Score moved from ' + rec.lastKnownScore + ' to ' + evidence.opportunityScore + '.';
      } else if (evidence.breakoutVideos && evidence.breakoutVideos.length > 0 && (!rec.lastBreakoutCount || evidence.breakoutVideos.length > rec.lastBreakoutCount)) {
        flagReason = 'New breakout video detected: "' + evidence.breakoutVideos[0].title + '".';
      }

      rec.lastKnownScore = evidence.opportunityScore;
      rec.lastCheckedAt = new Date().toISOString();
      rec.lastBreakoutCount = evidence.breakoutVideos ? evidence.breakoutVideos.length : 0;
      if (flagReason) {
        rec.flagged = true;
        rec.flagReason = flagReason;
        flagged++;
      }
      await store.setJSON(item.key, rec);
      checked++;
    } catch (e) {
      // A single topic failing (quota, no results, transient error) never
      // stops the rest of the watchlist from being checked.
      continue;
    }
  }

  return { statusCode: 200, body: 'checked=' + checked + ' flagged=' + flagged };
};
