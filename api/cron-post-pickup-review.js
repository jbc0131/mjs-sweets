// Cron: 0 16 * * * UTC (~10am Central winter / 11am Central summer).
// Sends post-pickup review request to orders where status === 'picked-up' AND
// the picked-up status was set ~24h+ ago AND we haven't sent the review email yet.

const { listOrders, writeOrder } = require('./_lib/order-storage');
const { sendEmail } = require('./_lib/email');

function checkCron(req) {
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

module.exports = async function handler(req, res) {
  if (!checkCron(req)) return res.status(401).json({ error: 'unauthorized' });
  const orders = await listOrders({ since: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() });
  const now = Date.now();
  const minAgeMs = 18 * 3600 * 1000; // give ~24h breathing room; 18h+ is "yesterday-ish"
  let sent = 0, skipped = 0, failed = 0;
  for (const order of orders) {
    if (order.status !== 'picked-up') { skipped++; continue; }
    if ((order.emails || []).some(e => e.type === 'post-pickup-review' && e.status === 'sent')) { skipped++; continue; }
    const pickedUpEntry = (order.statusHistory || []).find(s => s.status === 'picked-up');
    if (!pickedUpEntry) { skipped++; continue; }
    const ageMs = now - new Date(pickedUpEntry.ts).getTime();
    if (ageMs < minAgeMs) { skipped++; continue; }
    const result = await sendEmail(order, 'post-pickup-review', {}, { trigger: 'cron' });
    await writeOrder(order.orderId, order);
    if (result.status === 'sent') sent++; else failed++;
  }
  return res.status(200).json({ ok: true, sent, skipped, failed, scanned: orders.length });
};
