// Vercel Blob-backed storage for the order tracking system.
//
// One JSON file per order at `orders/{orderId}.json`, public-read so admin
// reads don't pay an auth round-trip. Photos at `orders/{orderId}/photo-*.jpg`.
//
// CONCURRENCY MODEL
//   We use read-then-write with last-writer-wins. For MJ's volume the chance of
//   real write-write contention on a single order is essentially zero. The one
//   exception is the Resend webhook which patches `emails[i]` entries — those
//   patches are scoped to a single index keyed by resendId, so even if a stale
//   read clobbers a webhook patch, Resend retries on non-2xx and on 2xx the
//   worst case is the panel shows "delivered" instead of "opened" briefly.
//   No real lock; not worth the complexity at this volume.

const { put, list, head } = require('@vercel/blob');
const crypto = require('crypto');

const BLOB_TOKEN = () => process.env.BLOB_READ_WRITE_TOKEN;

function orderJsonKey(orderId) {
  return `orders/${orderId}.json`;
}

function emailIndexKey() {
  return `orders/_email-index.json`;
}

// ---------- Read ----------

async function readOrder(orderId) {
  const url = await urlForKey(orderJsonKey(orderId));
  if (!url) return null;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function urlForKey(key) {
  try {
    const meta = await head(key, { token: BLOB_TOKEN() });
    return meta?.url || null;
  } catch (_) {
    return null;
  }
}

// ---------- Write ----------

async function writeOrder(orderId, order) {
  const body = JSON.stringify(order);
  await put(orderJsonKey(orderId), body, {
    access: 'public',
    contentType: 'application/json',
    token: BLOB_TOKEN(),
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return order;
}

async function mutateOrder(orderId, fn) {
  const order = await readOrder(orderId);
  if (!order) throw new Error(`mutateOrder: order ${orderId} not found`);
  const next = await fn(order) || order;
  await writeOrder(orderId, next);
  return next;
}

// ---------- Email log helpers ----------

async function appendEmailLog(orderId, emailEntry) {
  await mutateOrder(orderId, (order) => {
    if (!Array.isArray(order.emails)) order.emails = [];
    order.emails.push(emailEntry);
    return order;
  });
  if (emailEntry.resendId) {
    await indexEmail(emailEntry.resendId, orderId);
  }
}

async function patchEmailByResendId(resendId, patch) {
  const orderId = await lookupEmailOrderId(resendId);
  if (!orderId) return false;
  await mutateOrder(orderId, (order) => {
    if (!Array.isArray(order.emails)) return order;
    const idx = order.emails.findIndex(e => e.resendId === resendId);
    if (idx === -1) return order;
    order.emails[idx] = { ...order.emails[idx], ...patch };
    return order;
  });
  return true;
}

// Resend → orderId index (avoids brute-scanning all order JSONs for the webhook)
async function readEmailIndex() {
  const url = await urlForKey(emailIndexKey());
  if (!url) return {};
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return {};
    return await res.json();
  } catch (_) {
    return {};
  }
}

async function indexEmail(resendId, orderId) {
  const idx = await readEmailIndex();
  idx[resendId] = orderId;
  await put(emailIndexKey(), JSON.stringify(idx), {
    access: 'public',
    contentType: 'application/json',
    token: BLOB_TOKEN(),
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

async function lookupEmailOrderId(resendId) {
  const idx = await readEmailIndex();
  if (idx[resendId]) return idx[resendId];
  // Fallback: brute scan (slow but correct if index is missing)
  const all = await listOrders({ since: null });
  for (const order of all) {
    const hit = order.emails?.find(e => e.resendId === resendId);
    if (hit) return order.orderId;
  }
  return null;
}

// ---------- Photo helpers ----------

async function addPhoto(orderId, photoEntry) {
  return mutateOrder(orderId, (order) => {
    if (!Array.isArray(order.photos)) order.photos = [];
    order.photos.push({
      url: photoEntry.url,
      caption: photoEntry.caption || '',
      ts: photoEntry.ts || new Date().toISOString(),
      stage: photoEntry.stage || order.status || 'unknown',
      hidden: false,
      sentInEmailIds: photoEntry.sentInEmailIds || [],
    });
    return order;
  });
}

async function softDeletePhoto(orderId, photoUrl) {
  return mutateOrder(orderId, (order) => {
    if (!Array.isArray(order.photos)) return order;
    for (const p of order.photos) {
      if (p.url === photoUrl) p.hidden = true;
    }
    return order;
  });
}

// ---------- List ----------

async function listOrders(opts = {}) {
  const { since = null, statusFilter = null, pickupDateFilter = null, search = null } = opts;
  const blobs = await list({ prefix: 'orders/', token: BLOB_TOKEN() });
  const jsonBlobs = (blobs.blobs || []).filter(b =>
    b.pathname.endsWith('.json') &&
    !b.pathname.endsWith('_email-index.json')
  );

  const orders = [];
  for (const b of jsonBlobs) {
    try {
      const res = await fetch(b.url, { cache: 'no-store' });
      if (!res.ok) continue;
      const order = await res.json();
      if (since && order.createdAt && new Date(order.createdAt) < new Date(since)) continue;
      if (statusFilter && order.status !== statusFilter) continue;
      if (pickupDateFilter && order.pickupDate !== pickupDateFilter) continue;
      if (search) {
        const q = search.toLowerCase();
        const haystack = [
          order.orderId || '',
          order.customerName || '',
          order.customerEmail || '',
        ].join(' ').toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      orders.push(order);
    } catch (_) {
      // Skip malformed JSON
    }
  }
  // Newest first
  orders.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return orders;
}

// ---------- Helpers ----------

function newEmailLogId() {
  return 'e_' + crypto.randomBytes(4).toString('hex');
}

module.exports = {
  readOrder,
  writeOrder,
  mutateOrder,
  appendEmailLog,
  patchEmailByResendId,
  addPhoto,
  softDeletePhoto,
  listOrders,
  newEmailLogId,
  orderJsonKey,
};
