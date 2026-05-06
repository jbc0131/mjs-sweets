// Cron: 0 14 * * * UTC (~8am Central winter / 9am Central summer).
// Sends "pickup tomorrow" reminder to orders with pickupDate === tomorrow AND status >= confirmed.

const { listOrders, writeOrder } = require('./_lib/order-storage');
const { sendEmail } = require('./_lib/email');

function checkCron(req) {
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

function tomorrowCentralYmd() {
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(tomorrow);
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
}

const ELIGIBLE_STATUSES = new Set(['confirmed', 'baking', 'decorating', 'ready']);

module.exports = async function handler(req, res) {
  if (!checkCron(req)) return res.status(401).json({ error: 'unauthorized' });
  const targetDate = tomorrowCentralYmd();
  const orders = await listOrders({ since: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString() });
  let sent = 0, skipped = 0, failed = 0;
  for (const order of orders) {
    if (order.pickupDate !== targetDate) { skipped++; continue; }
    if (!ELIGIBLE_STATUSES.has(order.status)) { skipped++; continue; }
    if ((order.emails || []).some(e => e.type === 'pickup-tomorrow' && e.status === 'sent')) { skipped++; continue; }
    const result = await sendEmail(order, 'pickup-tomorrow', {
      pickupDate: order.pickupDate,
      pickupTimeNote: order.pickupTimeNote,
    }, { trigger: 'cron' });
    await writeOrder(order.orderId, order);
    if (result.status === 'sent') sent++; else failed++;
  }
  return res.status(200).json({ ok: true, targetDate, sent, skipped, failed, scanned: orders.length });
};
