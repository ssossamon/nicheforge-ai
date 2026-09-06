// NicheForge AI — playbook-core.js (v2.1)
//
// Transcript Intelligence + Playbook. Real segment timestamps come from
// content-analysis.js's fetchTranscriptWithTimestamps; the marker-building/
// timestamp-snapping mechanism itself now lives in content-analysis.js too
// (shared with analyze-content.js's video/transcript analysis) so there's
// exactly one implementation of "ground every timestamp in real data."

const competitorCore = require('./competitor-core');
const contentAnalysis = require('./content-analysis');

// ===========================================================================
// Main dissection — Transcript Intelligence (summary/chapters/claims/pain
// points/hook analysis/fact-check queue) + the existing tactics/mechanic/
// playbook layer.
// ===========================================================================

async function dissectTranscript(provider, apiKey, model, transcriptInput, sourceLabel, videoId) {
  // transcriptInput may be a plain string (pasted transcript — no real
  // timestamps exist) or a {segments, fullText} object from a real fetched
  // video (real timestamps exist and get embedded as markers).
  let markedText, windowStarts, plainText;
  if (transcriptInput && typeof transcriptInput === 'object' && transcriptInput.segments) {
    const built = contentAnalysis.buildMarkedTranscript(transcriptInput.segments);
    markedText = built.markedText;
    windowStarts = built.windowStarts;
    plainText = transcriptInput.fullText;
  } else {
    plainText = String(transcriptInput);
    markedText = plainText.slice(0, 8000);
    windowStarts = null;
  }

  const hasRealTimestamps = !!windowStarts;

  const systemPrompt =
    'You are a marketing strategist and content analyst who reverse-engineers real transcripts. ' +
    (hasRealTimestamps
      ? 'The transcript below has real [T=M:SS] time markers inserted at ~20-second intervals. Whenever you reference a specific ' +
        'moment (a chapter start, a key claim, a pain point, the hook), you MUST copy one of the exact [T=...] marker values shown — ' +
        'never invent a time that isn\u2019t one of the markers given. '
      : 'This is pasted text with no real timing data, so do not include any timestamp fields — leave them null. ') +
    'Ground every finding in something ACTUALLY said in the transcript — never invent a claim, tactic, or quote that isn\u2019t there. ' +
    'When referencing transcript wording, paraphrase in your own words rather than quoting more than a short phrase (under 12 words), ' +
    'since this may be copyrighted material. ' +
    'Separate the MECHANIC (the real, generic, transferable technique) from the PROPRIETARY SPECIFICS (their exact brand, product, ' +
    'wording, offer) — "replicableMechanic" and the playbook must be built on the mechanic, generalized for a different niche/business, ' +
    'never a copy of their specific brand or claims. ' +
    'Respond with STRICT JSON only, no markdown fences, matching exactly:\n\n' +
    '{"summary":string,\n' +
    '"chapters":[{"timestamp":string|null,"title":string,"description":string}],\n' +
    '"keyClaims":[{"claim":string,"timestamp":string|null}],\n' +
    '"frameworksAndProcesses":[string],\n' +
    '"toolsAndResources":[string],\n' +
    '"painPoints":[{"painPoint":string,"severity":"low"|"medium"|"high","audienceSegment":string,"timestamp":string|null}],\n' +
    '"desiredOutcomes":[string,string,string],\n' +
    '"hookAnalysis":{"technique":string,"description":string,"timestamp":string|null},\n' +
    '"persuasionDevices":[string,string,string],\n' +
    '"factCheckQueue":[string],\n' +
    '"whatTheyDid":[{"tactic":string,"howTheyDidIt":string,"whyItWorks":string}],\n' +
    '"replicableMechanic":string,\n' +
    '"adaptationNotes":[string,string,string],\n' +
    '"playbook":{"title":string,"objective":string,"prerequisites":[string,string],' +
    '"steps":[{"stepNumber":number,"action":string,"details":string,"estimatedTime":string}],' +
    '"successMetrics":[string,string],"commonPitfalls":[string,string]}}\n\n' +
    'Identify 3-6 chapters covering the whole video, 3-6 key claims, 3-5 pain points, 3-5 distinct tactics in "whatTheyDid", and a ' +
    '5-9 step executable playbook. "factCheckQueue" lists specific factual claims made (stats, named studies, guarantees) that a ' +
    'viewer should independently verify before repeating — omit if the transcript makes no checkable factual claims.';

  const userPrompt =
    'SOURCE: ' + sourceLabel + '\n\n' +
    'TRANSCRIPT' + (hasRealTimestamps ? ' (with real [T=M:SS] markers)' : ' (pasted, no real timing data)') + ':\n' + markedText + '\n\n' +
    'Produce the JSON described in your instructions, grounded only in what this transcript actually shows.';

  const result = await competitorCore.callAi(provider, apiKey, model, systemPrompt, userPrompt, ['whatTheyDid', 'replicableMechanic', 'playbook']);

  // ---- Defensive defaults ----
  if (!Array.isArray(result.chapters)) result.chapters = [];
  if (!Array.isArray(result.keyClaims)) result.keyClaims = [];
  if (!Array.isArray(result.frameworksAndProcesses)) result.frameworksAndProcesses = [];
  if (!Array.isArray(result.toolsAndResources)) result.toolsAndResources = [];
  if (!Array.isArray(result.painPoints)) result.painPoints = [];
  if (!Array.isArray(result.desiredOutcomes)) result.desiredOutcomes = [];
  if (!Array.isArray(result.persuasionDevices)) result.persuasionDevices = [];
  if (!Array.isArray(result.factCheckQueue)) result.factCheckQueue = [];
  if (!Array.isArray(result.whatTheyDid)) result.whatTheyDid = [];
  if (!Array.isArray(result.adaptationNotes)) result.adaptationNotes = [];
  if (!result.playbook) result.playbook = { steps: [] };
  if (!Array.isArray(result.playbook.steps)) result.playbook.steps = [];
  if (!Array.isArray(result.playbook.prerequisites)) result.playbook.prerequisites = [];
  if (!Array.isArray(result.playbook.successMetrics)) result.playbook.successMetrics = [];
  if (!Array.isArray(result.playbook.commonPitfalls)) result.playbook.commonPitfalls = [];

  applyRealTimestamps(result, windowStarts, videoId);

  return result;
}

// Snap every AI-cited timestamp field in a Transcript Intelligence result to
// a real marker (or null it out) — shared shape used by both this playbook
// dissection and analyze-content.js's video/transcript analysis.
function applyRealTimestamps(result, windowStarts, videoId) {
  const hasRealTimestamps = !!windowStarts;
  const timeFor = function (raw) {
    return hasRealTimestamps ? contentAnalysis.withRealTimestamp(raw, windowStarts, videoId) : contentAnalysis.noTimestamp();
  };

  result.chapters = (result.chapters || [])
    .filter(function (c) { return c && typeof c.title === 'string'; })
    .map(function (c) { return { time: timeFor(c.timestamp), title: c.title, description: c.description || '' }; });
  result.keyClaims = (result.keyClaims || [])
    .filter(function (c) { return c && typeof c.claim === 'string'; })
    .map(function (c) { return { claim: c.claim, time: timeFor(c.timestamp) }; });
  result.painPoints = (result.painPoints || [])
    .filter(function (p) { return p && typeof p.painPoint === 'string'; })
    .map(function (p) {
      return {
        painPoint: p.painPoint,
        severity: ['low', 'medium', 'high'].indexOf(p.severity) !== -1 ? p.severity : 'medium',
        audienceSegment: p.audienceSegment || '',
        time: timeFor(p.timestamp)
      };
    });
  if (result.hookAnalysis) {
    result.hookAnalysis.time = timeFor(result.hookAnalysis.timestamp);
  }
}

async function fetchVideoTitle(videoId) {
  try {
    const res = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + videoId) + '&format=json');
    if (!res.ok) return null;
    const data = await res.json();
    return data.title || null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  dissectTranscript: dissectTranscript,
  applyRealTimestamps: applyRealTimestamps,
  fetchVideoTitle: fetchVideoTitle
};
