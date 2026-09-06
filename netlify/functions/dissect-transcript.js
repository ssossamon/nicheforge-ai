// NicheForge AI — dissect-transcript.js (v1.0)
//
// Reuses _shared/content-analysis.js's detectInputType/fetchTranscript
// (already proven for the "Analyze URL" tab) rather than re-detecting URLs
// from scratch. Same free-scan/license gating as every other endpoint.

const { getStore, connectLambda } = require('@netlify/blobs');
const http = require('./_shared/http');
const license = require('./_shared/license');
const contentAnalysis = require('./_shared/content-analysis');
const playbookCore = require('./_shared/playbook-core');

const FREE_SCAN_LIMIT = 3;

exports.handler = async function (event) {
  try {
    return await handleRequest(event);
  } catch (e) {
    return http.fail(500, 'unexpected_error', 'Something went wrong dissecting that transcript: ' + e.message);
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
  const input = String(payload.input || '').trim();
  const aiProvider = String(payload.aiProvider || '').trim().toLowerCase();
  const aiApiKey = String(payload.aiApiKey || '').trim();
  const aiModel = payload.aiModel ? String(payload.aiModel).trim() : '';

  if (!http.validEmail(email)) {
    return http.fail(400, 'missing_email', 'A valid email is required.');
  }
  if (!input) {
    return http.fail(400, 'missing_input', 'Paste a YouTube URL or a transcript.');
  }
  if (!aiProvider || !aiApiKey) {
    return http.fail(400, 'missing_ai_key', 'Choose an AI provider and paste your API key first.');
  }

  const detected = contentAnalysis.detectInputType(input);
  if (detected.type === 'empty' || detected.type === 'unrecognized') {
    return http.fail(
      400,
      'unrecognized_input',
      "That doesn't look like a YouTube URL or a transcript.",
      'Paste a full youtube.com/watch, youtu.be, or /shorts/ URL — or paste at least a few sentences of transcript text.'
    );
  }
  if (detected.type === 'channel') {
    return http.fail(400, 'channel_not_supported', 'Transcript Playbook needs one video or a pasted transcript, not a channel.', 'Use the "Analyze URL" tab for a channel-level breakdown instead.');
  }

  // ---- Usage gating — same free-scan quota as everything else -------------
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

  let transcriptInput;
  let sourceLabel;
  let videoTitle = null;
  let videoId = null;

  if (detected.type === 'video') {
    const fetched = await contentAnalysis.fetchTranscriptWithTimestamps(detected.videoId);
    if (!fetched) {
      return http.fail(
        404,
        'no_captions',
        'That video has no captions available, or they couldn\u2019t be fetched.',
        'Try a different video, or paste the transcript text directly instead.'
      );
    }
    transcriptInput = fetched;
    videoId = detected.videoId;
    videoTitle = await playbookCore.fetchVideoTitle(detected.videoId);
    sourceLabel = videoTitle ? 'YouTube video: "' + videoTitle + '"' : 'YouTube video ' + detected.videoId;
  } else {
    transcriptInput = detected.text;
    sourceLabel = 'Pasted transcript';
  }

  let result;
  try {
    result = await playbookCore.dissectTranscript(aiProvider, aiApiKey, aiModel, transcriptInput, sourceLabel, videoId);
  } catch (e) {
    return http.fail(e.statusCode || 502, e.code || 'ai_call_failed', e.message, e.whatToDoNext, e.rawResponse ? { _diagnostics: { rawAiResponse: e.rawResponse } } : undefined);
  }

  let playbookId = null;
  try {
    const store = getStore('nforge-playbooks');
    playbookId = http.safeKey(email) + '::' + Date.now() + '::' + Math.random().toString(36).slice(2, 8);
    await store.setJSON(playbookId, {
      id: playbookId,
      email: email,
      sourceLabel: sourceLabel,
      videoTitle: videoTitle,
      inputType: detected.type,
      result: result,
      createdAt: new Date().toISOString()
    });
  } catch (e) {
    playbookId = null;
  }

  try {
    if (!unlimited) {
      const usageRaw = await usageStore.get(http.safeKey(email), { type: 'json' });
      const usedCount = (usageRaw && usageRaw.count ? usageRaw.count : 0) + 1;
      await usageStore.setJSON(http.safeKey(email), { count: usedCount, lastScanAt: new Date().toISOString() });
    }
  } catch (e) {
    // non-fatal
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
    playbookId: playbookId,
    sourceLabel: sourceLabel,
    result: result,
    meta: { unlimited: unlimited, tier: tier, scansRemaining: scansRemaining, freeScanLimit: FREE_SCAN_LIMIT }
  });
}
