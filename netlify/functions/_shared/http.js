// NicheForge AI — shared HTTP response helpers (v1.0)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function json(statusCode, bodyObj, extraHeaders) {
  return {
    statusCode: statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS, extraHeaders || {}),
    body: JSON.stringify(bodyObj)
  };
}

function csv(statusCode, csvText, filename) {
  return {
    statusCode: statusCode,
    headers: Object.assign(
      {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="' + (filename || 'export.csv') + '"'
      },
      CORS_HEADERS
    ),
    body: csvText
  };
}

function fail(statusCode, code, message, whatToDoNext, extra) {
  const body = Object.assign(
    {
      success: false,
      error: {
        code: code,
        message: message,
        whatToDoNext: whatToDoNext || null
      }
    },
    extra || {}
  );
  return json(statusCode, body);
}

function isPreflight(event) {
  return event.httpMethod === 'OPTIONS';
}

function preflightResponse() {
  return { statusCode: 204, headers: CORS_HEADERS, body: '' };
}

function validEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// Netlify Blobs keys built from raw strings containing '@', spaces, or ':'
// have shown a mismatch between what list() reports and what get() returns
// for the same key. Always run any dynamic key component through this
// before concatenating it into a Blobs key.
function safeKey(str) {
  return encodeURIComponent(String(str));
}

module.exports = {
  CORS_HEADERS: CORS_HEADERS,
  json: json,
  csv: csv,
  fail: fail,
  isPreflight: isPreflight,
  preflightResponse: preflightResponse,
  validEmail: validEmail,
  safeKey: safeKey
};
