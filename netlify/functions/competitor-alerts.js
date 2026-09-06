// NicheForge AI — competitor-alerts.js (v1.0)

const { getStore, connectLambda } = require('@netlify/blobs');
const http = require('./_shared/http');
const core = require('./_shared/competitor-core');

exports.handler = async function (event) {
  try {
    return await handleRequest(event);
  } catch (e) {
    return http.fail(500, 'unexpected_error', 'Something went wrong: ' + e.message);
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

  const action = String(payload.action || 'list');
  const email = String(payload.email || '').trim().toLowerCase();
  if (!http.validEmail(email)) {
    return http.fail(400, 'missing_email', 'A valid email is required.');
  }

  let store;
  try {
    store = getStore('nforge-competitor-alerts');
  } catch (e) {
    return http.fail(500, 'storage_unavailable', 'Storage is not available right now: ' + e.message);
  }

  if (action === 'list') {
    try {
      const rawPrefix = email + '::';
      const listing = await store.list({ prefix: rawPrefix });
      const alerts = [];
      for (const item of listing.blobs) {
        const sepIndex = item.key.indexOf('::');
        if (sepIndex === -1) continue;
        const encodedId = http.safeKey(item.key.slice(0, sepIndex)) + '::' + item.key.slice(sepIndex + 2);
        const rec = await store.get(encodedId, { type: 'json' });
        if (rec) alerts.push(rec);
      }
      alerts.sort(function (a, b) { return new Date(b.detectedAt) - new Date(a.detectedAt); });
      return http.json(200, { success: true, alerts: alerts.slice(0, 100) });
    } catch (e) {
      return http.fail(500, 'alerts_list_failed', 'Could not load alerts: ' + e.message);
    }
  }

  if (action === 'markRead') {
    const id = String(payload.id || '');
    if (!id || id.indexOf(http.safeKey(email) + '::') !== 0) {
      return http.fail(400, 'invalid_id', 'That alert does not belong to this email.');
    }
    try {
      const rec = await store.get(id, { type: 'json' });
      if (!rec) return http.fail(404, 'not_found', 'That alert no longer exists.');
      rec.isRead = true;
      await store.setJSON(id, rec);
      return http.json(200, { success: true });
    } catch (e) {
      return http.fail(500, 'alert_update_failed', 'Could not update that alert: ' + e.message);
    }
  }

  if (action === 'explainChange') {
    const id = String(payload.id || '');
    const aiProvider = String(payload.aiProvider || '').trim().toLowerCase();
    const aiApiKey = String(payload.aiApiKey || '').trim();
    const aiModel = payload.aiModel ? String(payload.aiModel).trim() : '';
    if (!id || id.indexOf(http.safeKey(email) + '::') !== 0) {
      return http.fail(400, 'invalid_id', 'That alert does not belong to this email.');
    }
    if (!aiProvider || !aiApiKey) {
      return http.fail(400, 'missing_ai_key', 'Add your AI provider and key in Settings first.');
    }
    let rec;
    try {
      rec = await store.get(id, { type: 'json' });
      if (!rec) return http.fail(404, 'not_found', 'That alert no longer exists.');
    } catch (e) {
      return http.fail(500, 'alert_get_failed', 'Could not load that alert: ' + e.message);
    }
    if (rec.explanation) {
      return http.json(200, { success: true, explanation: rec.explanation });
    }
    try {
      const explanation = await core.summarizeChange(aiProvider, aiApiKey, aiModel, rec.competitorName, rec.oldText, rec.newText);
      rec.explanation = explanation;
      try { await store.setJSON(id, rec); } catch (e) { /* non-fatal cache write */ }
      return http.json(200, { success: true, explanation: explanation });
    } catch (e) {
      return http.fail(e.statusCode || 502, e.code || 'ai_call_failed', e.message, e.whatToDoNext);
    }
  }

  return http.fail(400, 'unknown_action', 'Unknown action: ' + action);
}
