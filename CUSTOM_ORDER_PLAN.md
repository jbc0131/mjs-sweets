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
11. On success (charge confirmed by Square):
     - Square Order created with the tier SKU as a line item × qty (using client-provided idempotency key)
     - Photos already uploaded to Vercel Blob earlier in the request
     - Maddie/Jordan receive email with full order details + tier + qty + total + photos (best-effort; logged on failure but does NOT fail the request)
     - Customer receives confirmation email with order ID + receipt link (best-effort; logged on failure but does NOT fail the request)
     - Form transitions to success state with order ID + receipt link + thank-you message. If Maddie's email failed, success state shows fallback: "If you don't hear from Maddie within 24hr, text her at (504) 559-6466."
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

**Tier example thumbnails.** Each tier card in the form shows one representative cookie photo from the existing portfolio (1 image per tier, ~120px square). Tier descriptions are read on vibe more than feature lists; one good visual does more than the bullet list to set expectations. Source images:
- Signature → a clean monogram / single-theme set from `portfolio/elegant/` or `portfolio/monogram/` (pick whichever reads as "focused, calm, 1–3 color").
- Showstopper → a rich, multi-color set from `portfolio/wedding/` or `portfolio/birthday/` (pick whichever reads as "bold, layered, 4+ color").

---

## Square setup (one-time)

Add 2 items to Square Item Library:

| SKU | Item Name | Variation | Price | Sellable | Stockable | Category |
|---|---|---|---|---|---|---|
| `CUSTOM-SIG-DZN` | Signature Custom Dozen | 1 Dozen | $40.00 | Y | N | Custom Orders |
| `CUSTOM-SHOW-DZN` | Showstopper Custom Dozen | 1 Dozen | $46.00 | Y | N | Custom Orders |

Will update `Square_Item_Import.csv` so the repo source-of-truth stays accurate.

**Import path safety:** Square's CSV importer matches on Item Name + Variation, not SKU — re-importing the full CSV after the existing 13 items are already in the library will create duplicates. **Recommended: Maddie adds the 2 new rows manually in the Square dashboard** (~60 seconds). The CSV update is for repo bookkeeping, not live re-import.

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
  Need more than 10 dozen? Text Maddie at (504) 559-6466
  to plan a larger order.

═══════════════════════════════════════
Total: $40.00
═══════════════════════════════════════

[ Pay & Reserve $40.00 → ]
```

Live total recalculates when tier OR qty changes. Date picker `min` enforced as today + 14 days. The "more than 10 dozen" hint sits below the stepper as small muted text — visible at the cap so the customer doesn't silently bounce.

---

## Custom-order checkout modal (new)

Slimmer version of the existing cart checkout modal. Reuses Square SDK setup.

**Mobile overflow gotcha (per `CLAUDE.md`):** any off-screen position must use `transform: translateX(100%)` rather than `right: -420px` or similar negative offsets. Negative-positioned `position: fixed` elements bypass `overflow-x: clip` on `<html>` and extend document width on iOS Safari. The cart drawer already uses the transform pattern; the new modal must too.

**Pay button must disable on click** to prevent double-submit. The idempotency key (see Backend changes #6) is generated once on modal open and reused if the user retries — so a network-level retry of the same submission collapses to one Square Order + Payment instead of two.

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
2. Validate text fields (existing) **+ new:** `tier` ∈ {`CUSTOM-SIG-DZN`, `CUSTOM-SHOW-DZN`}, `dozens` ∈ [1, 10], `paymentToken` present, `idempotencyKey` present (UUID generated client-side on modal open)
3. Validate `date_needed` ≥ today + 14 days
4. Upload photos to Vercel Blob (existing)
5. **NEW:** Fetch tier price from Square Catalog API server-side (don't trust client total)
6. **NEW:** Create Square Order with the tier SKU × qty as line item, full customer info in metadata. **Use `idempotencyKey` from request** (not a fresh `randomUUID()`) so a retried POST collapses to one order.
7. **NEW:** Charge via Square Payments API with the payment token. **Use the same `idempotencyKey`** (Square allows reuse across Order + Payment in the same request context — keeps the retry semantics consistent).
8. **NEW:** If payment fails → return 402 with Square's error detail. (Photos stay on Blob; acceptable orphan.)
9. **Post-charge: notifications are best-effort, NEVER fail the request.** Once `createPayment` succeeds, the customer is charged and we MUST return 200 with `orderId` regardless of email/SMS outcome. Otherwise the customer retries and double-charges.
   - Send Maddie/Jordan email (Resend) — log on failure, do not return 502.
   - **NEW:** Send customer confirmation email — log on failure, do not return 502.
   - Send Maddie SMS (SignalWire, existing) — log on failure, already non-fatal in current code.
10. Return `{ success: true, orderId, paymentId, receiptUrl, notificationsSent: { maddieEmail, customerEmail, sms } }` so the client can display a recovery message if Maddie's email failed (e.g. "Order placed — if you don't hear from Maddie in 24hr, text her at (504) 559-6466").

**Why post-charge failures are special.** The current `api/contact.js` returns 502 if email send fails — that's correct for the *un-paid* form because retry is harmless. After we add a charge step, retry = double-charge, so the gating channel inverts: payment becomes the gate, notifications become best-effort. Maddie's Square dashboard is the durable source of truth for "did this order actually happen."

**Photo orphans on payment failure:** photos remain on Blob with random URLs, cost nothing, acceptable.

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
| `index.html` | Add tier section (with example thumbnails) + qty stepper + ">10dz" hint + live total to the form. Add custom-checkout modal HTML + CSS using `transform: translateX(100%)` pattern. JS for tier/qty handling, modal lifecycle, Square SDK reuse, **client-side idempotency key generation on modal open**, post-charge notification-failure recovery messaging. |
| `api/contact.js` | Add `tier`/`dozens`/`paymentToken`/`idempotencyKey` validation. Catalog API price fetch. Square Order + Payment creation **using request-provided idempotency key**. Customer confirmation email (new template). **Post-charge notification failures must be non-fatal** — return 200 with `notificationsSent` status object. |
| `Square_Item_Import.csv` | Add 2 new rows for the tier SKUs (repo source-of-truth — Maddie adds manually in Square dashboard, NOT via re-import). |
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
| 1. Update `Square_Item_Import.csv` + Maddie adds 2 rows manually in Square dashboard | 10 min (mostly her action) |
| 2. Form HTML changes (tier cards w/ example thumbnails, qty stepper, "more than 10dz" hint, live total, lead-time enforcement) | 45 min |
| 3. Custom checkout modal — HTML + CSS (`transform: translateX` pattern, button-disable on click) | 60 min |
| 4. JS: tier/qty handlers, live total, modal open/close + state, **client-side idempotency key generation**, Square SDK init for new modal, post-charge notification-failure recovery messaging | 60 min |
| 5. `api/contact.js` refactor: validate `paymentToken` + `idempotencyKey`, fetch catalog price, create Square Order + Payment with provided key, **post-charge non-fatal notification handling**, send customer confirmation email (new template) | 90 min |
| 6. Test plan execution + mobile testing (see Test plan section) | 45 min |

**Total: ~4–5 hours.** (Up from 2.5–3 hr after baking in idempotency, post-charge failure handling, mobile patterns, tier thumbnails, and a real test plan.)

---

## Test plan

Execute against a deployed preview branch before merging to main. Production-only Square means we'll use real cards on small ($40) test orders, refunded immediately via Square dashboard.

| # | Case | Expected result |
|---|---|---|
| 1 | Submit form with no photos, Signature tier, qty 1 | $40 charged, Maddie email arrives, customer email arrives, success state shown |
| 2 | Submit form with 5 photos at ~5MB each, Showstopper tier, qty 3 | $138 charged, all 5 photos in Maddie email, customer email arrives |
| 3 | Submit with declined card (use a real card that will decline — small known-bad number) | 402 returned, no Square Order persisted with payment, photos may orphan (OK), form re-enables for retry |
| 4 | Submit, then click "Pay" twice rapidly | One Square Order, one Payment (idempotency holds) |
| 5 | Submit, kill network mid-request, retry submission with same modal still open | One Square Order, one Payment (same idempotency key reused) |
| 6 | Apple Pay flow on iOS Safari (real iPhone) | Apple Pay sheet appears, charge completes, success state shown |
| 7 | Google Pay flow on Android Chrome | Google Pay sheet appears, charge completes |
| 8 | Form submit with `date_needed` < today + 14 days | 400 returned with clear error in form banner |
| 9 | Form submit with `dozens` = 0 or 11 | 400 returned (server-side; client should also block) |
| 10 | Simulate Resend outage (revoke API key temporarily on staging) — submit valid order | Charge succeeds, 200 returned with `notificationsSent.maddieEmail: false`, customer sees fallback message |
| 11 | Open modal, leave it open for 25+ hours, then submit | Square payment token may be expired → 402 with token-expired error, form re-enables |
| 12 | Mobile viewport (iPhone SE width, 375px): horizontal scroll check on the new modal | No horizontal overflow on `<html>` (modal uses `transform`, not negative offsets) |

---

## Risks & operational notes

1. **Refund expectations.** Customer pays $40–$460 upfront based on the tier they self-selected. If their vision is more complex than the tier supports, Maddie either upgrades via phone call (collect the difference manually) or refunds. Maddie should know the refund flow: Square dashboard → order → Refund → confirm. ~10 seconds.
2. **Square processing fees.** ~2.6% + 10¢ per online order. $40 order ≈ $1.14 fee, $92 order ≈ $2.49 fee. Standard for the industry; built into Maddie's pricing already.
3. **Photo orphans on payment failure.** Photos uploaded to Blob even if payment fails. They live on random URLs (effectively private), cost nothing. Acceptable. Could add a cleanup cron later if needed.
4. **Concurrent submissions.** Square Orders API uses idempotency keys. The custom-order flow uses a **client-generated** key (created on modal open, stable across retries) so a network-level retry of the same submission collapses to one Order + Payment instead of duplicating.
5. **Tier mismatch / "Maddie says no".** The tier system is honor-system. Some customers will pick Signature for designs that genuinely require Showstopper-tier work. Maddie's recourse: text the customer, explain, offer upgrade or refund. The customer confirmation email already sets the expectation that confirmation comes before work begins.
6. **24-hour cancellation window is a manual SLA.** The customer email promises full refund if they cancel within 24hr or if Maddie can't take the order. There is **no automated reminder, no self-serve cancel link, and no audit trail** beyond the Square Order timestamp. Maddie is on the hook to check email at least once a day and process the refund manually. If she misses the window, she's still committed to the promise. Acceptable for v1; revisit if we add an admin interface later (`ORDER_TRACKING_PLAN.md` is the natural home for a "needs response" badge + cron reminder).
7. **SignalWire SMS is in test-enabled mode (per `CLAUDE.md`).** SMS to new customer numbers will not deliver until A2P 10DLC registration completes. The customer confirmation flow does NOT depend on SMS (email-only); SMS to Maddie remains best-effort. Don't add SMS-to-customer to this flow until 10DLC is live.

---

## What to send when ready to start building

Just reply with **"go"** if all locked-in defaults work. I'll proceed with phases 1–6 in order, with checkpoints between phases. Phase 1 is the easiest — I update the CSV and you re-import (or add manually in Square dashboard).

If anything in this spec needs to change before I start, call it out now.
