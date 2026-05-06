// GET /api/order-status?id=xxx
// Public, but requires a valid mjs_order_{orderId} cookie OR a ?t= URL token.
// Returns the order JSON plus computed expectedEmails / wontFireEmails arrays.
// On first read of an order whose JSON doesn't yet exist in Blob (legacy orders
// from before this system shipped), lazily synthesizes one from Square's
// retrieveOrder so the page renders.

const { readOrder, writeOrder } = require('./_lib/order-storage');
const { parseAuthFromReq } = require('./_lib/order-auth');
const { computeExpectedEmails, computeWontFireEmails } = require('./_lib/email');
const { Client, Environment } = require('square');

const square = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: (process.env.SQUARE_ENVIRONMENT || 'sandbox') === 'production'
    ? Environment.Production : Environment.Sandbox,
});

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const url = new URL(req.url, 'http://localhost');
  const orderId = url.searchParams.get('id');
  if (!orderId) return res.status(400).json({ error: 'Missing id' });

  const auth = parseAuthFromReq(req, orderId);
  if (!auth.ok) return res.status(401).json({ error: 'unauthorized', reason: auth.reason });

  let order = await readOrder(orderId);
  if (!order) {
    order = await synthesizeFromSquare(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    try { await writeOrder(orderId, order); } catch (_) { /* ignore */ }
  }

  // Hide soft-deleted photos from the customer-facing response
  const visiblePhotos = (order.photos || []).filter(p => !p.hidden);
  const safeOrder = { ...order, photos: visiblePhotos };

  // Don't send the email log to customers (it contains internal trigger info)
  delete safeOrder.emails;

  return res.status(200).json({
    order: safeOrder,
    expectedEmails: computeExpectedEmails(order),
    wontFireEmails: computeWontFireEmails(order),
  });
};

async function synthesizeFromSquare(orderId) {
  try {
    const r = await square.ordersApi.retrieveOrder(orderId);
    const o = r.result.order;
    if (!o) return null;
    const meta = o.metadata || {};
    return {
      orderId,
      createdAt: o.createdAt || new Date().toISOString(),
      status: 'paid',
      statusHistory: [{ status: 'paid', ts: o.createdAt || new Date().toISOString(), auto: true }],
      photos: [],
      notes: [],
      emails: [],
      pickupAddress: '',
      pickupWindow: meta.pickup_window || '',
      pickupDate: null,
      pickupTimeNote: '',
      canceledAt: null,
      customerName: meta.customer_name || '',
      customerPhone: meta.customer_phone || '',
      customerEmail: '',
      customerFirstName: (meta.customer_name || '').split(' ')[0] || '',
      lineItems: (o.lineItems || []).map(li => ({
        name: li.name || '',
        quantity: li.quantity || '1',
        priceCents: Number(li.basePriceMoney?.amount || 0),
      })),
      totalCents: Number(o.totalMoney?.amount || 0),
    };
  } catch (err) {
    console.error('synthesizeFromSquare:', err.message);
    return null;
  }
}
