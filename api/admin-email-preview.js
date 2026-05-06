// GET /api/admin-email-preview?orderId=...&emailId=... — admin-auth required
// Re-renders the email body using the same template the customer received,
// using the payload stored on the email log entry.

const { readOrder } = require('./_lib/order-storage');
const { requireAdmin } = require('./_lib/admin-auth');
const { renderEmail } = require('./_lib/email');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res).ok) return;

  const url = new URL(req.url, 'http://localhost');
  const orderId = url.searchParams.get('orderId');
  const emailId = url.searchParams.get('emailId');
  if (!orderId || !emailId) return res.status(400).json({ error: 'Missing orderId or emailId' });

  const order = await readOrder(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const entry = (order.emails || []).find(e => e.id === emailId);
  if (!entry) return res.status(404).json({ error: 'Email not found' });

  try {
    const rendered = renderEmail(entry.type, order, entry.payload || {});
    return res.status(200).json({
      html: rendered.html,
      subject: rendered.subject,
      to: entry.to,
      ts: entry.ts,
      status: entry.status,
      type: entry.type,
      trigger: entry.trigger,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Render failed', detail: err.message });
  }
};
