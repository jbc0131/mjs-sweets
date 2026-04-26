# Next Steps — MJ's Sweets

Living checklist for finishing the storefront. Sections are ordered roughly by priority. Anything checked is already in the codebase.

## Where we are

- `index.html` storefront with hero countdown, seasonal/year-round product cards, mobile hamburger nav, accessible cart drawer, FAQ, and contact form
- Cart split by pickup window — each batch checks out separately
- Square Item Library imported from `Square_Item_Import.csv` (13 items)
- Vercel project scaffolded: `package.json`, `vercel.json`, `.gitignore`, `.env.example`
- `api/config.js` — exposes public Square IDs to the browser
- `api/checkout.js` — server-side checkout that fetches authoritative prices from the Square Catalog API on every order (no hardcoded prices)
- Form provider chosen: **Web3Forms** (free tier, supports image uploads for inspiration photos)

---

## Up next — embedded Square checkout

Work to wire the Square Web Payments SDK into the existing cart. Do these in order.

### 1. Get Square Developer credentials

Go to https://developer.squareup.com/apps, sign in with the Square account that owns the Item Library.

- [ ] Create an Application named "MJ's Sweets Website"
- [ ] On the **Sandbox** tab, Credentials page, copy:
  - Application ID (starts with `sandbox-sq0idb-...`)
  - Access Token (starts with `EAAAl...`) — **secret**, treat carefully
- [ ] Locations page → copy the default sandbox **Location ID** (starts with `L...`)
- [ ] Repeat on the **Production** tab once we're ready to go live (different IDs)

### 2. Deploy to Vercel and wire env vars

- [ ] Create a new Vercel project pointing at this folder (or push to GitHub and import)
- [ ] In Project → Settings → Environment Variables, add:
  - `SQUARE_ENVIRONMENT` = `sandbox`
  - `SQUARE_APPLICATION_ID` = (sandbox app ID)
  - `SQUARE_LOCATION_ID` = (sandbox location ID)
  - `SQUARE_ACCESS_TOKEN` = (sandbox access token, marked Secret)
- [ ] Deploy. Visit `/api/config` to confirm it returns your sandbox IDs (means env vars are wired up)

### 3. Build the embedded checkout UI

- [ ] Add the Square Web Payments SDK script tag to `index.html` (sandbox URL while testing, swap to production URL on go-live)
- [ ] Build a checkout modal/drawer with two steps:
  1. **Pickup details** — name, email, phone, pickup time slot
  2. **Card form** — Square SDK card input (rendered in their iframe — Maddie never touches PCI scope)
- [ ] Wire `startCheckout(windowId)` in `index.html` to open the modal with the right cart group
- [ ] On submit: tokenize card → POST `{ items, paymentToken, customer, pickupWindow }` to `/api/checkout`
- [ ] Success state: show order ID + Square receipt URL, clear that cart group, leave others intact
- [ ] Failure state: surface Square's error message inline, do NOT clear the cart

### 3.5. Apple Pay domain verification (one-time setup)

Apple Pay requires Square to verify that you control the domain it's running on. Google Pay needs no extra setup.

**For sandbox testing:**

1. Square Developer Dashboard → MJ's Sweets Website → **Sandbox** tab → **Apple Pay** → **Web** in left sidebar.
2. Click **Add a domain** → enter your Vercel URL (e.g., `mjs-sweets-jbc0131s-projects.vercel.app`).
3. Square gives you a **domain association file** — download it.
4. Save the file at `~/Desktop/MJS-Sweets/.well-known/apple-developer-merchantid-domain-association` (no extension).
5. Commit and push: `git add . && git commit -m "Apple Pay domain verification file" && git push`.
6. Wait for Vercel to redeploy (~30s).
7. Verify the file is accessible: visit `https://your-vercel-url/.well-known/apple-developer-merchantid-domain-association` in a browser — you should see the file contents (a long string of characters), not a 404.
8. Back in Square dashboard, click **Verify** next to your domain. Should turn green.

**For production:** Repeat the same steps on the Production tab of the Square Developer Dashboard, registering your real custom domain (e.g., `mjssweetsla.com`). The file from the production tab is *different* from the sandbox file.

**Important:** Vercel serves `.well-known/` files automatically as long as they're at the project root. If you ever deploy this site somewhere that needs an explicit MIME type (some hosts), set the `Content-Type` to `application/octet-stream` for that path.

### 4. Sandbox testing

- [ ] Test cards from Square: `4111 1111 1111 1111` (success), `4000 0000 0000 0002` (decline), `4000 0000 0000 0119` (CVV failure) — full list at https://developer.squareup.com/docs/devtools/sandbox/payments
- [ ] Place a multi-item order across one pickup window — confirm the order shows up in the Square Sandbox dashboard with correct line items and metadata
- [ ] Place orders across two pickup windows — confirm each becomes its own Square Order
- [ ] Test declined card → confirm error surfaces, cart not cleared
- [ ] Test missing fields → confirm 400 errors are user-friendly
- [ ] Test inventory caps (if you decide to enable Stockable on a sold-out item, it should reject)
- [ ] Test Apple Pay (Safari on Mac with Wallet card, or iPhone Safari) — button should appear above card form, tap → Apple Pay sheet → Touch/Face ID → success
- [ ] Test Google Pay (Chrome with a saved Google Pay card) — button should appear, click → Google Pay sheet → success
- [ ] On Firefox/Edge/non-Apple-Pay browsers — only Google Pay (or just card) should appear, no broken Apple Pay button

### 5. Production rollout

- [ ] Add Production env vars to Vercel (same names, different values) — switch `SQUARE_ENVIRONMENT` to `production`
- [ ] Update Square SDK script tag to production URL (or load it dynamically based on `/api/config.environment`)
- [ ] Live transaction test: place a real $1 order with your own card, verify it lands in the production Square dashboard, immediately refund it from the dashboard
- [ ] Update DNS / connect a custom domain in Vercel (e.g., mjssweetsla.com)
- [ ] Announce on Facebook / Instagram

---

## Pre-launch fixes (independent of checkout)

Things flagged in the original code review that are still pending. Knock these out before going live.

### Contact form
- [ ] Sign up for Web3Forms at https://web3forms.com — get an Access Key (sent to Maddie's email)
- [ ] Update the `<form onsubmit="handleRequest(event)">` in `index.html`:
  - Change `action="https://api.web3forms.com/submit"` and `method="POST"`
  - Add `<input type="hidden" name="access_key" value="...">`
  - Add `<input type="hidden" name="subject" value="New custom order — MJ's Sweets">`
  - Add `name` attributes to every input so Web3Forms captures them
  - Add a `<input type="file" name="inspiration_photos" multiple accept="image/*">` field for inspiration photos
  - Update `handleRequest()` to actually submit (currently just shows a toast)

### Real contact info
- [x] Maddie's phone: **(504) 559-6466** (saved to memory) — replace `+15045551234` placeholder in 3 places (hero, footer text-link, footer social)
- [ ] Real Facebook URL — replace `href="#"` in footer social links
- [ ] Real Instagram URL — replace `href="#"` in footer social links

### Accessibility
- [ ] Form labels not associated with inputs — add `for`/`id` pairs so screen readers announce them
- [ ] Heading hierarchy — `.section-title` elements use `<h1>`; should be `<h2>`
- [ ] Focus trap in cart drawer and flavor modal (currently focus escapes)

### SEO
- [ ] `<meta name="description">` (controls Google snippet)
- [ ] Open Graph tags (`og:title`, `og:description`, `og:image`) for Facebook/iMessage previews
- [ ] Favicon (`<link rel="icon">`)
- [ ] JSON-LD `LocalBusiness` / `Bakery` schema with address, areaServed, openingHours — meaningful boost for Northshore local search
- [ ] `<link rel="canonical">`

### Quality of life
- [ ] Cart persistence via `localStorage` (currently a refresh empties the cart)
- [ ] Dynamic copyright year in footer (`new Date().getFullYear()`)
- [ ] Auto-roll holiday dates year over year (currently hardcoded 2026 — Mother's Day flips "Sold Out" forever after May 11, 2026 unless you bump them)

---

## Future polish (nice-to-have, post-launch)

- Real product photography in the hero collage and product cards (currently emoji placeholders)
- Multi-flavor cake pop picker in one go (currently customer reopens the modal per flavor)
- Email confirmation template — Square sends a default receipt; can be customized in Square dashboard with branding
- Pickup time slot scheduling — instead of a free-text time field, offer pre-defined slots (e.g., "Sat 10am-12pm", "Sat 2pm-4pm") that count down as they fill
- Loyalty / referral discount codes via Square Discounts API
- Customer accounts (saved address/card) — Square supports this but adds complexity
- Analytics: Plausible or Fathom (privacy-respecting) on the storefront to track which seasonal sets convert best
- Postcard / sticker for in-bag thank-you — physical brand touch matching the site's aesthetic

---

## Operational notes

**Where prices live:** authoritative prices live in Square. `api/checkout.js` fetches them via the Catalog API on every checkout (60s cache). To change a price, edit it in the Square dashboard — no code change needed. The website still shows the prices hardcoded in `products` array in `index.html` for display; if a price changes in Square but not the array, the cart will display the old price but the customer will be charged the new (Square-fetched) price. Worth keeping the array in sync, but a mismatch fails safe.

**Where the customer's card data lives:** never on our server. Square's iframe handles card entry; we only ever see a one-time-use token. PCI scope: SAQ-A (the lightest level).

**What happens if Square is down:** `api/checkout.js` returns a 402/500 error and the cart stays intact. Show the customer "Payments are temporarily unavailable, please try again or text Maddie" and surface her phone.

**Refunds and order changes:** handled entirely from the Square dashboard — the website doesn't need a backend for this. Maddie clicks the order in Square, refunds it, customer is notified automatically.
