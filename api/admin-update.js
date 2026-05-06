// POST /api/admin-update?action=...&id=orderId — admin-auth required
//
// Discriminated by `action` query param:
//   send-update           — multipart: photos[] + note (+ optional nextStatus). Fires send-update email.
//   advance-status        — body: {status}. Bare advance — no auto email for non-terminal stages.
//   mark-ready            — body: {pickupDate, pickupAddress?, pickupTimeNote?}. Fires ready-for-pickup email.
//   mark-picked-up        — fires picked-up email.
//   refund-completed      — body: {refundAmountCents?}. Fires refund-confirmation email; sets canceledAt.
//   confirm-no-show       — fires no-show-checkin email.
//   soft-delete-photo     — body: {photoUrl}.
//   update-pickup-address — body: {pickupAddress}.

const { Formidable } = require('formidable');
const fs = require('fs');
const { put } = require('@vercel/blob');
const { mutateOrder, readOrder, writeOrder, addPhoto, softDeletePhoto } = require('./_lib/order-storage');
const { requireAdmin } = require('./_lib/admin-auth');
const { sendEmail } = require('./_lib/email');

const MAX_PHOTOS = 10;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const form = new Formidable({
      multiples: true,
      maxFileSize: MAX_PHOTO_BYTES,
      maxTotalFileSize: MAX_TOTAL_BYTES,
      keepExtensions: true,
      allowEmptyFiles: true,
      minFileSize: 0,
    });
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

async function readJsonBody(req) {
  // Vercel populates req.body for JSON requests when bodyParser is on (default).
  // For multipart requests we use parseMultipart instead.
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res).ok) return;

  const url = new URL(req.url, 'http://localhost');
  const action = url.searchParams.get('action');
  const orderId = url.searchParams.get('id');
  if (!action || !orderId) return res.status(400).json({ error: 'Missing action or id' });

  try {
    switch (action) {
      case 'send-update':       return await actSendUpdate(req, res, orderId);
      case 'advance-status':    return await actAdvanceStatus(req, res, orderId);
      case 'mark-ready':        return await actMarkReady(req, res, orderId);
      case 'mark-picked-up':    return await actMarkPickedUp(req, res, orderId);
      case 'refund-completed':  return await actRefundCompleted(req, res, orderId);
      case 'confirm-no-show':   return await actConfirmNoShow(req, res, orderId);
      case 'soft-delete-photo': return await actSoftDeletePhoto(req, res, orderId);
      case 'update-pickup-address': return await actUpdatePickupAddress(req, res, orderId);
      default: return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('admin-update error', { action, orderId, err: err.message });
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
}

async function actSendUpdate(req, res, orderId) {
  const { fields, files } = await parseMultipart(req);
  const get = (k) => Array.isArray(fields[k]) ? fields[k][0] : fields[k];
  const note = (get('note') || '').toString().trim().slice(0, 2000);
  const nextStatus = (get('nextStatus') || '').toString().trim();

  let photoFiles = files.photos || [];
  if (!Array.isArray(photoFiles)) photoFiles = [photoFiles];
  photoFiles = photoFiles.filter(f => f && f.size > 0);
  if (photoFiles.length > MAX_PHOTOS) return res.status(400).json({ error: `Max ${MAX_PHOTOS} photos.` });
  for (const f of photoFiles) {
    if (!ALLOWED_TYPES.has(f.mimetype)) return res.status(400).json({ error: 'Unsupported image type.' });
    if (f.size > MAX_PHOTO_BYTES) return res.status(400).json({ error: 'Photo too large.' });
  }

  // Upload photos
  const uploaded = [];
  for (let i = 0; i < photoFiles.length; i++) {
    const f = photoFiles[i];
    const safeName = (f.originalFilename || `photo-${i}`).replace(/[^a-z0-9._-]/gi, '_');
    const key = `orders/${orderId}/photo-${Date.now()}-${i}-${safeName}`;
    const buf = await fs.promises.readFile(f.filepath);
    const blob = await put(key, buf, {
      access: 'public', contentType: f.mimetype, token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    uploaded.push(blob.url);
  }

  // Mutate order: add photos, advance status if requested
  const updated = await mutateOrder(orderId, (order) => {
    if (!Array.isArray(order.photos)) order.photos = [];
    if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
    const now = new Date().toISOString();
    for (const u of uploaded) {
      order.photos.push({ url: u, caption: '', ts: now, stage: order.status, hidden: false, sentInEmailIds: [] });
    }
    if (nextStatus && nextStatus !== order.status) {
      order.status = nextStatus;
      order.statusHistory.push({ status: nextStatus, ts: now });
    }
    return order;
  });

  // Send the update email — mutates updated.emails in-memory
  const result = await sendEmail(updated, 'send-update', {
    photoUrls: uploaded,
    note,
    statusAtSend: updated.status,
  }, { trigger: 'maddie' });

  // Mark photos as sent in this email — also in-memory on the same `updated`
  // object so the single writeOrder below captures both the email log entry
  // AND the sentInEmailIds backref. (A second mutateOrder here would re-read
  // from Blob, missing the email log just pushed by sendEmail.)
  if (result.id && uploaded.length > 0 && Array.isArray(updated.photos)) {
    for (const p of updated.photos) {
      if (uploaded.includes(p.url)) {
        if (!Array.isArray(p.sentInEmailIds)) p.sentInEmailIds = [];
        p.sentInEmailIds.push(result.id);
      }
    }
  }

  // Single writeOrder captures: photos, status advance, email log entry, sentInEmailIds
  await writeOrder(orderId, updated);

  return res.status(200).json({ ok: true, emailResult: result });
}

async function actAdvanceStatus(req, res, orderId) {
  const body = await readJsonBody(req);
  const status = body.status;
  if (!status) return res.status(400).json({ error: 'Missing status' });
  await mutateOrder(orderId, (order) => {
    order.status = status;
    if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
    order.statusHistory.push({ status, ts: new Date().toISOString() });
    return order;
  });
  return res.status(200).json({ ok: true });
}

async function actMarkReady(req, res, orderId) {
  const body = await readJsonBody(req);
  const updated = await mutateOrder(orderId, (order) => {
    order.status = 'ready';
    if (body.pickupDate) order.pickupDate = body.pickupDate;
    if (body.pickupAddress) order.pickupAddress = body.pickupAddress;
    if (body.pickupTimeNote) order.pickupTimeNote = body.pickupTimeNote;
    if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
    order.statusHistory.push({ status: 'ready', ts: new Date().toISOString() });
    return order;
  });
  const result = await sendEmail(updated, 'ready-for-pickup', {
    pickupDate: updated.pickupDate,
    pickupAddress: updated.pickupAddress,
    pickupTimeNote: updated.pickupTimeNote,
  }, { trigger: 'auto' });
  await writeOrder(orderId, updated);
  return res.status(200).json({ ok: true, emailResult: result });
}

async function actMarkPickedUp(req, res, orderId) {
  const updated = await mutateOrder(orderId, (order) => {
    order.status = 'picked-up';
    if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
    order.statusHistory.push({ status: 'picked-up', ts: new Date().toISOString() });
    return order;
  });
  const result = await sendEmail(updated, 'picked-up', {}, { trigger: 'auto' });
  await writeOrder(orderId, updated);
  return res.status(200).json({ ok: true, emailResult: result });
}

async function actRefundCompleted(req, res, orderId) {
  const body = await readJsonBody(req);
  const updated = await mutateOrder(orderId, (order) => {
    order.status = 'canceled';
    order.canceledAt = new Date().toISOString();
    if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
    order.statusHistory.push({ status: 'canceled', ts: order.canceledAt });
    return order;
  });
  const result = await sendEmail(updated, 'refund-confirmation', {
    refundAmountCents: body.refundAmountCents != null ? Number(body.refundAmountCents) : updated.totalCents,
  }, { trigger: 'auto' });
  await writeOrder(orderId, updated);
  return res.status(200).json({ ok: true, emailResult: result });
}

async function actConfirmNoShow(req, res, orderId) {
  const updated = await mutateOrder(orderId, (order) => {
    order.status = 'no-show';
    if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
    order.statusHistory.push({ status: 'no-show', ts: new Date().toISOString() });
    return order;
  });
  const result = await sendEmail(updated, 'no-show-checkin', {}, { trigger: 'auto' });
  await writeOrder(orderId, updated);
  return res.status(200).json({ ok: true, emailResult: result });
}

async function actSoftDeletePhoto(req, res, orderId) {
  const body = await readJsonBody(req);
  if (!body.photoUrl) return res.status(400).json({ error: 'Missing photoUrl' });
  await softDeletePhoto(orderId, body.photoUrl);
  return res.status(200).json({ ok: true });
}

async function actUpdatePickupAddress(req, res, orderId) {
  const body = await readJsonBody(req);
  await mutateOrder(orderId, (order) => {
    if (typeof body.pickupAddress === 'string') order.pickupAddress = body.pickupAddress;
    if (typeof body.pickupTimeNote === 'string') order.pickupTimeNote = body.pickupTimeNote;
    return order;
  });
  return res.status(200).json({ ok: true });
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
