// POST /api/contact
//
// PAID custom-order endpoint. Receives the custom-order form (multipart with
// optional inspiration photos), validates fields + tier + qty + lead time,
// uploads photos to Vercel Blob, then:
//   1. Fetches authoritative tier price from Square Catalog (don't trust client)
//   2. Creates a Square Order with the tier SKU × qty
//   3. Charges the customer via Square Payments using the tokenized card / wallet
//   4. Sends Maddie an order email + customer a confirmation email + Maddie an SMS
//
// Notification failures POST-CHARGE are non-fatal: the customer is already
// charged, so we MUST return 200 with `notificationsSent` flags rather than
// surface a 502 that would prompt a duplicate submission. The Square dashboard
// is the durable source of truth.
//
// Charge failures DO return 402 with Square's error detail. Photos may orphan
// on Blob in that case — acceptable cost.
//
// Idempotency: client generates a UUID on modal open and sends it as
// `idempotencyKey`. We pass it to Square Order create AND derive a paired key
// for Payment create, so a retried POST collapses to one Order + one Payment.
//
// Expected multipart fields:
//   name, phone, email, occasion, occasion_other?, date_needed,
//   vision, inspiration_photos[]?, tier, dozens, paymentToken,
//   paymentMethod?, idempotencyKey

const { Formidable } = require('formidable');
const fs = require('fs');
const { put } = require('@vercel/blob');
const { Client, Environment, ApiError } = require('square');
const { RestClient } = require('@signalwire/compatibility-api');
const { Resend } = require('resend');
const { ensureCustomer, splitName } = require('./_lib/squareCustomer');
const { writeOrder } = require('./_lib/order-storage');
const { sendEmail } = require('./_lib/email');

// ---- Limits ----
const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;        // 5 MB per photo
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;       // 20 MB across all photos
const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const TEXT_FIELD_LIMIT = 2000;
const LEAD_TIME_DAYS = 14;
const MIN_DOZENS = 1;
const MAX_DOZENS = 10;

// ---- Tier whitelist ----
// SKUs match what's in Square's Item Library. Prices fetched from Catalog
// at request time — these constants are only used for tier-name lookup in the
// email templates and as a sanity floor on the catalog response.
const ALLOWED_TIER_SKUS = new Set(['CUSTOM-SIG-DZN', 'CUSTOM-SHOW-DZN']);
const TIER_DISPLAY_NAME = {
  'CUSTOM-SIG-DZN':  'Signature Custom Dozen',
  'CUSTOM-SHOW-DZN': 'Showstopper Custom Dozen',
};

// ---- Optional add-ons whitelist ----
// Cake pop variations (POP-*) + KRIS-DZ + PRETZ-DZ. Server fetches authoritative
// prices from Square Catalog; this set is only for input validation. Sanity
// price floor for add-ons is wider than the tier check since they're cheaper.
const ALLOWED_ADDON_SKUS = new Set([
  'POP-CHOC', 'POP-VAN', 'POP-FUN', 'POP-RV', 'POP-LEM', 'POP-STR',
  'KRIS-DZ', 'PRETZ-DZ',
]);
const MAX_ADDON_LINES = 8; // 3 distinct add-on rows in the UI; cap defensively.
const ADDON_PRICE_CENTS_MIN = 100;     // catches accidental zero
const ADDON_PRICE_CENTS_MAX = 10_000;  // catches wildly wrong catalog data

// ---- Square client ----
const square = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    (process.env.SQUARE_ENVIRONMENT || 'sandbox') === 'production'
      ? Environment.Production
      : Environment.Sandbox,
});

// ---- Catalog cache (mirrors the pattern in api/checkout.js) ----
// Keep in sync with checkout.js. If we add a third Square-charging endpoint
// it's worth extracting both copies into api/_lib/squareCatalog.js. For two
// callers, duplication is the cheaper choice.
const CATALOG_TTL_MS = 60_000;
const catalogCache = new Map(); // sku -> { entry, expiresAt }

async function fetchCatalogEntries(skus) {
  const uniqueSkus = [...new Set(skus)];
  const now = Date.now();
  const result = {};
  const toFetch = [];

  for (const sku of uniqueSkus) {
    const cached = catalogCache.get(sku);
    if (cached && cached.expiresAt > now) {
      result[sku] = cached.entry;
    } else {
      toFetch.push(sku);
    }
  }

  if (toFetch.length === 0) return result;

  const apiRes = await square.catalogApi.searchCatalogObjects({
    objectTypes: ['ITEM_VARIATION'],
    query: {
      setQuery: {
        attributeName: 'sku',
        attributeValues: toFetch,
      },
    },
    includeRelatedObjects: true,
  });

  const variations = apiRes.result.objects || [];
  const relatedItems = (apiRes.result.relatedObjects || []).filter(o => o.type === 'ITEM');
  const itemById = new Map(relatedItems.map(it => [it.id, it]));

  for (const v of variations) {
    if (v.isDeleted) continue;
    const data = v.itemVariationData;
    if (!data?.sku || !data.priceMoney?.amount) continue;
    const parent = itemById.get(data.itemId);
    if (!parent || parent.isDeleted) continue;
    if (parent.itemData?.isArchived) continue;

    // If the parent item has multiple variations (e.g., Cake Pops with 6
    // flavors), include the variation name so emails show "Cake Pops,
    // Chocolate" instead of just "Cake Pops". For single-variation items
    // (tiers, KRIS-DZ, PRETZ-DZ) the variation name is just a unit label
    // ("1 Dozen") and we drop it.
    const itemName = parent.itemData?.name || TIER_DISPLAY_NAME[data.sku] || 'Item';
    const variationName = data.name || '';
    const variationCount = parent.itemData?.variations?.length || 1;
    const displayName = (variationCount > 1 && variationName)
      ? `${itemName}, ${variationName}`
      : itemName;

    const entry = {
      name: displayName,
      priceCents: Number(data.priceMoney.amount),
      currency: data.priceMoney.currency || 'USD',
      catalogObjectId: v.id,
    };
    result[data.sku] = entry;
    catalogCache.set(data.sku, { entry, expiresAt: now + CATALOG_TTL_MS });
  }

  return result;
}

// =========================================================================
// Handler
// =========================================================================

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Env sanity. Email + Square + Blob are all required to take an order.
  // SMS is best-effort, so SignalWire env is checked at send time.
  const requiredAlways = [
    'BLOB_READ_WRITE_TOKEN',
    'RESEND_API_KEY',
    'RESEND_FROM_EMAIL',
    'NOTIFY_EMAIL',
    'SQUARE_ACCESS_TOKEN',
    'SQUARE_LOCATION_ID',
  ];
  const missing = requiredAlways.filter(k => !process.env[k]);
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Server not configured',
      detail: `Missing env vars: ${missing.join(', ')}`,
    });
  }

  // ---- Parse multipart ----
  let fields, files;
  try {
    ({ fields, files } = await parseMultipart(req));
  } catch (err) {
    console.error('Multipart parse error:', err);
    return res.status(400).json({
      error: 'Could not read your form. Try again.',
      detail: err.message || String(err),
    });
  }

  const get = (key) => {
    const v = fields[key];
    return Array.isArray(v) ? v[0] : v;
  };

  // ---- Validate text fields ----
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

  if (phone.replace(/\D/g, '').length !== 10) {
    return res.status(400).json({
      error: 'Invalid phone number',
      detail: 'Please enter a valid 10-digit phone number.',
    });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      error: 'Invalid email address',
      detail: 'Please enter a valid email address.',
    });
  }

  if (occasion === 'Other' && !occasionOther) {
    return res.status(400).json({
      error: 'Missing occasion details',
      detail: 'Please tell us more about the occasion.',
    });
  }
  const occasionDisplay = (occasion === 'Other' && occasionOther)
    ? `Other — ${occasionOther}`
    : occasion;

  // ---- Validate paid-order fields ----
  const tier = sanitize(get('tier'));
  const dozensRaw = sanitize(get('dozens'));
  const paymentToken = sanitize(get('paymentToken'));
  const paymentMethod = sanitize(get('paymentMethod')) || 'card';
  const idempotencyKey = sanitize(get('idempotencyKey'));

  if (!ALLOWED_TIER_SKUS.has(tier)) {
    return res.status(400).json({
      error: 'Invalid tier',
      detail: 'Please pick a tier (Signature or Showstopper).',
    });
  }

  const dozens = parseInt(dozensRaw, 10);
  if (!Number.isInteger(dozens) || dozens < MIN_DOZENS || dozens > MAX_DOZENS) {
    return res.status(400).json({
      error: 'Invalid quantity',
      detail: `Quantity must be between ${MIN_DOZENS} and ${MAX_DOZENS} dozen.`,
    });
  }

  if (!paymentToken || paymentToken.length < 4) {
    return res.status(400).json({
      error: 'Missing payment token',
      detail: 'Payment was not tokenized. Please refresh and try again.',
    });
  }

  // Square idempotency keys are capped at 45 chars. UUIDv4 is 36 chars.
  // The 39-char ceiling here is LOAD-BEARING: the squareCustomer helper derives
  // `${idempotencyKey}-cust` (5 extra chars) for the createCustomer call, so the
  // parent must stay ≤ 39 to keep the derived key ≤ 44 (one under Square's 45
  // cap). Don't loosen without updating api/_lib/squareCustomer.js.
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 39) {
    return res.status(400).json({
      error: 'Missing or malformed idempotency key',
      detail: 'Please refresh the page and try again.',
    });
  }

  if (!isDateAtLeast14Days(dateNeeded)) {
    return res.status(400).json({
      error: 'Lead time too short',
      detail: `Custom orders need at least ${LEAD_TIME_DAYS} days lead time. Please pick a later date.`,
    });
  }

  // ---- Parse + validate add-ons (cake pops, rice krispies, pretzel rods) ----
  // The client sends these as a JSON-stringified array of {sku, qty}. Empty or
  // missing addons field is fine — the order is just a tier-only purchase.
  let requestedAddons = [];
  const addonsRaw = sanitize(get('addons'));
  if (addonsRaw) {
    let parsed;
    try {
      parsed = JSON.parse(addonsRaw);
    } catch (_) {
      return res.status(400).json({ error: 'Invalid add-ons format' });
    }
    if (!Array.isArray(parsed)) {
      return res.status(400).json({ error: 'Invalid add-ons format' });
    }
    if (parsed.length > MAX_ADDON_LINES) {
      return res.status(400).json({ error: `Too many add-on lines (max ${MAX_ADDON_LINES}).` });
    }
    // Coalesce duplicate SKUs by summing qty (defensive — client shouldn't send
    // dupes but a malformed payload could). Validates each row before adding.
    const seen = new Map();
    for (const a of parsed) {
      if (!a || typeof a !== 'object') {
        return res.status(400).json({ error: 'Invalid add-on entry' });
      }
      const sku = String(a.sku || '').trim();
      if (!ALLOWED_ADDON_SKUS.has(sku)) {
        return res.status(400).json({ error: `Unknown add-on SKU: ${sku}` });
      }
      const q = parseInt(a.qty, 10);
      if (!Number.isInteger(q) || q < 1 || q > 10) {
        return res.status(400).json({ error: `Invalid add-on quantity for ${sku}` });
      }
      seen.set(sku, (seen.get(sku) || 0) + q);
    }
    for (const [sku, qty] of seen.entries()) {
      if (qty > 10) {
        return res.status(400).json({ error: `Add-on quantity exceeds max (10) for ${sku}` });
      }
      requestedAddons.push({ sku, qty });
    }
  }

  // ---- Collect uploaded photos ----
  let photoFiles = files?.inspiration_photos;
  if (!photoFiles) photoFiles = [];
  if (!Array.isArray(photoFiles)) photoFiles = [photoFiles];
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

  // ---- Upload photos to Vercel Blob ----
  // Photos uploaded BEFORE charging — accepting potential orphans on charge
  // failure rather than risk paying customers losing their attached photos.
  let photoUrls = [];
  try {
    photoUrls = await Promise.all(
      photoFiles.map(async (f, idx) => {
        const safeName = (f.originalFilename || `photo-${idx + 1}`).replace(/[^a-z0-9._-]/gi, '_');
        const key = `inspiration/${Date.now()}-${idx}-${safeName}`;
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
      error: 'Could not upload photos. Try again or text them directly to (504) 559-6466.',
      detail: err.message || String(err),
    });
  }

  // ---- Fetch authoritative prices from Square Catalog (tier + add-ons) ----
  // Single Catalog call covers everything; cached responses are reused.
  const allSkus = [tier, ...requestedAddons.map(a => a.sku)];
  let catalog;
  try {
    catalog = await fetchCatalogEntries(allSkus);
  } catch (err) {
    console.error('Catalog fetch error:', err);
    return res.status(502).json({
      error: 'Could not look up pricing. Try again in a moment.',
      detail: err.message || String(err),
    });
  }

  const tierEntry = catalog[tier];
  if (!tierEntry) {
    return res.status(400).json({
      error: 'Tier not currently available',
      detail: `Tier ${tier} isn't sellable in Square right now. Please text Maddie at (504) 559-6466.`,
    });
  }
  if (tierEntry.priceCents < 1000 || tierEntry.priceCents > 20_000) {
    console.error('Tier price out of expected range', { tier, priceCents: tierEntry.priceCents });
    return res.status(500).json({
      error: 'Tier pricing looks wrong. Please text Maddie at (504) 559-6466.',
    });
  }

  // Build line items array — tier first, then each add-on. We carry both the
  // Square line-item shape (for createOrder) and a lighter display copy used
  // in emails / SMS / payment note.
  const orderLineItems = [{
    catalogObjectId: tierEntry.catalogObjectId,
    quantity: String(dozens),
    basePriceMoney: { amount: BigInt(tierEntry.priceCents), currency: tierEntry.currency },
    name: TIER_DISPLAY_NAME[tier] || tierEntry.name,
  }];
  const displayLines = [{
    name: TIER_DISPLAY_NAME[tier] || tierEntry.name,
    qty: dozens,
    priceCents: tierEntry.priceCents,
    subtotalCents: tierEntry.priceCents * dozens,
  }];
  let totalCents = tierEntry.priceCents * dozens;

  for (const a of requestedAddons) {
    const e = catalog[a.sku];
    if (!e) {
      return res.status(400).json({
        error: 'Add-on not currently available',
        detail: `${a.sku} isn't sellable in Square right now. Please text Maddie at (504) 559-6466.`,
      });
    }
    if (e.priceCents < ADDON_PRICE_CENTS_MIN || e.priceCents > ADDON_PRICE_CENTS_MAX) {
      console.error('Add-on price out of expected range', { sku: a.sku, priceCents: e.priceCents });
      return res.status(500).json({
        error: 'Add-on pricing looks wrong. Please text Maddie at (504) 559-6466.',
      });
    }
    orderLineItems.push({
      catalogObjectId: e.catalogObjectId,
      quantity: String(a.qty),
      basePriceMoney: { amount: BigInt(e.priceCents), currency: e.currency },
      name: e.name,
    });
    const sub = e.priceCents * a.qty;
    displayLines.push({ name: e.name, qty: a.qty, priceCents: e.priceCents, subtotalCents: sub });
    totalCents += sub;
  }

  // ---- Ensure Customer Directory record (best-effort, never blocks charge) ----
  // Failure here returns null and we proceed without `customerId`. Customer
  // Directory is observability / marketing infrastructure — its unavailability
  // must never break a sale. Runs AFTER blob upload (photos already orphan-
  // acceptable on charge failure) and BEFORE createOrder so the order can
  // attach to the Customer record on success.
  const customerId = await ensureCustomer(square, {
    name,
    email,
    phone,
    parentIdempotencyKey: idempotencyKey,
  });

  // ---- Create Square Order + Charge ----
  // Both calls use idempotency keys derived from the client-provided UUID,
  // so a retried POST collapses to one Order + one Payment + one Customer.
  let orderId, paymentId, receiptUrl;
  try {
    const orderRes = await square.ordersApi.createOrder({
      idempotencyKey: idempotencyKey,
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        ...(customerId && { customerId }),
        lineItems: orderLineItems,
        metadata: {
          source: 'mjssweets-website',
          flow: 'custom-order',
          tier: tier,
          dozens: String(dozens),
          addon_count: String(requestedAddons.length),
          customer_name: name.slice(0, 100),
          customer_phone: phone.slice(0, 20),
          occasion: occasionDisplay.slice(0, 100),
          date_needed: dateNeeded.slice(0, 20),
          payment_method: paymentMethod.slice(0, 20),
        },
      },
    });
    orderId = orderRes.result.order.id;

    const noteSummary = requestedAddons.length > 0
      ? `Custom: ${TIER_DISPLAY_NAME[tier]} × ${dozens} + ${requestedAddons.length} add-on${requestedAddons.length === 1 ? '' : 's'} · ${name} · needs ${dateNeeded}`
      : `Custom: ${TIER_DISPLAY_NAME[tier]} × ${dozens} · ${name} · needs ${dateNeeded}`;

    const paymentRes = await square.paymentsApi.createPayment({
      idempotencyKey: `${idempotencyKey}-pay`,
      sourceId: paymentToken,
      amountMoney: {
        amount: BigInt(totalCents),
        currency: 'USD',
      },
      orderId,
      buyerEmailAddress: email,
      note: noteSummary.slice(0, 500), // Square caps note length
    });
    paymentId = paymentRes.result.payment.id;
    receiptUrl = paymentRes.result.payment.receiptUrl;
  } catch (err) {
    if (err instanceof ApiError) {
      const detail = err.errors?.[0]?.detail || err.message || 'Square rejected the request';
      console.error('Square API error (custom-order):', JSON.stringify(err.errors, null, 2));
      return res.status(402).json({ error: 'Payment failed', detail });
    }
    console.error('Square unexpected error (custom-order):', err);
    return res.status(500).json({ error: 'Unexpected server error' });
  }

  // ============================================================
  // Charge succeeded. Below this point all failures are NON-FATAL.
  // The customer's card has been charged; returning a non-2xx here
  // would prompt them to retry → double charge. We always return
  // 200 with notificationsSent flags so the client can render an
  // appropriate fallback message if email/SMS didn't go out.
  // ============================================================

  const orderShortId = (orderId || '').slice(0, 8) || 'order';

  // ---- Persist order JSON for the tracking page ----
  // Best-effort post-charge. The existing custom-order emails fire below
  // with their own HTML; this just makes /order/{id} resolve.
  try {
    const { givenName } = splitName(name);
    const orderRecord = {
      orderId,
      createdAt: new Date().toISOString(),
      status: 'paid',
      statusHistory: [{ status: 'paid', ts: new Date().toISOString(), auto: true }],
      photos: [],
      notes: [],
      emails: [],
      pickupAddress: '',
      pickupWindow: '',
      pickupDate: null,
      pickupTimeNote: dateNeeded ? `Needed by ${dateNeeded}` : '',
      canceledAt: null,
      customerId,
      customerName: name,
      customerEmail: email,
      customerPhone: phone,
      customerFirstName: givenName,
      lineItems: displayLines.map(li => ({
        name: li.name,
        quantity: String(li.qty),
        priceCents: li.priceCents,
      })),
      totalCents,
      flow: 'custom-order',
      occasion: occasionDisplay,
      vision,
      photoUrls,
    };
    await writeOrder(orderId, orderRecord);
  } catch (persistErr) {
    console.error('Order persistence error (non-fatal):', persistErr.message);
  }

  // Build email payloads. `lineItems` lets the templates render a full
  // breakdown (tier + each add-on) rather than just the tier line.
  const orderPayload = {
    name,
    phone,
    email,
    occasion: occasionDisplay,
    dateNeeded: formatDate(dateNeeded),
    dateNeededRaw: dateNeeded,
    vision,
    photoUrls,
    tier,
    tierName: TIER_DISPLAY_NAME[tier],
    dozens,
    addonCount: requestedAddons.length,
    lineItems: displayLines, // [{ name, qty, priceCents, subtotalCents }, ...]
    totalCents,
    orderId,
    orderShortId,
    paymentId,
    receiptUrl,
  };

  const maddieSubject = `New custom order from ${name} — ${occasionDisplay} (${formatDate(dateNeeded)})`;
  const maddieHtml = buildOrderEmailHtml(orderPayload);
  const maddieText = buildOrderEmailText(orderPayload);

  const customerSubject = `Your MJ's Sweets custom order is reserved! (Order #${orderShortId})`;
  const customerHtml = buildCustomerEmailHtml(orderPayload);
  const customerText = buildCustomerEmailText(orderPayload);

  const notifyRecipients = process.env.NOTIFY_EMAIL
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const resend = new Resend(process.env.RESEND_API_KEY);

  // SMS body — kept ASCII so it stays in GSM-7 encoding (160-char segments).
  // Lists tier first then each add-on so Maddie sees the full bundle at a glance.
  const smsLines = [
    `PAID custom order from ${name}`,
    `Total: $${(totalCents / 100).toFixed(2)}`,
  ];
  for (const li of displayLines) {
    smsLines.push(`- ${li.name} x ${li.qty} = $${(li.subtotalCents / 100).toFixed(2)}`);
  }
  smsLines.push(
    '',
    `${phone} | ${email}`,
    `${occasionDisplay} - needs ${formatDate(dateNeeded)}`,
    '',
    `Vision: ${truncate(vision, 160)}`,
  );
  if (photoUrls.length > 0) {
    smsLines.push('', `Photos (${photoUrls.length}):`);
    photoUrls.forEach(url => smsLines.push(url));
  }
  smsLines.push('', `Order: ${orderShortId}`, 'mjs-sweets.com');
  const smsBody = smsLines.join('\n');

  // Fire all three notifications in parallel — none of them gate the response.
  const [maddieEmailResult, customerEmailResult, smsResult] = await Promise.allSettled([
    resend.emails.send({
      from: `MJ's Sweets <${process.env.RESEND_FROM_EMAIL}>`,
      to: notifyRecipients,
      replyTo: email,
      subject: maddieSubject,
      html: maddieHtml,
      text: maddieText,
    }),
    resend.emails.send({
      from: `MJ's Sweets <${process.env.RESEND_FROM_EMAIL}>`,
      to: [email],
      replyTo: process.env.RESEND_FROM_EMAIL,
      subject: customerSubject,
      html: customerHtml,
      text: customerText,
    }),
    sendSignalWireSms(smsBody),
  ]);

  const maddieEmailOk   = maddieEmailResult.status === 'fulfilled'   && !maddieEmailResult.value?.error;
  const customerEmailOk = customerEmailResult.status === 'fulfilled' && !customerEmailResult.value?.error;
  const smsOk           = smsResult.status === 'fulfilled';

  if (!maddieEmailOk) {
    const detail = maddieEmailResult.status === 'rejected'
      ? (maddieEmailResult.reason?.message || String(maddieEmailResult.reason))
      : (maddieEmailResult.value?.error?.message || 'Unknown email error');
    console.error('Maddie email failed (post-charge, non-fatal):', detail, { orderId });
  }
  if (!customerEmailOk) {
    const detail = customerEmailResult.status === 'rejected'
      ? (customerEmailResult.reason?.message || String(customerEmailResult.reason))
      : (customerEmailResult.value?.error?.message || 'Unknown email error');
    console.error('Customer email failed (post-charge, non-fatal):', detail, { orderId, email });
  }
  if (!smsOk) {
    console.warn('SignalWire send failed (non-fatal):',
      smsResult.status === 'rejected' ? smsResult.reason : 'unknown', { orderId });
  }

  return res.status(200).json({
    success: true,
    orderId,
    orderShortId,
    paymentId,
    receiptUrl,
    totalCents,
    photoCount: photoUrls.length,
    notificationsSent: {
      maddieEmail:   maddieEmailOk,
      customerEmail: customerEmailOk,
      sms:           smsOk,
    },
  });
}

// =========================================================================
// SMS sender
// =========================================================================

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

// =========================================================================
// Email templates — Maddie's notification (enhanced) + customer confirmation (new)
// =========================================================================

// Renders the order's line items as <br>-separated rows inside one table cell.
// Used in both Maddie's notification email and the customer confirmation email,
// so cake-pop flavors and bundled add-ons show up cleanly in both.
function buildItemsRowHtml(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return '';
  const rows = lineItems.map(li => {
    const sub = `$${(li.subtotalCents / 100).toFixed(2)}`;
    return `${escapeHtml(li.name)} <span style="color:#5C4A6B;">× ${escapeHtml(String(li.qty))}</span> &nbsp;·&nbsp; <strong>${escapeHtml(sub)}</strong>`;
  }).join('<br>');
  return `
    <tr>
      <td style="font-weight:600;color:#5C4A6B;font-size:14px;vertical-align:top;width:110px;padding-top:10px;">Items</td>
      <td style="font-size:15px;color:#2A1A2E;line-height:1.8;">
        ${rows}
      </td>
    </tr>
    <tr><td colspan="2" style="border-top:1px dashed #F0E2D2;height:1px;line-height:0;font-size:0;">&nbsp;</td></tr>`;
}

// Plain-text version — returns an array of indented lines that the caller
// splices into its line list.
function buildItemsTextLines(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return [];
  return lineItems.map(li =>
    `  ${li.name} × ${li.qty} = $${(li.subtotalCents / 100).toFixed(2)}`
  );
}

function buildOrderEmailHtml(p) {
  const phoneRaw = (p.phone || '').replace(/\D/g, '');
  const totalUsd = `$${(p.totalCents / 100).toFixed(2)}`;
  const itemsRow = buildItemsRowHtml(p.lineItems);
  const photoTiles = (p.photoUrls || []).map(url => `
    <td style="padding:6px;">
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="display:inline-block;border-radius:10px;overflow:hidden;">
        <img src="${escapeHtml(url)}" alt="Inspiration photo" style="display:block;max-width:240px;width:100%;height:auto;border-radius:10px;border:0;" />
      </a>
    </td>
  `).join('');

  const photosBlock = p.photoUrls && p.photoUrls.length > 0 ? `
    <h2 style="margin:32px 0 8px;font-family:Georgia,serif;font-size:18px;font-weight:700;color:#2A1A2E;">
      Inspiration photos (${p.photoUrls.length})
    </h2>
    <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
      <tr>${photoTiles}</tr>
    </table>
  ` : '';

  const receiptBlock = p.receiptUrl ? `
    <p style="margin:24px 0 0;text-align:center;">
      <a href="${escapeHtml(p.receiptUrl)}" target="_blank" rel="noopener"
         style="display:inline-block;background:#2A1A2E;color:#FFF8F0;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600;font-size:14px;">
        View Square receipt →
      </a>
    </p>
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
              <h1 style="margin:6px 0 0;font-family:Georgia,serif;font-size:24px;font-weight:700;">💰 New custom order — paid in full</h1>
              <div style="margin-top:6px;font-size:13px;opacity:0.9;">Order #${escapeHtml(p.orderShortId)} · ${escapeHtml(totalUsd)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px;">
              <table cellpadding="8" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="font-weight:600;width:110px;color:#5C4A6B;font-size:14px;vertical-align:top;">From</td>
                  <td style="font-size:16px;font-weight:600;color:#2A1A2E;">${escapeHtml(p.name)}</td>
                </tr>
                <tr><td colspan="2" style="border-top:1px dashed #F0E2D2;height:1px;line-height:0;font-size:0;">&nbsp;</td></tr>
                <tr>
                  <td style="font-weight:600;color:#5C4A6B;font-size:14px;vertical-align:top;">Phone</td>
                  <td><a href="tel:${escapeHtml(phoneRaw)}" style="color:#FF3B7F;text-decoration:none;font-size:16px;">${escapeHtml(p.phone)}</a></td>
                </tr>
                <tr><td colspan="2" style="border-top:1px dashed #F0E2D2;height:1px;line-height:0;font-size:0;">&nbsp;</td></tr>
                <tr>
                  <td style="font-weight:600;color:#5C4A6B;font-size:14px;vertical-align:top;">Email</td>
                  <td><a href="mailto:${escapeHtml(p.email)}" style="color:#FF3B7F;text-decoration:none;font-size:16px;">${escapeHtml(p.email)}</a></td>
                </tr>
                <tr><td colspan="2" style="border-top:1px dashed #F0E2D2;height:1px;line-height:0;font-size:0;">&nbsp;</td></tr>
                ${itemsRow}
                <tr>
                  <td style="font-weight:600;color:#5C4A6B;font-size:14px;vertical-align:top;">Paid</td>
                  <td style="font-size:18px;font-weight:700;color:#6BCB77;">${escapeHtml(totalUsd)}</td>
                </tr>
                <tr><td colspan="2" style="border-top:1px dashed #F0E2D2;height:1px;line-height:0;font-size:0;">&nbsp;</td></tr>
                <tr>
                  <td style="font-weight:600;color:#5C4A6B;font-size:14px;vertical-align:top;">Occasion</td>
                  <td style="font-size:16px;">${escapeHtml(p.occasion)}</td>
                </tr>
                <tr><td colspan="2" style="border-top:1px dashed #F0E2D2;height:1px;line-height:0;font-size:0;">&nbsp;</td></tr>
                <tr>
                  <td style="font-weight:600;color:#5C4A6B;font-size:14px;vertical-align:top;">Needed by</td>
                  <td style="font-size:16px;">${escapeHtml(p.dateNeeded)}</td>
                </tr>
              </table>

              <h2 style="margin:28px 0 8px;font-family:Georgia,serif;font-size:18px;font-weight:700;color:#2A1A2E;">Vision</h2>
              <div style="background:#FFF8F0;padding:16px 18px;border-radius:10px;border-left:3px solid #FF3B7F;font-size:15px;white-space:pre-wrap;">${escapeHtml(p.vision)}</div>

              ${photosBlock}

              ${receiptBlock}

              <p style="margin:32px 0 0;padding-top:20px;border-top:1px dashed #F0E2D2;color:#5C4A6B;font-size:14px;">
                💡 <strong>Reply to this email</strong> to respond directly to ${escapeHtml(p.name)}.
                Heads up: customer was told you'll confirm within <strong>24 hours</strong>, with full refund either way during that window.
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

function buildOrderEmailText(p) {
  const totalUsd = `$${(p.totalCents / 100).toFixed(2)}`;
  const itemLines = buildItemsTextLines(p.lineItems);
  const lines = [
    'NEW CUSTOM ORDER — PAID IN FULL',
    '================================',
    '',
    `Order ID:  ${p.orderId}`,
    `Total:     ${totalUsd}`,
    '',
    `From:      ${p.name}`,
    `Phone:     ${p.phone}`,
    `Email:     ${p.email}`,
    'Items:',
    ...itemLines,
    '',
    `Occasion:  ${p.occasion}`,
    `Needed by: ${p.dateNeeded}`,
    '',
    'Vision:',
    p.vision,
  ];
  if (p.photoUrls && p.photoUrls.length > 0) {
    lines.push('', `Inspiration photos (${p.photoUrls.length}):`);
    p.photoUrls.forEach(url => lines.push(`  ${url}`));
  }
  if (p.receiptUrl) {
    lines.push('', `Square receipt: ${p.receiptUrl}`);
  }
  lines.push(
    '',
    'Customer was told you\'ll confirm within 24 hours, with full refund either way during that window.',
    '',
    'Reply to this email to respond directly to the customer.',
    '',
    "— MJ's Sweets · mjs-sweets.com"
  );
  return lines.join('\n');
}

function buildCustomerEmailHtml(p) {
  const totalUsd = `$${(p.totalCents / 100).toFixed(2)}`;
  const firstName = (p.name || 'there').split(' ')[0] || p.name || 'there';

  const receiptBlock = p.receiptUrl ? `
    <p style="margin:24px 0 0;text-align:center;">
      <a href="${escapeHtml(p.receiptUrl)}" target="_blank" rel="noopener"
         style="display:inline-block;background:#FF3B7F;color:white;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:600;font-size:14px;">
        View your Square receipt →
      </a>
    </p>
  ` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your MJ's Sweets custom order is reserved</title>
</head>
<body style="margin:0;padding:0;background:#FFF8F0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2A1A2E;line-height:1.55;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FFF8F0;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(42,26,46,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#FF6B9D,#FF3B7F);padding:28px 32px;color:white;text-align:center;">
              <div style="font-family:Georgia,serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;opacity:0.85;">MJ's Sweets</div>
              <h1 style="margin:8px 0 0;font-family:Georgia,serif;font-size:26px;font-weight:700;">Your custom order is reserved! 🎉</h1>
              <div style="margin-top:6px;font-size:14px;opacity:0.95;">Order #${escapeHtml(p.orderShortId)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px;">
              <p style="font-size:16px;margin:0 0 16px;">Thanks for ordering, <strong>${escapeHtml(firstName)}</strong>!</p>
              <p style="font-size:15px;color:#5C4A6B;margin:0 0 20px;">
                Maddie will text or email you within <strong>24 hours</strong> to confirm design details and lock in your pickup.
              </p>

              <table cellpadding="10" cellspacing="0" border="0" width="100%" style="background:#FFF8F0;border-radius:12px;margin-bottom:8px;">
                ${buildItemsRowHtml(p.lineItems)}
                <tr>
                  <td style="font-weight:600;color:#5C4A6B;font-size:14px;">Needed by</td>
                  <td style="font-size:15px;">${escapeHtml(p.dateNeeded)}</td>
                </tr>
                <tr><td colspan="2" style="border-top:1px dashed #F0E2D2;height:1px;line-height:0;font-size:0;">&nbsp;</td></tr>
                <tr>
                  <td style="font-weight:600;color:#5C4A6B;font-size:14px;">Paid</td>
                  <td style="font-size:18px;font-weight:700;color:#FF3B7F;">${escapeHtml(totalUsd)}</td>
                </tr>
              </table>

              ${receiptBlock}

              <h2 style="margin:32px 0 10px;font-family:Georgia,serif;font-size:17px;font-weight:700;color:#2A1A2E;">Need to cancel?</h2>
              <p style="font-size:14.5px;color:#5C4A6B;margin:0 0 14px;">
                You have <strong>24 hours from order submission</strong> to cancel for any reason — full refund, no questions asked. Just text Maddie at <a href="tel:5045596466" style="color:#FF3B7F;text-decoration:none;font-weight:600;">(504) 559-6466</a>.
              </p>
              <p style="font-size:14.5px;color:#5C4A6B;margin:0 0 20px;">
                If Maddie can't take the order — busy schedule, or the design needs the next tier up — you'll get a full refund within 1–3 business days.
              </p>

              <p style="margin:28px 0 0;padding-top:20px;border-top:1px dashed #F0E2D2;color:#5C4A6B;font-size:14px;">
                Questions? Just text Maddie at <a href="tel:5045596466" style="color:#FF3B7F;text-decoration:none;font-weight:600;">(504) 559-6466</a>. We can't wait to make something sweet for you.
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

function buildCustomerEmailText(p) {
  const totalUsd = `$${(p.totalCents / 100).toFixed(2)}`;
  const firstName = (p.name || 'there').split(' ')[0] || p.name || 'there';
  const itemLines = buildItemsTextLines(p.lineItems);
  const lines = [
    `Thanks for ordering, ${firstName}!`,
    '',
    `Your MJ's Sweets custom order is reserved.`,
    `Maddie will text or email within 24 hours to confirm design details and lock in your pickup.`,
    '',
    `Order #${p.orderShortId}`,
    'Items:',
    ...itemLines,
    '',
    `Needed by: ${p.dateNeeded}`,
    `Paid:      ${totalUsd}`,
  ];
  if (p.receiptUrl) {
    lines.push('', `Receipt: ${p.receiptUrl}`);
  }
  lines.push(
    '',
    'NEED TO CANCEL?',
    'You have 24 hours from order submission to cancel for any reason — full refund, no questions asked. Just text Maddie at (504) 559-6466.',
    '',
    "If Maddie can't take the order (busy schedule, or the design needs the next tier up), you'll get a full refund within 1–3 business days.",
    '',
    'Questions? Just text Maddie at (504) 559-6466.',
    '',
    "— MJ's Sweets · mjs-sweets.com"
  );
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

// =========================================================================
// Helpers
// =========================================================================

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const form = new Formidable({
      multiples: true,
      maxFileSize: MAX_PHOTO_BYTES,
      maxTotalFileSize: MAX_TOTAL_BYTES,
      keepExtensions: true,
      // Browsers send empty file inputs even when no file is selected.
      // Without this, formidable rejects the whole submission as "file size
      // should be greater than 0". We filter empties ourselves below.
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
  if (!iso) return iso;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Server-side mirror of the client check. Belt-and-suspenders against a
// crafted POST that bypasses the date picker's `min` attribute.
function isDateAtLeast14Days(iso) {
  if (!iso) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  target.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const minDate = new Date(today);
  minDate.setDate(minDate.getDate() + LEAD_TIME_DAYS);
  return target.getTime() >= minDate.getTime();
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
