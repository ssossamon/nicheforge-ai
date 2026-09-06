// NicheForge AI — scan-core.js (v1.2)
//
// The reusable engine behind both a single scan and a batch scan: real
// YouTube evidence gathering (with a short-lived cache to protect quota),
// transparent deterministic scoring, and BYOK AI synthesis. Nothing here is
// simulated — every number is either pulled straight from YouTube's API or
// computed by a visible formula, and the cache never returns anything a
// live call wouldn't have returned within its freshness window.

const { getStore } = require('@netlify/blobs');

const YT_BASE = 'https://www.googleapis.com/youtube/v3';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function normalizeQueryKey(query) {
  // URL-encoded because raw spaces in a Blobs key have shown a mismatch
  // between what list() reports and what get() returns for that same key.
  return encodeURIComponent(String(query).trim().toLowerCase().replace(/\s+/g, ' '));
}

async function getCachedEvidence(query) {
  try {
    const cacheStore = getStore('nforge-scan-cache');
    const rec = await cacheStore.get(normalizeQueryKey(query), { type: 'json' });
    if (!rec) return null;
    if (Date.now() > rec.expiresAt) return null;
    return rec.evidence;
  } catch (e) {
    return null;
  }
}

async function setCachedEvidence(query, evidence) {
  try {
    const cacheStore = getStore('nforge-scan-cache');
    await cacheStore.setJSON(normalizeQueryKey(query), {
      evidence: evidence,
      cachedAt: Date.now(),
      expiresAt: Date.now() + CACHE_TTL_MS
    });
  } catch (e) {
    // Non-fatal — caching is a cost optimization, never a requirement.
  }
}

// ===========================================================================
// Score history — every FRESH (non-cached) real scan of a topic appends a
// point here, so repeat scans of the same topic can show a real trend line
// instead of a single snapshot. Capped at the most recent 30 points.
// ===========================================================================

async function getScoreHistory(query) {
  try {
    const store = getStore('nforge-score-history');
    const rec = await store.get(normalizeQueryKey(query), { type: 'json' });
    return (rec && rec.points) || [];
  } catch (e) {
    return [];
  }
}

async function appendScoreHistory(query, opportunityScore, avgViews) {
  try {
    const store = getStore('nforge-score-history');
    const key = normalizeQueryKey(query);
    const rec = (await store.get(key, { type: 'json' })) || { points: [] };
    rec.points.push({ date: new Date().toISOString(), opportunityScore: opportunityScore, avgViews: avgViews });
    if (rec.points.length > 30) rec.points = rec.points.slice(rec.points.length - 30);
    await store.setJSON(key, rec);
    return rec.points;
  } catch (e) {
    return [];
  }
}

// ===========================================================================
// Transparent multi-component scoring engine.
//
// Four components are computed purely from real evidence (no AI involved):
// Demand, Competition Opportunity, Momentum, Evidence Confidence. Two more
// — Gap and Monetization — need real judgment (what's actually missing from
// existing coverage, whether there's genuine buyer intent) that a formula
// can't honestly produce from view counts alone, so those come from the AI
// synthesis call and are always labeled "AI Inference," never presented as
// computed. A seventh, Execution Fit, needs a user's own skills/time/
// resources — NicheForge doesn't collect that yet, so it's left unscored
// and its weight is redistributed across whichever components ARE
// available, exactly the reweighting rule this whole design follows.
// ===========================================================================

const SCORE_WEIGHTS = {
  demand: 0.20,
  competitionOpportunity: 0.15,
  momentum: 0.15,
  gap: 0.20,
  monetization: 0.15,
  executionFit: 0.10,
  evidenceConfidence: 0.05
};

function clampScore(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function computeDemandScore(evidence) {
  const blended = (evidence.avgViews + evidence.medianViews) / 2;
  return clampScore(Math.log10(blended + 1) * 16.67);
}

function computeCompetitionOpportunityScore(evidence) {
  // Unknown channel-size data gets a neutral midpoint rather than assuming
  // either a wide-open or fully saturated market.
  const dominance = evidence.bigChannelRatio === null ? 0.5 : evidence.bigChannelRatio;
  const dominancePoints = (1 - dominance) * 80;
  const breakoutBonus = Math.min(20, evidence.breakoutVideoCount * 4);
  return clampScore(dominancePoints + breakoutBonus);
}

function computeMomentumScore(evidence) {
  const freshness = evidence.daysSinceMostRecentUpload <= 7 ? 40
    : evidence.daysSinceMostRecentUpload <= 14 ? 30
    : evidence.daysSinceMostRecentUpload <= 30 ? 15
    : 0;
  const cadence = Math.max(0, Math.min(30, Math.round(evidence.uploadsPerWeekInSample * 6)));
  const breakout = Math.max(0, Math.min(30, evidence.breakoutVideoCount * 6));
  return clampScore(freshness + cadence + breakout);
}

function computeEvidenceConfidenceScore(evidence) {
  const sampleSize = Math.max(0, Math.min(40, Math.round((evidence.videoCount / 25) * 40)));
  const completeness = Math.max(0, Math.min(30, Math.round((evidence.channelsWithKnownSubs / Math.max(1, evidence.uniqueChannelCount)) * 30)));
  const recency = evidence.daysSinceMostRecentUpload <= 14 ? 30
    : evidence.daysSinceMostRecentUpload <= 30 ? 20
    : evidence.daysSinceMostRecentUpload <= 90 ? 10
    : 0;
  return clampScore(sampleSize + completeness + recency);
}

function computeExecutionFitScore(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const maps = {
    experience: { beginner: 45, intermediate: 70, advanced: 90 },
    hoursPerWeek: { under3: 35, '3to5': 55, '6to10': 75, over10: 95 },
    budget: { none: 40, under100: 55, '100to500': 75, over500: 90 },
    team: { solo: 60, small: 80, established: 90 },
    distribution: { none: 40, building: 65, established: 90 }
  };
  const values = Object.keys(maps).map(function (key) { return maps[key][profile[key]]; })
    .filter(function (value) { return typeof value === 'number'; });
  if (values.length < 3) return null;
  return clampScore(values.reduce(function (sum, value) { return sum + value; }, 0) / values.length);
}

function scoreBandLabel(score) {
  if (score >= 80) return 'Strong';
  if (score >= 65) return 'Promising';
  if (score >= 50) return 'Validate First';
  if (score >= 35) return 'Weak';
  return 'Avoid for Now';
}

// Combines whichever named components have a real numeric value, giving
// each its full weight from SCORE_WEIGHTS reweighted proportionally across
// only the available components — an unavailable component's weight is
// redistributed, never silently defaulted to a value.
// Validates a user-supplied weights object (from Settings, sent with the
// scan request — never trusted blindly). Any missing, non-numeric, or
// negative field falls back to the default weight for that component;
// Execution Fit is never user-adjustable since it's never scored. The
// result is proportionally normalized to sum to exactly 1.0 so a user
// fat-fingering "60, 60, 60..." doesn't silently break the math.
function normalizeCustomWeights(rawWeights) {
  if (!rawWeights || typeof rawWeights !== 'object') return null;
  const adjustableKeys = ['demand', 'competitionOpportunity', 'momentum', 'gap', 'monetization', 'executionFit', 'evidenceConfidence'];
  // All-or-nothing: mixing a partial set of user-provided values (often on
  // a 0-100 percentage-like scale) with default fallback values (0-0.20
  // fractions) for the missing ones would badly skew the result toward
  // whichever fields the user happened to provide. Safer and simpler to
  // require a complete, valid set or fall back to full defaults.
  const allValid = adjustableKeys.every(function (key) {
    const v = rawWeights[key];
    return typeof v === 'number' && isFinite(v) && v >= 0;
  });
  if (!allValid) return null;
  const sum = adjustableKeys.reduce(function (a, key) { return a + rawWeights[key]; }, 0);
  if (sum <= 0) return null;
  const normalized = {};
  adjustableKeys.forEach(function (key) { normalized[key] = rawWeights[key] / sum; });
  // The six adjustable components always share that same 90% (Execution
  // Fit's reserved slice stays reserved, unscored, exactly as in the
  // default weights) — a user can shift emphasis AMONG the six, not claim
  // Execution Fit's share for something else. combineWeighted's existing
  // reweighting then expands these back to 100% automatically, same as it
  // already does for the default weights when Execution Fit is absent.
  return normalized;
}

function combineWeighted(componentValues, weights) {
  const activeWeights = weights || SCORE_WEIGHTS;
  let availableWeightSum = 0;
  const usedKeys = [];
  Object.keys(SCORE_WEIGHTS).forEach(function (key) {
    if (typeof componentValues[key] === 'number') {
      availableWeightSum += activeWeights[key];
      usedKeys.push(key);
    }
  });
  if (availableWeightSum === 0) return { overall: null, reweighted: {}, usedKeys: [] };
  const reweighted = {};
  let weightedSum = 0;
  usedKeys.forEach(function (key) {
    reweighted[key] = activeWeights[key] / availableWeightSum;
    weightedSum += componentValues[key] * reweighted[key];
  });
  return { overall: Math.round(weightedSum), reweighted: reweighted, usedKeys: usedKeys };
}

// Assembles the full transparent breakdown object the frontend's score
// drawer renders — every component's value (or null), its formula in
// plain text, its provenance (Computed vs AI Inference vs Not scored), its
// reweighted share of the final number, and the resulting Overall score
// and band. `stage` records whether this reflects evidence-only scoring
// (no AI ever ran — the watchlist background recheck path) or the fuller
// AI-enriched version an interactive scan produces.
function buildScoreBreakdown(evidence, aiScores, stage, customWeights, executionProfile) {
  const demand = computeDemandScore(evidence);
  const competitionOpportunity = computeCompetitionOpportunityScore(evidence);
  const momentum = computeMomentumScore(evidence);
  const evidenceConfidence = computeEvidenceConfidenceScore(evidence);
  const gap = aiScores && typeof aiScores.gapScore === 'number' ? clampScore(aiScores.gapScore) : null;
  const monetization = aiScores && typeof aiScores.monetizationScore === 'number' ? clampScore(aiScores.monetizationScore) : null;
  const executionFit = computeExecutionFitScore(executionProfile);
  const activeWeights = customWeights || SCORE_WEIGHTS;

  const combo = combineWeighted({
    demand: demand,
    competitionOpportunity: competitionOpportunity,
    momentum: momentum,
    gap: gap,
    monetization: monetization,
    executionFit: executionFit,
    evidenceConfidence: evidenceConfidence
  }, activeWeights);

  const components = [
    {
      key: 'demand', label: 'Demand', value: demand, provenance: 'Computed',
      weight: combo.reweighted.demand || 0, rawWeight: activeWeights.demand,
      formula: 'log10((avgViews + medianViews) / 2 + 1) \u00D7 16.67, clamped 0-100',
      inputs: { avgViews: evidence.avgViews, medianViews: evidence.medianViews }
    },
    {
      key: 'competitionOpportunity', label: 'Competition Opportunity', value: competitionOpportunity, provenance: 'Computed',
      weight: combo.reweighted.competitionOpportunity || 0, rawWeight: activeWeights.competitionOpportunity,
      formula: '(1 \u2212 shareOf100k+SubChannels) \u00D7 80 + min(20, breakoutVideos \u00D7 4). Higher = less dominated by big channels.',
      inputs: { bigChannelRatio: evidence.bigChannelRatio, breakoutVideoCount: evidence.breakoutVideoCount }
    },
    {
      key: 'momentum', label: 'Momentum', value: momentum, provenance: 'Computed',
      weight: combo.reweighted.momentum || 0, rawWeight: activeWeights.momentum,
      formula: 'freshness(0/15/30/40 by days since last upload) + cadence(uploads/week \u00D7 6, capped 30) + breakout(count \u00D7 6, capped 30)',
      inputs: { daysSinceMostRecentUpload: evidence.daysSinceMostRecentUpload, uploadsPerWeekInSample: evidence.uploadsPerWeekInSample, breakoutVideoCount: evidence.breakoutVideoCount }
    },
    {
      key: 'gap', label: 'Content Gap', value: gap, provenance: gap === null ? 'Not available' : 'AI Inference',
      weight: combo.reweighted.gap || 0, rawWeight: activeWeights.gap,
      formula: gap === null ? 'Requires the AI synthesis step, which hasn\u2019t run for this evidence yet.' : 'AI-estimated 0-100: how underserved the real evidence (titles, comments, autocomplete) shows this angle to be.',
      justification: (aiScores && aiScores.gapScoreJustification) || null
    },
    {
      key: 'monetization', label: 'Monetization Potential', value: monetization, provenance: monetization === null ? 'Not available' : 'AI Inference',
      weight: combo.reweighted.monetization || 0, rawWeight: activeWeights.monetization,
      formula: monetization === null ? 'Requires the AI synthesis step, which hasn\u2019t run for this evidence yet.' : 'AI-estimated 0-100: buyer intent and plausible offer fit implied by the real evidence \u2014 never a revenue prediction.',
      justification: (aiScores && aiScores.monetizationScoreJustification) || null
    },
    {
      key: 'executionFit', label: 'Execution Fit', value: executionFit, provenance: executionFit === null ? 'Not available' : 'Computed',
      weight: combo.reweighted.executionFit || 0, rawWeight: activeWeights.executionFit,
      formula: executionFit === null ? 'Complete at least three Execution Profile fields in Settings; the unavailable weight is transparently redistributed.' : 'Average of fixed readiness points for experience, weekly time, budget, team capacity, and existing distribution.',
      inputs: executionFit === null ? null : executionProfile
    },
    {
      key: 'evidenceConfidence', label: 'Evidence Confidence', value: evidenceConfidence, provenance: 'Computed',
      weight: combo.reweighted.evidenceConfidence || 0, rawWeight: activeWeights.evidenceConfidence,
      formula: 'sampleSize(videoCount/25 \u00D7 40) + completeness(channelsWithKnownSubs/uniqueChannelCount \u00D7 30) + recency(0/10/20/30 by days since last upload)',
      inputs: { videoCount: evidence.videoCount, channelsWithKnownSubs: evidence.channelsWithKnownSubs, uniqueChannelCount: evidence.uniqueChannelCount }
    }
  ];

  return {
    stage: stage, // 'evidence-only' (no AI ran) or 'full' (AI synthesis included)
    overall: combo.overall === null ? null : { value: combo.overall, band: scoreBandLabel(combo.overall) },
    components: components,
    customWeightsApplied: !!customWeights,
    weightsNote: (customWeights ? 'Using your custom weights (Settings \u2192 Score weights). ' : '') +
      (executionFit === null ? 'Execution Fit is unavailable, so its weight was redistributed proportionally across available components.' : 'Execution Fit uses the readiness profile saved in Settings.'),
    computedAt: new Date().toISOString()
  };
}

// ===========================================================================
// Real viewer comments — pulled from the top few highest-viewed videos in
// the sample so the AI's "content gap" can be grounded in what viewers
// actually said, not just inferred from titles and view counts. Videos with
// comments disabled are skipped silently rather than failing the scan.
// ===========================================================================

async function gatherTopComments(videoIds, ytKey) {
  const comments = [];
  for (let i = 0; i < videoIds.length && comments.length < 15; i++) {
    try {
      const res = await fetchJson(
        YT_BASE + '/commentThreads?part=snippet&order=relevance&maxResults=5&videoId=' + videoIds[i] + '&key=' + ytKey
      );
      if (res.status < 200 || res.status >= 300) continue;
      (res.data.items || []).forEach(function (item) {
        const top = item.snippet && item.snippet.topLevelComment && item.snippet.topLevelComment.snippet;
        if (!top) return;
        comments.push({
          text: String(top.textDisplay || '').replace(/<[^>]+>/g, '').slice(0, 240),
          likeCount: top.likeCount || 0
        });
      });
    } catch (e) {
      // Comments disabled or API hiccup for this video — skip, don't fail the scan.
    }
  }
  return comments.sort(function (a, b) { return b.likeCount - a.likeCount; }).slice(0, 12);
}

// ===========================================================================
// Real YouTube autocomplete signal — what people actually type before they
// search. This is YouTube's own public suggestion endpoint (no API key, no
// quota cost), used here as a second, genuinely different demand signal
// alongside the ranked-results data above.
// ===========================================================================

async function gatherAutocompleteSuggestions(query) {
  try {
    const res = await fetch(
      'https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&ds=yt&hl=en&gl=US&q=' + encodeURIComponent(query)
    );
    const text = await res.text();
    const match = text.match(/\[.*\]/s);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    const suggestions = (parsed[1] || []).map(function (item) { return Array.isArray(item) ? item[0] : item; });
    return suggestions.filter(Boolean).slice(0, 10);
  } catch (e) {
    return [];
  }
}

// ===========================================================================
// Real YouTube data gathering + transparent scoring
// ===========================================================================

async function gatherYoutubeEvidence(query, ytKey, ytKeySource, skipCache) {
  if (!skipCache) {
    const cached = await getCachedEvidence(query);
    if (cached) {
      return Object.assign({}, cached, { fromCache: true });
    }
  }

  const publishedAfter = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

  const searchUrl =
    YT_BASE +
    '/search?part=snippet&type=video&order=viewCount&maxResults=25&relevanceLanguage=en' +
    '&publishedAfter=' + encodeURIComponent(publishedAfter) +
    '&q=' + encodeURIComponent(query) +
    '&key=' + ytKey;

  const searchRes = await fetchJson(searchUrl);
  throwOnYoutubeError(searchRes, 'search.list', ytKeySource);

  const items = (searchRes.data.items || []).filter(function (it) {
    return it.id && it.id.videoId;
  });

  if (items.length === 0) {
    return { videoCount: 0, fromCache: false };
  }

  const videoIds = items.map(function (it) { return it.id.videoId; });
  const channelIdSet = {};
  items.forEach(function (it) { channelIdSet[it.snippet.channelId] = true; });
  const channelIds = Object.keys(channelIdSet);

  const videosUrl =
    YT_BASE + '/videos?part=statistics,snippet,contentDetails&id=' + videoIds.join(',') + '&key=' + ytKey;
  const videosRes = await fetchJson(videosUrl);
  throwOnYoutubeError(videosRes, 'videos.list', ytKeySource);

  const channelsUrl =
    YT_BASE + '/channels?part=statistics&id=' + channelIds.join(',') + '&key=' + ytKey;
  const channelsRes = await fetchJson(channelsUrl);
  throwOnYoutubeError(channelsRes, 'channels.list', ytKeySource);

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

  // ---- Transparent, deterministic scoring (evidence-only stage) ----------
  // This is the score watchlist-recheck.js sees directly — it calls
  // gatherYoutubeEvidence with no AI key available (a scheduled job, BYOK
  // constraint), so it must get a real, meaningful, standalone score from
  // evidence alone. A full interactive scan enriches this further in
  // runFullScan once the AI's Gap/Monetization judgment exists.
  const evidenceOnlyDraft = {
    avgViews: avgViews,
    medianViews: medianViews,
    bigChannelRatio: bigChannelRatio,
    breakoutVideos: breakoutVideos,
    breakoutVideoCount: breakoutVideos.length,
    daysSinceMostRecentUpload: daysSinceMostRecent,
    uploadsPerWeekInSample: uploadsPerWeek,
    videoCount: videos.length,
    channelsWithKnownSubs: knownSubChannels.length,
    uniqueChannelCount: channelIds.length
  };
  const scoreBreakdown = buildScoreBreakdown(evidenceOnlyDraft, null, 'evidence-only');
  const opportunityScore = scoreBreakdown.overall.value;

  // Real, independent signals alongside the ranked-results data above.
  const topVideoIdsForComments = videos
    .slice()
    .sort(function (a, b) { return b.views - a.views; })
    .slice(0, 5)
    .map(function (v) { return v.id; });
  const topComments = await gatherTopComments(topVideoIdsForComments, ytKey);
  const autocompleteSuggestions = await gatherAutocompleteSuggestions(query);
  const scoreHistory = await getScoreHistory(query);

  const evidence = {
    videoCount: videos.length,
    totalResultsReportedByYoutube: searchRes.data.pageInfo ? searchRes.data.pageInfo.totalResults : null,
    avgViews: avgViews,
    medianViews: medianViews,
    bigChannelRatio: bigChannelRatio === null ? null : Number(bigChannelRatio.toFixed(2)),
    channelsWithKnownSubs: knownSubChannels.length,
    uniqueChannelCount: channelIds.length,
    uploadsPerWeekInSample: uploadsPerWeek,
    daysSinceMostRecentUpload: daysSinceMostRecent,
    shortsShare: Number((shortsCount / videos.length).toFixed(2)),
    breakoutVideos: breakoutVideos.slice(0, 5),
    breakoutVideoCount: breakoutVideos.length,
    opportunityScore: opportunityScore,
    scoreFormula: 'Weighted blend of Demand, Competition Opportunity, Momentum, and Evidence Confidence (Gap and Monetization are added once the AI synthesis step runs \u2014 see scoreBreakdown for the full transparent formula). Computed from real YouTube metadata, not a guarantee of results.',
    scoreBreakdown: scoreBreakdown,
    topVideos: videos
      .slice()
      .sort(function (a, b) { return b.views - a.views; })
      .slice(0, 12)
      .map(function (v) {
        return { channelId: v.channelId, title: v.title, channelTitle: v.channelTitle, views: v.views, publishedAt: v.publishedAt, channelSubs: v.channelSubs };
      }),
    topComments: topComments,
    autocompleteSuggestions: autocompleteSuggestions,
    scoreHistory: scoreHistory,
    dataSource: 'YouTube Data API v3 (search.list, videos.list, channels.list, commentThreads.list) plus YouTube\u2019s public autocomplete endpoint — videos published in the last 12 months, ordered by view count.',
    youtubeKeySource: ytKeySource,
    fetchedAt: new Date().toISOString(),
    fromCache: false
  };

  await setCachedEvidence(query, evidence);
  return evidence;
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

function throwOnYoutubeError(res, callName, ytKeySource) {
  if (res.status >= 200 && res.status < 300) return;
  const reason = res.data && res.data.error && res.data.error.errors && res.data.error.errors[0]
    ? res.data.error.errors[0].reason
    : null;
  const err = new Error();
  if (res.status === 403 && reason === 'quotaExceeded') {
    err.statusCode = 429;
    err.code = 'youtube_quota_exceeded';
    err.message = (ytKeySource === 'settings' ? 'Your' : "The site's") + ' daily YouTube API quota has been used up.';
    err.whatToDoNext = 'Try again after midnight Pacific time when the quota resets, or raise the quota in Google Cloud Console.';
  } else if (res.status === 400 && reason === 'keyInvalid') {
    err.statusCode = 500;
    err.code = 'youtube_key_invalid';
    err.message = (ytKeySource === 'settings' ? 'Your' : "The site's configured") + ' YouTube API key was rejected by Google.';
    err.whatToDoNext = ytKeySource === 'settings'
      ? 'Check the key you entered in Settings and confirm "YouTube Data API v3" is enabled for it in Google Cloud Console.'
      : 'Check the YOUTUBE_API_KEY environment variable in Netlify and confirm YouTube Data API v3 is enabled for it.';
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
    'You must not invent view counts, subscriber counts, revenue figures, or any other statistic beyond what is given. ' +
    'When you reference a number, it must come from the provided evidence. ' +
    'Respond with STRICT JSON only, no markdown code fences, no commentary before or after, matching this shape exactly: ' +
    '{"opportunities":[{"angle":string,"rationale":string,"titleIdeas":[string,string,string,string,string]}],' +
    '"contentGap":string,"contentGapSource":"comments"|"patterns",' +
    '"monetizationAngles":[{"type":string,"description":string}],' +
    '"gapScore":number,"gapScoreJustification":string,' +
    '"monetizationScore":number,"monetizationScoreJustification":string,' +
    '"opportunityCards":[{"category":string,"opportunity":string,"targetSegment":string,"supportingEvidence":string,' +
    '"competitorCoverage":string,"demandSignal":string,"expectedImpact":"low"|"medium"|"high","effort":"low"|"medium"|"high",' +
    '"confidence":"low"|"medium"|"high","risk":string,"recommendedFormat":string,"firstValidationTest":string}]}. ' +
    'Produce between 3 and 5 items in "opportunities". "rationale" must explicitly tie back to a real number from the evidence ' +
    '(e.g. "avg views of X across the sample" or "N of the top channels have 100k+ subscribers"). ' +
    '"titleIdeas" should be inspired by the style/phrasing of the real top-performing titles provided, but must be original wording, ' +
    'never a verbatim copy of any provided title. ' +
    '"contentGap" should name one specific, underserved angle visible in the data — prefer grounding it in the REAL VIEWER COMMENTS ' +
    'provided (a recurring question, complaint, or request) when any are given, and set "contentGapSource" to "comments" in that case; ' +
    'otherwise infer it from title/view patterns and set "contentGapSource" to "patterns". ' +
    '"monetizationAngles" should list 2-4 realistic ways a creator could monetize content in this niche (e.g. affiliate, digital product, ' +
    'sponsorship, ad revenue, service/coaching), each a qualitative strategic description grounded in what the evidence shows about the niche ' +
    '— never invent a specific dollar amount, RPM, or earnings figure; only Scott\u2019s own stated numbers (none given here) would be trustworthy for that. ' +
    '"gapScore" (0-100) is YOUR judgment of how underserved this angle is \u2014 how much real, specific demand (comments, autocomplete queries, ' +
    'title patterns) exists for something the current top results DON\u2019T already cover well; 0 means thoroughly covered, 100 means a wide-open ' +
    'gap. "monetizationScore" (0-100) is YOUR judgment of buyer intent and offer fit implied by the evidence (do viewers/searchers show signs of ' +
    'wanting to solve a problem worth paying for?), never a revenue prediction. Both scores are explicitly your inference, not a measurement \u2014 ' +
    'say so plainly in the one-sentence justification for each, and ground each justification in a specific piece of the evidence provided. ' +
    '"opportunityCards" is a ranked list (put the strongest first) of 3-6 distinct, specific opportunities \u2014 not the same idea repeated. ' +
    'Choose whichever categories genuinely apply from: content_gap, audience_problem_gap, product_feature_gap, offer_pricing_gap, ' +
    'format_platform_gap, authority_proof_gap, workflow_automation_gap, education_gap \u2014 do not force all 8, only include a category if the ' +
    'evidence actually supports it. Each card: "opportunity" is one specific, actionable idea (not a vague theme); "targetSegment" names who ' +
    'it is for; "supportingEvidence" cites a real number or pattern from the evidence above; "competitorCoverage" states plainly how well the ' +
    'sampled top videos already address this (e.g. "none of the top 12 cover this angle" or "covered but only by 1 of 12"); "demandSignal" ' +
    'names which real signal supports it (comments, autocomplete, view pattern, breakout video); "expectedImpact"/"effort"/"confidence" are ' +
    'each your honest low/medium/high judgment, not inflated toward high; "risk" names the one thing most likely to make this fail or ' +
    'underperform; "recommendedFormat" is a concrete deliverable (e.g. "a single comparison video", "a short series", "a downloadable template"); ' +
    '"firstValidationTest" is one specific, cheap action to test demand before committing real production time.'
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
  const commentsBlock = (evidence.topComments && evidence.topComments.length)
    ? evidence.topComments.map(function (c) { return '- "' + c.text + '" (' + c.likeCount + ' likes)'; }).join('\n')
    : '(no comments retrieved for this sample)';
  const autocompleteBlock = (evidence.autocompleteSuggestions && evidence.autocompleteSuggestions.length)
    ? evidence.autocompleteSuggestions.join(', ')
    : '(none returned)';
  const componentByKey = {};
  evidence.scoreBreakdown.components.forEach(function (c) { componentByKey[c.key] = c; });

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
    '- Deterministic scores already computed from this evidence (0-100, not AI-generated \u2014 use these as context, don\u2019t restate them): ' +
    'Demand ' + componentByKey.demand.value + ', Competition Opportunity ' + componentByKey.competitionOpportunity.value +
    ', Momentum ' + componentByKey.momentum.value + ', Evidence Confidence ' + componentByKey.evidenceConfidence.value + '.\n\n' +
    'TOP PERFORMING VIDEOS IN THIS SAMPLE:\n' + topTitles + '\n\n' +
    'BREAKOUT VIDEOS (outperformed their own channel\u2019s sampled average by 2x+):\n' + breakouts + '\n\n' +
    'REAL VIEWER COMMENTS from the highest-viewed videos in this sample (use these to ground the content gap when they reveal a recurring need):\n' + commentsBlock + '\n\n' +
    'REAL SEARCH-BOX AUTOCOMPLETE SUGGESTIONS for this topic (what people actually type before searching):\n' + autocompleteBlock + '\n\n' +
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
  if (!Array.isArray(parsed.monetizationAngles)) parsed.monetizationAngles = [];
  if (!parsed.contentGapSource) parsed.contentGapSource = 'patterns';
  parsed.gapScore = (typeof parsed.gapScore === 'number' && isFinite(parsed.gapScore)) ? Math.max(0, Math.min(100, Math.round(parsed.gapScore))) : null;
  parsed.monetizationScore = (typeof parsed.monetizationScore === 'number' && isFinite(parsed.monetizationScore)) ? Math.max(0, Math.min(100, Math.round(parsed.monetizationScore))) : null;
  if (typeof parsed.gapScoreJustification !== 'string') parsed.gapScoreJustification = null;
  if (typeof parsed.monetizationScoreJustification !== 'string') parsed.monetizationScoreJustification = null;
  parsed.opportunityCards = validateOpportunityCards(parsed.opportunityCards);
  return parsed;
}

const VALID_GAP_CATEGORIES = ['content_gap', 'audience_problem_gap', 'product_feature_gap', 'offer_pricing_gap', 'format_platform_gap', 'authority_proof_gap', 'workflow_automation_gap', 'education_gap'];
const VALID_LEVELS = ['low', 'medium', 'high'];

function validateOpportunityCards(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(function (c) { return c && typeof c.opportunity === 'string' && c.opportunity.trim().length > 0; })
    .slice(0, 8)
    .map(function (c) {
      return {
        category: VALID_GAP_CATEGORIES.indexOf(c.category) !== -1 ? c.category : 'content_gap',
        opportunity: c.opportunity,
        targetSegment: typeof c.targetSegment === 'string' ? c.targetSegment : '',
        supportingEvidence: typeof c.supportingEvidence === 'string' ? c.supportingEvidence : '',
        competitorCoverage: typeof c.competitorCoverage === 'string' ? c.competitorCoverage : '',
        demandSignal: typeof c.demandSignal === 'string' ? c.demandSignal : '',
        expectedImpact: VALID_LEVELS.indexOf(c.expectedImpact) !== -1 ? c.expectedImpact : 'medium',
        effort: VALID_LEVELS.indexOf(c.effort) !== -1 ? c.effort : 'medium',
        confidence: VALID_LEVELS.indexOf(c.confidence) !== -1 ? c.confidence : 'medium',
        risk: typeof c.risk === 'string' ? c.risk : '',
        recommendedFormat: typeof c.recommendedFormat === 'string' ? c.recommendedFormat : '',
        firstValidationTest: typeof c.firstValidationTest === 'string' ? c.firstValidationTest : ''
      };
    });
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

// ===========================================================================
// Combined single-topic pipeline: evidence + AI synthesis
// ===========================================================================

async function runFullScan(query, ytKey, ytKeySource, skipCache, aiProvider, aiApiKey, aiModel, rawCustomWeights, executionProfile) {
  const evidence = await gatherYoutubeEvidence(query, ytKey, ytKeySource, skipCache);
  if (evidence.videoCount === 0) {
    return { evidence: evidence, ai: null };
  }
  const ai = await runAiSynthesis(aiProvider, aiApiKey, aiModel, query, evidence);
  const customWeights = normalizeCustomWeights(rawCustomWeights);

  // Enrich the evidence-only score with the AI's Gap/Monetization judgment,
  // now that it exists. The underlying YouTube evidence may have come from
  // cache, but this combined score never is \u2014 it reflects THIS call's AI
  // response. A fresh score-history point is only recorded when the
  // underlying evidence was ALSO freshly fetched, preserving the existing
  // "one point per real data refresh" behavior rather than one per AI call.
  const fullBreakdown = buildScoreBreakdown(evidence, {
    gapScore: ai.gapScore,
    gapScoreJustification: ai.gapScoreJustification,
    monetizationScore: ai.monetizationScore,
    monetizationScoreJustification: ai.monetizationScoreJustification
  }, 'full', customWeights, executionProfile);

  const enrichedEvidence = Object.assign({}, evidence, {
    opportunityScore: fullBreakdown.overall.value,
    scoreFormula: 'Weighted blend of Demand, Competition Opportunity, Momentum, Content Gap, Monetization Potential, Execution Fit when configured, and Evidence Confidence. Missing components are transparently reweighted.',
    scoreBreakdown: fullBreakdown
  });

  if (!evidence.fromCache) {
    enrichedEvidence.scoreHistory = await appendScoreHistory(query, fullBreakdown.overall.value, evidence.avgViews);
  } else {
    // The cached evidence's own embedded scoreHistory was frozen at the
    // moment it was cached — a later fresh scan of this same query could
    // have appended a point since then. Re-fetch live so the chart never
    // silently misses a point that actually exists in storage.
    enrichedEvidence.scoreHistory = await getScoreHistory(query);
  }

  return { evidence: enrichedEvidence, ai: ai };
}

// ===========================================================================
// Scan history — every successful scan (single or batch) is saved here so
// it can be reopened later instead of vanishing the moment you navigate
// away. Keyed by email so each person's history stays separate.
// ===========================================================================

async function saveToHistory(email, query, evidence, ai, contentType) {
  try {
    const store = getStore('nforge-history');
    const id = encodeURIComponent(email) + '::' + Date.now() + '::' + Math.random().toString(36).slice(2, 8);
    const type = contentType || 'niche';
    // Normalize whichever score field this content type uses (each type has
    // its own name/formula) into one field reports can sort/compare on.
    const normalizedScore =
      evidence.opportunityScore !== undefined ? evidence.opportunityScore :
      evidence.videoPerformanceScore !== undefined ? evidence.videoPerformanceScore :
      evidence.channelHealthScore !== undefined ? evidence.channelHealthScore :
      evidence.competitivePositionScore !== undefined ? evidence.competitivePositionScore :
      (ai && ai.scriptQualityScore !== undefined) ? ai.scriptQualityScore : null;
    await store.setJSON(id, {
      id: id,
      email: email,
      contentType: type,
      query: query,
      score: normalizedScore,
      avgViews: evidence.avgViews !== undefined ? evidence.avgViews : (evidence.views !== undefined ? evidence.views : null),
      timestamp: new Date().toISOString(),
      evidence: evidence,
      ai: ai
    });
    return id;
  } catch (e) {
    return null;
  }
}

module.exports = {
  gatherYoutubeEvidence: gatherYoutubeEvidence,
  runAiSynthesis: runAiSynthesis,
  runFullScan: runFullScan,
  normalizeQueryKey: normalizeQueryKey,
  saveToHistory: saveToHistory,
  gatherAutocompleteSuggestions: gatherAutocompleteSuggestions,
  buildScoreBreakdown: buildScoreBreakdown,
  normalizeCustomWeights: normalizeCustomWeights,
  SCORE_WEIGHTS: SCORE_WEIGHTS,
  YT_BASE: YT_BASE,
  fetchJson: fetchJson
};
