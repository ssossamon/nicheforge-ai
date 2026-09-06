// NicheForge AI — history.js (v1.3)
//
// Every successful scan is saved (see _shared/scan-core.js saveToHistory).
// This endpoint lets the app list a person's past scans, reopen one in
// full, or delete it. No AI or YouTube calls happen here — it's a pure
// read/write against the nforge-history Blobs store.

const { getStore, connectLambda } = require('@netlify/blobs');
const http = require('./_shared/http');

const MAX_LIST = 100;

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
  if (!http.validEmail(email)) {
    return http.fail(400, 'missing_email', 'A valid email is required.');
  }

  let store;
  try {
    store = getStore('nforge-history', { consistency: 'strong' });
  } catch (e) {
    return http.fail(500, 'storage_unavailable', 'History storage is not available right now: ' + e.message);
  }

  if (action === 'list') {
    try {
      const listing = await store.list({ prefix: email + '::' });
      const summaries = [];
      for (const item of listing.blobs) {
        const rec = await store.get(item.key, { type: 'json' });
        if (rec) {
          summaries.push({ id: rec.id, query: rec.query, opportunityScore: rec.opportunityScore, avgViews: rec.avgViews, timestamp: rec.timestamp });
        }
      }
      summaries.sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
      return http.json(200, { success: true, history: summaries.slice(0, MAX_LIST) });
    } catch (e) {
      return http.fail(500, 'history_list_failed', 'Could not load history: ' + e.message);
    }
  }

  if (action === 'get') {
    const id = String(payload.id || '');
    if (!id || id.indexOf(email + '::') !== 0) {
      return http.fail(400, 'invalid_id', 'That history entry does not belong to this email.');
    }
    try {
      const rec = await store.get(id, { type: 'json' });
      if (!rec) return http.fail(404, 'not_found', 'That history entry no longer exists.');
      return http.json(200, { success: true, entry: rec });
    } catch (e) {
      return http.fail(500, 'history_get_failed', 'Could not load that entry: ' + e.message);
    }
  }

  if (action === 'delete') {
    const id = String(payload.id || '');
    if (!id || id.indexOf(email + '::') !== 0) {
      return http.fail(400, 'invalid_id', 'That history entry does not belong to this email.');
    }
    try {
      await store.delete(id);
      return http.json(200, { success: true });
    } catch (e) {
      return http.fail(500, 'history_delete_failed', 'Could not delete that entry: ' + e.message);
    }
  }

  return http.fail(400, 'unknown_action', 'Unknown action: ' + action);
};
