// NicheForge AI — verify-paypal.js (v1.0)
// Never trusts the client about payment success or amount. Confirms the
// order server-side against PayPal's own Orders API, checks the paid amount
// against a server-side price map, THEN issues a real license key and
// emails it via Resend. If PayPal env vars are missing, this fails honestly
// instead of pretending to succeed.

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

  const orderID = String(payload.orderID || '').trim();
  const tier = String(payload.tier || '').trim().toUpperCase();
  const email = String(payload.email || '').trim().toLowerCase();
  const name = payload.name ? String(payload.name).trim() : '';

  if (!orderID) return http.fail(400, 'missing_order_id', 'No PayPal order ID was provided.');
  if (!license.TIER_PRICE_USD[tier]) return http.fail(400, 'invalid_tier', 'Unknown pricing tier: ' + tier);
  if (!http.validEmail(email)) return http.fail(400, 'invalid_email', 'A valid email is required to receive your license key.');

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_SECRET;
  const env = (process.env.PAYPAL_ENV || 'live').toLowerCase();
  const base = env === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

  if (!clientId || !secret) {
    return http.fail(
      500,
      'paypal_not_configured',
      'PayPal credentials are not configured on the server yet.',
      'Set PAYPAL_CLIENT_ID and PAYPAL_SECRET (and optionally PAYPAL_ENV=sandbox for testing) in Netlify environment variables.'
    );
  }

  // ---- 1. Get an OAuth token from PayPal --------------------------------
  let accessToken;
  try {
    const tokenRes = await fetch(base + '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(clientId + ':' + secret).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return http.fail(502, 'paypal_auth_failed', 'Could not authenticate with PayPal: ' + (tokenData.error_description || tokenRes.status), 'Check PAYPAL_CLIENT_ID and PAYPAL_SECRET are correct and match PAYPAL_ENV.');
    }
    accessToken = tokenData.access_token;
  } catch (e) {
    return http.fail(502, 'paypal_auth_error', 'Network error contacting PayPal: ' + e.message);
  }

  // ---- 2. Capture (or read) the order, and verify the amount -------------
  let order;
  try {
    let orderRes = await fetch(base + '/v2/checkout/orders/' + orderID, {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    order = await orderRes.json();

    if (order.status === 'APPROVED') {
      const captureRes = await fetch(base + '/v2/checkout/orders/' + orderID + '/capture', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
      });
      order = await captureRes.json();
    }
  } catch (e) {
    return http.fail(502, 'paypal_order_error', 'Network error verifying the order with PayPal: ' + e.message);
  }

  if (order.status !== 'COMPLETED') {
    return http.fail(402, 'payment_not_completed', 'PayPal reports this order as "' + order.status + '", not COMPLETED.', 'If you completed checkout, wait a moment and retry — otherwise the payment did not go through.');
  }

  const paidUnit = order.purchase_units && order.purchase_units[0];
  const capture = paidUnit && paidUnit.payments && paidUnit.payments.captures && paidUnit.payments.captures[0];
  const paidAmount = capture ? parseFloat(capture.amount.value) : 0;
  const expectedAmount = license.TIER_PRICE_USD[tier];

  if (paidAmount < expectedAmount - 0.01) {
    return http.fail(
      402,
      'amount_mismatch',
      'The captured PayPal amount ($' + paidAmount + ') does not match the ' + tier + ' tier price ($' + expectedAmount + ').',
      'This purchase was not credited automatically to avoid issuing a mismatched license. Contact support with your PayPal order ID.'
    );
  }

  // ---- 3. Issue the license key ------------------------------------------
  const key = license.generateLicenseKey(tier);
  try {
    const licensesStore = getStore('nforge-licenses');
    await licensesStore.setJSON(key, {
      key: key,
      tier: tier,
      email: email,
      name: name,
      status: 'active',
      source: 'paypal',
      paypalOrderId: orderID,
      paidAmountUsd: paidAmount,
      createdAt: new Date().toISOString()
    });
  } catch (e) {
    return http.fail(500, 'license_storage_failed', 'Payment succeeded but the license could not be saved: ' + e.message, 'Contact support with your PayPal order ID (' + orderID + ') to have your key issued manually.');
  }

  // ---- 4. Email the key via Resend (best-effort, never blocks the key) --
  let emailSent = false;
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL || 'NicheForge AI <onboarding@resend.dev>',
          to: [email],
          subject: 'Your NicheForge AI license key',
          text:
            'Thanks for grabbing NicheForge AI (' + license.TIER_LABELS[tier] + ')!\n\n' +
            'Your license key: ' + key + '\n\n' +
            'Enter it in the app under "Activate License" to unlock unlimited scans.\n\n' +
            '\u2014 NicheForge AI'
        })
      });
      emailSent = resendRes.ok;
    } catch (e) {
      emailSent = false;
    }
  }

  return http.json(200, {
    success: true,
    licenseKey: key,
    tier: tier,
    tierLabel: license.TIER_LABELS[tier],
    emailSent: emailSent
  });
};
