// NicheForge AI — playbook-core.js (v1.0)
//
// Reuses _shared/content-analysis.js for URL detection and real transcript
// fetching (already proven there), and _shared/competitor-core.js's generic
// callAi for the provider dispatch — no third copy of either.

const competitorCore = require('./competitor-core');

async function dissectTranscript(provider, apiKey, model, transcriptText, sourceLabel) {
  const systemPrompt =
    'You are a marketing strategist who reverse-engineers real tactics from a real transcript, then teaches someone else ' +
    'to do it themselves. Ground every "whatTheyDid" entry in something ACTUALLY said or demonstrated in the transcript — ' +
    'never invent a tactic that isn\u2019t evidenced there. When you reference the transcript, paraphrase in your own words ' +
    'rather than quoting more than a short phrase (under 12 words), since this may be copyrighted material. ' +
    'Then separate the MECHANIC (the real, generic, transferable technique — e.g. "pattern-interrupt hook in the first ' +
    '5 seconds," "tiered urgency in the CTA," "problem-agitate-solve structure") from the PROPRIETARY SPECIFICS (their ' +
    'exact brand, product name, exact wording, exact offer) — "replicableMechanic" and the playbook must be built on the ' +
    'mechanic, generalized for someone in a different niche/business, never a copy of their specific brand or claims. ' +
    'Respond with STRICT JSON only, no markdown fences, matching exactly:\n\n' +
    '{"whatTheyDid":[{"tactic":string,"howTheyDidIt":string,"whyItWorks":string}],\n' +
    '"replicableMechanic":string,\n' +
    '"adaptationNotes":[string,string,string],\n' +
    '"playbook":{"title":string,"objective":string,"prerequisites":[string,string],' +
    '"steps":[{"stepNumber":number,"action":string,"details":string,"estimatedTime":string}],' +
    '"successMetrics":[string,string],"commonPitfalls":[string,string]}}\n\n' +
    'Identify 3-5 distinct tactics in "whatTheyDid". The playbook should have 5-9 concrete, sequential, executable steps ' +
    '— specific enough that someone could actually start doing step 1 today, not vague advice like "create good content."';

  const userPrompt =
    'SOURCE: ' + sourceLabel + '\n\n' +
    'TRANSCRIPT (may be truncated):\n' + transcriptText.slice(0, 8000) + '\n\n' +
    'Produce the JSON described in your instructions, grounded only in what this transcript actually shows.';

  const result = await competitorCore.callAi(provider, apiKey, model, systemPrompt, userPrompt, ['whatTheyDid', 'replicableMechanic', 'playbook']);
  if (!Array.isArray(result.whatTheyDid)) result.whatTheyDid = [];
  if (!Array.isArray(result.adaptationNotes)) result.adaptationNotes = [];
  if (!result.playbook) result.playbook = { steps: [] };
  if (!Array.isArray(result.playbook.steps)) result.playbook.steps = [];
  if (!Array.isArray(result.playbook.prerequisites)) result.playbook.prerequisites = [];
  if (!Array.isArray(result.playbook.successMetrics)) result.playbook.successMetrics = [];
  if (!Array.isArray(result.playbook.commonPitfalls)) result.playbook.commonPitfalls = [];
  return result;
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
  fetchVideoTitle: fetchVideoTitle
};
