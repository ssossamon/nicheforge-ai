// NicheForge AI — playbooks.js (v1.0)

const { getStore, connectLambda } = require('@netlify/blobs');
const http = require('./_shared/http');

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
    store = getStore('nforge-playbooks');
  } catch (e) {
    return http.fail(500, 'storage_unavailable', 'Storage is not available right now: ' + e.message);
  }

  if (action === 'list') {
    try {
      const rawPrefix = email + '::';
      const listing = await store.list({ prefix: rawPrefix });
      const summaries = [];
      for (const item of listing.blobs) {
        const sepIndex = item.key.indexOf('::');
        if (sepIndex === -1) continue;
        const encodedId = http.safeKey(item.key.slice(0, sepIndex)) + '::' + item.key.slice(sepIndex + 2);
        const rec = await store.get(encodedId, { type: 'json' });
        if (rec) {
          summaries.push({
            id: rec.id,
            sourceLabel: rec.sourceLabel,
            playbookTitle: rec.result && rec.result.playbook ? rec.result.playbook.title : null,
            tacticCount: rec.result && rec.result.whatTheyDid ? rec.result.whatTheyDid.length : 0,
            createdAt: rec.createdAt
          });
        }
      }
      summaries.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
      return http.json(200, { success: true, playbooks: summaries });
    } catch (e) {
      return http.fail(500, 'playbooks_list_failed', 'Could not load your playbooks: ' + e.message);
    }
  }

  if (action === 'get') {
    const id = String(payload.id || '');
    if (!id || id.indexOf(http.safeKey(email) + '::') !== 0) {
      return http.fail(400, 'invalid_id', 'That item does not belong to this email.');
    }
    try {
      const rec = await store.get(id, { type: 'json' });
      if (!rec) return http.fail(404, 'not_found', 'That playbook no longer exists.');
      return http.json(200, { success: true, playbook: rec });
    } catch (e) {
      return http.fail(500, 'playbook_get_failed', 'Could not load that playbook: ' + e.message);
    }
  }

  if (action === 'delete') {
    const id = String(payload.id || '');
    if (!id || id.indexOf(http.safeKey(email) + '::') !== 0) {
      return http.fail(400, 'invalid_id', 'That item does not belong to this email.');
    }
    try {
      await store.delete(id);
      return http.json(200, { success: true });
    } catch (e) {
      return http.fail(500, 'playbook_delete_failed', 'Could not delete that playbook: ' + e.message);
    }
  }

  return http.fail(400, 'unknown_action', 'Unknown action: ' + action);
}
