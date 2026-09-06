// NicheForge AI — shared license helpers (v1.0)
// Key format: NFORGE-{TIER}-{RANDOM8}-{CHECKSUM4}
// Tiers: STR (Starter) / PRO (Pro) / AGN (Agency) / ADM (Owner/Admin, never sold)

const crypto = require('crypto');

const TIER_LABELS = {
  STR: 'Starter',
  PRO: 'Pro',
  AGN: 'Agency',
  ADM: 'Owner (Full Access)'
};

const TIER_PRICE_USD = {
  STR: 47,
  PRO: 97,
  AGN: 197
};

// Owner access is server-only. Never fall back to a source-controlled key.
const OWNER_KEY = String(process.env.ADMIN_KEY || '').trim().toUpperCase();

function randomBase32(length) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function checksumFor(tier, random8) {
  const hash = crypto.createHash('sha256').update('NFORGE-' + tier + '-' + random8).digest('hex').toUpperCase();
  return hash.slice(0, 4);
}

function generateLicenseKey(tier) {
  const t = String(tier || '').toUpperCase();
  if (!TIER_LABELS[t]) {
    throw new Error('Unknown tier: ' + tier);
  }
  const random8 = randomBase32(8);
  const checksum = checksumFor(t, random8);
  return 'NFORGE-' + t + '-' + random8 + '-' + checksum;
}

function parseLicenseKey(key) {
  if (typeof key !== 'string') return null;
  const parts = key.trim().toUpperCase().split('-');
  if (parts.length !== 4 || parts[0] !== 'NFORGE') return null;
  const tier = parts[1];
  const random8 = parts[2];
  const checksum = parts[3];
  if (!TIER_LABELS[tier]) return null;
  if (tier !== 'ADM') {
    // ADM keys (owner) don't need to satisfy the checksum format since only
    // the single hardcoded owner key is ever valid for that tier.
    if (checksumFor(tier, random8) !== checksum) return null;
  }
  return { tier: tier, random8: random8, checksum: checksum, raw: key.trim().toUpperCase() };
}

function isOwnerKey(key) {
  return OWNER_KEY.length > 0 && typeof key === 'string' && key.trim().toUpperCase() === OWNER_KEY;
}

module.exports = {
  TIER_LABELS: TIER_LABELS,
  TIER_PRICE_USD: TIER_PRICE_USD,
  OWNER_KEY: OWNER_KEY,
  generateLicenseKey: generateLicenseKey,
  parseLicenseKey: parseLicenseKey,
  isOwnerKey: isOwnerKey
};
