// Signed webhooks. The sender puts  X-CRIT-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
// on every request. The HMAC covers the raw bytes as received (n8n's webhook keeps them with rawBody), so a
// re-serialised body can never pass. The timestamp is checked after the HMAC: an authentic but old request is
// a replay and is refused as stale.

const SIGNATURE_HEADER = 'x-crit-signature';
const SIGNATURE_TOLERANCE_SECONDS = 300;
const MIN_SECRET_LENGTH = 16;

function hmacHex(secret, timestamp, raw) {
  const crypto = require('crypto');
  return crypto.createHmac('sha256', secret).update(String(timestamp) + '.').update(raw).digest('hex');
}

function signatureHeader(secret, timestamp, raw) {
  return 't=' + timestamp + ',v1=' + hmacHex(secret, timestamp, raw);
}

// "t=1794453300,v1=ab12...,v1=cd34..." -> { t, v1: [...] } (several v1 values allow a secret rotation), or null.
function parseSignatureHeader(value) {
  let t = null;
  const v1 = [];
  for (const part of String(value).split(',')) {
    const [key, ...rest] = part.trim().split('=');
    const text = rest.join('=');
    if (key === 't' && /^\d{9,11}$/.test(text)) t = Number(text);
    else if (key === 'v1' && /^[0-9a-f]{64}$/.test(text)) v1.push(text);
  }
  return t !== null && v1.length ? { t, v1 } : null;
}

// Constant time for equal lengths (both are 64 hex characters here).
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function verifySignature(secret, header, raw, nowSeconds) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) return { ok: false, reason: 'secret_not_configured' };
  if (header === undefined || header === null || header === '') return { ok: false, reason: 'missing_signature' };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: 'malformed_signature' };
  if (raw === null || raw === undefined) return { ok: false, reason: 'raw_body_missing' };
  const expected = hmacHex(secret, parsed.t, raw);
  if (!parsed.v1.some(given => sameHex(given, expected))) return { ok: false, reason: 'bad_signature' };
  if (Math.abs(nowSeconds - parsed.t) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: 'stale_timestamp', age_seconds: nowSeconds - parsed.t };
  return { ok: true, reason: null, timestamp: parsed.t };
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

// The raw request body the Webhook node kept as binary (rawBody option), or null.
async function rawBodyOf(helpers, item) {
  const keys = Object.keys((item && item.binary) || {});
  const key = keys.includes('data') ? 'data' : keys[0];
  if (!key) return null;
  try {
    return await helpers.getBinaryDataBuffer(0, key);
  } catch (error) {
    return null;
  }
}

// Verifies a request and parses the JSON from the verified bytes (never from n8n's own parse of the body).
function verifiedPayload(verdict, raw) {
  if (!verdict.ok) return { ok: false, reason: verdict.reason, payload: null };
  try {
    return { ok: true, reason: null, payload: JSON.parse(raw.toString('utf8')) };
  } catch (error) {
    return { ok: true, reason: null, payload: null, parse_error: 'body is not valid JSON' };
  }
}
