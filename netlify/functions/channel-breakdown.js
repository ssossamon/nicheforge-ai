// NicheForge AI — channel-breakdown.js (v1.4)
//
// Pure real-data view of one channel. Thin wrapper around
// _shared/content-analysis.js's gatherChannelEvidence, which is also used
// by analyze-content.js's "channel URL" branch — one implementation, two
// entry points.

const http = require('./_shared/http');
const contentAnalysis = require('./_shared/content-analysis');

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

  const channelId = String(payload.channelId || '').trim();
  const clientYoutubeKey = payload.youtubeApiKey ? String(payload.youtubeApiKey).trim() : '';
  if (!channelId) {
    return http.fail(400, 'missing_channel_id', 'No channel ID was provided.');
  }

  const ytKey = clientYoutubeKey || process.env.YOUTUBE_API_KEY;
  const ytKeySource = clientYoutubeKey ? 'settings' : 'server';
  if (!ytKey) {
    return http.fail(500, 'youtube_key_not_configured', 'No YouTube Data API key is available.', 'Add your own key in Settings, or set YOUTUBE_API_KEY in Netlify.');
  }

  try {
    const channel = await contentAnalysis.gatherChannelEvidence(channelId, ytKey, ytKeySource);
    return http.json(200, { success: true, channel: channel });
  } catch (e) {
    return http.fail(
      e.statusCode || 502,
      e.code || 'channel_breakdown_failed',
      e.message || 'Could not build the channel breakdown right now.',
      e.whatToDoNext || 'Try again in a moment.'
    );
  }
};
