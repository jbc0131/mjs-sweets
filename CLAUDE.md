# MJ's Sweets — Claude Context

## Project

Storefront for **MJ's Sweets**, a one-person handmade cookie bakery in Madisonville, LA, run by Maddie. Built and maintained by Jordan Cisco.

Live at **https://www.mjs-sweets.com**.

## Tech stack

- **Frontend:** vanilla HTML/CSS/JS (single `index.html`, no framework). Mobile-first responsive design with brand-pink/cream/yellow palette.
- **Hosting:** Vercel Pro (custom domain via Namecheap with Vercel nameservers)
- **Payments:** Square Web Payments SDK (card + Apple Pay + Google Pay), with serverless backend in `api/checkout.js`
- **Order data:** Square Catalog API (single source of truth for prices and item names)
- **Photo storage:** Vercel Blob (`mjs-sweets-public-blob`, public access)
- **SMS notifications:** SignalWire (notifies on custom-order form submissions; currently in test-enabled mode pending 10DLC registration)
- **Form handling:** custom `api/contact.js` with formidable for multipart parsing

## Key files

| Path | Purpose |
|---|---|
| `index.html` | Single-page storefront (~3000 lines including inline CSS/JS) |
| `api/config.js` | Returns public Square credentials to browser |
| `api/checkout.js` | POST: creates Square Order + Payment with server-side price validation via Catalog API |
| `api/contact.js` | POST: processes custom-order form, uploads photos to Vercel Blob, SMS via SignalWire |
| `package.json` | Dependencies: `square`, `@signalwire/compatibility-api`, `@vercel/blob`, `formidable` |
| `vercel.json` | Function timeouts + security headers |
| `.well-known/apple-developer-merchantid-domain-association` | Apple Pay domain verification (works for both sandbox and production) |
| `Square_Item_Import.csv` | Source of truth for the 13 items in Square's Item Library |
| `portfolio/{category}/*.jpg` | 52 SEO-renamed, web-optimized cookie photos across 7 categories |
| `NEXT_STEPS.md` | Active checklist of pending work |
| `ORDER_TRACKING_PLAN.md` | Detailed spec for the upcoming order tracking + admin features |
| `DEVELOPMENT_LOG.md` | Chronological log of significant changes |

## Common commands

```bash
# Deploy: push to main → Vercel auto-deploys
git add . && git commit -m "..." && git push

# Verify a deploy is live
curl -I https://www.mjs-sweets.com

# Verify Square config endpoint (should return current env)
curl https://www.mjs-sweets.com/api/config

# JS syntax check on inline script
python3 -c "import re; html=open('index.html').read(); open('/tmp/c.js','w').write(re.search(r'<script>(.*?)</script>', html, re.DOTALL).group(1))" && node --check /tmp/c.js

# Optimize a new portfolio photo (template; see DEVELOPMENT_LOG.md for full pipeline)
python3 -c "from PIL import Image,ImageOps; ..."
```

## Conventions

- **Single HTML file:** all CSS and JS inline. No build step. This is intentional for a tiny-team project; keeps deployment trivial.
- **Function exports:** API functions use CommonJS (`module.exports`). When attaching `.config` for body parser settings, define the handler first then attach `handler.config = {...}` then `module.exports = handler` — assigning `module.exports.config` BEFORE assigning the handler will be wiped out.
- **Product photos:** add `photo: "/path.jpg"` field to a product in `index.html`'s `products` array. The `renderProductImage(p)` helper will use the photo if present, fall back to emoji otherwise. Every other `${p.img}` template usage already routes through this helper.
- **Portfolio photos:** placed in `portfolio/{category}/` and added to the `PORTFOLIO` array in `index.html`. Adding a new category requires adding to `PORTFOLIO_CATEGORIES`.
- **SEO file names:** lowercase, hyphenated, descriptive of theme. e.g., `birthday-cookies-cow-print-pink-farmhouse.jpg`.
- **Photo optimization:** max 1600px on longest side, JPEG quality 85, progressive. ~95% size reduction with no visible quality loss. Pipeline using PIL is documented in `DEVELOPMENT_LOG.md`.

## Production constraints

**Square**:
- Production credentials are in Vercel env vars (`SQUARE_*`). Sandbox is no longer used.
- Apple Pay verified for `www.mjs-sweets.com` on both sandbox and production tabs.
- Test cards (`4111 1111 1111 1111`) get rejected in production — that's correct behavior.

**SignalWire**:
- Number `+1 (470) 298-7936` is in **test-enabled mode** — can only send to verified destinations.
- Currently sends to `+1 (504) 330-4335` (Jordan's verified personal number) for testing. Will switch to Maddie's number `+1 (504) 559-6466` once she completes verification.
- The "[SignalWire Free Trial]" prefix on outbound SMS is causing carrier filtering (error 30008). Account has $14 funded credit but the **number-level test status** still applies the prefix. Resolution: complete A2P 10DLC registration (~1 week) OR switch to email via Resend (preferred near-term solution per `NEXT_STEPS.md`).

**DNS**:
- `www.mjs-sweets.com` is the primary; `mjs-sweets.com` 307-redirects to www.
- Nameservers at Namecheap point to `ns1.vercel-dns.com` and `ns2.vercel-dns.com`.
- Vercel manages all DNS records.
- **macOS DNS cache flapping** is a known local issue when iterating — see auto-memory note. Use `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`.

**Cart / pickup window logic**:
- Each holiday product belongs to a `windowId` (`mothers-day-2026`, `july-4-2026`, etc.).
- Year-round items (cake pops, rice krispies, pretzels) auto-attach to the **soonest active seasonal window** when added to cart. If no seasonal is open, they fall back to `next-available`.
- Cart is split visually by `windowId` — each batch is its own checkout (one Square Order per batch).
- Holiday ordering windows: opens 4 weeks before, closes 3 days before (defined in `getOrderStatus()`).

**Mobile horizontal overflow gotcha**:
- `position: fixed` elements with negative offsets (e.g., a closed drawer with `right: -420px`) bypass `overflow-x: clip` on `<html>` and can extend the document width on iOS Safari.
- Resolution: use `transform: translateX(100%)` instead of negative `right`. Transforms don't affect layout. The cart drawer was migrated to this pattern.

## What NOT to do

- **Don't add a build step.** No webpack, no bundler, no framework. Single-file HTML is the conscious choice.
- **Don't hardcode Square prices in `api/checkout.js`.** Always fetch via Catalog API (already implemented in `fetchCatalogEntries`). The 60s in-memory cache is acceptable.
- **Don't trust client-sent prices, quantities, or SKUs without server-side validation** in `api/checkout.js`.
- **Don't share Square production access tokens in chat transcripts.** Set them directly in Vercel env vars marked Sensitive.
- **Don't commit `.env`, `.env.local`, or anything with `BLOB_READ_WRITE_TOKEN` / `SQUARE_ACCESS_TOKEN` / `SIGNALWIRE_API_TOKEN`.** `.gitignore` is configured but always run `git status` before commit.

## Useful operational notes

- Maddie is non-developer. All admin happens through Square's dashboard (orders, refunds, item edits) or via Jordan's intervention.
- The verification card on file at SignalWire: MasterCard ending 6405. Account has ~$14 balance.
- Resend signup pending — when complete, will be the email backup channel for form notifications.
- Order tracking + admin interface is fully scoped in `ORDER_TRACKING_PLAN.md`. ~7 hours of build work, ready to execute when env vars + Resend are set up.
