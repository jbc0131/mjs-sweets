// POST /api/order-verify
// Body: { lookup: "<last name OR phone>", orderId: "..." }
// On match, sets the signed mjs_order_{orderId} cookie. Rate-limited to 5
// failed attempts per 15 min per IP. Generic error message on every failure
// path so the response doesn't reveal which dimension matched.

const { Client, Environment } = require('square');
const { list } = require('@vercel/blob');
const { setOrderCookieHeader } = require('./_lib/order-auth');

const square = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: (process.env.SQUARE_ENVIRONMENT || 'sandbox') === 'production'
    ? Environment.Production : Environment.Sandbox,
});

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const failedByIp = new Map();

function ipOf(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const entry = failedByIp.get(ip);
  if (entry && entry.resetAt > now && entry.count >= RATE_LIMIT_MAX) return true;
  return false;
}

function recordFailed(ip) {
  const now = Date.now();
  const entry = failedByIp.get(ip);
  if (entry && entry.resetAt > now) entry.count++;
  else failedByIp.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
}

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

function looksLikePhone(input) {
  const digits = digitsOnly(input);
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

// The confirmation email shows `Order #${orderId.slice(0, 8)}` for readability,
// but the full Square order ID is ~27 chars. If the customer pastes the short
// version from their email, expand it to the full ID via Blob prefix lookup.
// Returns the full ID on unique match; otherwise returns the input unchanged
// (downstream Square retrieveOrder will fail and the user sees a generic error).
async function expandShortOrderId(orderId) {
  if (!orderId || orderId.length >= 20) return orderId;
  try {
    const blobs = await list({ prefix: 'orders/' + orderId, token: process.env.BLOB_READ_WRITE_TOKEN });
    const matches = (blobs.blobs || [])
      .filter(b => b.pathname.endsWith('.json') && !b.pathname.endsWith('_email-index.json'))
      .map(b => b.pathname.replace(/^orders\//, '').replace(/\.json$/, ''));
    if (matches.length === 1) return matches[0];
  } catch (_) { /* fall through */ }
  return orderId;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = ipOf(req);
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }

  const { lookup, orderId: rawOrderId } = req.body || {};
  if (!lookup || !rawOrderId) {
    return res.status(400).json({ error: "Please enter both your name (or phone) and order number." });
  }

  // Expand 8-char prefix (as shown in the email subject) to full order ID.
  const orderId = await expandShortOrderId(String(rawOrderId).trim());

  try {
    const r = await square.ordersApi.retrieveOrder(orderId);
    const order = r.result.order;
    if (!order) {
      recordFailed(ip);
      return res.status(401).json({ error: "We couldn't verify that. Double-check your details." });
    }

    let matched = false;

    if (looksLikePhone(lookup)) {
      const inputLast10 = digitsOnly(lookup).slice(-10);
      const metaPhone = digitsOnly(order.metadata?.customer_phone || '').slice(-10);
      if (metaPhone && metaPhone === inputLast10) matched = true;

      if (!matched && order.customerId) {
        try {
          const cust = await square.customersApi.retrieveCustomer(order.customerId);
          const custPhone = digitsOnly(cust.result.customer?.phoneNumber || '').slice(-10);
          if (custPhone && custPhone === inputLast10) matched = true;
        } catch (_) { /* ignore */ }
      }
    } else {
      const needle = String(lookup).trim().toLowerCase();
      if (needle.length >= 1) {
        const metaName = String(order.metadata?.customer_name || '').toLowerCase();
        const lastName = metaName.trim().split(/\s+/).pop() || '';
        if (lastName && lastName.includes(needle)) matched = true;

        if (!matched && order.customerId) {
          try {
            const cust = await square.customersApi.retrieveCustomer(order.customerId);
            const familyName = String(cust.result.customer?.familyName || '').toLowerCase();
            if (familyName && familyName.includes(needle)) matched = true;
          } catch (_) { /* ignore */ }
        }
      }
    }

    if (!matched) {
      recordFailed(ip);
      return res.status(401).json({ error: "We couldn't verify that. Double-check your details." });
    }

    // Success — clear any failed attempts and set the signed cookie
    failedByIp.delete(ip);
    res.setHeader('Set-Cookie', setOrderCookieHeader(orderId));
    return res.status(200).json({ ok: true, orderId });
  } catch (err) {
    console.error('order-verify error:', err.message);
    recordFailed(ip);
    return res.status(401).json({ error: "We couldn't verify that. Double-check your details." });
  }
};
