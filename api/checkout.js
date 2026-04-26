// POST /api/checkout
//
// Receives a tokenized payment from the Square Web Payments SDK on the client,
// fetches authoritative prices from the Square Catalog API (so prices live in
// exactly one place — Square — and a price change in Square automatically
// applies to the website), creates a Square Order, then charges the card.
//
// One call = one pickup batch = one Square Order + one Payment.
// The caller invokes this once per cart group (Mother's Day, 4th of July, etc.).
//
// Expected request body shape:
//   {
//     items:        [{ sku: 'SET-MD', qty: 1 }, ...],
//     paymentToken: 'cnon:...' (from Square SDK card.tokenize()),
//     customer:     { name, email, phone },
//     pickupWindow: 'mothers-day-2026'
//   }

const { Client, Environment, ApiError } = require('square');
const { randomUUID } = require('crypto');

const square = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    (process.env.SQUARE_ENVIRONMENT || 'sandbox') === 'production'
      ? Environment.Production
      : Environment.Sandbox,
});

// ---------- Catalog cache ----------
// In-memory cache keyed by SKU. Works for warm Vercel invocations and avoids
// a Square API round-trip on every checkout. Cold starts will refetch.
// 60s TTL is short enough that price changes in Square propagate quickly.
const CATALOG_TTL_MS = 60_000;
const catalogCache = new Map(); // sku -> { entry, expiresAt }

// Fetch authoritative { name, priceCents } for each requested SKU directly
// from Square. Returns a plain object keyed by SKU. Missing SKUs simply won't
// appear in the result, which the caller treats as "unknown SKU".
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

  // Single Square API call returns all matching ITEM_VARIATIONS plus their
  // parent ITEMs (so we can build a friendly display name).
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
    const parentData = parent.itemData;
    if (parentData?.isArchived) continue;

    // If the parent item has multiple variations (e.g., Cake Pops with 6
    // flavors), include the variation name. If it has only one (e.g.,
    // Mother's Day Box → "1 Dozen"), the variation name is just a unit
    // label, so use only the item name.
    const itemName = parentData?.name || 'Item';
    const variationName = data.name || '';
    const variationCount = parentData?.variations?.length || 1;
    const displayName = (variationCount > 1 && variationName)
      ? `${itemName}, ${variationName}`
      : itemName;

    const entry = {
      name: displayName,
      priceCents: Number(data.priceMoney.amount),
      currency: data.priceMoney.currency || 'USD',
      catalogObjectId: v.id, // useful for line-item linking in Square reports
    };
    result[data.sku] = entry;
    catalogCache.set(data.sku, { entry, expiresAt: now + CATALOG_TTL_MS });
  }

  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Reject early if env not configured. Easier to debug than a Square SDK exception.
  if (!process.env.SQUARE_ACCESS_TOKEN || !process.env.SQUARE_LOCATION_ID) {
    return res.status(500).json({
      error: 'Server not configured',
      detail: 'SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID env vars are required.',
    });
  }

  try {
    const { items, paymentToken, customer, pickupWindow } = req.body || {};

    // ---- Input validation ----
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items in cart' });
    }
    if (!paymentToken || typeof paymentToken !== 'string') {
      return res.status(400).json({ error: 'Missing payment token' });
    }
    if (!customer?.name || !customer?.email || !customer?.phone) {
      return res.status(400).json({
        error: 'Missing customer info',
        detail: 'name, email, and phone are required.',
      });
    }

    // ---- Fetch authoritative prices/names from Square Catalog ----
    const catalog = await fetchCatalogEntries(items.map(i => i.sku));

    // ---- Build line items from server-fetched catalog (ignore client prices) ----
    let totalCents = 0;
    const lineItems = items.map((item) => {
      const catalogItem = catalog[item.sku];
      if (!catalogItem) {
        throw new ClientError(`Item not currently available: ${item.sku}`);
      }
      const qty = parseInt(item.qty, 10);
      if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
        throw new ClientError(`Invalid quantity for ${item.sku}: ${item.qty}`);
      }
      // Sanity floor: a real item shouldn't be free, and shouldn't be > $1000.
      // Catches data corruption or accidental zeros from the catalog before we charge.
      if (catalogItem.priceCents < 1 || catalogItem.priceCents > 100_000) {
        throw new Error(`Catalog price out of expected range for ${item.sku}`);
      }
      totalCents += catalogItem.priceCents * qty;
      return {
        catalogObjectId: catalogItem.catalogObjectId,
        quantity: String(qty),
        // Including basePriceMoney makes the order self-contained even if a
        // catalog object is later updated; Square uses what we send here.
        basePriceMoney: {
          amount: BigInt(catalogItem.priceCents),
          currency: catalogItem.currency,
        },
        name: catalogItem.name,
      };
    });

    // ---- Create order ----
    const orderRes = await square.ordersApi.createOrder({
      idempotencyKey: randomUUID(),
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        lineItems,
        metadata: {
          pickup_window: String(pickupWindow || ''),
          customer_name: customer.name.slice(0, 100),
          customer_phone: customer.phone.slice(0, 20),
          source: 'mjssweets-website',
        },
      },
    });
    const orderId = orderRes.result.order.id;

    // ---- Charge ----
    const paymentRes = await square.paymentsApi.createPayment({
      idempotencyKey: randomUUID(),
      sourceId: paymentToken,
      amountMoney: {
        amount: BigInt(totalCents),
        currency: 'USD',
      },
      orderId,
      buyerEmailAddress: customer.email,
      note: `Pickup: ${pickupWindow || 'TBD'} · ${customer.name}`,
    });

    return res.status(200).json({
      success: true,
      orderId,
      paymentId: paymentRes.result.payment.id,
      receiptUrl: paymentRes.result.payment.receiptUrl,
      totalCents,
    });
  } catch (err) {
    if (err instanceof ClientError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof ApiError) {
      const detail = err.errors?.[0]?.detail || err.message || 'Square rejected the request';
      console.error('Square API error:', JSON.stringify(err.errors, null, 2));
      return res.status(402).json({ error: 'Payment failed', detail });
    }
    console.error('Checkout error:', err);
    return res.status(500).json({ error: 'Unexpected server error' });
  }
};

// Sentinel error type for caller mistakes that should return 400, not 500.
class ClientError extends Error {}
