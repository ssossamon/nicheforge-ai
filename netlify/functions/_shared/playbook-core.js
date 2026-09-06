// NicheForge AI — playbook-core.js (v2.0)
//
// Transcript Intelligence + Playbook. Real segment timestamps (from
// content-analysis.js's fetchTranscriptWithTimestamps) are embedded as
// markers in the prompt; the AI must cite one of those markers rather than
// invent a time, and every timestamp it returns is then snapped to the
// nearest REAL segment before being shown — so a displayed "12:34" always
// corresponds to an actual moment in the actual transcript, never a guess.

const competitorCore = require('./competitor-core');
const contentAnalysis = require('./content-analysis');

const MARKER_WINDOW_SECONDS = 20; // group captions into ~20s windows for markers
const MAX_MARKERS = 180; // keep the marked-up transcript a reasonable prompt size

// ===========================================================================
// Build a transcript with visible real-time markers the AI can cite.
// ===========================================================================

function buildMarkedTranscript(segments) {
  const windows = [];
  let currentWindowStart = 0;
  let currentWindowText = [];

  segments.forEach(function (seg) {
    if (seg.start >= currentWindowStart + MARKER_WINDOW_SECONDS) {
      if (currentWindowText.length > 0) {
        windows.push({ start: currentWindowStart, text: currentWindowText.join(' ') });
      }
      currentWindowStart = Math.floor(seg.start / MARKER_WINDOW_SECONDS) * MARKER_WINDOW_SECONDS;
      currentWindowText = [];
    }
    currentWindowText.push(seg.text);
  });
  if (currentWindowText.length > 0) {
    windows.push({ start: currentWindowStart, text: currentWindowText.join(' ') });
  }

  const capped = windows.slice(0, MAX_MARKERS);
  const marked = capped
    .map(function (w) { return '[T=' + contentAnalysis.formatTimestamp(w.start) + '] ' + w.text; })
    .join('\n');

  return { markedText: marked.slice(0, 12000), windowStarts: capped.map(function (w) { return w.start; }) };
}

// Snap an AI-returned timestamp string (which might be slightly off, or in
// the wrong format) to the nearest REAL marker time actually present in the
// transcript, so every timestamp shown to the user is grounded in real data.
function snapTimestamp(rawTimestamp, windowStarts) {
  if (!rawTimestamp || !windowStarts || windowStarts.length === 0) return null;
  const match = String(rawTimestamp).match(/(?:(\d+):)?(\d+):(\d+)/);
  if (!match) return null;
  const h = match[1] ? parseInt(match[1], 10) : 0;
  const m = parseInt(match[2], 10);
  const s = parseInt(match[3], 10);
  const totalSeconds = h * 3600 + m * 60 + s;

  let nearest = windowStarts[0];
  let smallestDiff = Math.abs(windowStarts[0] - totalSeconds);
  for (const w of windowStarts) {
    const diff = Math.abs(w - totalSeconds);
    if (diff < smallestDiff) {
      smallestDiff = diff;
      nearest = w;
    }
  }
  return nearest;
}

function withRealTimestamp(rawTimestamp, windowStarts, videoId) {
  const realSeconds = snapTimestamp(rawTimestamp, windowStarts);
  if (realSeconds === null) return { display: null, seconds: null, url: null };
  return {
    display: contentAnalysis.formatTimestamp(realSeconds),
    seconds: realSeconds,
    url: videoId ? 'https://www.youtube.com/watch?v=' + videoId + '&t=' + Math.floor(realSeconds) + 's' : null
  };
}

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
    const built = buildMarkedTranscript(transcriptInput.segments);
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

  // ---- Snap every AI-cited timestamp to a real marker (or null it out) ----
  if (hasRealTimestamps) {
    result.chapters = result.chapters
      .filter(function (c) { return c && typeof c.title === 'string'; })
      .map(function (c) {
        return { time: withRealTimestamp(c.timestamp, windowStarts, videoId), title: c.title, description: c.description || '' };
      });
    result.keyClaims = result.keyClaims
      .filter(function (c) { return c && typeof c.claim === 'string'; })
      .map(function (c) { return { claim: c.claim, time: withRealTimestamp(c.timestamp, windowStarts, videoId) }; });
    result.painPoints = result.painPoints
      .filter(function (p) { return p && typeof p.painPoint === 'string'; })
      .map(function (p) {
        return {
          painPoint: p.painPoint,
          severity: ['low', 'medium', 'high'].indexOf(p.severity) !== -1 ? p.severity : 'medium',
          audienceSegment: p.audienceSegment || '',
          time: withRealTimestamp(p.timestamp, windowStarts, videoId)
        };
      });
    if (result.hookAnalysis) {
      result.hookAnalysis.time = withRealTimestamp(result.hookAnalysis.timestamp, windowStarts, videoId);
    }
  } else {
    // No real timing data (pasted transcript) — strip any timestamp the AI
    // may have hallucinated anyway rather than showing a fake time.
    result.chapters = result.chapters
      .filter(function (c) { return c && typeof c.title === 'string'; })
      .map(function (c) { return { time: { display: null, seconds: null, url: null }, title: c.title, description: c.description || '' }; });
    result.keyClaims = result.keyClaims
      .filter(function (c) { return c && typeof c.claim === 'string'; })
      .map(function (c) { return { claim: c.claim, time: { display: null, seconds: null, url: null } }; });
    result.painPoints = result.painPoints
      .filter(function (p) { return p && typeof p.painPoint === 'string'; })
      .map(function (p) {
        return {
          painPoint: p.painPoint,
          severity: ['low', 'medium', 'high'].indexOf(p.severity) !== -1 ? p.severity : 'medium',
          audienceSegment: p.audienceSegment || '',
          time: { display: null, seconds: null, url: null }
        };
      });
    if (result.hookAnalysis) result.hookAnalysis.time = { display: null, seconds: null, url: null };
  }

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
