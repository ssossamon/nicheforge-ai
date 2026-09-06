// NicheForge AI — verify-license.js (v1.0)

const { getStore } = require('@netlify/blobs');
const http = require('./_shared/http');
const license = require('./_shared/license');

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

  const key = String(payload.licenseKey || '').trim();
  if (!key) return http.fail(400, 'missing_key', 'No license key was provided.');

  if (license.isOwnerKey(key)) {
    return http.json(200, { success: true, valid: true, tier: 'ADM', tierLabel: license.TIER_LABELS.ADM, isOwner: true });
  }

  const parsed = license.parseLicenseKey(key);
  if (!parsed) {
    return http.json(200, { success: true, valid: false, reason: 'That key does not match the NicheForge AI format.' });
  }

  try {
    const licensesStore = getStore('nforge-licenses');
    const rec = await licensesStore.get(parsed.raw, { type: 'json' });
    if (!rec) {
      return http.json(200, { success: true, valid: false, reason: 'Key not found. Double-check it was typed correctly.' });
    }
    if (rec.status !== 'active') {
      return http.json(200, { success: true, valid: false, reason: 'This key is marked "' + rec.status + '", not active.' });
    }
    return http.json(200, {
      success: true,
      valid: true,
      tier: rec.tier,
      tierLabel: license.TIER_LABELS[rec.tier] || rec.tier,
      isOwner: false
    });
  } catch (e) {
    return http.fail(500, 'storage_unavailable', 'Could not check the license store right now: ' + e.message);
  }
};
