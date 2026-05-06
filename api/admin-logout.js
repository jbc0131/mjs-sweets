// POST /api/admin-logout — clears the mjs_admin cookie.

const { clearAdminCookieHeader } = require('./_lib/admin-auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Set-Cookie', clearAdminCookieHeader());
  return res.status(200).json({ ok: true });
};
