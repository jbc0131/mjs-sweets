// GET /api/admin-order-detail?id=... — admin-auth required
// Returns the FULL order JSON (including emails[] log) plus computed expected
// and won't-fire emails. Mirrors /api/order-status but with admin trust.

const { readOrder } = require('./_lib/order-storage');
const { requireAdmin } = require('./_lib/admin-auth');
const { computeExpectedEmails, computeWontFireEmails } = require('./_lib/email');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res).ok) return;

  const url = new URL(req.url, 'http://localhost');
  const orderId = url.searchParams.get('id');
  if (!orderId) return res.status(400).json({ error: 'Missing id' });

  const order = await readOrder(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  return res.status(200).json({
    order,
    expectedEmails: computeExpectedEmails(order),
    wontFireEmails: computeWontFireEmails(order),
  });
};
