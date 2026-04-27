# Next Steps — MJ's Sweets

Active checklist of pending work. See `DEVELOPMENT_LOG.md` for what's already shipped.

## Where we are

Storefront is **live in production at https://www.mjs-sweets.com** with:
- Card, Apple Pay, and Google Pay checkout
- Real product photos
- 52-photo portfolio gallery across 7 categories
- Custom-order form with photo uploads
- SMS notifications (currently unreliable — see Priority 1)

---

## Priority 1 — Fix custom-order form notification reliability (do this first)

Custom-order form currently delivers SMS only intermittently due to SignalWire trial-mode prefix triggering carrier filtering. Two paths, do **both** for redundancy:

### Path A — Add Resend email as the reliable channel (~30 minutes)

Email is more reliable than SMS for transactional notifications and doesn't have carrier filtering issues. Adds ~50 lines to `api/contact.js` to fire an email alongside the SMS.

- [ ] Sign up at https://resend.com (free, no credit card required)
- [ ] Verify `mjs-sweets.com` domain in Resend (3-4 DNS records to add at Vercel; ~5 min, auto-verifies)
- [ ] Get Resend API key
- [ ] Add Vercel env vars: `RESEND_API_KEY` (Sensitive), `RESEND_FROM_EMAIL` = `orders@mjs-sweets.com`
- [ ] Send Claude the API key + confirmation; we wire up the email pipeline

### Path B — Complete SignalWire A2P 10DLC registration (~1 week wait)

Registers the SignalWire number as a legitimate business sender, removes the "[SignalWire Free Trial]" prefix, lifts carrier filtering. Required for SMS to ever be reliable in the long term.

- [ ] SignalWire dashboard → Compliance → A2P 10DLC → register Sole Proprietor brand ($4 one-time)
- [ ] Register a campaign for "MJ's Sweets order notifications" (~$2/month)
- [ ] Wait 1-7 business days for carrier approval
- [ ] After approval, SMS becomes ~99% deliverable

**Do A this week (instant fix), B in parallel (proper long-term fix). After both: form notifications go via both channels, redundant + reliable.**

---

## Priority 2 — Order tracking + admin interface

Fully scoped in `ORDER_TRACKING_PLAN.md`. Highlights:

- Customer-facing `/order/[id]` page with status timeline + photo gallery
- "Track Order" lookup form on homepage (last name OR phone + order ID)
- Maddie's `/admin` page (password-protected) — upload photos as she bakes, advance status
- Each photo upload triggers a customer email with the photo + tracking link
- Vercel cron jobs for pickup reminders (24hr before, day-of) and post-pickup review request

Estimated 7 hours of build, broken into 11 phases. Requires Resend setup (Priority 1 Path A) as a prerequisite.

When ready to build:
- [ ] Read `ORDER_TRACKING_PLAN.md` top to bottom
- [ ] Complete the setup checklist in that doc (env vars, password, cookie secrets)
- [ ] Reply to Claude with credentials + decision overrides; build begins

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
