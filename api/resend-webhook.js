// POST /api/resend-webhook
// Verifies Svix-style signature using RESEND_WEBHOOK_SECRET, then patches
// emails[i] on the matching order with deliveredAt/openedAt/failed state.
// Always returns 200 (with logged warnings for unfindable resendIds) to avoid
// Resend retry storms.

const { verifyResendWebhook } = require('./_lib/email');
const { patchEmailByResendId } = require('./_lib/order-storage');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const raw = await readRawBody(req);
  const ok = verifyResendWebhook(req.headers, raw, process.env.RESEND_WEBHOOK_SECRET);
  if (!ok) {
    console.warn('resend-webhook: signature verification failed');
    return res.status(401).json({ error: 'invalid signature' });
  }

  let event;
  try { event = JSON.parse(raw); } catch (_) {
    return res.status(400).json({ error: 'bad json' });
  }

  const type = event.type;
  const data = event.data || {};
  const resendId = data.email_id || data.id;
  if (!resendId) {
    console.warn('resend-webhook: missing resend id in payload', { type });
    return res.status(200).json({ ok: true, ignored: 'no resend id' });
  }

  const now = new Date().toISOString();
  const patch = {};
  switch (type) {
    case 'email.delivered':  patch.deliveredAt = now; break;
    case 'email.opened':     patch.openedAt = now; break;
    case 'email.bounced':    patch.status = 'failed'; patch.errorDetail = 'bounced'; break;
    case 'email.complained': patch.status = 'failed'; patch.errorDetail = 'spam complaint'; break;
    case 'email.delivery_delayed': /* noop, transient */ break;
    case 'email.failed':     patch.status = 'failed'; patch.errorDetail = data.failed?.reason || 'failed'; break;
    default:
      // Ignore unknown event types but ack with 200
      return res.status(200).json({ ok: true, ignored: `unhandled type: ${type}` });
  }
  if (Object.keys(patch).length === 0) {
    return res.status(200).json({ ok: true, ignored: 'noop' });
  }

  try {
    const found = await patchEmailByResendId(resendId, patch);
    if (!found) {
      console.warn('resend-webhook: resendId not found in any order', { resendId, type });
    }
    return res.status(200).json({ ok: true, type, resendId, applied: !!found });
  } catch (err) {
    console.error('resend-webhook: patch error', err.message);
    return res.status(200).json({ ok: true, error: err.message });
  }
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
