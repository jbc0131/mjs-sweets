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
  - Filter by status (Confirmed/Baking/Decorating/Ready/Picked Up)
  - Filter by pickup date (today, this weekend, this week)
  - Search by customer name or order ID
- New page `/admin/order/[orderId]` — manage one order
  - Read-only order details (customer, items, pickup window)
  - Status buttons (advance through pipeline, jump back if needed)
  - Photo upload (multi-file, mobile camera-ready)
  - Caption input per upload batch
  - "Notify customer" checkbox (default ON) — toggles whether email goes out
  - Free-text "Send a note" field (e.g., "Quick Q — can I substitute X?")
  - Existing photos with delete buttons (with confirmation)
  - Pickup address field (templated default Maddie can override)
- Mobile-optimized — Maddie will use this on her phone in the kitchen

### Backend

**New endpoints:**
- `GET /api/order-status?id=xxx` — public, returns order + extras (requires valid cookie or token)
- `POST /api/order-verify` — takes `{lastNameOrPhone, orderId}`, validates against Square, sets signed cookie if match
- `POST /api/admin-login` — password check, sets signed admin cookie
- `POST /api/admin-logout` — clears admin cookie
- `GET /api/admin-orders` — list orders (auth required)
- `POST /api/admin-update` — update status / upload photos / send notification (auth required)

**Cron jobs (Vercel cron, free tier):**
- Daily at 8am: send "pickup tomorrow" reminders to orders matching tomorrow's window
- Daily at 7am: send "pickup today" reminders to orders matching today's window
- Daily at 9am: send "Maddie daily summary" with today's pickups
- Daily at 10am: send post-pickup review-request emails to orders marked Picked Up yesterday

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
      "stage": "baking"
    }
  ],
  "notes": [
    { "text": "Quick Q — can I substitute X?", "ts": "2026-05-09T09:00:00Z" }
  ],
  "pickupAddress": "123 Main St, Madisonville, LA 70447 — text when you arrive",
  "pickupTimeNote": "Saturday 10am-12pm window"
}
```

Photos stored at `orders/{orderId}/photo-{timestamp}-{n}.jpg` in the same Blob bucket.

---

## Auth design

### Customer auth (per order)

- Cookie: `mjs_order_{orderId}`, value `{orderId}.{expiresAt}.{hmac}`, 30-day expiry
- HttpOnly, Secure, SameSite=Lax
- Set after successful lookup (last name OR phone match)
- URL token (for email links): `?t=base64({orderId}.{expiresAt}.{hmac})`, signed with same secret
- Validates without needing the cookie — generated by email pipeline
- Last-name matching: case-insensitive, trimmed, substring (handles "Smith-Jones", "Maria Garcia Lopez")
- Phone matching: digits-only, last 10 digits

### Admin auth (Maddie)

- Single admin password stored as Vercel env var
- POST password to `/api/admin-login` → if match, sets signed cookie
- Cookie expires 7 days, refreshed on activity
- Failed login: rate-limited (5 attempts / 15 minutes by IP)

---

## Status pipeline

| Stage | Triggered by | Customer email? | Default behavior |
|---|---|---|---|
| Paid | Auto on payment | No (Square handles receipt) | Set automatically |
| Confirmed | Maddie clicks button | Optional | "Maddie has your order!" |
| Baking | Maddie advances | Optional + can include photos | Photos triggered email |
| Decorating | Maddie advances | Optional + can include photos | Photos triggered email |
| Ready for Pickup | Maddie sets pickup time | Yes (auto) | "Your cookies are ready! Pickup details: [address]" |
| Picked Up | Maddie marks complete | Yes (auto) | Thank-you email + Facebook review CTA |

Maddie can advance forward, jump back if needed, and add photos at any stage.

---

## Email pipeline (via Resend)

All emails branded in pink/cream matching site aesthetic. Mobile-optimized HTML.

**Trigger emails (event-driven):**
1. **Order confirmation** — sent immediately after `/api/checkout` succeeds
2. **Photo update** — sent when Maddie uploads photo(s) and "notify customer" is checked
3. **Note from Maddie** — sent when Maddie sends a free-text note
4. **Status change** (optional) — sent if Maddie checks "notify on this status change"
5. **Ready for pickup** — auto when status set to Ready, includes address
6. **Picked up / thank you** — auto when status set to Picked Up, includes Facebook review CTA

**Cron-driven emails:**
7. **Pickup tomorrow** — fires 24hr before pickup window, only if status is Confirmed or further
8. **Pickup today** — fires morning of pickup window
9. **Post-pickup review request** — fires 24hr after Picked Up
10. **Maddie's daily summary** — fires 7am, lists today's pickups (sent to Maddie, not customers)

All emails include the signed track link so customer goes straight to their order page.

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
- [ ] **Add 4 more env vars in Vercel** (Production + Preview + Development):
  - [ ] `ADMIN_PASSWORD` = (your chosen password) — mark Sensitive
  - [ ] `ADMIN_COOKIE_SECRET` = (first openssl output) — mark Sensitive
  - [ ] `ORDER_VERIFY_SECRET` = (second openssl output) — mark Sensitive
  - [ ] `SITE_URL` = `https://www.mjs-sweets.com`

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

---

## Build phases (estimated ~5 hours total — Resend infrastructure is now done)

| Phase | Time | Deliverable | Status |
|---|---|---|---|
| 1. Storage layer | 20 min | `lib/order-storage.js` + `/api/order-status` | ⏭️ |
| 2. Order verification + cookie/token | 30 min | `lib/order-auth.js` + `/api/order-verify` | ⏭️ |
| 3. Customer order page | 60 min | `/order/[id]` with auth check, status timeline, photo gallery, lightbox | ⏭️ |
| 4. Track Order modal + nav/footer links | 30 min | Modal in index.html, links wired | ⏭️ |
| 5. Admin auth | 30 min | Login page + cookie validation | ⏭️ |
| 6. Admin orders list with filters | 45 min | `/admin` lists recent orders, filter by status/date | ⏭️ |
| 7. Admin order detail + photo upload + status + notes | 75 min | `/admin/order/[id]` full management | ⏭️ |
| 8. Email integration | **15 min** (was 60) | `lib/email.js` + 6 trigger templates — reuse pattern from `api/contact.js` | ⏭️ |
| 9. Wire admin actions to email + checkout success | 45 min | Email sends, success modal updates with track link | ⏭️ |
| 10. Vercel cron jobs (reminders + summary) | 60 min | 4 cron jobs, schedule config | ⏭️ |
| 11. Polish + mobile testing + edge cases | 45 min | Loading states, error copy, responsive, lightbox UX | ⏭️ |

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

## Open decisions

| # | Decision | Default |
|---|---|---|
| 1 | Status stages | Paid → Confirmed → Baking → Decorating → Ready → Picked Up |
| 2 | Auto-notify customer or per-action toggle | Toggle (Maddie controls) |
| 3 | Email FROM address | `orders@mjs-sweets.com` |
| 4 | Email FROM name | `MJ's Sweets` |
| 5 | Order ID format in URLs | Square's full ID (`/order/Vrvg4P5UswEe3...`) |
| 6 | Photos per upload limit | 10 photos, 10 MB each |
| 7 | Email frequency cap | None — Maddie decides per upload |
| 8 | Old orders accessible? | Yes, forever (with valid auth) |

If defaults are fine, no action needed. Override any in your reply when you start building.

---

## What to send when ready to start

Just reply with:

1. **Confirmation the 4 remaining env vars are set in Vercel** — `ADMIN_PASSWORD`, `ADMIN_COOKIE_SECRET`, `ORDER_VERIFY_SECRET`, `SITE_URL`. Don't tell me the password or secrets — just set them and confirm.
2. **Decision overrides** (or "defaults are fine")
3. **Scope confirmation** — all 7 v1 items, or any to defer?

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
- **Cron jobs use Vercel free tier:** 1000 invocations/month, well within limits for daily emails.
- **Photo storage:** 1GB Blob free tier covers thousands of small photos. Each order's photos can be deleted after 90 days if storage becomes a concern (cron job).
- **Admin password recovery:** if Maddie forgets, just rotate `ADMIN_PASSWORD` env var in Vercel and tell her the new one.
- **No PII in URLs:** order ID is random; customer name/email never in URL params.
- **GDPR / privacy:** customer photos are uploaded by them, displayed only to verified viewers; Maddie's photos are her business content. No tracking pixels, no analytics by default.
