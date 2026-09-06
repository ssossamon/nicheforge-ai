// NicheForge AI — config.js (v1.0)
// Returns only NON-secret, publicly-safe config so the frontend doesn't
// need the PayPal client ID hardcoded into the HTML source.

const http = require('./_shared/http');

exports.handler = async function (event) {
  if (http.isPreflight(event)) return http.preflightResponse();
  return http.json(200, {
    success: true,
    paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
    paypalEnv: (process.env.PAYPAL_ENV || 'live').toLowerCase()
  });
};
