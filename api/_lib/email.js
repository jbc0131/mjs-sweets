// Email library — 10 templates, send wrapper, computed expected/won't-fire lists,
// Resend webhook verifier. All wall-clock times in customer emails render in
// Central Time via Intl.DateTimeFormat 'America/Chicago' (DST-aware).

const { Resend } = require('resend');
const crypto = require('crypto');
const { newEmailLogId } = require('./order-storage');

const SITE_URL = () => process.env.SITE_URL || 'https://www.mjs-sweets.com';
const FROM_EMAIL = () => process.env.RESEND_FROM_EMAIL;
const FROM_NAME = "MJ's Sweets";
const NOTIFY_EMAIL = () => (process.env.NOTIFY_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean);

// ---------- Helpers ----------

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstNameOf(order) {
  if (order?.customerFirstName) return order.customerFirstName;
  const full = order?.customerName || '';
  return full.trim().split(/\s+/)[0] || 'there';
}

function formatCentralDate(isoDate) {
  // isoDate is YYYY-MM-DD; render as "Saturday, May 9"
  if (!isoDate) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 17));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

function formatCentralDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

function trackUrl(order) {
  const { signOrderToken } = require('./order-auth');
  const t = signOrderToken(order.orderId);
  return `${SITE_URL()}/order/${order.orderId}?t=${t}`;
}

function shell(title, bodyInner) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#FFF8F0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2A1A2E;line-height:1.55;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FFF8F0;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(42,26,46,0.08);">
${bodyInner}
<tr><td style="background:#FFF8F0;padding:16px 32px;text-align:center;color:#5C4A6B;font-size:12px;">MJ's Sweets · Madisonville, LA · <a href="${SITE_URL()}" style="color:#FF3B7F;text-decoration:none;">mjs-sweets.com</a></td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function header(title, subtitle) {
  return `<tr><td style="background:linear-gradient(135deg,#FF6B9D,#FF3B7F);padding:28px 32px;color:white;text-align:center;">
<div style="font-family:Georgia,serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;opacity:0.85;">MJ's Sweets</div>
<h1 style="margin:8px 0 0;font-family:Georgia,serif;font-size:24px;font-weight:700;">${escapeHtml(title)}</h1>
${subtitle ? `<div style="margin-top:6px;font-size:13px;opacity:0.95;">${escapeHtml(subtitle)}</div>` : ''}
</td></tr>`;
}

function ctaButton(label, url, color = '#FF3B7F') {
  return `<p style="margin:24px 0 0;text-align:center;">
<a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="display:inline-block;background:${color};color:white;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600;font-size:14px;">${escapeHtml(label)}</a>
</p>`;
}

// ---------- Templates ----------

function buildOrderConfirmation(order, payload) {
  const first = firstNameOf(order);
  const url = trackUrl(order);
  const subject = `Your MJ's Sweets order is confirmed! (Order #${order.orderId.slice(0, 8)})`;
  const body = `${header('Order confirmed! 🎉', `Order #${order.orderId.slice(0, 8)}`)}
<tr><td style="padding:28px 32px;">
<p style="font-size:16px;margin:0 0 16px;">Thanks for ordering, <strong>${escapeHtml(first)}</strong>!</p>
<p style="font-size:15px;color:#5C4A6B;margin:0 0 20px;">Your order is in. Bookmark the link below — you'll get updates as Maddie bakes and decorates, including photos along the way.</p>
${ctaButton('Track your order →', url)}
<p style="margin:28px 0 0;padding-top:20px;border-top:1px dashed #F0E2D2;color:#5C4A6B;font-size:14px;">Questions? Text Maddie at <a href="tel:5045596466" style="color:#FF3B7F;">(504) 559-6466</a>.</p>
</td></tr>`;
  return { subject, html: shell(subject, body), text: `Thanks for ordering, ${first}! Track your order: ${url}`, to: order.customerEmail };
}

function buildSendUpdate(order, payload) {
  const first = firstNameOf(order);
  const url = trackUrl(order);
  const photos = payload.photoUrls || [];
  const note = payload.note || '';
  const subject = photos.length > 0
    ? `📸 Update from Maddie on your order`
    : `Update from Maddie on your order`;
  const photosBlock = photos.length > 0 ? `
<table cellpadding="0" cellspacing="0" border="0" style="margin:20px auto 0;">
<tr>${photos.map(u => `<td style="padding:6px;"><img src="${escapeHtml(u)}" alt="Update photo" style="display:block;max-width:240px;width:100%;border-radius:10px;border:0;" /></td>`).join('')}</tr>
</table>` : '';
  const noteBlock = note ? `
<div style="background:#FFF8F0;padding:16px 18px;border-radius:10px;border-left:3px solid #FF3B7F;font-size:15px;white-space:pre-wrap;margin:20px 0 0;">${escapeHtml(note)}</div>` : '';
  const body = `${header(`Update for ${first}!`)}
<tr><td style="padding:28px 32px;">
<p style="font-size:15px;color:#5C4A6B;margin:0;">A quick update on your cookies:</p>
${noteBlock}
${photosBlock}
${ctaButton('See full order →', url)}
<p style="margin:28px 0 0;padding-top:20px;border-top:1px dashed #F0E2D2;color:#5C4A6B;font-size:14px;">Reply to this email to talk back to Maddie — she'll see it.</p>
</td></tr>`;
  return { subject, html: shell(subject, body), text: `Update from Maddie\n\n${note}\n\nSee full order: ${url}`, to: order.customerEmail, replyTo: NOTIFY_EMAIL()[0] };
}

function buildReadyForPickup(order, payload) {
  const first = firstNameOf(order);
  const url = trackUrl(order);
  const subject = `Your cookies are ready, ${first}! 🍪`;
  const dateStr = formatCentralDate(payload.pickupDate || order.pickupDate);
  const addrBlock = payload.pickupAddress ? `
<div style="background:#FFF8F0;padding:16px 18px;border-radius:10px;border-left:3px solid #6BCB77;margin:18px 0 0;">
<div style="font-size:13px;color:#5C4A6B;text-transform:uppercase;letter-spacing:1px;">Pickup at</div>
<div style="font-size:15px;color:#2A1A2E;margin-top:4px;white-space:pre-wrap;">${escapeHtml(payload.pickupAddress)}</div>
</div>` : '';
  const body = `${header('Cookies are ready! 🎉', dateStr ? `Pickup ${dateStr}` : '')}
<tr><td style="padding:28px 32px;">
<p style="font-size:16px;margin:0 0 16px;">Hi <strong>${escapeHtml(first)}</strong>!</p>
<p style="font-size:15px;color:#5C4A6B;margin:0 0 4px;">Your cookies are decorated and ready to go${dateStr ? ` for <strong>${escapeHtml(dateStr)}</strong>` : ''}. ${payload.pickupTimeNote ? escapeHtml(payload.pickupTimeNote) : ''}</p>
${addrBlock}
${ctaButton('See order details →', url)}
<p style="margin:28px 0 0;padding-top:20px;border-top:1px dashed #F0E2D2;color:#5C4A6B;font-size:14px;">Text Maddie at <a href="tel:5045596466" style="color:#FF3B7F;">(504) 559-6466</a> when you arrive.</p>
</td></tr>`;
  return { subject, html: shell(subject, body), text: `Hi ${first}! Your cookies are ready. ${dateStr ? 'Pickup ' + dateStr + '. ' : ''}${payload.pickupAddress || ''}\n\n${url}`, to: order.customerEmail };
}

function buildPickedUp(order, payload) {
  const first = firstNameOf(order);
  const subject = `Thanks for picking up, ${first}! 🍪`;
  const reviewUrl = 'https://www.facebook.com/mjssweets25';
  const body = `${header('Hope you love them!', '')}
<tr><td style="padding:28px 32px;">
<p style="font-size:16px;margin:0 0 16px;">Thanks for picking up, <strong>${escapeHtml(first)}</strong>!</p>
<p style="font-size:15px;color:#5C4A6B;margin:0 0 20px;">It was a pleasure baking for you. Enjoy every bite — and if anyone asks where they came from, please send them our way!</p>
${ctaButton('Leave a Facebook review ⭐', reviewUrl)}
<p style="margin:28px 0 0;padding-top:20px;border-top:1px dashed #F0E2D2;color:#5C4A6B;font-size:14px;">A review helps a tiny bakery like mine reach more sweet-toothed neighbors. Thank you! 🍪</p>
</td></tr>`;
  return { subject, html: shell(subject, body), text: `Thanks for picking up, ${first}! Leave a Facebook review: ${reviewUrl}`, to: order.customerEmail };
}

function buildRefundConfirmation(order, payload) {
  const first = firstNameOf(order);
  const amount = payload.refundAmountCents != null ? `$${(payload.refundAmountCents / 100).toFixed(2)}` : 'your full order amount';
  const subject = `Your MJ's Sweets order has been refunded`;
  const body = `${header('Refund processed', '')}
<tr><td style="padding:28px 32px;">
<p style="font-size:16px;margin:0 0 16px;">Hi <strong>${escapeHtml(first)}</strong>,</p>
<p style="font-size:15px;color:#5C4A6B;margin:0 0 16px;">Your order has been canceled and ${escapeHtml(amount)} has been refunded to your original payment method. Refunds typically clear in 1–3 business days.</p>
<p style="font-size:15px;color:#5C4A6B;margin:0 0 16px;">Sorry to miss you this round — I hope to bake for you another time! 🍪</p>
<p style="margin:28px 0 0;padding-top:20px;border-top:1px dashed #F0E2D2;color:#5C4A6B;font-size:14px;">Questions about the refund? Text Maddie at <a href="tel:5045596466" style="color:#FF3B7F;">(504) 559-6466</a>.</p>
</td></tr>`;
  return { subject, html: shell(subject, body), text: `Your order has been canceled and ${amount} refunded. Refunds clear in 1-3 business days.`, to: order.customerEmail };
}

function buildNoShowCheckin(order, payload) {
  const first = firstNameOf(order);
  const url = trackUrl(order);
  const subject = `Did we miss you, ${first}?`;
  const body = `${header(`Hey ${first} — did we miss you?`, '')}
<tr><td style="padding:28px 32px;">
<p style="font-size:15px;color:#5C4A6B;margin:0 0 16px;">Your cookies are still here waiting for you! Life happens — if you couldn't make it to pick up, just text Maddie at <a href="tel:5045596466" style="color:#FF3B7F;">(504) 559-6466</a> and we'll figure something out.</p>
${ctaButton('See your order →', url)}
</td></tr>`;
  return { subject, html: shell(subject, body), text: `Did we miss you, ${first}? Text Maddie at (504) 559-6466 to arrange pickup. Order: ${url}`, to: order.customerEmail };
}

function buildPickupTomorrow(order, payload) {
  const first = firstNameOf(order);
  const url = trackUrl(order);
  const dateStr = formatCentralDate(payload.pickupDate || order.pickupDate);
  const subject = `Your cookies are ready tomorrow!`;
  const body = `${header('Pickup is tomorrow! 🎉', dateStr)}
<tr><td style="padding:28px 32px;">
<p style="font-size:16px;margin:0 0 16px;">Hi <strong>${escapeHtml(first)}</strong>!</p>
<p style="font-size:15px;color:#5C4A6B;margin:0 0 16px;">Just a heads up — your cookies are scheduled for pickup ${dateStr ? `<strong>${escapeHtml(dateStr)}</strong>` : 'tomorrow'}. ${payload.pickupTimeNote ? escapeHtml(payload.pickupTimeNote) : ''}</p>
${ctaButton('See pickup details →', url)}
</td></tr>`;
  return { subject, html: shell(subject, body), text: `Hi ${first}! Your cookies are ready ${dateStr || 'tomorrow'}. ${url}`, to: order.customerEmail };
}

function buildPickupToday(order, payload) {
  const first = firstNameOf(order);
  const url = trackUrl(order);
  const subject = `Today's pickup day, ${first}!`;
  const addrBlock = payload.pickupAddress ? `
<div style="background:#FFF8F0;padding:16px 18px;border-radius:10px;border-left:3px solid #FF3B7F;margin:18px 0 0;">
<div style="font-size:13px;color:#5C4A6B;text-transform:uppercase;letter-spacing:1px;">Pickup at</div>
<div style="font-size:15px;color:#2A1A2E;margin-top:4px;white-space:pre-wrap;">${escapeHtml(payload.pickupAddress)}</div>
</div>` : '';
  const body = `${header('Pickup day! 🍪', '')}
<tr><td style="padding:28px 32px;">
<p style="font-size:16px;margin:0 0 16px;">Hi <strong>${escapeHtml(first)}</strong>!</p>
<p style="font-size:15px;color:#5C4A6B;margin:0 0 4px;">Today's the day. ${payload.pickupTimeNote ? escapeHtml(payload.pickupTimeNote) : ''}</p>
${addrBlock}
${ctaButton('See order →', url)}
<p style="margin:28px 0 0;padding-top:20px;border-top:1px dashed #F0E2D2;color:#5C4A6B;font-size:14px;">Text Maddie at <a href="tel:5045596466" style="color:#FF3B7F;">(504) 559-6466</a> when you arrive.</p>
</td></tr>`;
  return { subject, html: shell(subject, body), text: `Today's pickup day, ${first}! ${payload.pickupAddress || ''} ${url}`, to: order.customerEmail };
}

function buildPostPickupReview(order, payload) {
  const first = firstNameOf(order);
  const reviewUrl = 'https://www.facebook.com/mjssweets25';
  const subject = `Hope you loved them — leave us a review?`;
  const body = `${header('How were they?', '')}
<tr><td style="padding:28px 32px;">
<p style="font-size:16px;margin:0 0 16px;">Hi <strong>${escapeHtml(first)}</strong>!</p>
<p style="font-size:15px;color:#5C4A6B;margin:0 0 16px;">Hope you loved your cookies! If you have a moment, a quick Facebook review would mean the world to me. Reviews are how a one-person bakery like mine reaches new neighbors.</p>
${ctaButton('Leave a Facebook review ⭐', reviewUrl)}
<p style="margin:28px 0 0;padding-top:20px;border-top:1px dashed #F0E2D2;color:#5C4A6B;font-size:14px;">Thanks again — Maddie 🍪</p>
</td></tr>`;
  return { subject, html: shell(subject, body), text: `Hope you loved them, ${first}! Leave a review: ${reviewUrl}`, to: order.customerEmail };
}

function buildMaddieDailySummary(order, payload) {
  // 'order' is null here; payload contains the computed summary.
  const s = payload.summary || {};
  const subject = `MJ's Sweets — daily summary (${formatCentralDate(s.todayDate)})`;
  const renderRows = (rows) => rows.length === 0
    ? '<p style="font-size:14px;color:#5C4A6B;margin:6px 0;">— none —</p>'
    : rows.map(r => `<div style="padding:10px 12px;background:#FFF8F0;border-radius:8px;margin-bottom:6px;font-size:14px;"><a href="${escapeHtml(r.adminUrl)}" style="color:#2A1A2E;text-decoration:none;"><strong>${escapeHtml(r.firstName || 'Customer')}</strong> · ${escapeHtml(r.itemsSummary || '')} · <span style="color:#5C4A6B;">${escapeHtml(r.statusLabel || '')}</span></a></div>`).join('');

  const body = `${header(`Daily summary`, `${s.activeCount || 0} active orders · ${s.todayCount || 0} picking up today`)}
<tr><td style="padding:28px 32px;">
<h2 style="margin:0 0 8px;font-family:Georgia,serif;font-size:18px;color:#2A1A2E;">Today's pickups</h2>
${renderRows(s.todayPickups || [])}
${(s.yesterdayUnresolved && s.yesterdayUnresolved.length > 0) ? `<h2 style="margin:24px 0 8px;font-family:Georgia,serif;font-size:18px;color:#2A1A2E;">Yesterday's unresolved</h2>${renderRows(s.yesterdayUnresolved)}` : ''}
${(s.tomorrowConfirmed && s.tomorrowConfirmed.length > 0) ? `<h2 style="margin:24px 0 8px;font-family:Georgia,serif;font-size:18px;color:#2A1A2E;">Tomorrow's confirmed</h2>${renderRows(s.tomorrowConfirmed)}` : ''}
${(s.pastDue && s.pastDue.length > 0) ? `<h2 style="margin:24px 0 8px;font-family:Georgia,serif;font-size:18px;color:#2A1A2E;">Past-due, no resolution</h2>${renderRows(s.pastDue)}` : ''}
${ctaButton('Open admin →', `${SITE_URL()}/admin`)}
</td></tr>`;
  return { subject, html: shell(subject, body), text: `Daily summary — ${s.activeCount || 0} active orders, ${s.todayCount || 0} picking up today. Open admin: ${SITE_URL()}/admin`, to: NOTIFY_EMAIL()[0] };
}

const TEMPLATES = {
  'order-confirmation': buildOrderConfirmation,
  'send-update': buildSendUpdate,
  'ready-for-pickup': buildReadyForPickup,
  'picked-up': buildPickedUp,
  'refund-confirmation': buildRefundConfirmation,
  'no-show-checkin': buildNoShowCheckin,
  'pickup-tomorrow': buildPickupTomorrow,
  'pickup-today': buildPickupToday,
  'post-pickup-review': buildPostPickupReview,
  'maddie-daily-summary': buildMaddieDailySummary,
};

function renderEmail(type, order, payload) {
  const fn = TEMPLATES[type];
  if (!fn) throw new Error(`Unknown email type: ${type}`);
  return fn(order, payload || {});
}

// ---------- Send wrapper ----------

async function sendEmail(order, type, payload, opts = {}) {
  const { trigger = 'auto' } = opts;
  if (!process.env.RESEND_API_KEY) {
    console.error('sendEmail: RESEND_API_KEY not set; skipping');
    return { id: null, status: 'skipped', error: 'no api key' };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const rendered = renderEmail(type, order, payload);
  // Guard against empty recipient — synthesized legacy orders have no email
  // captured, and Resend will throw on empty `to`.
  const toAny = Array.isArray(rendered.to) ? rendered.to.find(Boolean) : rendered.to;
  if (!toAny) {
    console.warn('sendEmail: empty recipient; skipping', { type });
    return { id: null, status: 'skipped', error: 'no recipient' };
  }
  const id = newEmailLogId();
  const baseEntry = {
    id,
    type,
    trigger,
    ts: new Date().toISOString(),
    to: rendered.to,
    subject: rendered.subject,
    payload: payload || {},
  };
  try {
    const sendArgs = {
      from: `${FROM_NAME} <${FROM_EMAIL()}>`,
      to: Array.isArray(rendered.to) ? rendered.to : [rendered.to],
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    };
    if (rendered.replyTo) sendArgs.replyTo = rendered.replyTo;
    const result = await resend.emails.send(sendArgs);
    if (result?.error) {
      const entry = { ...baseEntry, status: 'failed', errorDetail: result.error.message || String(result.error) };
      if (Array.isArray(order?.emails)) order.emails.push(entry);
      return { id, status: 'failed', error: entry.errorDetail };
    }
    const entry = { ...baseEntry, status: 'sent', resendId: result?.data?.id || null };
    if (Array.isArray(order?.emails)) order.emails.push(entry);
    return { id, status: 'sent', resendId: entry.resendId };
  } catch (err) {
    const entry = { ...baseEntry, status: 'failed', errorDetail: err.message || String(err) };
    if (Array.isArray(order?.emails)) order.emails.push(entry);
    console.error('sendEmail: exception', { type, error: err.message });
    return { id, status: 'failed', error: err.message };
  }
}

// ---------- Computed expected/won't-fire emails ----------

function computeExpectedEmails(order) {
  const expected = [];
  const status = order.status || 'paid';
  const nonTerminal = !['picked-up', 'canceled', 'no-show'].includes(status);
  const hasFired = (type) => (order.emails || []).some(e => e.type === type && e.status === 'sent');

  if (nonTerminal && status !== 'ready' && status !== 'picked-up' && status !== 'canceled') {
    if (order.pickupDate) {
      if (!hasFired('pickup-tomorrow')) {
        expected.push({ type: 'pickup-tomorrow', label: 'Pickup tomorrow reminder', when: `Day before ${order.pickupDate} · 8am Central`, source: 'cron' });
      }
      if (!hasFired('pickup-today')) {
        expected.push({ type: 'pickup-today', label: 'Pickup today reminder', when: `${order.pickupDate} · 7am Central`, source: 'cron' });
      }
    }
    expected.push({ type: 'ready-for-pickup', label: 'Cookies are ready email', when: 'When you mark Ready', source: 'auto' });
  }

  if (status === 'ready') {
    expected.push({ type: 'picked-up', label: 'Thank-you email', when: 'When you mark Picked Up', source: 'auto' });
  }

  if (status === 'picked-up' && !hasFired('post-pickup-review')) {
    expected.push({ type: 'post-pickup-review', label: 'Post-pickup review request', when: '~24 hours after pickup · 10am Central', source: 'cron' });
  }

  if (status === 'canceled' && !hasFired('refund-confirmation')) {
    expected.push({ type: 'refund-confirmation', label: 'Refund confirmation', when: 'When you click "Refund completed"', source: 'auto' });
  }

  if (status === 'ready' && order.pickupDate) {
    expected.push({ type: 'no-show-checkin', label: 'No-show check-in', when: `48 hours after ${order.pickupDate} (if not picked up)`, source: 'auto' });
  }

  return expected;
}

function computeWontFireEmails(order) {
  const status = order.status || 'paid';
  const items = [];
  if (status !== 'canceled') {
    items.push({ type: 'refund-confirmation', label: 'Refund confirmation', condition: 'Only if order is canceled' });
  }
  if (!['ready', 'no-show'].includes(status)) {
    items.push({ type: 'no-show-checkin', label: 'No-show check-in', condition: 'Only if pickup not marked by pickup-date + 48h' });
  }
  if (status !== 'picked-up' && !(order.emails || []).some(e => e.type === 'post-pickup-review')) {
    items.push({ type: 'post-pickup-review', label: 'Post-pickup review request', condition: 'Only after pickup is marked complete' });
  }
  return items;
}

// ---------- Resend webhook verifier ----------
// Resend uses Svix-style signing: svix-id, svix-timestamp, svix-signature headers.
// signature payload = `${svix-id}.${svix-timestamp}.${rawBody}`
// `svix-signature` is space-separated `v1,base64sig` entries; accept if any match.

function verifyResendWebhook(headers, rawBody, secret) {
  const svixId = headers['svix-id'] || headers['Svix-Id'];
  const svixTs = headers['svix-timestamp'] || headers['Svix-Timestamp'];
  const svixSig = headers['svix-signature'] || headers['Svix-Signature'];
  if (!svixId || !svixTs || !svixSig || !secret) return false;

  // Replay protection: ±5 min
  const tsNum = parseInt(svixTs, 10);
  if (!Number.isFinite(tsNum)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > 300) return false;

  const cleanSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const secretBytes = Buffer.from(cleanSecret, 'base64');
  const signedPayload = `${svixId}.${svixTs}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedPayload).digest('base64');

  for (const part of String(svixSig).split(' ')) {
    const [, sig] = part.split(',');
    if (!sig) continue;
    if (sig.length !== expected.length) continue;
    if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return true;
  }
  return false;
}

module.exports = {
  sendEmail,
  renderEmail,
  computeExpectedEmails,
  computeWontFireEmails,
  verifyResendWebhook,
  formatCentralDate,
  formatCentralDateTime,
  trackUrl,
  firstNameOf,
  escapeHtml,
};
