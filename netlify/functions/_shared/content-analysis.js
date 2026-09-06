// NicheForge AI — content-analysis.js (v1.4)
//
// Shared helpers for analyzing a pasted YouTube video URL, channel URL, or
// raw transcript/script text. Everything here either pulls real data from
// YouTube (video stats, channel stats, real captions) or clearly labels
// what it returns as an AI estimate — same honesty rules as scan-core.js.

const core = require('./scan-core');

// ===========================================================================
// Input detection
// ===========================================================================

function detectInputType(raw) {
  const input = String(raw || '').trim();
  if (!input) return { type: 'empty' };

  const videoMatch = input.match(
    /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  if (videoMatch) {
    return { type: 'video', videoId: videoMatch[1] };
  }

  const channelIdMatch = input.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/);
  if (channelIdMatch) {
    return { type: 'channel', channelId: channelIdMatch[1] };
  }

  const handleMatch = input.match(/youtube\.com\/@([A-Za-z0-9_.-]+)/);
  if (handleMatch) {
    return { type: 'channel', handle: handleMatch[1] };
  }

  const userMatch = input.match(/youtube\.com\/user\/([A-Za-z0-9_-]+)/);
  if (userMatch) {
    return { type: 'channel', username: userMatch[1] };
  }

  const customMatch = input.match(/youtube\.com\/c\/([A-Za-z0-9_-]+)/);
  if (customMatch) {
    return { type: 'channel', customName: customMatch[1] };
  }

  // Looks like a bare @handle with no URL wrapper.
  const bareHandleMatch = input.match(/^@([A-Za-z0-9_.-]+)$/);
  if (bareHandleMatch) {
    return { type: 'channel', handle: bareHandleMatch[1] };
  }

  // A bare 11-character YouTube video ID.
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) {
    return { type: 'video', videoId: input };
  }

  // Anything else — if it contains no youtube.com/youtu.be at all and has
  // some real length to it, treat it as pasted transcript/script text.
  if (input.length > 40 && !/youtube\.com|youtu\.be/.test(input)) {
    return { type: 'transcript', text: input };
  }

  return { type: 'unrecognized' };
}

// ===========================================================================
// Channel resolution — turn any of the URL formats above into a channelId
// ===========================================================================

async function resolveChannelId(detected, ytKey) {
  if (detected.channelId) return detected.channelId;

  if (detected.handle) {
    const res = await core.fetchJson(
      core.YT_BASE + '/channels?part=id&forHandle=' + encodeURIComponent(detected.handle) + '&key=' + ytKey
    );
    const item = res.data && res.data.items && res.data.items[0];
    if (item) return item.id;
  }

  if (detected.username) {
    const res = await core.fetchJson(
      core.YT_BASE + '/channels?part=id&forUsername=' + encodeURIComponent(detected.username) + '&key=' + ytKey
    );
    const item = res.data && res.data.items && res.data.items[0];
    if (item) return item.id;
  }

  // Legacy /c/ custom URLs have no direct API lookup — fall back to a
  // real search and take the top channel result whose custom name/title
  // plausibly matches, rather than guessing.
  const nameToSearch = detected.customName || detected.handle || detected.username;
  if (nameToSearch) {
    const res = await core.fetchJson(
      core.YT_BASE + '/search?part=snippet&type=channel&maxResults=1&q=' + encodeURIComponent(nameToSearch) + '&key=' + ytKey
    );
    const item = res.data && res.data.items && res.data.items[0];
    if (item && item.snippet) return item.snippet.channelId;
  }

  return null;
}

// ===========================================================================
// Real channel evidence — shared by channel-breakdown.js and the "channel
// URL" branch of analyze-content.js so the fetching logic lives in one place.
// ===========================================================================

async function gatherChannelEvidence(channelId, ytKey, ytKeySource) {
  const chRes = await core.fetchJson(
    core.YT_BASE + '/channels?part=snippet,statistics,contentDetails&id=' + encodeURIComponent(channelId) + '&key=' + ytKey
  );
  if (chRes.status < 200 || chRes.status >= 300) {
    const err = new Error('Could not look up that channel (HTTP ' + chRes.status + ').');
    err.statusCode = 502;
    err.code = 'youtube_channel_lookup_failed';
    throw err;
  }
  const chItem = (chRes.data.items || [])[0];
  if (!chItem) {
    const err = new Error('YouTube has no channel with that ID.');
    err.statusCode = 404;
    err.code = 'channel_not_found';
    throw err;
  }
  const uploadsPlaylistId = chItem.contentDetails && chItem.contentDetails.relatedPlaylists && chItem.contentDetails.relatedPlaylists.uploads;

  let recentVideos = [];
  if (uploadsPlaylistId) {
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

  let uploadsPerWeek = null;
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

  const subscriberCount = chItem.statistics && chItem.statistics.hiddenSubscriberCount !== true
    ? parseInt(chItem.statistics.subscriberCount || '0', 10)
    : null;

  // ---- Transparent, deterministic Channel Health Score (0-100) ----------
  // Rewards a healthy upload cadence (1-7/week), a trend of recent videos
  // out-earning older ones in the sample, and views relative to sub count.
  let cadencePoints = 0;
  if (uploadsPerWeek !== null) {
    cadencePoints = uploadsPerWeek >= 1 && uploadsPerWeek <= 7 ? 35 : Math.max(0, 35 - Math.abs(uploadsPerWeek - 4) * 5);
  }
  let trendPoints = 15;
  if (recentVideos.length >= 6) {
    const half = Math.floor(recentVideos.length / 2);
    const newerAvg = average(recentVideos.slice(0, half).map(function (v) { return v.views; }));
    const olderAvg = average(recentVideos.slice(half).map(function (v) { return v.views; }));
    if (olderAvg > 0) {
      const ratio = newerAvg / olderAvg;
      trendPoints = Math.max(0, Math.min(30, 15 + (ratio - 1) * 15));
    }
  }
  let viewToSubPoints = 15;
  if (subscriberCount && subscriberCount > 0 && recentVideos.length > 0) {
    const avgRecentViews = average(recentVideos.map(function (v) { return v.views; }));
    const ratio = avgRecentViews / subscriberCount;
    viewToSubPoints = Math.max(0, Math.min(35, ratio * 100));
  }
  const channelHealthScore = Math.max(0, Math.min(100, Math.round(cadencePoints + trendPoints + viewToSubPoints)));
  const autocompleteSuggestions = await core.gatherAutocompleteSuggestions(chItem.snippet.title);

  return {
    id: channelId,
    title: chItem.snippet.title,
    description: (chItem.snippet.description || '').slice(0, 500),
    subscriberCount: subscriberCount,
    totalVideoCount: parseInt((chItem.statistics && chItem.statistics.videoCount) || '0', 10),
    totalViewCount: parseInt((chItem.statistics && chItem.statistics.viewCount) || '0', 10),
    sampledRecentUploads: recentVideos.length,
    uploadsPerWeekRecent: uploadsPerWeek,
    shortsShareRecent: shortsShare,
    topVideosInSample: topVideos,
    recentVideos: recentVideos,
    channelHealthScore: channelHealthScore,
    channelHealthFormula: 'cadencePoints(0-35, best at 1-7 uploads/week) + trendPoints(0-30, newer vs older half of sample) + viewToSubPoints(0-35, avg recent views / subscriber count). Deterministic, computed from real YouTube data.',
    autocompleteSuggestions: autocompleteSuggestions,
    dataSource: 'YouTube Data API v3 (channels.list, playlistItems.list, videos.list) — most recent uploads only, real numbers, no estimates.',
    youtubeKeySource: ytKeySource
  };
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
}

function isLikelyShortDuration(dur) {
  if (!dur) return false;
  const match = dur.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return false;
  const minutes = parseInt(match[1] || '0', 10);
  const seconds = parseInt(match[2] || '0', 10);
  return minutes === 0 && seconds > 0 && seconds <= 60;
}

// ===========================================================================
// Real video evidence — stats, channel context, comments, transcript
// ===========================================================================

async function gatherVideoEvidence(videoId, ytKey, ytKeySource) {
  const vRes = await core.fetchJson(
    core.YT_BASE + '/videos?part=snippet,statistics,contentDetails&id=' + videoId + '&key=' + ytKey
  );
  if (vRes.status < 200 || vRes.status >= 300) {
    const err = new Error('Could not look up that video (HTTP ' + vRes.status + ').');
    err.statusCode = 502;
    err.code = 'youtube_video_lookup_failed';
    throw err;
  }
  const item = (vRes.data.items || [])[0];
  if (!item) {
    const err = new Error('YouTube has no video with that ID — it may be private, deleted, or the URL is wrong.');
    err.statusCode = 404;
    err.code = 'video_not_found';
    throw err;
  }

  const views = parseInt((item.statistics && item.statistics.viewCount) || '0', 10);
  const likes = parseInt((item.statistics && item.statistics.likeCount) || '0', 10);
  const commentCount = parseInt((item.statistics && item.statistics.commentCount) || '0', 10);
  const publishedAt = item.snippet.publishedAt;
  const daysSincePublished = Math.max(1, Math.floor((Date.now() - new Date(publishedAt).getTime()) / 86400000));
  const isShort = isLikelyShortDuration(item.contentDetails && item.contentDetails.duration);

  // Channel context — how does this video compare to the channel's own
  // recent typical performance?
  let channelAvgRecentViews = null;
  let channelEvidence = null;
  try {
    channelEvidence = await gatherChannelEvidence(item.snippet.channelId, ytKey, ytKeySource);
    if (channelEvidence.recentVideos && channelEvidence.recentVideos.length > 0) {
      channelAvgRecentViews = average(channelEvidence.recentVideos.map(function (v) { return v.views; }));
    }
  } catch (e) {
    // Non-fatal — the video's own stats stand on their own without channel context.
  }

  const topComments = await gatherTopCommentsForVideo(videoId, ytKey);
  const transcript = await fetchTranscriptWithTimestamps(videoId);
  const autocompleteSuggestions = await core.gatherAutocompleteSuggestions(item.snippet.title);

  // ---- Transparent, deterministic Video Performance Score (0-100) -------
  const viewVelocity = views / daysSincePublished;
  const velocityPoints = Math.min(45, Math.log10(viewVelocity + 1) * 15);
  let relativePoints = 15;
  if (channelAvgRecentViews && channelAvgRecentViews > 0) {
    const multiple = views / channelAvgRecentViews;
    relativePoints = Math.max(0, Math.min(35, 15 + (multiple - 1) * 10));
  }
  const engagementRate = views > 0 ? (likes + commentCount) / views : 0;
  const engagementPoints = Math.max(0, Math.min(20, engagementRate * 1000));
  const videoPerformanceScore = Math.max(0, Math.min(100, Math.round(velocityPoints + relativePoints + engagementPoints)));

  return {
    videoId: videoId,
    title: item.snippet.title,
    description: (item.snippet.description || '').slice(0, 1000),
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    publishedAt: publishedAt,
    daysSincePublished: daysSincePublished,
    views: views,
    likes: likes,
    commentCount: commentCount,
    isShort: isShort,
    channelAvgRecentViews: channelAvgRecentViews === null ? null : Math.round(channelAvgRecentViews),
    channelContext: channelEvidence
      ? { title: channelEvidence.title, subscriberCount: channelEvidence.subscriberCount, uploadsPerWeekRecent: channelEvidence.uploadsPerWeekRecent }
      : null,
    topComments: topComments,
    transcript: transcript,
    autocompleteSuggestions: autocompleteSuggestions,
    videoPerformanceScore: videoPerformanceScore,
    videoPerformanceFormula: 'velocityPoints(0-45, views/day since publish) + relativePoints(0-35, this video vs channel\u2019s recent average) + engagementPoints(0-20, (likes+comments)/views). Deterministic, computed from real YouTube data.',
    dataSource: 'YouTube Data API v3 (videos.list, commentThreads.list) plus the channel\u2019s recent uploads for comparison' + (transcript ? ' and YouTube\u2019s public caption track.' : '.'),
    youtubeKeySource: ytKeySource
  };
}

async function gatherTopCommentsForVideo(videoId, ytKey) {
  try {
    const res = await core.fetchJson(
      core.YT_BASE + '/commentThreads?part=snippet&order=relevance&maxResults=8&videoId=' + videoId + '&key=' + ytKey
    );
    if (res.status < 200 || res.status >= 300) return [];
    return (res.data.items || [])
      .map(function (item) {
        const top = item.snippet && item.snippet.topLevelComment && item.snippet.topLevelComment.snippet;
        if (!top) return null;
        return { text: String(top.textDisplay || '').replace(/<[^>]+>/g, '').slice(0, 240), likeCount: top.likeCount || 0 };
      })
      .filter(Boolean)
      .sort(function (a, b) { return b.likeCount - a.likeCount; })
      .slice(0, 8);
  } catch (e) {
    return [];
  }
}

// ===========================================================================
// Real transcript fetching — YouTube's public timedtext endpoint. No API
// key or OAuth needed; this is the same public caption track viewers see.
// Not every video has captions, so this can legitimately return null.
// ===========================================================================

async function fetchTranscript(videoId) {
  try {
    const listRes = await fetch('https://www.youtube.com/api/timedtext?type=list&v=' + videoId);
    const listXml = await listRes.text();
    if (!listXml || listXml.indexOf('<track') === -1) return null;

    const langMatch = listXml.match(/lang_code="([^"]+)"/);
    const lang = langMatch ? langMatch[1] : 'en';

    const trackRes = await fetch('https://www.youtube.com/api/timedtext?v=' + videoId + '&lang=' + encodeURIComponent(lang));
    const trackXml = await trackRes.text();
    if (!trackXml) return null;

    const textMatches = trackXml.match(/<text[^>]*>([\s\S]*?)<\/text>/g);
    if (!textMatches || textMatches.length === 0) return null;

    const plain = textMatches
      .map(function (chunk) {
        return chunk
          .replace(/<[^>]+>/g, '')
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&gt;/g, '>')
          .replace(/&lt;/g, '<');
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return plain.length > 0 ? plain.slice(0, 8000) : null;
  } catch (e) {
    return null;
  }
}

// Same public caption source as fetchTranscript, but keeps each line's real
// start/duration instead of flattening to plain text — needed for real
// timestamped chapters rather than an AI-guessed outline.
async function fetchTranscriptWithTimestamps(videoId) {
  try {
    const listRes = await fetch('https://www.youtube.com/api/timedtext?type=list&v=' + videoId);
    const listXml = await listRes.text();
    if (!listXml || listXml.indexOf('<track') === -1) return null;

    const langMatch = listXml.match(/lang_code="([^"]+)"/);
    const lang = langMatch ? langMatch[1] : 'en';

    const trackRes = await fetch('https://www.youtube.com/api/timedtext?v=' + videoId + '&lang=' + encodeURIComponent(lang));
    const trackXml = await trackRes.text();
    if (!trackXml) return null;

    const textTagMatches = trackXml.match(/<text[^>]*>[\s\S]*?<\/text>/g);
    if (!textTagMatches || textTagMatches.length === 0) return null;

    function decodeEntities(s) {
      return s
        .replace(/<[^>]+>/g, '')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const segments = textTagMatches
      .map(function (tag) {
        const startMatch = tag.match(/start="([\d.]+)"/);
        const durMatch = tag.match(/dur="([\d.]+)"/);
        const innerMatch = tag.match(/<text[^>]*>([\s\S]*?)<\/text>/);
        const text = innerMatch ? decodeEntities(innerMatch[1]) : '';
        return {
          start: startMatch ? parseFloat(startMatch[1]) : 0,
          dur: durMatch ? parseFloat(durMatch[1]) : 0,
          text: text
        };
      })
      .filter(function (seg) { return seg.text.length > 0; });

    if (segments.length === 0) return null;

    const fullText = segments.map(function (s) { return s.text; }).join(' ').replace(/\s+/g, ' ').trim();

    return { segments: segments, fullText: fullText.slice(0, 10000) };
  } catch (e) {
    return null;
  }
}

function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
}

// ===========================================================================
// Real-timestamp marker system, shared by anything that reverse-engineers a
// transcript (Transcript Playbook, and video/transcript analysis in
// analyze-content.js). Groups real caption segments into windows tagged
// with a real [T=M:SS] marker so the AI can cite one rather than invent a
// time; whatever it returns is then snapped to the nearest real marker
// before display, so a shown timestamp is always grounded in real data.
// ===========================================================================

const MARKER_WINDOW_SECONDS = 20;
const MAX_MARKERS = 180;

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
    .map(function (w) { return '[T=' + formatTimestamp(w.start) + '] ' + w.text; })
    .join('\n');

  return { markedText: marked.slice(0, 12000), windowStarts: capped.map(function (w) { return w.start; }) };
}

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
    display: formatTimestamp(realSeconds),
    seconds: realSeconds,
    url: videoId ? 'https://www.youtube.com/watch?v=' + videoId + '&t=' + Math.floor(realSeconds) + 's' : null
  };
}

function noTimestamp() {
  return { display: null, seconds: null, url: null };
}

module.exports = {
  detectInputType: detectInputType,
  resolveChannelId: resolveChannelId,
  gatherChannelEvidence: gatherChannelEvidence,
  gatherVideoEvidence: gatherVideoEvidence,
  fetchTranscriptWithTimestamps: fetchTranscriptWithTimestamps,
  formatTimestamp: formatTimestamp,
  buildMarkedTranscript: buildMarkedTranscript,
  snapTimestamp: snapTimestamp,
  withRealTimestamp: withRealTimestamp,
  noTimestamp: noTimestamp,
  fetchTranscript: fetchTranscript
};
