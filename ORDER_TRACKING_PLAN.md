# Order Tracking & Post-Order User Journey — Build Plan

Comprehensive spec for the order tracking system, customer email pipeline, and Maddie's admin interface. Built on top of the live storefront. Pick this up when you're ready to ship the next batch of features.

> **Status (2026-04-27):** Resend email pipeline is now wired up and tested via the custom-order form. The HTML email template pattern is proven. Domain verified. So the "build the email infrastructure" portion of this plan is essentially done — what's left is the storage layer, customer/admin UI, status workflows, and cron jobs. **Estimated remaining work: ~5 hours** (was 7 in the original scope).

---

## Vision in one paragraph

Customer pays → receives a tracking URL + immediate confirmation email. Bookmarks the URL, or comes back to the homepage and uses the "Track Order" lookup (last name + order ID, or phone + order ID). Maddie casually uploads photos as she bakes from her phone via a password-protected admin page. Each photo upload sends an email to the customer with the photo and a link back to the live tracking page. Customer feels involved. Photos are inherently shareable so they double as social proof. Pickup reminders fire automatically. Post-pickup follow-up requests a Facebook review.

---

## Full customer journey

```
DISCOVERY → ORDER → WAIT → PICKUP → POST-PICKUP

Discovery:
  Customer hears about MJ's Sweets (Facebook, word-of-mouth, Google)
  Visits mjs-sweets.com, browses products

Order:
  Adds items to cart → checkout → pays
  Success modal shows: order ID + "Track Your Order" link
  Square auto-emails standard receipt
  ALSO: Our system emails confirmation immediately with one-click track link

Wait period:
  Customer can return to homepage → "Track Order" → enter last name + order ID
  → see live status timeline + photos as Maddie posts them
  Bookmark the tracking page; it auto-updates
  
  Maddie uploads photos as she bakes:
  → Customer gets email with each photo
  → Email links bypass lookup form (signed token)
  
  24 hours before pickup:
  → Auto email: "Your cookies are ready tomorrow!"
  
  Morning of pickup:
  → Auto email: "Today's pickup day — here's the address"

Pickup:
  Maddie sets status to "Ready", optionally sets pickup time
  → Pickup address now visible on order page
  Maddie hands over box, taps "Mark Picked Up" in admin
  → Customer gets thank-you email

Post-pickup:
  24 hours after pickup:
  → Auto email: "Hope you loved them! Mind leaving a Facebook review?"
  → Direct link to https://www.facebook.com/mjssweets25
```

---

## Components to build

### Frontend

**Customer-facing:**
- New page `/order/[orderId]` — bookmarkable order tracking page
  - Order summary (items, total, pickup window)
  - Status timeline with current stage highlighted
  - Photo gallery, newest first, with timestamps and Maddie's captions
  - Pickup address (only shown once status = "Ready for Pickup")
  - "Need to change something? Text Maddie at (504) 559-6466" CTA
  - Mobile-first, swipe-able photo lightbox
- New "Track Order" modal in `index.html` (matches existing modal patterns)
  - Last name input (case-insensitive substring match)
  - OR phone number input (alternative to last name)
  - Order number input
  - Submit → validates → redirects to order page with signed cookie
  - Friendly help text explaining where to find order number
- "Track Order" link in nav (next to FAQ)
- "Track Order" link in footer Contact column
- Updated checkout success modal — prominent tracking URL + "Bookmark this" hint

**Maddie-facing:**
- New page `/admin` — password-protected
  - Login form (single password)
  - List of orders, last 30 days, newest first
  - Filter by status (Confirmed / Baking / Decorating / Ready / Picked Up / Canceled / No-Show)
  - Filter by `pickupDate` (today, this weekend, this week)
  - Search by customer name or order ID
- New page `/admin/order/[orderId]` — manage one order
  - Read-only order details (customer, items, `pickupWindow`, `pickupDate` once set)
  - Status buttons (advance pipeline; **bare advances are silent — no auto-email on Confirmed/Baking/Decorating**)
  - **One unified "Send Update" action** (single button → modal):
    - Optional photo(s) (multi-file, mobile camera-ready)
    - Optional free-text caption / note
    - Optional status change (auto-fills current; can advance with this update in one shot)
    - Cadence indicator visible in the modal: `📧 3rd update to Sarah today` (read from `updatesSent` log on the order)
    - Send button copy is explicit: `Send to Sarah →` (using customer's first name from the linked Square Customer record)
  - Quick actions outside the Send Update modal:
    - **Mark Ready** — sets `pickupDate` (date picker) → auto-fires the "Ready for pickup" email to customer
    - **Mark Picked Up** — auto-fires the thank-you / Facebook review email
    - **Cancel order** — opens link to the order in Square dashboard so Maddie processes refund there; once she clicks "Refund completed" back in admin, fires the cancellation email to customer
  - Existing photos with **soft-delete** (sets `hidden: true` on the photo record; blob is retained so already-sent email URLs still resolve). Confirmation copy: "This photo was sent to the customer in an email on [date]. Hiding it removes it from the tracking page; the email already sent will still show it."
  - Pickup address field (templated default; Maddie can override per-order)
  - **Email Activity panel** showing what was sent (with delivered / opened / failed states), what's coming up, and what won't fire for this order. Full spec in "Email activity surface" section below. No automatic emails happen invisibly.
- The `/admin` dashboard also surfaces a global email panel: last 24 hours sent count, any failures (with attention dot), next-firing email — see "Dashboard email panel" below.
- Mobile-optimized — Maddie will use this on her phone in the kitchen

### Backend

**New endpoints:**
- `GET /api/order-status?id=xxx` — public, returns order + extras (requires valid cookie or token). Response includes computed `expectedEmails[]` and `wontFireEmails[]` arrays for the Email Activity panel.
- `POST /api/order-verify` — takes `{lastNameOrPhone, orderId}`, validates against Square, sets signed cookie if match
- `POST /api/admin-login` — password check, sets signed admin cookie
- `POST /api/admin-logout` — clears admin cookie
- `GET /api/admin-orders` — list orders (auth required). Includes 24-hour email summary for the dashboard panel (sent/failed/coming-up counts).
- `POST /api/admin-update` — update status / upload photos / send notification (auth required). Every send writes to the order's `emails[]` log.
- `POST /api/resend-webhook` — public endpoint Resend calls for delivery / open / bounce events. Verifies HMAC signature using `RESEND_WEBHOOK_SECRET`, then patches the matching `emails[i]` entry on the relevant order by `resendId` lookup.

**Cron jobs (Vercel cron, free tier — all run UTC; see "Central Time scheduling" section below for the UTC-to-Central mapping):**
- `0 14 * * *` (≈8am Central winter / 9am Central summer): send "pickup tomorrow" reminders to orders matching `pickupDate === tomorrow` AND status ≥ Confirmed
- `0 13 * * *` (≈7am Central winter / 8am Central summer): send "pickup today" reminders to orders matching `pickupDate === today`
- `0 12 * * *` (≈6am Central winter / 7am Central summer): send "Maddie daily summary" — suppresses (no email sent) on truly empty days; see "Daily Maddie summary content" below for send criteria
- `0 16 * * *` (≈10am Central winter / 11am Central summer): send post-pickup review-request emails to orders marked Picked Up yesterday
- `0 15 * * *` (≈9am Central winter / 10am Central summer): no-show check — find orders where `pickupDate + 48hr < now` AND status still Ready, surface in Maddie's daily summary as actionable rows

### Shared library code

- `lib/order-storage.js` — read/write order metadata JSON in Blob
- `lib/order-auth.js` — sign/validate cookies and URL tokens for order pages
- `lib/admin-auth.js` — sign/validate admin auth cookie
- `lib/email.js` — Resend wrapper + HTML templates

---

## Storage design

**One JSON file per order in Vercel Blob:** `orders/{orderId}.json`

```json
{
  "orderId": "abc123...",
  "createdAt": "2026-04-27T01:00:00Z",
  "status": "decorating",
  "statusHistory": [
    { "status": "paid",       "ts": "2026-04-27T01:00:00Z", "auto": true },
    { "status": "confirmed",  "ts": "2026-04-27T08:30:00Z" },
    { "status": "baking",     "ts": "2026-05-09T08:00:00Z" },
    { "status": "decorating", "ts": "2026-05-09T11:00:00Z" }
  ],
  "photos": [
    {
      "url": "https://blob.../mixing-1.jpg",
      "caption": "Mixing the dough!",
      "ts": "2026-05-09T08:30:00Z",
      "stage": "baking",
      "hidden": false
    }
  ],
  "notes": [
    { "text": "Quick Q — can I substitute X?", "ts": "2026-05-09T09:00:00Z" }
  ],
  "emails": [
    {
      "id": "e_a8f3c1",
      "type": "order-confirmation",
      "trigger": "auto",
      "ts": "2026-04-27T01:00:30Z",
      "to": "sarah@example.com",
      "subject": "Your MJ's Sweets order is confirmed!",
      "status": "sent",
      "resendId": "re_8d2e4f",
      "deliveredAt": "2026-04-27T01:00:42Z",
      "openedAt": "2026-04-27T01:14:22Z"
    },
    {
      "id": "e_b9d4e2",
      "type": "send-update",
      "trigger": "maddie",
      "ts": "2026-05-09T13:00:00Z",
      "to": "sarah@example.com",
      "subject": "Update on your order from Maddie",
      "status": "sent",
      "metadata": { "photoCount": 2, "notePreview": "Almost done with the icing!" },
      "resendId": "re_a3b9c1",
      "deliveredAt": "2026-05-09T13:00:11Z",
      "openedAt": null
    },
    {
      "id": "e_c0e5f3",
      "type": "ready-for-pickup",
      "trigger": "auto",
      "ts": "2026-05-10T14:30:15Z",
      "to": "sarah@example.com",
      "subject": "Your cookies are ready, Sarah!",
      "status": "failed",
      "errorDetail": "Recipient mailbox full"
    }
  ],
  "pickupAddress": "123 Main St, Madisonville, LA 70447 — text when you arrive",
  "pickupWindow": "mothers-day-2026",
  "pickupDate": "2026-05-09",
  "pickupTimeNote": "Saturday 10am-12pm window",
  "canceledAt": null
}
```

**Field semantics worth knowing:**
- `pickupWindow` is the customer's seasonal batch (what they ordered for, e.g., `mothers-day-2026`). `pickupDate` is the actual day Maddie commits to (`YYYY-MM-DD`); set when she advances to Ready. All pickup-related crons key off `pickupDate`, not `pickupWindow`.
- `photos[i].hidden: true` is a soft-delete: filtered from the tracking page, but the underlying Vercel Blob URL still resolves so already-sent emails don't break.
- `emails[]` is an append-only log of every email send attempt — auto-fired, cron-driven, and Maddie-driven Send Updates all write here. Powers the **Email Activity panel** in admin (see "Email activity surface" below) plus the cadence indicator (`📧 3rd update to Sarah today` reads count of `type === "send-update"` from today). `trigger` distinguishes `auto` (status-change-driven), `cron` (scheduled), or `maddie` (Send Update click). `status` is `sent` / `failed` / `skipped`. `deliveredAt` and `openedAt` are populated by the Resend webhook.
- `canceledAt` is non-null only when status === `canceled`. Marks the moment Maddie clicked "Refund completed" after processing the Square refund.

Photos stored at `orders/{orderId}/photo-{timestamp}-{n}.jpg` in the same Blob bucket.

---

## Auth design

### Customer auth (per order)

- Cookie: `mjs_order_{orderId}`, value `{orderId}.{expiresAt}.{hmac}`, 30-day expiry
- HttpOnly, Secure, SameSite=Lax
- Set after successful lookup (last name OR phone match)
- URL token (for email links): `?t=base64({orderId}.{expiresAt}.{hmac})`, signed with same secret
- Validates without needing the cookie — generated by email pipeline
- Last-name matching: case-insensitive, trimmed, substring (handles "Smith-Jones", "Maria Garcia Lopez"). Pull `familyName` from the linked Square Customer record (post-2026-05-05) as the primary source, falling back to last-word-of `customer_name` in Order metadata for any orders that pre-date the customer-directory work.
- Phone matching: digits-only, last 10 digits. Normalize both the input and the stored values, then compare. Stored phone exists in two forms post-2026-05-05 — raw `customer_phone` in Order metadata (e.g., `(504) 555-1234`) and E.164 `phoneNumber` on the linked Square Customer record (`+15045551234`). Either resolves to the same order.

### Admin auth (Maddie)

- Single admin password stored as Vercel env var
- POST password to `/api/admin-login` → if match, sets signed cookie
- Cookie expires 7 days, refreshed on activity
- Failed login: rate-limited (5 attempts / 15 minutes by IP)

---

## Status pipeline

| Stage | Triggered by | Auto-email to customer? | Notes |
|---|---|---|---|
| Paid | Auto on payment | No — Square handles receipt; our order-confirmation email already fires from `/api/checkout` and `/api/contact` | Set automatically |
| Confirmed | Maddie advances | **No** — bare advance is silent | Customer notified only via "Send Update" |
| Baking | Maddie advances | **No** — bare advance is silent | Send Update is how engagement happens at this stage |
| Decorating | Maddie advances | **No** — bare advance is silent | Same |
| Ready for Pickup | Maddie sets `pickupDate` + advances | **Yes (auto)** | "Your cookies are ready! Pickup at [pickupDate]: [address]" |
| Picked Up | Maddie marks complete | **Yes (auto)** | Thank-you email + Facebook review CTA |
| Canceled | Maddie clicks "Cancel" → completes refund in Square dashboard → clicks "Refund completed" in admin | **Yes (auto)** after Maddie confirms refund | "Refund processing — your order has been canceled. Sorry to miss you." |
| No-Show | Auto-suggested 48hr after `pickupDate` if status still Ready; Maddie one-clicks to confirm | **Yes (auto)** after Maddie confirms | "Hey, did we miss you? Cookies are still here — text Maddie to arrange pickup." Optional further action: refund within 7 days. |

Maddie can advance forward and jump back if needed. Bare status advances on Confirmed / Baking / Decorating are silent by design — the unified "Send Update" action is the customer-facing surface for those mid-pipeline stages, since photos and notes are what customers actually engage with.

---

## Email pipeline (via Resend)

All emails branded in pink/cream matching site aesthetic. Mobile-optimized HTML. Greetings always pull the customer's first name from the linked Square Customer record (`givenName`), populated since the 2026-05-05 customer-directory work — see `DEVELOPMENT_LOG.md` for context. Falls back to `customer_name` first-word in Order metadata if for any reason the Customer link is missing (defensive).

**Maddie-driven email (one unified surface):**
1. **Update from Maddie** — fires once per click of "Send Update" in the admin order page. Body contains optional photos (gallery layout), optional note, current status badge, customer first name, link to live tracking page. The cadence indicator in admin shows how many updates this customer has received today, read from `updatesSent` on the order.

**Auto-fired (no Maddie action):**
2. **Order confirmation** — fires immediately after `/api/checkout` (cart) or `/api/contact` (custom) succeeds. Custom-order confirmation already exists; cart-order confirmation is new in this plan. Subject: `Your MJ's Sweets order is confirmed! (Order #XYZ)`.
3. **Ready for pickup** — fires when Maddie sets `pickupDate` and advances status to Ready. Includes `pickupAddress` + `pickupDate` formatted in Central Time. Subject: `Your cookies are ready, [firstName]!`.
4. **Picked up / thank you** — fires when Maddie marks Picked Up. Includes Facebook review CTA. Subject: `Thanks for picking up, [firstName]! 🍪`.
5. **Refund confirmation** — fires after Maddie clicks "Refund completed" on a canceled order. Subject: `Your MJ's Sweets order has been refunded`.
6. **No-show check-in** — fires when Maddie confirms No-Show on the 48-hour-stale prompt. Subject: `Did we miss you, [firstName]?`.

**Cron-driven (see "Central Time scheduling" below for UTC schedule):**
7. **Pickup tomorrow** — fires the day before `pickupDate`, only if status ≥ Confirmed. Subject: `Your cookies are ready tomorrow!`.
8. **Pickup today** — fires the morning of `pickupDate`. Subject: `Today's pickup day, [firstName]`.
9. **Post-pickup review request** — fires 24hr after Picked Up. Subject: `Hope you loved them — leave us a review?`.
10. **Maddie's daily summary** — fires every morning *if* there's any active order or recent pickup activity. Sent to Maddie (not customers). On truly empty days the cron exits silently without sending. See "Daily Maddie summary content" below for the full send criteria.

All customer-facing emails include the signed track-link URL so the customer goes straight to their order page without needing to look up an order ID.

---

## Central Time scheduling

Madisonville is Central, the bakery doesn't ship outside the region, and customers reading these emails are all in Central or close to it. **All wall-clock times in customer-facing email bodies render in Central Time** (e.g., "your cookies will be ready Saturday at 10am Central"). Format helper should accept a UTC timestamp and an `America/Chicago` zone string, then render via `Intl.DateTimeFormat` so DST is handled automatically.

**Cron jobs run UTC** because that's what Vercel cron supports. Vercel cron does NOT understand DST, so a fixed UTC time will land at slightly different Central wall-clock times in winter (CST = UTC-6) vs. summer (CDT = UTC-5). UTC times below were picked so the cron always fires at-or-after the intended Central wall-clock time — never offensively early in either season.

| Cron name | Schedule (UTC) | Local time CST (winter) | Local time CDT (summer) |
|---|---|---|---|
| Maddie daily summary | `0 12 * * *` | 6am | 7am |
| Pickup today | `0 13 * * *` | 7am | 8am |
| Pickup tomorrow | `0 14 * * *` | 8am | 9am |
| No-show check | `0 15 * * *` | 9am | 10am |
| Post-pickup review | `0 16 * * *` | 10am | 11am |

If a future feature needs DST-precise scheduling, the cron's function can check current Central time on entry (`new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })`) and bail until the right hour — overengineered for v1 but a clean upgrade path.

---

## Daily Maddie summary content

Maddie's primary touchpoint with the system. Skimmed on her phone in bed; should be everything she needs to plan her day. Six sections, in order:

1. **Active order count** — single header line. Example: `9 active orders · 3 picking up today`.

2. **Today's pickups** — orders with `pickupDate === today`, grouped by time-window if Maddie set one. Each row: customer first name, items summary (`Custom Showstopper × 2 dz`), time window, current status badge. Tap any row to deep-link into the admin order page.

3. **Yesterday's unresolved** — orders with `pickupDate === yesterday` AND status still Ready (not Picked Up). One-click action buttons inline: `Mark Picked Up` and `Flag No-Show`. Hitting either fires the relevant customer email and updates status; Maddie doesn't need to log into admin for these.

4. **Tomorrow's confirmed** — orders with `pickupDate === tomorrow` AND status ≥ Confirmed. Use this to plan today's baking. Each row links to the admin order page.

5. **Past-due, no resolution** — orders where `pickupDate + 48hr < now` AND status ∉ {Picked Up, Canceled, No-Show}. Drives the No-Show prompt. Each row has a `Confirm No-Show` action button.

6. **Send criteria — suppress on empty days.** The cron runs every morning, but the email is **only sent when there is at least one of**: a pickup today, an unresolved yesterday, a confirmed tomorrow, a past-due order, OR any active order in any non-terminal state (Confirmed / Baking / Decorating / Ready). On truly empty days — no active orders anywhere in the system — the cron exits silently without firing an email. No "quiet day" filler.

The summary fires every day of the week (including weekends — Maddie often bakes Saturdays and pickup activity is heaviest then) whenever the send criteria are met.

If Maddie ever wants to confirm the cron is alive during a long drought, she can hit `/admin` directly (the orders list will show what's active). The cron logs are also visible in the Vercel dashboard.

---

## Email activity surface

So Maddie can see what's been sent and what's coming — automatic emails should not be invisible to her. Two views: per-order detail and admin dashboard summary.

### Per-order Email Activity panel

Lives on `/admin/order/[orderId]`, below the Send Update action. Three sub-sections, ordered by recency:

```
EMAIL ACTIVITY

Sent
  ✅ Apr 27 · 8:00pm   Order confirmation                opened ✉️  (auto)
  ✅ May 09 · 1:00pm   Update from Maddie · 2 photos     opened ✉️  (you)
  ✅ May 10 · 9:30am   Pickup tomorrow reminder          delivered  (cron)
  ❌ May 10 · 2:30pm   Ready for pickup                  failed: Recipient mailbox full

Coming up
  ⏰ May 11 · 7am Central         Pickup today reminder      (cron)
  ⏰ When you mark Picked Up      Thank-you email            (auto)
  ⏰ May 12 · 10am Central        Post-pickup review request (24hr after Picked Up)

Won't fire
  ⚪ Refund confirmation          Only if order is canceled
  ⚪ No-show check-in             Only if pickup not marked by May 13
```

Visual conventions:
- **✅ Sent + opened** — green check, "opened ✉️" badge if Resend webhook reported an open. Slightly muted color if not opened (delivered but unread). 
- **✅ Delivered** — green check, no opened badge. Means the email landed in their inbox (Resend confirmed) but no open tracking event yet.
- **❌ Failed** — red X with the error reason inline. Important: failures are surfaced visibly so Maddie can text the customer as a fallback.
- **⏰ Coming up** — clock icon with the trigger condition. Either a specific time ("May 11 · 7am Central") or a state-driven trigger ("When you mark Picked Up").
- **⚪ Won't fire** — gray dot with the conditional that would activate it. Lets Maddie see the full email map for an order without surprises.
- Each row has a hover/tap target → reveals subject line + recipient + (for sent) "View as customer saw it" link that renders the actual HTML in a modal.

The "Coming up" section is computed at view-time from order state + the cron rules (no scheduling table maintained in storage). State-driven entries surface automatically as the order progresses through the pipeline.

### Dashboard email panel

On `/admin` (the orders list page), a compact panel above the orders list:

```
EMAILS · last 24 hours

  📤 12 sent      · last: May 10 · 11am · "Update from Maddie" → Sarah
  ❌ 1 failed     · ⚠️ tap to review
  ⏰ 4 coming up  · next: May 11 · 7am Central · "Pickup today" × 3
```

- Failed count surfaces an attention dot if non-zero. Tapping the failed row shows the failures across all orders for the past 24h.
- Coming up shows the next-firing email and the count of imminent (next 24h) emails so Maddie has a heads-up.
- Tapping the panel header drills into a global email log (last 7 days, paginated) — useful for postmortems ("did the Mother's Day reminders all fire?").

### Implementation notes

- **Resend webhook integration** for delivery + open tracking: new endpoint `POST /api/resend-webhook` receives Resend's event payloads (`email.delivered`, `email.opened`, `email.bounced`, etc.), looks up the order by the `resendId` we stored on send, and updates the matching `emails[i]` entry. Webhook signing secret is verified per Resend's docs (HMAC over the raw body).
- **Append-only writes:** every email send (success OR failure) appends to `emails[]` BEFORE returning to caller. Webhook updates patch the entry in-place. No deletions; history is the auditable trail.
- **"View as customer saw it":** stash the rendered HTML at send time alongside the `emails[]` entry, OR re-render from the same template at view-time (simpler, but stale if templates change). For v1, re-render is fine — the templates change rarely and the customer-facing copy is what matters.
- **Compute "Coming up" lazily:** read order state, run a small pure function `computeExpectedEmails(order)` that returns the list. No background job, no queue.
- **Compute "Won't fire" lazily too:** same function with the inverse — emails that would fire under different conditions, surfaced for transparency.
- **No skip / send-now actions in v1.** Visibility-only as requested. If Maddie wants to send something earlier or suppress one, she does it via the existing surfaces (Send Update for early sends; staying silent on cron emails by transitioning the order out of the matching status). Skip/send-now is a clean v1.1 addition once we see if she actually needs it.

---

## Setup checklist (do these before building)

- [x] **Sign up for Resend** at https://resend.com using `jordanbcisco@gmail.com`
- [x] **Verify mjs-sweets.com domain in Resend** (DNS at Vercel, all records green)
- [x] **Get Resend API key** from Resend dashboard → API Keys → Create
- [x] **`RESEND_API_KEY`** env var set in Vercel (Sensitive)
- [x] **`RESEND_FROM_EMAIL`** env var set in Vercel = `orders@mjs-sweets.com`
- [x] **`NOTIFY_EMAIL`** env var set in Vercel (comma-separated for multiple recipients)

**Still to do:**

- [ ] **Pick admin password** — strong but memorable, e.g., `madisonville-cookies-2026`
- [ ] **Generate cookie secrets** — run `openssl rand -hex 32` **twice** (one for admin, one for order verify)
- [ ] **Add Resend webhook endpoint** in Resend dashboard → Webhooks → New: URL `https://www.mjs-sweets.com/api/resend-webhook`, events `email.delivered`, `email.opened`, `email.bounced`, `email.complained`. Copy the signing secret it generates.
- [ ] **Add 5 more env vars in Vercel** (Production + Preview + Development):
  - [ ] `ADMIN_PASSWORD` = (your chosen password) — mark Sensitive
  - [ ] `ADMIN_COOKIE_SECRET` = (first openssl output) — mark Sensitive
  - [ ] `ORDER_VERIFY_SECRET` = (second openssl output) — mark Sensitive
  - [ ] `SITE_URL` = `https://www.mjs-sweets.com`
  - [ ] `RESEND_WEBHOOK_SECRET` = (signing secret from Resend webhook setup) — mark Sensitive

---

## Env vars summary

| Name | Value | Sensitive | Set? |
|---|---|---|---|
| `RESEND_API_KEY` | from resend.com | Yes | ✅ |
| `RESEND_FROM_EMAIL` | `orders@mjs-sweets.com` | No | ✅ |
| `NOTIFY_EMAIL` | comma-separated recipients | No | ✅ |
| `ADMIN_PASSWORD` | (chosen) | Yes | ⏭️ |
| `ADMIN_COOKIE_SECRET` | `openssl rand -hex 32` | Yes | ⏭️ |
| `ORDER_VERIFY_SECRET` | `openssl rand -hex 32` | Yes | ⏭️ |
| `SITE_URL` | `https://www.mjs-sweets.com` | No | ⏭️ |
| `RESEND_WEBHOOK_SECRET` | from Resend dashboard → Webhooks → Add endpoint | Yes | ⏭️ |

---

## Build phases (estimated ~7 hours total — Resend infrastructure is now done)

| Phase | Time | Deliverable | Status |
|---|---|---|---|
| 1. Storage layer | 25 min (was 20) | `lib/order-storage.js` + `/api/order-status` (includes `pickupDate`, `hidden` photo flag, `emails[]` log, `canceledAt`) | ⏭️ |
| 2. Order verification + cookie/token | 30 min | `lib/order-auth.js` + `/api/order-verify` (phone matching against both raw + E.164) | ⏭️ |
| 3. Customer order page | 60 min | `/order/[id]` with auth check, status timeline (incl. Canceled / No-Show states), photo gallery filtered to non-hidden, lightbox | ⏭️ |
| 4. Track Order modal + nav/footer links | 30 min | Modal in index.html, links wired | ⏭️ |
| 5. Admin auth | 30 min | Login page + cookie validation | ⏭️ |
| 6. Admin orders list with filters + dashboard email panel | 60 min (was 45) | `/admin` lists recent orders, filter by status/`pickupDate`, plus 24h email summary panel with sent/failed/coming-up counts | ⏭️ |
| 7. Admin order detail + Send Update modal + soft-delete + cancel-then-refund + Email Activity panel | 120 min (was 90) | `/admin/order/[id]` full management; Email Activity panel renders sent / coming-up / won't-fire from `emails[]` log + `computeExpectedEmails(order)` | ⏭️ |
| 8. Email integration | 15 min | `lib/email.js` + 10 templates — reuse pattern from `api/contact.js`, all use customer `firstName`, every send appends to `emails[]` log with `resendId` | ⏭️ |
| 9. Wire admin actions to email + checkout success | 45 min | Email sends, success modal updates with track link | ⏭️ |
| 10. Vercel cron jobs (reminders + summary + no-show check) | 75 min | 5 cron jobs, schedule config in `vercel.json`, all UTC times documented with Central equivalents | ⏭️ |
| 11. Resend webhook handler + email-status update | 30 min (NEW) | `POST /api/resend-webhook` verifies HMAC, patches `emails[i]` with `deliveredAt` / `openedAt` / `failed` state | ⏭️ |
| 12. "View as customer saw it" email preview modal | 20 min (NEW) | Click any sent email row → modal renders the email HTML using the same template the customer received | ⏭️ |
| 13. Polish + mobile testing + edge cases | 45 min | Loading states, error copy, responsive, lightbox UX, Email Activity mobile layout | ⏭️ |

---

## User journey enhancements (decisions to make)

Earlier we identified 11 enhancements. Recommendation on what's in v1 vs deferred:

### Build in v1 (included in 7-hour estimate above)

1. **Confirmation email immediately after order** — critical, the safety net for lost order IDs
2. **Phone number as alternate lookup** — small effort, big UX win
3. **"Send note" feature for Maddie** — huge flexibility for her workflow
4. **"Need to change something?" CTA on order page** — tiny addition, prevents support queries
5. **Pickup address visible once Ready** — tiny addition, customers need to know where to go
6. **Loading states + better error copy** — baseline polish, not optional
7. **Mobile photo lightbox** — premium feel for the photo viewing experience

### Build in v1.1 (next sprint, week or two later)

8. **Pickup reminder emails (24hr + day-of)** — needs Vercel cron setup
9. **Post-pickup review request** — needs cron setup
10. **Daily summary email to Maddie** — needs cron setup
11. **Admin filters/search** — quality of life for Maddie when volume increases

### v2 (post-launch when you see actual usage)

- Plausible analytics (1-line addition, do whenever)
- Referral system ($5 off for sharing)
- Customer accounts (saved address, order history) — only if customers ask
- SMS notifications to customers (requires 10DLC registration)
- Order modification self-service

---

## Decisions (resolved 2026-05-06)

| # | Decision | Resolved value |
|---|---|---|
| 1 | Status stages | Paid → Confirmed → Baking → Decorating → Ready → Picked Up, plus Canceled and No-Show side states |
| 2 | Customer-notification model | Bare status advances are silent. Customer-facing email only fires via the unified "Send Update" action OR auto-fired Ready / Picked Up / Refund / No-Show emails |
| 3 | Email FROM address | `orders@mjs-sweets.com` |
| 4 | Email FROM name | `MJ's Sweets` |
| 5 | Order ID format in URLs | Square's full ID (`/order/Vrvg4P5UswEe3...`) |
| 6 | Photos per upload limit | 10 photos, 10 MB each |
| 7 | Email frequency cap | None enforced; admin shows a per-customer cadence indicator (`📧 3rd update to Sarah today`) so Maddie self-regulates |
| 8 | Old orders accessible? | Yes, forever (with valid auth) |
| 9 | Photo deletion | Soft-delete (`hidden: true`); blob retained so already-sent email URLs still resolve |
| 10 | Pickup time abstraction | Per-order `pickupDate` distinct from `pickupWindow`; all pickup-related crons key off `pickupDate` |
| 11 | Timezone for emails / display | Central Time for all customer-facing wall-clock; cron jobs scheduled UTC with Central equivalents documented |
| 12 | Customer first name in greetings | Yes — read `givenName` from the linked Square Customer record (post-2026-05-05 customer-directory work) |
| 13 | Cancel / refund flow | Manual via Square dashboard; admin has a "Refund completed" button that fires the customer cancellation email |
| 14 | No-show handling | Auto-suggested 48hr after `pickupDate` if status still Ready; surfaces in Maddie's daily summary as actionable rows; one-click confirm fires the customer No-Show email |
| 15 | Email activity visibility | Email Activity panel on every `/admin/order/[id]` showing Sent (with delivered/opened/failed states) + Coming Up + Won't Fire. Plus a 24-hour email summary panel on `/admin` dashboard. Visibility-only for v1 — no skip / send-now actions yet |
| 16 | Open / delivered tracking source | Resend webhook (`POST /api/resend-webhook`) patches `emails[i].deliveredAt` / `openedAt` / failure state. HMAC-verified per Resend's docs |
| 17 | Email preview ("View as customer saw it") | Re-render at view time using the same template the customer received. No HTML stashing — keeps storage lean and templates always reflect the canonical version |

---

## What to send when ready to start

The 14 design decisions above are resolved (2026-05-06). What's left to unblock the build:

1. **Confirm the 4 remaining env vars are set in Vercel** — `ADMIN_PASSWORD`, `ADMIN_COOKIE_SECRET`, `ORDER_VERIFY_SECRET`, `SITE_URL`. Don't share the password or secrets in chat — just set them and confirm.
2. **Scope confirmation** — all 7 v1 items, or any to defer?

Then phase 1 starts.

---

## Reference: existing infrastructure that supports this

These already exist and don't need changes:

- Vercel Blob (`mjs-sweets-public-blob`) — used for order photos and metadata JSON
- SignalWire SMS — Maddie still gets SMS on new orders (separate from this email pipeline)
- Square Web Payments + production credentials — orders flow into Square as before
- DNS at Vercel — domain `mjs-sweets.com` works
- Apple Pay / Google Pay verification — works for production checkout

This feature layers on top without changing any of the above.

---

## Operational notes

- **Email deliverability:** verifying mjs-sweets.com domain is critical so emails don't land in spam. SPF/DKIM/DMARC records do this.
- **Resend free tier:** 100 emails/day, 3,000/month. A busy Mother's Day week (~30 active orders × ~3 Send Updates each + cron emails + confirmations + auto-fired status emails) could approach the daily cap. Verify current Resend pricing before peak weeks; the next paid tier (~$20/mo) covers 50,000/month and is the obvious upgrade if usage warrants. Pin the daily cap as an alert in Resend's dashboard.
- **Cron jobs use Vercel free tier:** 1000 invocations/month, well within limits for 5 daily crons.
- **Photo storage:** 1GB Blob free tier covers thousands of small photos. Soft-deleted (`hidden: true`) photos still occupy storage; if storage ever becomes a concern, a separate purge cron can hard-delete photos older than 90 days where `hidden: true`.
- **Customer first name source:** post-2026-05-05, every order is linked to a Square Customer record with `givenName` parsed via the helper at `api/_lib/squareCustomer.js`. Email templates should always pull from there, not from `customer_name` in Order metadata. Fallback to first-word-of `customer_name` if the Customer link is missing.
- **Admin password recovery:** if Maddie forgets, just rotate `ADMIN_PASSWORD` env var in Vercel and tell her the new one.
- **No PII in URLs:** order ID is random; customer name/email never in URL params.
- **GDPR / privacy:** customer photos are uploaded by them, displayed only to verified viewers; Maddie's photos are her business content. No tracking pixels, no analytics by default.
