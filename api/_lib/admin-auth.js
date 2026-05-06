// Maddie admin auth: single password compared timing-safe; HMAC cookie via
// ADMIN_COOKIE_SECRET. Cookie name: `mjs_admin`. Activity-refreshed on each authed
// request. Failed-login rate limit: 5 attempts / 15 minutes per IP (in-memory).

const crypto = require('crypto');

const COOKIE_NAME = 'mjs_admin';
const DEFAULT_TTL_SECONDS = 7 * 24 * 3600;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

const failedAttempts = new Map(); // ip → {count, resetAt}

function getSecret() {
  const s = process.env.ADMIN_COOKIE_SECRET;
  if (!s) throw new Error('ADMIN_COOKIE_SECRET is not set');
  return s;
}

function hmac(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

function signAdminCookie(ttlSeconds = DEFAULT_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `admin.${exp}`;
  const sig = hmac(payload);
  return `${exp}.${sig}`;
}

function verifyAdminCookieValue(value) {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 2) return false;
  const [expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return false;
  if (Math.floor(Date.now() / 1000) >= exp) return false;
  const expected = hmac(`admin.${exp}`);
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function parseCookie(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.split(';').map(s => s.trim()).find(c => c.startsWith(COOKIE_NAME + '='));
  if (!match) return null;
  return match.slice(COOKIE_NAME.length + 1);
}

function isAuthed(req) {
  const value = parseCookie(req);
  return value ? verifyAdminCookieValue(value) : false;
}

function requireAdmin(req, res) {
  if (isAuthed(req)) return { ok: true };
  res.status(401).json({ error: 'unauthorized' });
  return { ok: false };
}

function setAdminCookieHeader(ttlSeconds = DEFAULT_TTL_SECONDS) {
  const value = signAdminCookie(ttlSeconds);
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}`;
}

function clearAdminCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (entry && entry.resetAt > now) {
    if (entry.count >= RATE_LIMIT_MAX) return { ok: false, retryAfter: entry.resetAt - now };
    return { ok: true };
  }
  return { ok: true };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (entry && entry.resetAt > now) {
    entry.count++;
  } else {
    failedAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  }
}

function clearFailedAttempts(ip) {
  failedAttempts.delete(ip);
}

function verifyPassword(presented) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  if (typeof presented !== 'string') return false;
  if (presented.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

module.exports = {
  isAuthed,
  requireAdmin,
  setAdminCookieHeader,
  clearAdminCookieHeader,
  checkRateLimit,
  recordFailedAttempt,
  clearFailedAttempts,
  verifyPassword,
  COOKIE_NAME,
};
