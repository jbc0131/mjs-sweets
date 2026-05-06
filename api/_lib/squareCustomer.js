// Square Customer Directory population helper.
//
// Used by api/checkout.js and api/contact.js to ensure a Customer record
// exists in Square's Customer Directory for every paying customer. Square
// only counts an email as "directly provided to the seller" (and surfaces
// it in our Directory) when we explicitly create a Customer record with
// it — passing `buyerEmailAddress` on a Payment alone does NOT populate
// the Directory; that field is just the receipt destination from Square's
// perspective.
//
// CONTRACT
//   ensureCustomer(square, { name, email, phone, parentIdempotencyKey })
//     → returns the Square customerId on success
//     → returns null on any non-fatal failure (search 5xx, create 4xx, etc.)
//     → throws synchronously only on programmer error (missing required arg)
//
// USAGE
//   const customerId = await ensureCustomer(square, {
//     name: customer.name,
//     email: customer.email,
//     phone: customer.phone,
//     parentIdempotencyKey: orderIdempotencyKey,
//   });
//   const orderRes = await square.ordersApi.createOrder({
//     idempotencyKey: orderIdempotencyKey,
//     order: { locationId, ...(customerId && { customerId }), lineItems, ... },
//   });
//
// WHAT THIS HELPER DOES NOT DO
//   - Update existing customer records (no name/phone/email writes after the
//     first create — respects manual edits Maddie might make in the dashboard).
//   - Handle marketing opt-in / emailUnsubscribed / SMS preferences.
//   - Merge duplicate customer records (manual via Square dashboard).
//   - Backfill customers from past orders (would need a separate script over
//     ordersApi.search).
//   - Validate email format (caller's job — both endpoints already do this).
//
// IDEMPOTENCY NOTE
//   The createCustomer idempotency key is derived as `${parentIdempotencyKey}-cust`
//   (parent UUID v4 = 36 chars, suffix = 5, total = 41 → fits Square's 45-char cap).
//   This means a retried POST collapses to one Customer record. It does NOT
//   prevent duplicates if two CONCURRENT first-time orders arrive for the same
//   email (different parent keys → different customer-create idempotency keys),
//   but for MJ's Sweets' volume that race is essentially nonexistent. If it does
//   happen, Maddie can merge in the Square dashboard. Per-order key was chosen
//   over hash-of-email because it preserves request correlation in logs and
//   avoids long-lived idempotency-key collisions across unrelated future orders.
//
//   LOAD-BEARING: api/contact.js validates the client-supplied idempotency key
//   at length ≤ 39 specifically so `${key}-cust` stays ≤ 44 chars, one under
//   Square's 45-char cap. If you ever loosen that validation, this derivation
//   silently breaks for max-length keys. The check at api/contact.js is the
//   source of truth; this comment is here so future contributors see the
//   coupling when they edit the helper.
//
// PHONE NORMALIZATION
//   `toE164` is US-only by design (Madisonville, LA bakery). 10-digit and
//   "1"-prefixed 11-digit inputs become +1XXXXXXXXXX; everything else returns
//   null and is omitted from the customer record. International customers
//   would silently lose their phone on the Customer record (their Order
//   metadata is unaffected). Acceptable for current customer base.

const { ApiError } = require('square');

// "Sarah Smith"        → { givenName: "Sarah",  familyName: "Smith" }
// "Maddie van der Meer" → { givenName: "Maddie", familyName: "van der Meer" }
// "Cher"               → { givenName: "Cher",   familyName: "" }
// "Mary Anne Smith"    → { givenName: "Mary",   familyName: "Anne Smith" } (imperfect; recoverable in dashboard)
// ""                   → { givenName: "",       familyName: "" } (caller validates non-empty)
function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { givenName: '', familyName: '' };
  if (parts.length === 1) return { givenName: parts[0], familyName: '' };
  return { givenName: parts[0], familyName: parts.slice(1).join(' ') };
}

// "(504) 555-1234"  → "+15045551234"
// "1-504-555-1234"  → "+15045551234"
// "504.555.1234"    → "+15045551234"
// "5045551234"      → "+15045551234"
// Anything else (too short, too long without country code) → null. Caller
// should treat null as "skip phoneNumber on the customer record" rather than
// passing through; Square will reject malformed E.164 with a 400.
function toE164(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

async function ensureCustomer(square, { name, email, phone, parentIdempotencyKey }) {
  // Programmer-error checks: throw synchronously so the caller's outer
  // try/catch returns 500 instead of silently degrading. Email is required
  // because we key on it; the helper has no useful work to do without it.
  if (!square) throw new Error('ensureCustomer: square client is required');
  if (!email) throw new Error('ensureCustomer: email is required');
  if (!parentIdempotencyKey) throw new Error('ensureCustomer: parentIdempotencyKey is required');

  try {
    // ---- Search by exact email match ----
    const searchRes = await square.customersApi.searchCustomers({
      query: {
        filter: {
          emailAddress: { exact: email },
        },
      },
      limit: 1,
    });

    const existing = searchRes.result.customers && searchRes.result.customers[0];
    if (existing && existing.id) {
      // Use existing record as-is. We deliberately don't update name or phone
      // on existing customers — Maddie may have edited the record in the
      // Square dashboard ("Sarah S. — birthday cookies referral") and we
      // shouldn't overwrite that.
      return existing.id;
    }

    // ---- Create new customer ----
    const { givenName, familyName } = splitName(name);
    const e164 = toE164(phone);

    const createBody = {
      idempotencyKey: `${parentIdempotencyKey}-cust`,
      givenName,
      familyName,
      emailAddress: email,
    };
    // Omit phoneNumber entirely when normalization fails — better to have a
    // Directory entry without phone than to fail the create with a Square 400.
    if (e164) createBody.phoneNumber = e164;

    const createRes = await square.customersApi.createCustomer(createBody);
    return createRes.result.customer && createRes.result.customer.id ? createRes.result.customer.id : null;
  } catch (err) {
    // Non-fatal — caller proceeds without customerId. Customer Directory is
    // observability/marketing infrastructure, not order-correctness; its
    // failure must never block a sale.
    if (err instanceof ApiError) {
      console.error('ensureCustomer: Square API error', {
        email,
        errors: JSON.stringify(err.errors, null, 2),
      });
    } else {
      console.error('ensureCustomer: unexpected error', {
        email,
        message: err.message || String(err),
      });
    }
    return null;
  }
}

// Pure helpers exported for testability and reuse if a future endpoint needs
// the same name/phone normalization without the full search-or-create flow.
module.exports = { ensureCustomer, splitName, toE164 };
