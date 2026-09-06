// NicheForge AI — watchlist.js (v1.3)
//
// Lets a person star a topic to be watched. The actual re-checking happens
// in the scheduled watchlist-recheck.js function; this endpoint only
// manages the watchlist itself (add/remove/list) and returns whatever the
// last recheck found for each entry.

const { getStore, connectLambda } = require('@netlify/blobs');
const http = require('./_shared/http');

exports.handler = async function (event) {
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

  const action = String(payload.action || 'list');
  const email = String(payload.email || '').trim().toLowerCase();
  const query = payload.query ? String(payload.query).trim() : '';
  if (!http.validEmail(email)) {
    return http.fail(400, 'missing_email', 'A valid email is required.');
  }

  let store;
  try {
    store = getStore('nforge-watchlist', { consistency: 'strong' });
  } catch (e) {
    return http.fail(500, 'storage_unavailable', 'Watchlist storage is not available: ' + e.message);
  }

  const key = email + '::' + query.toLowerCase();

  if (action === 'add') {
    if (!query) return http.fail(400, 'missing_query', 'No topic was provided.');
    try {
      const existing = await store.get(key, { type: 'json' });
      await store.setJSON(key, {
        email: email,
        query: query,
        addedAt: (existing && existing.addedAt) || new Date().toISOString(),
        lastKnownScore: (existing && existing.lastKnownScore) || null,
        lastCheckedAt: (existing && existing.lastCheckedAt) || null,
        flagged: (existing && existing.flagged) || false,
        flagReason: (existing && existing.flagReason) || null
      });
      return http.json(200, { success: true });
    } catch (e) {
      return http.fail(500, 'watchlist_add_failed', 'Could not add to watchlist: ' + e.message);
    }
  }

  if (action === 'remove') {
    if (!query) return http.fail(400, 'missing_query', 'No topic was provided.');
    try {
      await store.delete(key);
      return http.json(200, { success: true });
    } catch (e) {
      return http.fail(500, 'watchlist_remove_failed', 'Could not remove from watchlist: ' + e.message);
    }
  }

  if (action === 'acknowledge') {
    if (!query) return http.fail(400, 'missing_query', 'No topic was provided.');
    try {
      const rec = await store.get(key, { type: 'json' });
      if (rec) {
        rec.flagged = false;
        rec.flagReason = null;
        await store.setJSON(key, rec);
      }
      return http.json(200, { success: true });
    } catch (e) {
      return http.fail(500, 'watchlist_ack_failed', 'Could not update watchlist entry: ' + e.message);
    }
  }

  if (action === 'list') {
    try {
      const listing = await store.list({ prefix: email + '::' });
      const items = [];
      for (const item of listing.blobs) {
        const rec = await store.get(item.key, { type: 'json' });
        if (rec) items.push(rec);
      }
      items.sort(function (a, b) { return new Date(b.addedAt) - new Date(a.addedAt); });
      return http.json(200, { success: true, watchlist: items });
    } catch (e) {
      return http.fail(500, 'watchlist_list_failed', 'Could not load watchlist: ' + e.message);
    }
  }

  if (action === 'debug_raw') {
    try {
      const allListing = await store.list();
      const directGet = await store.get(key, { type: 'json' });
      return http.json(200, {
        success: true,
        debug: {
          expectedKey: key,
          directGetResult: directGet,
          allKeysInStore: allListing.blobs.map(function (b) { return b.key; }),
          prefixUsedForList: email + '::'
        }
      });
    } catch (e) {
      return http.fail(500, 'debug_failed', e.message);
    }
  }

  return http.fail(400, 'unknown_action', 'Unknown action: ' + action);
};
