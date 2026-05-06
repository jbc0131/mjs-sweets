// POST /api/admin-login  — body: { password }
// Verifies password timing-safe; sets mjs_admin cookie on success.
// Rate-limited per IP. Generic 401 on any failure.

const {
  setAdminCookieHeader, verifyPassword, checkRateLimit, recordFailedAttempt, clearFailedAttempts,
} = require('./_lib/admin-auth');

function ipOf(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || 'unknown';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = ipOf(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) return res.status(429).json({ error: 'Too many attempts. Try again later.' });

  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!verifyPassword(password)) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'unauthorized' });
  }

  clearFailedAttempts(ip);
  res.setHeader('Set-Cookie', setAdminCookieHeader());
  return res.status(200).json({ ok: true });
};
