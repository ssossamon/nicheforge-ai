// NicheForge AI — capture-lead.js (v1.0)
// Adds a visitor's email to ConvertKit (v4 API) and always keeps a backup
// copy in Netlify Blobs so no lead is ever lost even if ConvertKit sync
// fails (missing key, rate limit, etc.) — the user's free scan is never
// blocked on ESP sync succeeding.

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

  const email = String(payload.email || '').trim().toLowerCase();
  const name = payload.name ? String(payload.name).trim() : '';
  const source = payload.source ? String(payload.source).trim() : 'nicheforge-app';

  if (!http.validEmail(email)) {
    return http.fail(400, 'invalid_email', 'That does not look like a valid email address.');
  }

  let espSynced = false;
  let espError = null;

  const kitApiKey = process.env.CONVERTKIT_API_KEY;
  if (kitApiKey) {
    try {
      const body = { email_address: email };
      if (name) body.first_name = name;
      const res = await fetch('https://api.kit.com/v4/subscribers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kit-Api-Key': kitApiKey },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        espSynced = true;
        const tagId = process.env.CONVERTKIT_TAG_ID;
        if (tagId) {
          await fetch('https://api.kit.com/v4/tags/' + tagId + '/subscribers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Kit-Api-Key': kitApiKey },
            body: JSON.stringify({ email_address: email })
          }).catch(function () {});
        }
      } else {
        const errBody = await res.json().catch(function () { return {}; });
        espError = 'ConvertKit returned HTTP ' + res.status + (errBody && errBody.errors ? ': ' + JSON.stringify(errBody.errors) : '');
      }
    } catch (e) {
      espError = 'ConvertKit request failed: ' + e.message;
    }
  } else {
    espError = 'CONVERTKIT_API_KEY is not configured on the server yet.';
  }

  try {
    const leadsStore = getStore('nforge-leads', { consistency: 'strong' });
    const existing = await leadsStore.get(http.safeKey(email), { type: 'json' });
    const record = {
      email: email,
      name: name || (existing && existing.name) || '',
      source: source,
      espSynced: espSynced,
      espError: espSynced ? null : espError,
      firstSeenAt: (existing && existing.firstSeenAt) || new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    };
    await leadsStore.setJSON(http.safeKey(email), record);
  } catch (e) {
    // If Blobs itself is unavailable, still tell the truth about ESP sync
    // rather than silently pretending everything succeeded.
    return http.json(200, {
      success: true,
      espSynced: espSynced,
      warning: 'Lead was not persisted to storage (Netlify Blobs unavailable): ' + e.message
    });
  }

  return http.json(200, { success: true, espSynced: espSynced, espError: espSynced ? null : espError });
};
