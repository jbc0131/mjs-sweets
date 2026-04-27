# Custom Order Flow — Build Spec

How customers order, pay for, and reserve custom cookies through the website. Tiered pricing model with payment upfront via Square. Built on top of the existing custom-order request form and Square Web Payments SDK infrastructure.

---

## The customer journey

```
1. Customer visits #custom section, browses portfolio gallery
2. Scrolls to "Order custom cookies" form
3. Fills existing fields: Name, Phone, Email, Occasion, Date needed, Vision, Photos
4. NEW — picks a tier:
     ◯ Signature Custom Dozen — $40/dz
       Beautifully focused designs in your theme, perfect for monograms,
       single-theme sets, and elegant minimalism. 1–3 colors per cookie.

     ◯ Showstopper Custom Dozen — $46/dz
       Bold, expressive designs with rich palettes and intricate detail.
       Perfect for weddings, milestone celebrations, and standout themed
       sets. Up to 6 colors per cookie.
5. NEW — picks quantity (dozens, 1–10)
6. NEW — sees live total: tier × dozens
7. Clicks "Pay & Reserve $XX.XX →"
8. Form validates (all required fields + tier + qty + lead time ≥ 14 days)
9. Custom-order checkout modal opens:
     - Order summary (tier name, qty, total)
     - Apple Pay + Google Pay buttons (if available on device)
     - Card iframe (Square Web Payments SDK)
     - Note: "Maddie will text or email within 24 hours to confirm details"
10. Customer pays
11. On success:
     - Square Order created with the tier SKU as a line item × qty
     - Photos upload to Vercel Blob (if any)
     - Maddie/Jordan receive email with full order details + tier + qty + total + photos
     - Customer receives confirmation email with order ID + receipt link
     - Form transitions to success state with order ID + receipt link + thank-you message
12. (Maddie processes the order from her Square dashboard like any other order)

**24-hour confirmation window — protects both sides.**
- Maddie has 24 hours to review the order and confirm she can take it.
- Customer can also cancel within 24 hours of submitting (change of mind, found another baker, etc.).
- Either way → full refund via Square dashboard (one click), lands on customer's card in 1–3 business days.
- After 24 hours, the order is "locked in" — Maddie has committed to baking it; customer has committed to picking it up.
```

---

## Tier wording (locked in)

| Tier | Price | Description |
|---|---|---|
| **Signature Custom Dozen** | $40/dz | Beautifully focused designs in your theme, perfect for monograms, single-theme sets, and elegant minimalism. **1–3 colors per cookie.** |
| **Showstopper Custom Dozen** | $46/dz | Bold, expressive designs with rich palettes and intricate detail. Perfect for weddings, milestone celebrations, and standout themed sets. **Up to 6 colors per cookie.** |

---

## Square setup (one-time)

Add 2 items to Square Item Library:

| SKU | Item Name | Variation | Price | Sellable | Stockable | Category |
|---|---|---|---|---|---|---|
| `CUSTOM-SIG-DZN` | Signature Custom Dozen | 1 Dozen | $40.00 | Y | N | Custom Orders |
| `CUSTOM-SHOW-DZN` | Showstopper Custom Dozen | 1 Dozen | $46.00 | Y | N | Custom Orders |

Will update `Square_Item_Import.csv` so Maddie can re-import (or add manually in dashboard).

---

## Form additions (in `index.html`)

After existing photos field, before submit button:

```
═══════════════════════════════════════
Pick your style
═══════════════════════════════════════

  ◯ Signature Custom Dozen — $40/dz
     Beautifully focused designs in your theme,
     perfect for monograms, single-theme sets,
     and elegant minimalism.
     1–3 colors per cookie.

  ◯ Showstopper Custom Dozen — $46/dz
     Bold, expressive designs with rich palettes
     and intricate detail. Perfect for weddings,
     milestone celebrations, and standout themed sets.
     Up to 6 colors per cookie.

  How many dozens?    [−]   [ 1 ]   [+]    (1–10)

═══════════════════════════════════════
Total: $40.00
═══════════════════════════════════════

[ Pay & Reserve $40.00 → ]
```

Live total recalculates when tier OR qty changes. Date picker `min` enforced as today + 14 days.

---

## Custom-order checkout modal (new)

Slimmer version of the existing cart checkout modal. Reuses Square SDK setup:

```
┌─────────────────────────────────────────┐
│ Reserve your custom order            ✕ │
├─────────────────────────────────────────┤
│ Showstopper Custom Dozen × 2            │
│ Total: $92.00                           │
├─────────────────────────────────────────┤
│ [Apple Pay button] (if available)       │
│ [Google Pay button] (if available)      │
│  ──── or pay with card ────             │
│ [Square card iframe]                    │
│ [Pay $92.00 →]                          │
│                                         │
│ Maddie confirms within 24 hours.        │
│ You can cancel within 24 hours of       │
│ ordering for a full refund.             │
└─────────────────────────────────────────┘
```

Success state replaces the form view:

```
┌─────────────────────────────────────────┐
│         ✓                               │
│    Order placed!                        │
│ Maddie will reach out within 24 hours.  │
│                                         │
│ Order ID: abc123...                     │
│                                         │
│ [View Receipt →]   [Close]              │
└─────────────────────────────────────────┘
```

---

## Backend changes (`api/contact.js`)

Refactor from "form submit → notify" to "form submit → charge → notify":

1. Parse multipart form (existing)
2. Validate text fields (existing) **+ new:** `tier` ∈ {`CUSTOM-SIG-DZN`, `CUSTOM-SHOW-DZN`}, `dozens` ∈ [1, 10], `paymentToken` present
3. Validate `date_needed` ≥ today + 14 days
4. Upload photos to Vercel Blob (existing)
5. **NEW:** Fetch tier price from Square Catalog API server-side (don't trust client total)
6. **NEW:** Create Square Order with the tier SKU × qty as line item, full customer info in metadata
7. **NEW:** Charge via Square Payments API with the payment token
8. **NEW:** If payment fails → return 402 with Square's error detail
9. Send Maddie/Jordan email with order details (existing pattern, enhanced with tier/qty/total/receipt link)
10. **NEW:** Send customer confirmation email
11. Send Maddie SMS (existing, best-effort)
12. Return `{ success, orderId, paymentId, receiptUrl }`

Photo orphans on payment failure: photos remain on Blob with random URLs, cost nothing, acceptable.

---

## Email changes

**Maddie's notification email** (existing template, enhanced):
- Header changes from "New custom order" to "💰 New custom order — paid in full"
- New row in the details table: **Tier:** Signature Custom Dozen
- New row: **Quantity:** 2 dozen
- New row: **Paid:** $80.00
- New section: "View Square receipt →" link

**Customer confirmation email** (new):
- Subject: `Your MJ's Sweets custom order is reserved! (Order #abc123)`
- Body:
  - "Thanks for ordering, {name}!"
  - Order summary table (tier, qty, total)
  - "Maddie will text or email you within 24 hours to confirm design details and lock in your pickup."
  - "**Need to cancel?** You have 24 hours from order submission to cancel for any reason — full refund, no questions asked. Just text Maddie at (504) 559-6466."
  - "If Maddie can't take the order (busy schedule, design too complex for the tier you picked), you'll get a full refund within 1–3 business days."
  - Square receipt link
  - "Questions? Text Maddie at (504) 559-6466."

---

## Files to change

| File | What changes |
|---|---|
| `index.html` | Add tier section + qty stepper + live total to the form. Add custom-checkout modal HTML + CSS. JS for tier/qty handling, modal lifecycle, Square SDK reuse. |
| `api/contact.js` | Add `tier`/`dozens`/`paymentToken` validation. Catalog API price fetch. Square Order + Payment creation. Customer confirmation email. |
| `Square_Item_Import.csv` | Add 2 new rows for the tier SKUs. |
| Server-side env vars | None new — Square + Resend + Blob already wired. |

---

## Open decisions (locked in)

| # | Decision | Value |
|---|---|---|
| 1 | Minimum order | 1 dozen |
| 2 | Maximum per online order | 10 dozen / $460 cap |
| 3 | Payment timing | Full price upfront |
| 4 | Lead time | Date picker `min` = today + 14 days |
| 5 | Customer confirmation email | Yes |
| 6 | Tier names + descriptions | Signature / Showstopper, locked above |

---

## Time estimate

| Phase | Time |
|---|---|
| 1. Update `Square_Item_Import.csv` + Maddie re-imports to Square | 10 min (mostly her action) |
| 2. Form HTML changes (tier cards, qty stepper, live total, lead-time enforcement) | 30 min |
| 3. Custom checkout modal — HTML + CSS | 45 min |
| 4. JS: tier/qty handlers, live total, modal open/close + state, Square SDK init for new modal, success/error handling | 45 min |
| 5. `api/contact.js` refactor: validate payment token, fetch catalog price, create Square Order + Payment, send customer confirmation email | 60 min |
| 6. Polish + mobile testing + edge cases (declined card, payment fail mid-upload, etc.) | 30 min |

**Total: ~2.5–3 hours.**

---

## Risks & operational notes

1. **Refund expectations.** Customer pays $40–$460 upfront based on the tier they self-selected. If their vision is more complex than the tier supports, Maddie either upgrades via phone call (collect the difference manually) or refunds. Maddie should know the refund flow: Square dashboard → order → Refund → confirm. ~10 seconds.
2. **Square processing fees.** ~2.6% + 10¢ per online order. $40 order ≈ $1.14 fee, $92 order ≈ $2.49 fee. Standard for the industry; built into Maddie's pricing already.
3. **Photo orphans on payment failure.** Photos uploaded to Blob even if payment fails. They live on random URLs (effectively private), cost nothing. Acceptable. Could add a cleanup cron later if needed.
4. **Concurrent submissions.** Square Orders API uses idempotency keys (we already do this in cart checkout). Multiple simultaneous orders won't conflict.
5. **Tier mismatch / "Maddie says no".** The tier system is honor-system. Some customers will pick Signature for designs that genuinely require Showstopper-tier work. Maddie's recourse: text the customer, explain, offer upgrade or refund. The customer confirmation email already sets the expectation that confirmation comes before work begins.

---

## What to send when ready to start building

Just reply with **"go"** if all locked-in defaults work. I'll proceed with phases 1–6 in order, with checkpoints between phases. Phase 1 is the easiest — I update the CSV and you re-import (or add manually in Square dashboard).

If anything in this spec needs to change before I start, call it out now.
