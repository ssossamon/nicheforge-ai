// NicheForge AI — admin-keys.js (v1.0)
// Gated by the ADMIN_KEY environment variable (sent as the x-admin-key
// header). Supports: generating N license keys of a tier (returns CSV or
// JSON), and exporting the full leads / licenses lists as CSV for the
// admin panel.
//
// Actions (POST body: { action: "generate" | "export_leads" | "export_licenses", ... }):
//   generate        -> { tier, quantity, email?, name? }
//   export_leads    -> {}
//   export_licenses -> {}

const { getStore, connectLambda } = require('@netlify/blobs');
const http = require('./_shared/http');
const license = require('./_shared/license');

function checkAdmin(event) {
  const provided = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
  const expected = process.env.ADMIN_KEY || license.OWNER_KEY;
  return provided && provided === expected;
}

function toCsv(rows, columns) {
  const escape = function (val) {
    const s = val === undefined || val === null ? '' : String(val);
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const header = columns.join(',');
  const lines = rows.map(function (row) {
    return columns.map(function (col) { return escape(row[col]); }).join(',');
  });
  return [header].concat(lines).join('\n');
}

exports.handler = async function (event) {
  connectLambda(event);
  if (http.isPreflight(event)) return http.preflightResponse();
  if (event.httpMethod !== 'POST') {
    return http.fail(405, 'method_not_allowed', 'This endpoint only accepts POST requests.');
  }
  if (!checkAdmin(event)) {
    return http.fail(401, 'unauthorized', 'Missing or invalid admin key.', 'Enter your owner/admin key in the admin panel login screen.');
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return http.fail(400, 'bad_json', 'The request body was not valid JSON.');
  }

  const action = String(payload.action || 'generate');

  if (action === 'generate') {
    const tier = String(payload.tier || '').trim().toUpperCase();
    const quantity = Math.max(1, Math.min(500, parseInt(payload.quantity, 10) || 1));
    const email = payload.email ? String(payload.email).trim().toLowerCase() : '';
    const name = payload.name ? String(payload.name).trim() : '';

    if (!license.TIER_LABELS[tier] || tier === 'ADM') {
      return http.fail(400, 'invalid_tier', 'Tier must be one of STR, PRO, AGN.');
    }

    let licensesStore;
    try {
      licensesStore = getStore('nforge-licenses');
    } catch (e) {
      return http.fail(500, 'storage_unavailable', 'Netlify Blobs is not available: ' + e.message);
    }

    const generated = [];
    for (let i = 0; i < quantity; i++) {
      const key = license.generateLicenseKey(tier);
      const record = {
        key: key,
        tier: tier,
        email: email,
        name: name,
        status: email ? 'active' : 'unredeemed',
        source: 'admin_bulk',
        createdAt: new Date().toISOString()
      };
      await licensesStore.setJSON(key, record);
      generated.push(record);
    }

    if ((event.headers.accept || '').indexOf('text/csv') !== -1) {
      return http.csv(200, toCsv(generated, ['key', 'tier', 'status', 'email', 'name', 'createdAt']), 'nicheforge-keys-' + tier + '.csv');
    }
    return http.json(200, { success: true, generated: generated });
  }

  if (action === 'export_leads') {
    try {
      const leadsStore = getStore('nforge-leads');
      const list = await leadsStore.list();
      const rows = [];
      for (const item of list.blobs) {
        const rec = await leadsStore.get(item.key, { type: 'json' });
        if (rec) rows.push(rec);
      }
      return http.csv(200, toCsv(rows, ['email', 'name', 'source', 'espSynced', 'firstSeenAt', 'lastSeenAt']), 'nicheforge-leads.csv');
    } catch (e) {
      return http.fail(500, 'storage_unavailable', 'Could not read leads: ' + e.message);
    }
  }

  if (action === 'export_licenses') {
    try {
      const licensesStore = getStore('nforge-licenses');
      const list = await licensesStore.list();
      const rows = [];
      for (const item of list.blobs) {
        const rec = await licensesStore.get(item.key, { type: 'json' });
        if (rec) rows.push(rec);
      }
      return http.csv(200, toCsv(rows, ['key', 'tier', 'status', 'email', 'name', 'source', 'paidAmountUsd', 'createdAt']), 'nicheforge-licenses.csv');
    } catch (e) {
      return http.fail(500, 'storage_unavailable', 'Could not read licenses: ' + e.message);
    }
  }

  return http.fail(400, 'unknown_action', 'Unknown action: ' + action);
};
