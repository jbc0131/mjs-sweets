# Development Log

Chronological record of significant work. Most recent at top.

---

## 2026-05-06 — Order tracking + admin interface (full feature ship)

Built end-to-end against `ORDER_TRACKING_PLAN.md`. ~25 files created/modified across 13 phases. Customer tracking page, admin orders list, admin per-order management with unified Send Update flow, 4 cron-driven email reminders, Resend webhook for delivery/open tracking, Email Activity panel for visibility into every email sent and upcoming.

### What landed

- **Storage layer (`api/_lib/order-storage.js`):** Vercel Blob CRUD on `orders/{orderId}.json`. Append-only `emails[]` log; soft-delete via `hidden: true` on photos so already-sent email URLs survive deletion in admin. Maintains `orders/_email-index.json` mapping `resendId → orderId` so the webhook avoids brute-scanning every order on each event.
- **Auth (`api/_lib/order-auth.js`, `api/_lib/admin-auth.js`):** HMAC-SHA256 signed cookies + URL tokens. Customer cookie is `mjs_order_{orderId}`, signed with `ORDER_VERIFY_SECRET`. URL tokens (`?t=`) are base64url-encoded versions of the same tuple, used in email links so customers click straight through. Admin cookie is `mjs_admin`, signed with `ADMIN_COOKIE_SECRET`. Timing-safe compare on every signature check; in-memory rate limit on failed admin logins and order-verify lookups (5 attempts / 15 min).
- **Email library (`api/_lib/email.js`):** 10 templates — `order-confirmation`, `send-update`, `ready-for-pickup`, `picked-up`, `refund-confirmation`, `no-show-checkin`, `pickup-tomorrow`, `pickup-today`, `post-pickup-review`, `maddie-daily-summary`. All wall-clock formatting via `Intl.DateTimeFormat('America/Chicago')` so DST is handled. `sendEmail` mutates `order.emails[]` in-memory and returns the entry; caller persists via `writeOrder`. `computeExpectedEmails(order)` and `computeWontFireEmails(order)` are pure read-time functions powering the Email Activity panel. Includes the Svix-style webhook signature verifier for Resend.
- **Customer-facing (`order.html`):** Status timeline (paid → confirmed → baking → decorating → ready → picked up, plus side states for Canceled/No-Show), photo gallery filtered to non-hidden, lightbox on tap, conditional pickup address block (only when `status === 'ready'` or `'picked-up'`), "Need to change something? Text Maddie" CTA. Mobile-first layout matches the existing storefront aesthetic.
- **Track Order modal (in `index.html`):** Last name OR phone + order ID lookup. Phone matching handles both raw `customer_phone` (Square Order metadata) and E.164 `phoneNumber` (linked Square Customer record). Generic 401 message on every failure path so we don't leak which dimension matched.
- **Admin (`admin.html`):** Login → orders list with status / pickup-date / search filters, plus a 24-hour Email Activity dashboard panel showing sent count, failed count (with attention dot when non-zero), and active-orders count.
- **Admin order detail (`admin-order.html`):** Sticky "Send update to {firstName}" CTA at the bottom. Send Update modal supports optional photos + optional note + optional status advance in one shot, with a per-customer cadence indicator pulled from `emails[]`. Quick actions for Mark Ready (auto-emails customer with `pickupDate` and `pickupAddress`), Mark Picked Up (auto-emails thank-you), Cancel & Refund (Maddie processes the Square refund first, then clicks back here to fire the customer email), and Flag No-Show. Email Activity panel lists Sent (with delivered/opened/failed states from the webhook), Coming Up (computed from order state), and Won't Fire (conditional emails like Refund / No-Show, surfaced for transparency). "View as customer saw it" preview re-renders the email HTML inside a sandboxed iframe.
- **Cron jobs:** 4 daily UTC crons in `vercel.json`. `0 12 * * *` Maddie daily summary (suppresses on truly empty days), `0 13 * * *` pickup-today, `0 14 * * *` pickup-tomorrow, `0 16 * * *` post-pickup-review. Each cron checks `Authorization: Bearer ${process.env.CRON_SECRET}` before doing work. The original 5th cron (no-show-check) was removed during code review — it duplicated work already done by the daily summary's `pastDue` section.
- **Resend webhook (`api/resend-webhook.js`):** Verifies Svix signature with ±5min replay protection, patches `emails[i]` by `resendId` with `deliveredAt` / `openedAt` / failure state. Always returns 200 (with logged warnings on unfindable IDs) to avoid Resend retry storms.
- **Routing:** `vercel.json` rewrites: `/order/:id` → `/order.html?id=:id`, `/admin` → `/admin.html`, `/admin/order/:id` → `/admin-order.html?id=:id`. Function `maxDuration` set per endpoint.

### Existing endpoint integrations

- `api/checkout.js` — after Square payment success, persists the initial order JSON and fires the `order-confirmation` email. Best-effort post-charge: a persistence or email failure logs the error but never blocks the response (which would invite a double-charge retry).
- `api/contact.js` — same pattern. The existing custom-order branded emails (Maddie + customer) still fire; the order JSON now also persists so `/order/{id}` resolves for custom orders.

### Verification before shipping

Independent cold audit by a subagent surfaced one BLOCKER and a few should-fix items, all addressed:

1. **Race condition in `actSendUpdate` (`api/admin-update.js`)** — original code did mutateOrder → sendEmail → mutateOrder #2 → writeOrder. The second mutateOrder did a fresh Blob read that didn't yet have the email entry from sendEmail's in-memory mutation, silently dropping the log. Fixed: collapsed to a single in-memory mutation followed by one writeOrder.
2. **`sendEmail` empty-recipient guard** — synthesized legacy orders had no `customerEmail`. Resend would have thrown; now `sendEmail` short-circuits with `status: 'skipped'` and a warning log.
3. **Removed redundant no-show-check cron** — its surface (`pastDue` rows) is already in the daily summary.
4. **Cleaned up admin-order.html UX** — pickup address default value moved to placeholder so Maddie doesn't have to clear it; hardcoded "Sarah" in Send Update placeholder generalized.

All 20 JS files pass `node --check`. `vercel.json` validates as JSON.

### Required env vars (additions to existing list)

| Name | How to generate | Sensitive |
|---|---|---|
| `ADMIN_PASSWORD` | choose | Yes |
| `ADMIN_COOKIE_SECRET` | `openssl rand -hex 32` | Yes |
| `ORDER_VERIFY_SECRET` | `openssl rand -hex 32` | Yes |
| `SITE_URL` | `https://www.mjs-sweets.com` | No |
| `RESEND_WEBHOOK_SECRET` | from Resend dashboard webhook config | Yes |
| `CRON_SECRET` | `openssl rand -hex 32` | Yes |

All six are confirmed set in Vercel. Resend webhook configured at `https://www.mjs-sweets.com/api/resend-webhook` for events `email.delivered`, `email.opened`, `email.bounced`, `email.complained`.

### Post-deploy verification steps

After Vercel finishes deploying:
1. `curl -I https://www.mjs-sweets.com/api/_lib/order-storage` → expect 404 (underscore-prefix routing exclusion).
2. `https://www.mjs-sweets.com/admin` → login form. Valid password sets cookie, lands on orders list.
3. Place a test order (sandbox or real). Confirmation email lands. `/order/{id}` resolves with status timeline.
4. From admin, mark Ready → customer gets the "your cookies are ready" email automatically.
5. Watch Email Activity panel populate `delivered` then `opened` states as Resend's webhook fires.

---

## 2026-05-05 — Square Customer Directory population

Both checkout endpoints (`api/checkout.js`, `api/contact.js`) now create a proper Square Customer Directory record for every paying buyer, not just a Payment-level `buyerEmailAddress` (which Square treats as a receipt destination, not as "the customer provided their info to you"). Empty Customer Directory in production was the symptom.

### What changed

New shared helper at `api/_lib/squareCustomer.js` exporting `ensureCustomer(square, { name, email, phone, parentIdempotencyKey })`. The helper:

- Searches the Directory by exact email match. If found, returns the existing `customerId` unchanged (does NOT update name/phone — respects manual dashboard edits).
- If not found, creates a new Customer with `givenName` + `familyName` (best-effort split: first word vs. rest), `emailAddress`, and an E.164-normalized `phoneNumber` (US-only by design — 10 digits → `+1XXXXXXXXXX`, 11 starting with 1 → `+XXXXXXXXXXX`, anything else omitted from the record).
- Uses `${parentIdempotencyKey}-cust` as the createCustomer idempotency key so retried POSTs collapse to one Customer record.
- Returns `null` (not a throw) on any non-fatal Square API failure — best-effort upstream of the charge. Customer Directory is observability/marketing infrastructure; its unavailability must never block a sale.

Each endpoint now calls `ensureCustomer` immediately before `createOrder` and conditionally attaches `customerId` via spread:

```js
order: {
  locationId: process.env.SQUARE_LOCATION_ID,
  ...(customerId && { customerId }),
  lineItems,
  metadata: { ... },
}
```

`api/checkout.js` was also tightened to derive ALL three idempotency keys from one `randomUUID()` parent (`-cust`, no-suffix for order, `-pay` for payment), matching the convention `api/contact.js` already uses. Previously checkout's order and payment used independent UUIDs.

### Constraint coupling worth knowing

`api/contact.js` validates the client-supplied `idempotencyKey` length at ≤ 39 (was 40). The 39-char ceiling is **load-bearing**: with the `-cust` derivation it pins the customer-create key to ≤ 44, one under Square's 45-char cap. Inline comment at the validation site flags this; comment in `squareCustomer.js` mirrors it. Don't loosen one without the other.

### Why "search-then-create" instead of "create-with-conflict-check"

Square's Customers API has no "create or return existing" endpoint. The two-call dance (search → create if missing) has a theoretical race where two concurrent first-time orders for the same email both fail the search and both create. Different parent idempotency keys → two records. Per-order key was chosen anyway over a hash-of-email approach because: (a) MJ's volume makes the race essentially nonexistent, (b) per-order keys preserve request correlation in logs, (c) hash-of-email risks long-lived idempotency-key collisions across unrelated future orders if Square's idempotency window is wider than expected. If a duplicate ever does happen, Maddie merges in the dashboard.

### Verification before declaring this fully shipped

- [ ] After deploy, `curl -I https://www.mjs-sweets.com/api/_lib/squareCustomer` should return 404 (file should not be deployed as a Vercel function — the underscore prefix is Vercel's documented convention for non-route helpers, but worth confirming once).
- [ ] First test order via the live site → Square dashboard → Customers → Directory should show a new entry with name, email, and phone.
- [ ] Second order from the same email → no dupe; existing entry's order count increments.

---

## 2026-04-27 — Paid custom-order flow

The custom-order form was upgraded from "submit free inquiry" to "pay upfront to reserve." Spec lives in `CUSTOM_ORDER_PLAN.md`; build was executed in 5 phases plus a planning + review pre-phase.

### Tier model

Two tiers added to Square Item Library:

| SKU | Tier | Price | Description |
|---|---|---|---|
| `CUSTOM-SIG-DZN` | Signature Custom Dozen | $40/dz | 1–3 colors per cookie; monograms, single-theme sets, elegant minimalism |
| `CUSTOM-SHOW-DZN` | Showstopper Custom Dozen | $46/dz | Up to 6 colors per cookie; weddings, milestones, intricate themed sets |

Tier system is honor-system; Maddie's recourse if a customer self-selects the wrong tier is to text them, offer an upgrade or a refund. The customer email already sets the expectation that Maddie confirms before work begins. Source-of-truth price lives in Square; `api/contact.js` fetches it via Catalog API on every charge — same pattern as the cart flow's `api/checkout.js`.

### Form changes (`index.html`)

Below the existing custom-order fields, the form now has:
- Two tier cards side-by-side (stacked on mobile) showing real portfolio thumbnails — `wedding-cookies-gold-monogram.jpg` for Signature, `birthday-cookies-farm-animals.jpg` for Showstopper. Selected card gets a hot-pink border + soft pink background.
- Qty stepper (`−` / number input / `+`) bound to [1, 10] with a "Need more than 10 dozen? Text Maddie" hint that's always visible.
- Live total row that appears once a tier is selected. Submit button label updates to `Pay & Reserve $XX.XX →` in real time.
- Date picker `min` attribute set dynamically to today + 14 days.
- Pitch copy reframed: form is now the paid-reservation path; "Just exploring? Text me first" SMS link is the inquiry escape hatch.

### New custom-checkout modal (`index.html`)

Slim version of the existing cart-checkout modal. Lives in `#customCheckoutModal`, reuses every `.checkout-*` CSS class, but with `custom*` IDs so its DOM nodes don't collide with the cart modal. Shows order summary, Apple Pay / Google Pay buttons (if available on the device), card iframe, and a 24-hour-confirmation reassurance line under the title.

Square SDK wiring: separate Card / Apple Pay / Google Pay instances (`customSquareCard`, `customSquareApplePay`, `customSquareGooglePay`) attached to `#custom-*` DOM nodes. The `squarePayments` instance is shared with the cart flow. SDK init reuses `initSquare()` from the cart modal — first checkout in either modal triggers the lazy init.

Idempotency: client generates a UUID via `crypto.randomUUID()` once on modal open and reuses it across retries inside the same modal session. Backend uses it for `createOrder` and a derived `${key}-pay` for `createPayment`, so a network-level retry of the same submission collapses to one Square Order + one Payment.

Close-blocking: a `customCheckoutInFlight` flag is set during the POST. While it's set, the `✕` button and overlay-click both no-op — prevents the "user closes mid-payment, gets charged silently, panics" failure mode. The Pay button is `.is-loading` during the same window for visual signal.

### Backend rewrite (`api/contact.js`)

Refactored from "form submit → notify" to "form submit → charge → notify."

Pipeline:
1. Validate text fields + new fields (`tier`, `dozens`, `paymentToken`, `idempotencyKey`).
2. Server-side check: `date_needed >= today + 14 days`. Mirrors the client check; defends against crafted POSTs that bypass the picker's `min`.
3. Photos upload to Vercel Blob (existing).
4. Fetch authoritative tier price from Square Catalog (60s cache, mirrors `api/checkout.js`). Sanity floor: $10–$200 per dozen.
5. Create Square Order with the request's `idempotencyKey` and the tier × qty as a single line item. Order metadata includes tier, dozens, customer name/phone, occasion, date_needed, payment_method.
6. Charge via `paymentsApi.createPayment` with the same idempotency key + `-pay` suffix.
7. **Post-charge: notifications are best-effort, NEVER fail the request.** Once the Payment succeeds, the customer is charged; returning a non-2xx would prompt a retry → double charge. All three notifications (Maddie email, customer email, Maddie SMS) fire via `Promise.allSettled`. Each result is logged on failure but does not affect the response.
8. Response body: `{ success, orderId, orderShortId, paymentId, receiptUrl, totalCents, photoCount, notificationsSent: { maddieEmail, customerEmail, sms } }`. The client uses `notificationsSent.maddieEmail === false` to decide whether to surface a yellow fallback box telling the customer to text Maddie the order ID.

Email templates:
- **Maddie's email** (existing template, enhanced): header reads "💰 New custom order — paid in full" with Order #shortId + total in the gradient bar; new rows for Tier, Quantity, Paid (Paid uses the mint accent color); receipt button below the photos block; reply-to-respond hint also reminds Maddie about the 24-hr confirmation window.
- **Customer email** (new): friendly "Your custom order is reserved! 🎉" header, summary table (Tier, Quantity, Needed by, Paid), pink "View your Square receipt →" button, "Need to cancel?" section with 24-hr cancellation policy and SMS link to Maddie, "Questions?" footer. Plain-text counterpart included.

### What didn't change

- Cart checkout flow (`api/checkout.js`, cart drawer, cart modal) — untouched. The new modal lives alongside it with no shared DOM IDs and no shared SDK instances.
- Vercel env vars — `SQUARE_ACCESS_TOKEN` and `SQUARE_LOCATION_ID` were already set for the cart flow, so `api/contact.js` picks them up without new config.
- Photo upload + SignalWire SMS pipelines — same code paths as before.

### Risks logged but not addressed in v1

- **24-hr cancellation window is a manual SLA.** No automated reminder, no self-serve cancel link. Maddie has to check email at least once a day. Acceptable for v1; revisit when admin interface lands (`ORDER_TRACKING_PLAN.md`).
- **Tier mismatch.** Customer self-selects; honor-system. Mitigation is Maddie's text-and-refund recourse, set up by the customer-email language.
- **Photo orphans on payment failure.** Photos uploaded before charge; if the charge fails, photos stay on Blob. Cost is negligible. Could add a cleanup cron later.

---

## 2026-04-26 / 2026-04-27 — Initial build through production launch

Single intensive session that took the storefront from a static HTML mockup to a live, payment-accepting e-commerce site with embedded Square checkout, real product photography, a 52-photo portfolio gallery, and SMS notifications for custom orders. Major milestones below in the order they happened.

### Initial code review and quick wins

- Reviewed `index.html` (1995 lines) and identified 11 categories of issues spanning bugs, accessibility, SEO, performance, and code quality.
- Fixed hardcoded `TODAY = new Date('2026-04-26')` → real `new Date()` normalized to local midnight.
- Built dynamic hero countdown headline: "X days left to order [Holiday] Cookies!" with auto-rolling logic that picks the soonest open holiday from the products array.
- Added "Order Now →" CTA that scrolls to the matching product card with a brief pink-spotlight animation.

### Mobile responsive fixes

- Hamburger nav menu (was previously hidden with no replacement on mobile).
- 44px+ touch targets on all interactive elements (cart, qty controls, nav links).
- Hero h1 sized down for longer countdown headlines on phones.
- Cookie collage tiles scaled appropriately for narrow viewports.
- Cart drawer goes full-width on mobile.
- `prefers-reduced-motion` respected for animations.
- Escape key closes modals/menus.
- `theme-color` meta added.

### Cart refactor: split by pickup window

Major UX change. Each cart item now lives in a "pickup window" (Mother's Day batch, 4th of July batch, etc.). Year-round items (cake pops, rice krispies, pretzels) auto-attach to the soonest active seasonal window. Each batch checks out as its own Square Order. SKUs in the cart match the Square Item Library import. Cart UI shows items grouped by batch with per-group subtotals and "Checkout this batch →" buttons. Quantity controls preserve the new structure.

Display fix: cart line-item price now shows "per dozen" / "per 4-pack" instead of "each" so customers don't think they're buying single cookies.

### Square Item Library import

Generated `Square_Item_Import.csv` with 13 items mapping the products array. Cake Pops use Square's variation pattern (one Item Name, six rows for the six flavors, with `Option Name 1: Flavor`). Off-season seasonal sets are `Sellable=N` so they don't appear in the POS year-round. Imported into both production and sandbox accounts.

### Vercel project scaffolding

Created `package.json` (Square Node SDK), `vercel.json` (function timeouts + security headers), `.gitignore`, `.env.example`, and the initial `api/config.js` (returns public Square IDs to browser).

### Embedded Square checkout (sandbox first)

Built `api/checkout.js` with Square Web Payments SDK integration:
- Receives tokenized payment from browser
- Validates cart items against a server-side catalog (initially hardcoded, later replaced with Catalog API)
- Creates Square Order with line items + customer metadata
- Charges via Square Payments API
- Returns order ID + receipt URL

Built the checkout modal in `index.html`:
- Pickup details form (name, phone, email, optional time preference)
- Square SDK card iframe mounts inline
- Sandbox banner shows "use test card 4111..." in non-production
- Success state shows order ID + Square receipt link
- Error state surfaces Square's error inline

End-to-end sandbox tested with a multi-item Mother's Day batch.

### Square Catalog API integration

Replaced the hardcoded `CATALOG` constant in `api/checkout.js` with `fetchCatalogEntries()` that calls `searchCatalogObjects` for the requested SKUs. Single API call returns all variations + parent items via `includeRelatedObjects: true`. Display name uses `itemName, variationName` only when the parent has multiple variations (e.g., cake pop flavors), otherwise just the item name. 60-second in-memory cache for warm function invocations.

Result: prices and item names are now sourced from Square in real time. Editing a price in Maddie's Square dashboard immediately changes what the website charges. Catalog and code stay in sync without manual updates.

### Apple Pay + Google Pay

Refactored payment processing into `validateCheckoutForm()` + `processPayment()` so card, Apple Pay, and Google Pay all share the same validation and submit pipeline. Added wallet button containers above the card form, with an "or pay with card" divider. Apple Pay button uses `-apple-pay-button` CSS appearance (Safari-only). Google Pay renders via `payments.googlePay().attach()`. Both gracefully hide when not available on the device. `paymentRequest` includes line items so wallet sheets show itemized totals.

Apple Pay required domain verification:
- Sandbox: registered `www.mjs-sweets.com`, downloaded verification file, served at `/.well-known/apple-developer-merchantid-domain-association`. Verified.
- Production: same file works (Apple's verification is tied to the merchant ID, not environment), re-clicked Verify on production tab.

### Custom domain setup

Domain registered at Namecheap, configured to use Vercel nameservers (`ns1.vercel-dns.com`, `ns2.vercel-dns.com`). Vercel manages all DNS records. www is the primary; apex 307-redirects to www.

Significant debugging session resolving:
1. **macOS DNS cache flapping** — local resolver was caching old `parkingpage.namecheap.com` answers. Fix: flush DNS, point Mac directly at Cloudflare (1.1.1.1).
2. **Vercel deployment protection** — was blocking public access (returned 401 with TLS-style failures from curl). Fix: disabled in project settings.
3. **www CNAME pointing to Namecheap parking** — required setting Vercel as authoritative nameserver and removing legacy CNAME records.

Saved the DNS-cache-flapping diagnosis pattern to auto-memory so future sessions check it first.

### Square production rollout

Switched env vars in Vercel from sandbox → production credentials. Performed a real $1.00 charge with personal MasterCard for a Mother's Day Mini, verified in production Square dashboard, refunded immediately. Apple Pay + Google Pay both initially failed with carrier-side filtering — expected for new production accounts; resolves within 24-48 hours of merchant activation.

Test cards (`4111...`) now correctly rejected in production with `PAN_FAILURE`, confirming the production credentials are live.

### Custom order form with SMS notifications

Built `api/contact.js`:
- Multipart form parsing via `formidable` v3 (gotcha: `const { Formidable } = require('formidable')`, NOT `require('formidable')`)
- Photo uploads to Vercel Blob (public access, ~5MB per file, 5 max)
- SMS notification via SignalWire's compatibility API
- Comprehensive validation (10-digit phone, email format, file types, file sizes)
- Detailed error messages surfaced to the form's red banner

Several gotchas resolved:
- CommonJS `module.exports.config = {...}` must be assigned AFTER `module.exports = handler`, otherwise the handler assignment overwrites the config.
- `@vercel/blob` v2 prefers `Buffer` over `fs.createReadStream` for `put()` payload.
- Vercel Blob store must be created with **public** access for the URLs in the SMS to be publicly viewable.
- formidable v3 rejects empty file inputs by default — added `allowEmptyFiles: true, minFileSize: 0` to allow forms submitted without photos.

Form fields refined:
- Split single "Phone or email" into two required fields (Phone + Email).
- Phone uses live formatter (`(XXX) XXX-XXXX`) and pattern + digit-count validation.
- Email is `type=email` with browser + server-side regex validation.
- Conditional "Tell me more about the occasion" field appears only when "Other" is selected, becomes required when visible, clears when hidden.

### SMS body tightening

Discovered SignalWire trial-mode `[SignalWire Free Trial]` prefix was triggering carrier filtering (error 30008, "Carrier Responded as Undeliverable"). Account funding ($10 paid card + $5 promo) lifted account-level trial but the **number's** test status persists, still applies the prefix. Tightened SMS body: dropped the cookie emoji to enable GSM-7 encoding (160 chars/segment vs Unicode's 70 chars/segment). Trimmed labels for fewer segments.

Per `NEXT_STEPS.md`: resolution path is either A2P 10DLC registration (~1 week) or layering Resend email on top.

### Polish pass (SEO + accessibility + brand)

- Real phone `(504) 559-6466` everywhere (was `5045551234` placeholder).
- Real Facebook URL: `https://www.facebook.com/mjssweets25`. Removed Instagram (Maddie doesn't have one).
- Heading hierarchy: 4 `<h1 class="section-title">` → `<h2>` (was wrong for SEO and screen readers).
- Footer cleanup: dead links removed, FAQ anchors fixed, service-area as plain text.
- Dynamic copyright year via JS.
- Form labels properly associated with inputs (`for`/`id` + `name` attributes).
- SEO meta: description, canonical, Open Graph (title/description/image), Twitter Card.
- Favicon: SVG with brand-pink "M" + yellow "j" Caveat accent.
- JSON-LD `Bakery` schema for local search (Madisonville, areaServed cities, payment methods, sameAs Facebook).
- Removed redundant occasion icon cards from #custom section once the gallery existed.

### Real product photography

Replaced emoji placeholders with real product photos for:
- Cake Pops (4-pop transparent PNG, gradient background shows through)
- Rice Krispies Treats
- Dipped Pretzel Rods
- Maddie's portrait in the About section (circular crop with brand-pink ring + ✨ accent)

Built a `renderProductImage(p)` helper that uses the photo if present, falls back to emoji. Same helper used in product cards, addon cards, cart drawer thumbnails, compact upcoming cards. Adding a new product photo is now a one-line change to the products array.

### Portfolio gallery (52 photos, 7 categories)

Built a filterable masonry-grid gallery in the Custom Orders section. Each photo opens a fullscreen lightbox with prev/next navigation, swipe support, ESC to close.

Photo processing pipeline (Python + PIL):
- Resize to max 1600px on longest side
- JPEG quality 85, optimize, progressive
- Honor iPhone EXIF rotation
- Result: ~95% file size reduction with no visible quality loss

Categories and counts:
- 🎂 Birthdays — 16 (kids' themes + adult monograms in one bucket; rejected the Boys/Girls split)
- 🎄 Holidays — 6 (Easter, Valentine's, Halloween, Christmas)
- 💍 Wedding & Bridal — 6
- 👶 Baby Shower — 8
- ⛪ Faith & Milestones — 4
- 🎓 Graduation — 6
- 🎁 Corporate — 6 (Christmas bulk orders, branded favors)

Renamed all source filenames from iPhone UUIDs (e.g., `5D0A332C-920F-40C7-9B57-A5832F217349.jpeg`) to SEO-friendly hyphenated names that match search keywords (`graduation-cookies-star-wars-themed.jpg`, `baby-shower-cookies-mickey-pink-gold.jpg`, etc.).

Gallery initial-render limit: 9 photos shown by default per filter, "Show N more →" button reveals the rest. Cuts initial bandwidth from ~17 MB to ~3 MB and reduces scroll fatigue between gallery and contact form. Lightbox still navigates the full filtered set.

### Mobile horizontal-overflow fix

iOS Safari was showing a white sliver on the right of the page on mobile. Diagnosed as the cart drawer's `position: fixed; right: -420px` extending the document width — `overflow-x: clip` on `<html>` doesn't constrain `position: fixed` descendants since they're positioned relative to viewport, not html.

Fix: migrated cart drawer from `right: -420px` (off-layout to the right) to `right: 0; transform: translateX(100%)`. Transforms don't affect layout. Open state changed from `right: 0` to `transform: translateX(0)`. Transition target updated from `right` to `transform`. Same animation, no layout side-effect.

### Section header reorganization

Removed the redundant 6-card icon strip in #custom (Graduations, Bridal, Birthdays, Baby Showers, Faith, Sports) once the portfolio gallery existed. Made the gallery's "A peek at past custom orders" heading the section's main `<h2>` since it's the most useful title in context.

---

## Current state at session end

- ✅ Storefront live and accepting real payments at https://www.mjs-sweets.com
- ✅ Card, Apple Pay, Google Pay all working in production
- ✅ Real product photos for cake pops, rice krispies, pretzels, Maddie portrait
- ✅ 52-photo portfolio gallery across 7 categories
- ✅ Custom-order form processing photos via Vercel Blob
- ⚠️ SMS notifications functional but unreliable (SignalWire trial prefix → carrier filtering)
- ⏭️ Resend email backup pending user action
- ⏭️ Order tracking + admin interface fully scoped in ORDER_TRACKING_PLAN.md, ready to build
