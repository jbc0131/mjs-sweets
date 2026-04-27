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
const { Resend } = require('resend');

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

  // Quick env sanity check — surface a clear error if Vercel env vars aren't set.
  // Email is the critical channel; SMS is optional (best-effort) since SignalWire
  // is sometimes flaky in trial mode. Photo storage is always required.
  const requiredAlways = ['BLOB_READ_WRITE_TOKEN', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'NOTIFY_EMAIL'];
  const missing = requiredAlways.filter(k => !process.env[k]);
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
  const name           = sanitize(get('name'));
  const phone          = sanitize(get('phone'));
  const email          = sanitize(get('email'));
  const occasion       = sanitize(get('occasion'));
  const occasionOther  = sanitize(get('occasion_other'));
  const dateNeeded     = sanitize(get('date_needed'));
  const vision         = sanitize(get('vision'));

  if (!name || !phone || !email || !occasion || !dateNeeded || !vision) {
    return res.status(400).json({
      error: 'Missing required fields',
      detail: 'Name, phone, email, occasion, date, and vision are all required.',
    });
  }

  // Phone must contain exactly 10 digits (matches client-side validation)
  if (phone.replace(/\D/g, '').length !== 10) {
    return res.status(400).json({
      error: 'Invalid phone number',
      detail: 'Please enter a valid 10-digit phone number.',
    });
  }

  // Lightweight email shape check — browser already validated, this is belt-and-suspenders
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      error: 'Invalid email address',
      detail: 'Please enter a valid email address.',
    });
  }

  // If they picked "Other," require they tell us what
  if (occasion === 'Other' && !occasionOther) {
    return res.status(400).json({
      error: 'Missing occasion details',
      detail: 'Please tell us more about the occasion.',
    });
  }
  // Combine occasion + other for downstream display
  const occasionDisplay = (occasion === 'Other' && occasionOther)
    ? `Other — ${occasionOther}`
    : occasion;

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
  // No emoji on purpose: emojis force Unicode (UCS-2) encoding, capping each
  // SMS segment at 70 chars instead of 160. Plain ASCII keeps the message in
  // GSM-7 encoding, fewer segments, lower cost, much better deliverability
  // (multi-segment messages get filtered more aggressively by US carriers).
  const lines = [
    `New custom order from ${name}`,
    `${phone} | ${email}`,
    `${occasionDisplay} - needs ${formatDate(dateNeeded)}`,
    '',
    `Vision: ${truncate(vision, 200)}`,
  ];
  if (photoUrls.length > 0) {
    lines.push('', `Photos (${photoUrls.length}):`);
    photoUrls.forEach(url => lines.push(url));
  }
  lines.push('', 'mjs-sweets.com');
  const smsBody = lines.join('\n');

  // ---- Send notifications: email (critical) + SMS (best-effort) in parallel ----
  // Email is the gating channel — far more reliable than SMS, formats cleanly
  // with photos inline, supports reply-to so Maddie can respond directly.
  // SMS still goes out as a "buzz alert" when SignalWire/carriers cooperate.
  const emailPayload = {
    name,
    phone,
    email,
    occasion: occasionDisplay,
    dateNeeded: formatDate(dateNeeded),
    vision,
    photoUrls,
  };
  const emailSubject = `New custom order from ${name} — ${occasionDisplay} (${formatDate(dateNeeded)})`;
  const emailHtml = buildOrderEmailHtml(emailPayload);
  const emailText = buildOrderEmailText(emailPayload);

  // NOTIFY_EMAIL accepts a comma-separated list — both Maddie and Jordan can
  // receive each new order notification by setting e.g.
  // NOTIFY_EMAIL=maddie@example.com, jordanbcisco@gmail.com
  const notifyRecipients = process.env.NOTIFY_EMAIL
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const resend = new Resend(process.env.RESEND_API_KEY);
  const [emailResult, smsResult] = await Promise.allSettled([
    resend.emails.send({
      from: `MJ's Sweets <${process.env.RESEND_FROM_EMAIL}>`,
      to: notifyRecipients,
      replyTo: email, // hitting Reply responds straight to the customer
      subject: emailSubject,
      html: emailHtml,
      text: emailText,
    }),
    sendSignalWireSms(smsBody),
  ]);

  const emailOk = emailResult.status === 'fulfilled' && !emailResult.value?.error;
  const smsOk = smsResult.status === 'fulfilled';

  if (!emailOk) {
    const detail = emailResult.status === 'rejected'
      ? (emailResult.reason?.message || String(emailResult.reason))
      : (emailResult.value?.error?.message || 'Unknown email error');
    console.error('Resend send error:', detail);
    return res.status(502).json({
      error: "Couldn't send notification. Please text Maddie directly at (504) 559-6466.",
      detail,
    });
  }

  if (!smsOk) {
    // SMS failure is non-fatal — log for diagnostics but the form succeeded
    // because email landed. Common while SignalWire is in trial / pre-10DLC.
    console.warn('SignalWire send failed (non-fatal):',
      smsResult.status === 'rejected' ? smsResult.reason : 'unknown');
  }

  return res.status(200).json({
    success: true,
    photoCount: photoUrls.length,
    emailSent: true,
    smsSent: smsOk,
  });
}

// SMS sender wrapped in its own function so Promise.allSettled can capture
// errors uniformly with the email send.
async function sendSignalWireSms(smsBody) {
  if (!process.env.SIGNALWIRE_PROJECT_ID || !process.env.SIGNALWIRE_API_TOKEN
   || !process.env.SIGNALWIRE_SPACE_URL || !process.env.SIGNALWIRE_FROM_NUMBER
   || !process.env.NOTIFY_PHONE) {
    throw new Error('SignalWire env vars not set; skipping SMS');
  }
  const client = RestClient(
    process.env.SIGNALWIRE_PROJECT_ID,
    process.env.SIGNALWIRE_API_TOKEN,
    { signalwireSpaceUrl: process.env.SIGNALWIRE_SPACE_URL }
  );
  return client.messages.create({
    from: process.env.SIGNALWIRE_FROM_NUMBER,
    to: process.env.NOTIFY_PHONE,
    body: smsBody,
  });
}

// ---- Email templates ----
// Inline-CSS, mobile-friendly HTML matching site brand (pink/cream/yellow).
// Photos render inline as thumbnails (clickable to full Vercel Blob URLs).
function buildOrderEmailHtml({ name, phone, email, occasion, dateNeeded, vision, photoUrls }) {
  const phoneRaw = (phone || '').replace(/\D/g, '');
  const photoTiles = (photoUrls || []).map(url => `
    <td style="padding:6px;">
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="display:inline-block;border-radius:10px;overflow:hidden;">
        <img src="${escapeHtml(url)}" alt="Inspiration photo" style="display:block;max-width:240px;width:100%;height:auto;border-radius:10px;border:0;" />
      </a>
    </td>
  `).join('');

  const photosBlock = photoUrls && photoUrls.length > 0 ? `
    <h2 style="margin:32px 0 8px;font-family:Georgia,serif;font-size:18px;font-weight:700;color:#2A1A2E;">
      Inspiration photos (${photoUrls.length})
    </h2>
    <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
      <tr>${photoTiles}</tr>
    </table>
  ` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>New custom order — MJ's Sweets</title>
</head>
<body style="margin:0;padding:0;background:#FFF8F0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2A1A2E;line-height:1.5;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FFF8F0;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(42,26,46,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#FF6B9D,#FF3B7F);padding:24px 32px;color:white;">
              <div style="font-family:Georgia,serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;opacity:0.85;">MJ's Sweets · mjs-sweets.com</div>
              <h1 style="margin:6px 0 0;font-family:Georgia,serif;font-size:24px;font-weight:700;">New custom order</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px;">
              <table cellpadding="8" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="font-weight:600;width:110px;color:#5C4A6B;font-size:14px;vertical-align:top;">From</td>
                  <td style="font-size:16px;font-weight:600;color:#2A1A2E;">${escapeHtml(name)}</td>
                </tr>
                <tr><td colspan="2" style="border-top:1px dashed #F0E2D2;height:1px;line-height:0;font-size:0;">&nbsp;</td></tr>
                <tr>
                  <td style="font-weight:600;color:#5C4A6B;font-size:14px;vertical-align:top;">Phone</td>
                  <td><a href="tel:${escapeHtml(phoneRaw)}" style="color:#FF3B7F;text-decoration:none;font-size:16px;">${escapeHtml(phone)}</a></td>
                </tr>
                <tr><td colspan="2" style="border-top:1px dashed #F0E2D2;height:1px;line-height:0;font-size:0;">&nbsp;</td></tr>
                <tr>
                  <td style="font-weight:600;color:#5C4A6B;font-size:14px;vertical-align:top;">Email</td>
                  <td><a href="mailto:${escapeHtml(email)}" style="color:#FF3B7F;text-decoration:none;font-size:16px;">${escapeHtml(email)}</a></td>
                </tr>
                <tr><td colspan="2" style="border-top:1px dashed #F0E2D2;height:1px;line-height:0;font-size:0;">&nbsp;</td></tr>
                <tr>
                  <td style="font-weight:600;color:#5C4A6B;font-size:14px;vertical-align:top;">Occasion</td>
                  <td style="font-size:16px;">${escapeHtml(occasion)}</td>
                </tr>
                <tr><td colspan="2" style="border-top:1px dashed #F0E2D2;height:1px;line-height:0;font-size:0;">&nbsp;</td></tr>
                <tr>
                  <td style="font-weight:600;color:#5C4A6B;font-size:14px;vertical-align:top;">Needed by</td>
                  <td style="font-size:16px;">${escapeHtml(dateNeeded)}</td>
                </tr>
              </table>

              <h2 style="margin:28px 0 8px;font-family:Georgia,serif;font-size:18px;font-weight:700;color:#2A1A2E;">Vision</h2>
              <div style="background:#FFF8F0;padding:16px 18px;border-radius:10px;border-left:3px solid #FF3B7F;font-size:15px;white-space:pre-wrap;">${escapeHtml(vision)}</div>

              ${photosBlock}

              <p style="margin:32px 0 0;padding-top:20px;border-top:1px dashed #F0E2D2;color:#5C4A6B;font-size:14px;">
                💡 <strong>Reply to this email</strong> to respond directly to ${escapeHtml(name)}.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#FFF8F0;padding:16px 32px;text-align:center;color:#5C4A6B;font-size:12px;">
              MJ's Sweets · Madisonville, LA · <a href="https://www.mjs-sweets.com" style="color:#FF3B7F;text-decoration:none;">mjs-sweets.com</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildOrderEmailText({ name, phone, email, occasion, dateNeeded, vision, photoUrls }) {
  const lines = [
    'NEW CUSTOM ORDER',
    '================',
    '',
    `From:      ${name}`,
    `Phone:     ${phone}`,
    `Email:     ${email}`,
    `Occasion:  ${occasion}`,
    `Needed by: ${dateNeeded}`,
    '',
    'Vision:',
    vision,
  ];
  if (photoUrls && photoUrls.length > 0) {
    lines.push('', `Inspiration photos (${photoUrls.length}):`);
    photoUrls.forEach(url => lines.push(`  ${url}`));
  }
  lines.push('', 'Reply to this email to respond directly to the customer.', '', "— MJ's Sweets · mjs-sweets.com");
  return lines.join('\n');
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
