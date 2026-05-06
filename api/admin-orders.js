// GET /api/admin-orders — admin-auth required
// Returns up to 30-day window of orders + 24-hour email rollup for the
// dashboard email panel.

const { listOrders } = require('./_lib/order-storage');
const { requireAdmin } = require('./_lib/admin-auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res).ok) return;

  const url = new URL(req.url, 'http://localhost');
  const status = url.searchParams.get('status') || null;
  const pickupDate = url.searchParams.get('pickupDate') || null;
  const search = url.searchParams.get('q') || null;

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const all = await listOrders({ since });

  // Filter by status / pickupDate / search
  const filtered = all.filter(o => {
    if (status && o.status !== status) return false;
    if (pickupDate) {
      const target = pickupDate === 'today' ? todayCentralYmd()
        : pickupDate === 'this-week' ? null // handled below
        : pickupDate;
      if (target && o.pickupDate !== target) return false;
      if (pickupDate === 'this-week' && !isThisWeek(o.pickupDate)) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      const hay = [o.orderId, o.customerName, o.customerEmail, o.customerPhone].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // 24-hour email rollup
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let sent = 0, failed = 0;
  let lastSent = null, firstFailed = null;
  for (const o of all) {
    for (const e of (o.emails || [])) {
      const t = new Date(e.ts).getTime();
      if (!Number.isFinite(t) || t < cutoff) continue;
      if (e.status === 'sent') {
        sent++;
        if (!lastSent || t > new Date(lastSent.ts).getTime()) lastSent = { ...e, orderId: o.orderId, customerFirstName: o.customerFirstName };
      } else if (e.status === 'failed') {
        failed++;
        if (!firstFailed) firstFailed = { ...e, orderId: o.orderId, customerFirstName: o.customerFirstName };
      }
    }
  }

  return res.status(200).json({
    orders: filtered,
    emailSummary: { sent, failed, lastSent, firstFailed },
  });
};

function todayCentralYmd() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function isThisWeek(ymd) {
  if (!ymd) return false;
  const today = new Date(todayCentralYmd() + 'T12:00:00-06:00');
  const target = new Date(ymd + 'T12:00:00-06:00');
  const diffDays = Math.round((target - today) / (24 * 3600 * 1000));
  return diffDays >= 0 && diffDays <= 7;
}
