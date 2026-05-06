// HMAC-signed cookies + URL tokens for the customer order tracking page.
// Both the cookie and the URL token (?t=) encode the same 3-tuple
// `${orderId}.${expiresAtUnix}.${hmacBase64url}` signed with ORDER_VERIFY_SECRET.
// URL tokens are base64url-encoded as a single opaque blob.
//
// Cookie name: `mjs_order_{orderId}`. HttpOnly, Secure, SameSite=Lax, 30 days default.

const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = 30 * 24 * 3600;

function getSecret() {
  const s = process.env.ORDER_VERIFY_SECRET;
  if (!s) throw new Error('ORDER_VERIFY_SECRET is not set');
  return s;
}

function hmac(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

function signOrderCookie(orderId, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = hmac(`${orderId}.${exp}`);
  return `${orderId}.${exp}.${sig}`;
}

function signOrderToken(orderId, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const cookieValue = signOrderCookie(orderId, ttlSeconds);
  return Buffer.from(cookieValue, 'utf8').toString('base64url');
}

function verifyTuple(orderId, presented) {
  if (!presented || typeof presented !== 'string') {
    return { ok: false, reason: 'no-token' };
  }
  const parts = presented.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [tokenOrderId, expStr, sig] = parts;
  if (tokenOrderId !== orderId) return { ok: false, reason: 'order-mismatch' };
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'bad-exp' };
  if (Math.floor(Date.now() / 1000) >= exp) return { ok: false, reason: 'expired' };
  const expectedSig = hmac(`${tokenOrderId}.${exp}`);
  if (sig.length !== expectedSig.length) return { ok: false, reason: 'sig-len' };
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return { ok: false, reason: 'sig-mismatch' };
  return { ok: true };
}

function decodeUrlToken(token) {
  try {
    return Buffer.from(token, 'base64url').toString('utf8');
  } catch (_) {
    return null;
  }
}

function parseAuthFromReq(req, orderId) {
  // 1. Cookie path
  const cookieHeader = req.headers.cookie || '';
  const cookieName = `mjs_order_${orderId}`;
  const cookieMatch = cookieHeader.split(';').map(s => s.trim()).find(c => c.startsWith(cookieName + '='));
  if (cookieMatch) {
    const value = cookieMatch.slice(cookieName.length + 1);
    const result = verifyTuple(orderId, value);
    if (result.ok) return result;
  }
  // 2. URL token path (?t=)
  const url = new URL(req.url, 'http://localhost');
  const t = url.searchParams.get('t');
  if (t) {
    const decoded = decodeUrlToken(t);
    if (decoded) {
      const result = verifyTuple(orderId, decoded);
      if (result.ok) return result;
    }
  }
  return { ok: false, reason: 'no-valid-auth' };
}

function setOrderCookieHeader(orderId, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const value = signOrderCookie(orderId, ttlSeconds);
  const maxAge = ttlSeconds;
  return `mjs_order_${orderId}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

module.exports = {
  signOrderCookie,
  signOrderToken,
  verifyTuple,
  parseAuthFromReq,
  setOrderCookieHeader,
};
