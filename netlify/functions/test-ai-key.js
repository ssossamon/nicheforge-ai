// NicheForge AI — test-ai-key.js (v1.0)
// Performs one real, minimal request against the chosen AI provider so the
// "Test Connection" button never reports success from key format alone.

const http = require('./_shared/http');

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

  const provider = String(payload.provider || '').trim().toLowerCase();
  const apiKey = String(payload.apiKey || '').trim();

  if (!apiKey) return http.fail(400, 'missing_key', 'Paste your API key first.');

  try {
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: 'Bearer ' + apiKey }
      });
      if (res.ok) return http.json(200, { success: true, valid: true });
      return respondForStatus(res.status, 'OpenAI');
    }

    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }]
        })
      });
      if (res.ok) return http.json(200, { success: true, valid: true });
      return respondForStatus(res.status, 'Anthropic');
    }

    if (provider === 'gemini') {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey);
      if (res.ok) return http.json(200, { success: true, valid: true });
      return respondForStatus(res.status, 'Gemini');
    }

    return http.fail(400, 'unsupported_provider', 'Unsupported provider: ' + provider);
  } catch (e) {
    return http.fail(502, 'network_error', 'Could not reach the AI provider: ' + e.message, 'Check your internet connection and try again.');
  }
};

function respondForStatus(status, providerName) {
  if (status === 401 || status === 403) {
    return http.json(200, { success: true, valid: false, reason: providerName + ' rejected this key (HTTP ' + status + '). It may be invalid or revoked.' });
  }
  if (status === 429) {
    return http.json(200, { success: true, valid: false, reason: providerName + ' says this key is rate-limited or out of quota (HTTP 429). The key itself may still be valid.' });
  }
  return http.json(200, { success: true, valid: false, reason: providerName + ' returned HTTP ' + status + ' for this key.' });
}
