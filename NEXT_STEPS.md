# Next Steps — MJ's Sweets

Active checklist of pending work. See `DEVELOPMENT_LOG.md` for what's already shipped.

## Where we are

Storefront is **live in production at https://www.mjs-sweets.com** with:
- Card, Apple Pay, and Google Pay checkout — for both seasonal sets AND paid custom orders
- **Paid custom-order flow** with two tiers (Signature $40/dz, Showstopper $46/dz), 1–10 dozen, 14-day lead time, full-refund-on-cancel within 24 hours
- Real product photos
- 52-photo portfolio gallery across 7 categories
- Branded HTML email notifications via Resend (Maddie + customer confirmation)
- SMS notifications via SignalWire (best-effort; see Priority 3)

---

## Recently shipped

**Paid custom-order flow** — `CUSTOM_ORDER_PLAN.md` shipped end-to-end. Customer fills the existing form, picks a tier (Signature/Showstopper) and quantity (1–10 dozen), pays upfront via Square (card / Apple Pay / Google Pay) with a 14-day lead-time floor. Charge goes through `api/contact.js`, which fetches authoritative tier prices from Square Catalog, creates a Square Order + Payment with client-supplied idempotency keys (so retries collapse to one charge), then fires three notifications in parallel (Maddie email, customer confirmation email, Maddie SMS) — all best-effort post-charge so notification failures never double-charge a customer. Maddie has 24 hours to confirm or refund; full refund is one click in the Square dashboard. Pre-launch test plan is documented in `CUSTOM_ORDER_PLAN.md` § Test plan.

**Action items for Maddie before going live:**
- [ ] Add 2 items in the Square dashboard (already mirrored in `Square_Item_Import.csv` for repo bookkeeping):
  - Signature Custom Dozen / SKU `CUSTOM-SIG-DZN` / $40 / Sellable=Y, Stockable=N
  - Showstopper Custom Dozen / SKU `CUSTOM-SHOW-DZN` / $46 / Sellable=Y, Stockable=N
- [ ] Walk through `CUSTOM_ORDER_PLAN.md` § Test plan (12 cases) on a preview deploy before merging to main
- [ ] After first real custom order: confirm Square dashboard refund flow takes <30 seconds (Order → Refund → confirm)

---

## Priority 1 — Custom-order form notifications

**Status: ✅ Done via Resend email + ⚠️ SignalWire SMS (best-effort)**

The custom-order form now sends a branded HTML email via Resend on every submission. Email is the gating channel — if it lands, the form claims success regardless of SMS state. SignalWire SMS still fires in parallel as a "buzz alert" when carriers cooperate, but its failure is non-fatal.

`NOTIFY_EMAIL` accepts a comma-separated list, so both Maddie and Jordan can receive each order. Reply-To is set to the customer's email, so hitting Reply in either inbox responds straight to them.

### Optional — Complete SignalWire A2P 10DLC registration to make SMS reliable too

Removes the "[SignalWire Free Trial]" prefix that triggers carrier filtering. Email is now reliable on its own, but if you want SMS as a redundant alert too, this is how to fix it.

- [ ] SignalWire dashboard → Compliance → A2P 10DLC → register Sole Proprietor brand ($4 one-time)
- [ ] Register a campaign for "MJ's Sweets order notifications" (~$2/month)
- [ ] Wait 1-7 business days for carrier approval
- [ ] After approval, SMS becomes ~99% deliverable; both channels then fire reliably

---

## Priority 2 — Order tracking + admin interface

Fully scoped in `ORDER_TRACKING_PLAN.md`. Highlights:

- Customer-facing `/order/[id]` page with status timeline + photo gallery
- "Track Order" lookup form on homepage (last name OR phone + order ID)
- Maddie's `/admin` page (password-protected) — upload photos as she bakes, advance status
- Each photo upload triggers a customer email with the photo + tracking link
- Vercel cron jobs for pickup reminders (24hr before, day-of) and post-pickup review request

**Updated estimate: ~5 hours** (was 7 — Resend infrastructure is now done so the email phase is much faster).

When ready to build:
- [ ] Read `ORDER_TRACKING_PLAN.md` top to bottom
- [ ] Complete the **4 remaining env vars** in Vercel: `ADMIN_PASSWORD`, `ADMIN_COOKIE_SECRET`, `ORDER_VERIFY_SECRET`, `SITE_URL` (~5 min)
- [ ] Reply to Claude with confirmation + decision overrides; build begins

---

## Priority 3 — Switch SMS notifications to Maddie's actual phone

Right now `NOTIFY_PHONE` env var is `+1 (504) 330-4335` (Jordan's verified number for testing). Once Maddie verifies her number on SignalWire, flip the env var.

- [ ] Maddie completes verified caller ID flow on SignalWire for `+1 (504) 559-6466`
- [ ] Vercel → Settings → Environment Variables → edit `NOTIFY_PHONE` to `+15045596466`
- [ ] No code change needed; next deploy uses the new value

---

## Priority 4 — Switch site to mjssweets.com (or keep mjs-sweets.com)

Currently on `mjs-sweets.com`. If a cleaner domain becomes available or preferred, the migration is mostly DNS work (no code changes).

- [ ] Decide on final domain
- [ ] Add to Vercel domains
- [ ] Update DNS at Namecheap
- [ ] Re-do Apple Pay domain verification on Square Production tab
- [ ] Update `og:url`, `canonical`, `SITE_URL` env var, JSON-LD schema URLs

---

## Priority 5 — Quality of life additions (whenever)

These are nice-to-have, not blocking anything:

- [ ] **Cart persistence via localStorage** — refresh shouldn't empty the cart. Currently it does.
- [ ] **Auto-rolling holiday dates** — currently hardcoded to 2026 dates in the products array. After May 11 2026, Mother's Day flips to "Sold Out" forever unless dates are bumped. Could compute the next occurrence dynamically (Mother's Day = 2nd Sunday of May; July 4, Halloween, Christmas are fixed-date).
- [ ] **More product photography** — Mother's Day Box, Mother's Day Minis, 4th of July, Halloween, Christmas seasonal sets are still emoji placeholders. Drop photos into project root, tell Claude, takes 5 min to add.
- [ ] **More portfolio photos** — current 52 photos are great; more variety per category strengthens the gallery. Especially: more wedding/bridal, more faith milestones (currently only 4).
- [ ] **Plausible analytics** (~5 min, free for low traffic) — see what customers actually look at
- [ ] **Hero CTAs better mobile spacing** — possible cleanup; current layout is fine but could be tighter
- [ ] **Cake pop multi-flavor picker** — currently customer reopens the modal per flavor. Could let them pick multiple in one pass.

---

## Reference: how to do common things

**Add a new portfolio batch:**
1. Drop photos in a new folder named after the category (e.g., `Mothers Day/`)
2. Tell Claude what category they belong to
3. Claude runs the optimization pipeline → puts SEO-named JPEGs in `/portfolio/{category}/`
4. Claude adds the entries to the `PORTFOLIO` array in `index.html`
5. If it's a brand-new category, Claude adds it to `PORTFOLIO_CATEGORIES`
6. `git add . && git commit && git push`
7. Vercel auto-deploys

**Add a real product photo (replace emoji on a product card):**
1. Drop the photo at the project root with an SEO-friendly name
2. Add `photo: "/filename.jpg"` to the product in the `products` array in `index.html`
3. The `renderProductImage()` helper handles the rest automatically

**Update prices:**
1. Edit the price in your Square dashboard (production)
2. Done — `api/checkout.js` fetches authoritative prices from Square Catalog API on every checkout
3. Optional: also update the price displayed in `products` array in `index.html` so the cart matches the receipt visually (server still uses Square's price for the actual charge)

**Trigger a fresh Vercel deploy without code changes** (e.g., to pick up new env vars):
```bash
git commit --allow-empty -m "Trigger redeploy" && git push
```

**Force-refresh past mobile Safari cache when iterating:**
- Long-press the reload button → choose option to bypass cache
- Or open in private tab

---

## Operational notes

- **macOS local DNS cache** can flap on `www.mjs-sweets.com` and look like a site outage. First debugging step is always `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`. Permanent fix: point Mac DNS at Cloudflare 1.1.1.1.
- **Square production access tokens are real money.** Set them directly in Vercel env vars marked Sensitive; never paste in chat.
- **SignalWire test mode** persists on the phone number even after account leaves trial mode. The `[SignalWire Free Trial]` prefix on outbound SMS is the symptom.
- **Vercel Blob store must be public** for photo URLs in SMS to be viewable on customer phones. Migration from a private store would break existing photo URLs.
