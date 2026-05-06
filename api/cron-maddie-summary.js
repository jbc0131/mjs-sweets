// Cron: 0 12 * * * UTC (~6am Central winter / 7am Central summer).
// Maddie's daily summary. Suppresses (no email sent) on truly empty days.

const { listOrders } = require('./_lib/order-storage');
const { sendEmail } = require('./_lib/email');

function checkCron(req) {
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

function ymdCentralOffset(daysOffset) {
  const d = new Date(Date.now() + daysOffset * 24 * 3600 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
}

const TERMINAL = new Set(['picked-up', 'canceled', 'no-show']);
const NON_TERMINAL_FROM_CONFIRMED = new Set(['confirmed', 'baking', 'decorating', 'ready']);

function summarizeOrder(o, siteUrl) {
  return {
    orderId: o.orderId,
    firstName: o.customerFirstName || (o.customerName || '').split(' ')[0] || 'Customer',
    itemsSummary: (o.lineItems || []).map(li => `${li.name} × ${li.quantity}`).join(' + ') || '',
    statusLabel: (o.status || 'paid').replace(/-/g, ' '),
    pickupDate: o.pickupDate,
    adminUrl: `${siteUrl}/admin/order/${o.orderId}`,
  };
}

module.exports = async function handler(req, res) {
  if (!checkCron(req)) return res.status(401).json({ error: 'unauthorized' });
  const todayDate = ymdCentralOffset(0);
  const yesterdayDate = ymdCentralOffset(-1);
  const tomorrowDate = ymdCentralOffset(1);
  const siteUrl = process.env.SITE_URL || 'https://www.mjs-sweets.com';

  const orders = await listOrders({ since: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString() });

  const todayPickups = orders
    .filter(o => o.pickupDate === todayDate && !TERMINAL.has(o.status))
    .map(o => summarizeOrder(o, siteUrl));

  const yesterdayUnresolved = orders
    .filter(o => o.pickupDate === yesterdayDate && o.status === 'ready')
    .map(o => summarizeOrder(o, siteUrl));

  const tomorrowConfirmed = orders
    .filter(o => o.pickupDate === tomorrowDate && NON_TERMINAL_FROM_CONFIRMED.has(o.status))
    .map(o => summarizeOrder(o, siteUrl));

  const now = Date.now();
  const cutoff48h = 48 * 3600 * 1000;
  const pastDue = orders
    .filter(o => {
      if (TERMINAL.has(o.status)) return false;
      if (!o.pickupDate) return false;
      const pickupTime = new Date(o.pickupDate + 'T17:00:00Z').getTime();
      return (now - pickupTime) > cutoff48h;
    })
    .map(o => summarizeOrder(o, siteUrl));

  const activeOrders = orders.filter(o => !TERMINAL.has(o.status));

  // Suppression rule: if NOTHING active and NOTHING in any section, exit silently.
  const hasContent =
    todayPickups.length > 0 ||
    yesterdayUnresolved.length > 0 ||
    tomorrowConfirmed.length > 0 ||
    pastDue.length > 0 ||
    activeOrders.length > 0;

  if (!hasContent) {
    return res.status(200).json({ ok: true, sent: false, reason: 'truly-empty-day' });
  }

  const summary = {
    todayDate,
    activeCount: activeOrders.length,
    todayCount: todayPickups.length,
    todayPickups,
    yesterdayUnresolved,
    tomorrowConfirmed,
    pastDue,
  };

  // The summary email isn't tied to an order — pass a stub object whose emails
  // array is detached from the order log. Best-effort send.
  const stub = { emails: [] };
  const result = await sendEmail(stub, 'maddie-daily-summary', { summary }, { trigger: 'cron' });
  return res.status(200).json({ ok: true, sent: true, summary: { ...summary, todayPickups: undefined, yesterdayUnresolved: undefined, tomorrowConfirmed: undefined, pastDue: undefined }, result });
};
