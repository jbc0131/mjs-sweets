// POST /api/contact
//
// Receives the custom-order form (multipart/form-data with optional inspiration
// photos), uploads photos to Vercel Blob, and texts Maddie via SignalWire with
// the order details + photo URLs.
//
// SMS-only — no email backup. SignalWire is in test-enabled mode, so the SMS
// can only be sent to a verified phone number (NOTIFY_PHONE env var). When
// Maddie's number is verified later, just flip NOTIFY_PHONE in Vercel.
//
// Expected request: multipart/form-data with fields:
//   name, contact, occasion, date_needed, vision, inspiration_photos[]

// In formidable v3, CommonJS require returns a module object (not the
// constructor directly). Pull out the Formidable class explicitly.
const { Formidable } = require('formidable');
const fs = require('fs');
const { put } = require('@vercel/blob');
const { RestClient } = require('@signalwire/compatibility-api');

// Limits — generous enough for inspiration photos, tight enough to reject abuse.
const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB per photo
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB across all photos
const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const TEXT_FIELD_LIMIT = 2000;

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Quick env sanity check — surface a clear error if Vercel env vars aren't set
  const required = ['SIGNALWIRE_PROJECT_ID', 'SIGNALWIRE_API_TOKEN', 'SIGNALWIRE_SPACE_URL', 'SIGNALWIRE_FROM_NUMBER', 'NOTIFY_PHONE', 'BLOB_READ_WRITE_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Server not configured',
      detail: `Missing env vars: ${missing.join(', ')}`,
    });
  }

  let fields, files;
  try {
    ({ fields, files } = await parseMultipart(req));
  } catch (err) {
    console.error('Multipart parse error:', err);
    // Surface the actual error so we can debug from the form's red banner
    // instead of having to dig through Vercel logs every time.
    return res.status(400).json({
      error: 'Could not read your form. Try again.',
      detail: err.message || String(err),
    });
  }

  // ---- Validate text fields ----
  const get = (key) => {
    const v = fields[key];
    return Array.isArray(v) ? v[0] : v;
  };
  const name      = sanitize(get('name'));
  const contact   = sanitize(get('contact'));
  const occasion  = sanitize(get('occasion'));
  const dateNeeded = sanitize(get('date_needed'));
  const vision    = sanitize(get('vision'));

  if (!name || !contact || !occasion || !dateNeeded || !vision) {
    return res.status(400).json({
      error: 'Missing required fields',
      detail: 'Name, contact, occasion, date, and vision are all required.',
    });
  }

  // ---- Collect uploaded photos ----
  let photoFiles = files?.inspiration_photos;
  if (!photoFiles) photoFiles = [];
  if (!Array.isArray(photoFiles)) photoFiles = [photoFiles];
  // Filter empty placeholders that some browsers send for empty file inputs
  photoFiles = photoFiles.filter(f => f && f.size > 0);

  if (photoFiles.length > MAX_PHOTOS) {
    return res.status(400).json({
      error: `Too many photos (max ${MAX_PHOTOS}). Please send the most important ones.`,
    });
  }

  let totalBytes = 0;
  for (const f of photoFiles) {
    if (f.size > MAX_PHOTO_BYTES) {
      return res.status(400).json({
        error: `One photo is too large (max ${MAX_PHOTO_BYTES / 1024 / 1024} MB each).`,
      });
    }
    if (!ALLOWED_PHOTO_TYPES.has(f.mimetype)) {
      return res.status(400).json({
        error: `One photo isn't a supported image type (use JPEG, PNG, WEBP, or HEIC).`,
      });
    }
    totalBytes += f.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return res.status(400).json({ error: 'Photos total too large.' });
    }
  }

  // ---- Upload photos to Vercel Blob, get back public URLs ----
  let photoUrls = [];
  try {
    photoUrls = await Promise.all(
      photoFiles.map(async (f, idx) => {
        const safeName = (f.originalFilename || `photo-${idx + 1}`).replace(/[^a-z0-9._-]/gi, '_');
        const key = `inspiration/${Date.now()}-${idx}-${safeName}`;
        // Read into a Buffer first — @vercel/blob v2 doesn't always
        // accept Node fs ReadStreams; Buffer is the most reliable input.
        const buffer = await fs.promises.readFile(f.filepath);
        const blob = await put(key, buffer, {
          access: 'public',
          contentType: f.mimetype,
          token: process.env.BLOB_READ_WRITE_TOKEN,
        });
        return blob.url;
      })
    );
  } catch (err) {
    console.error('Blob upload error:', err);
    return res.status(500).json({
      error: 'Could not upload photos. Try again or text them directly.',
      detail: err.message || String(err),
    });
  }

  // ---- Build SMS body ----
  const lines = [
    '🍪 New custom order request',
    '',
    `From: ${name}`,
    `Reach: ${contact}`,
    `Occasion: ${occasion}`,
    `Needed by: ${formatDate(dateNeeded)}`,
    '',
    `Vision: ${truncate(vision, 400)}`,
  ];
  if (photoUrls.length > 0) {
    lines.push('', `Photos (${photoUrls.length}):`);
    photoUrls.forEach(url => lines.push(url));
  }
  lines.push('', 'via mjs-sweets.com');
  const smsBody = lines.join('\n');

  // ---- Send the SMS via SignalWire ----
  try {
    const client = RestClient(
      process.env.SIGNALWIRE_PROJECT_ID,
      process.env.SIGNALWIRE_API_TOKEN,
      { signalwireSpaceUrl: process.env.SIGNALWIRE_SPACE_URL }
    );
    await client.messages.create({
      from: process.env.SIGNALWIRE_FROM_NUMBER,
      to: process.env.NOTIFY_PHONE,
      body: smsBody,
    });
  } catch (err) {
    console.error('SignalWire send error:', err);
    // Photos are uploaded but SMS failed — log loudly so we can manually rescue
    return res.status(502).json({
      error: "Couldn't send notification. Maddie wasn't reached — please text her directly at (504) 559-6466.",
    });
  }

  return res.status(200).json({
    success: true,
    photoCount: photoUrls.length,
  });
}

// Disable Vercel's automatic body parser — formidable handles multipart itself.
// IMPORTANT: this MUST be set AFTER `handler` is defined so module.exports
// holds both the function and the config attached to it. If you ever change
// the export style, make sure the function and its `.config` end up on the
// same module.exports object.
handler.config = {
  api: { bodyParser: false },
};

module.exports = handler;

// ---------- Helpers ----------

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const form = new Formidable({
      multiples: true,
      maxFileSize: MAX_PHOTO_BYTES,
      maxTotalFileSize: MAX_TOTAL_BYTES,
      keepExtensions: true,
      // Browsers send empty file inputs even when no file is selected. Without
      // this, formidable rejects the whole submission as "file size should be
      // greater than 0". We filter empties ourselves below.
      allowEmptyFiles: true,
      minFileSize: 0,
    });
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

function sanitize(value) {
  if (typeof value !== 'string') return '';
  // Strip control chars + truncate. Newlines are allowed (vision can be multiline).
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim()
    .slice(0, TEXT_FIELD_LIMIT);
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

function formatDate(iso) {
  // Form sends YYYY-MM-DD; render as e.g., "May 15, 2026"
  if (!iso) return iso;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
