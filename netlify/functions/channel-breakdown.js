// NicheForge AI — channel-breakdown.js (v1.2)
//
// Pure real-data view of one channel: subscriber/video counts, upload
// frequency and Shorts/long-form split from its most recent uploads, and
// its top 5 videos by views within that sample. No AI call — this is a
// straight read of YouTube's own numbers, so no BYOK key is required.

const http = require('./_shared/http');
const core = require('./_shared/scan-core');

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
    // 1. Channel snippet + statistics + its uploads playlist ID
    const chRes = await core.fetchJson(
      core.YT_BASE + '/channels?part=snippet,statistics,contentDetails&id=' + encodeURIComponent(channelId) + '&key=' + ytKey
    );
    if (chRes.status < 200 || chRes.status >= 300) {
      return http.fail(502, 'youtube_channel_lookup_failed', 'Could not look up that channel (HTTP ' + chRes.status + ').', 'Try again in a moment.');
    }
    const chItem = (chRes.data.items || [])[0];
    if (!chItem) {
      return http.fail(404, 'channel_not_found', 'YouTube has no channel with that ID.');
    }
    const uploadsPlaylistId = chItem.contentDetails && chItem.contentDetails.relatedPlaylists && chItem.contentDetails.relatedPlaylists.uploads;

    var recentVideos = [];
    if (uploadsPlaylistId) {
      // 2. Most recent uploads from that playlist
      const plRes = await core.fetchJson(
        core.YT_BASE + '/playlistItems?part=contentDetails&maxResults=15&playlistId=' + uploadsPlaylistId + '&key=' + ytKey
      );
      if (plRes.status >= 200 && plRes.status < 300) {
        const videoIds = (plRes.data.items || [])
          .map(function (it) { return it.contentDetails && it.contentDetails.videoId; })
          .filter(Boolean);
        if (videoIds.length > 0) {
          const vidsRes = await core.fetchJson(
            core.YT_BASE + '/videos?part=snippet,statistics,contentDetails&id=' + videoIds.join(',') + '&key=' + ytKey
          );
          if (vidsRes.status >= 200 && vidsRes.status < 300) {
            recentVideos = (vidsRes.data.items || []).map(function (v) {
              return {
                title: v.snippet.title,
                publishedAt: v.snippet.publishedAt,
                views: parseInt((v.statistics && v.statistics.viewCount) || '0', 10),
                isShort: isLikelyShortDuration(v.contentDetails && v.contentDetails.duration)
              };
            });
          }
        }
      }
    }

    recentVideos.sort(function (a, b) { return new Date(b.publishedAt) - new Date(a.publishedAt); });

    var uploadsPerWeek = null;
    if (recentVideos.length >= 2) {
      const spanDays = Math.max(
        1,
        Math.floor((new Date(recentVideos[0].publishedAt) - new Date(recentVideos[recentVideos.length - 1].publishedAt)) / 86400000)
      );
      uploadsPerWeek = Number(((recentVideos.length / spanDays) * 7).toFixed(2));
    }

    const shortsCount = recentVideos.filter(function (v) { return v.isShort; }).length;
    const shortsShare = recentVideos.length > 0 ? Number((shortsCount / recentVideos.length).toFixed(2)) : null;

    const topVideos = recentVideos.slice().sort(function (a, b) { return b.views - a.views; }).slice(0, 5);

    return http.json(200, {
      success: true,
      channel: {
        id: channelId,
        title: chItem.snippet.title,
        subscriberCount: chItem.statistics && chItem.statistics.hiddenSubscriberCount !== true ? parseInt(chItem.statistics.subscriberCount || '0', 10) : null,
        totalVideoCount: parseInt((chItem.statistics && chItem.statistics.videoCount) || '0', 10),
        totalViewCount: parseInt((chItem.statistics && chItem.statistics.viewCount) || '0', 10),
        sampledRecentUploads: recentVideos.length,
        uploadsPerWeekRecent: uploadsPerWeek,
        shortsShareRecent: shortsShare,
        topVideosInSample: topVideos,
        dataSource: 'YouTube Data API v3 (channels.list, playlistItems.list, videos.list) — most recent uploads only, real numbers, no estimates.',
        youtubeKeySource: ytKeySource
      }
    });
  } catch (e) {
    return http.fail(502, 'channel_breakdown_failed', 'Could not build the channel breakdown right now: ' + e.message, 'Try again in a moment.');
  }
};

function isLikelyShortDuration(dur) {
  if (!dur) return false;
  const match = dur.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return false;
  const minutes = parseInt(match[1] || '0', 10);
  const seconds = parseInt(match[2] || '0', 10);
  return minutes === 0 && seconds > 0 && seconds <= 60;
}
