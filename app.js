 // Normalize to start of day in the user's local timezone so date comparisons
 // (Opens / Order by / Closed) flip cleanly at midnight rather than mid-afternoon.
 const TODAY = (() => {
   const d = new Date();
   d.setHours(0, 0, 0, 0);
   return d;
 })();

 // Flavor → Square SKU map for cake pop variations
 const FLAVOR_SKUS = {
   'Chocolate':  'POP-CHOC',
   'Vanilla':    'POP-VAN',
   'Funfetti':   'POP-FUN',
   'Red Velvet': 'POP-RV',
   'Lemon':      'POP-LEM',
   'Strawberry': 'POP-STR'
 };

 // Pickup-window metadata. Each seasonal product belongs to one of these.
 // Year-round items (cake pops, rice krispies, pretzels) auto-attach to whichever
 // seasonal window is currently open; if none, they fall back to next-available.
 const PICKUP_WINDOWS = {
   'mothers-day-2026': { label: "Mother's Day",  emoji: '💐', range: 'May 8–10',   pickupDate: '2026-05-10' },
   'july-4-2026':      { label: '4th of July',   emoji: '🎆', range: 'July 2–4',   pickupDate: '2026-07-04' },
   'halloween-2026':   { label: 'Halloween',     emoji: '🎃', range: 'Oct 29–31',  pickupDate: '2026-10-31' },
   'christmas-2026':   { label: 'Christmas',     emoji: '🎄', range: 'Dec 23–25',  pickupDate: '2026-12-25' },
   'next-available':   { label: 'Next Available Batch', emoji: '🍪', range: "Maddie will text to coordinate pickup", pickupDate: null }
 };

 const products = [
 {
 id: 1,
 sku: 'SET-MD',
 windowId: 'mothers-day-2026',
 name: "Mother's Day Box",
 cookieLabel: "Mother's Day Cookies",
 desc: "Celebrate Mom with this delightful assortment of 3-inch cookies, featuring beautiful flowers, hearts, and sweet messages like “Best Mom Ever.” A wonderful treat for the whole family to share!",
 price: 40,
 holidayDate: '2026-05-10',
 img: "💐",
 photo: "/mothers_day_dozen.jpg",
 cls: "mothers"
 },
 {
 id: 6,
 sku: 'MINI-MD',
 windowId: 'mothers-day-2026',
 name: "Mother's Day Minis",
 desc: "Brighten her day with our petite, 2-inch flower cookies. Beautifully packaged with a “Happy Mother’s Day” tag, they make the perfect sweet surprise for Mom!",
 price: 6,
 priceUnit: "/4 pack",
 holidayDate: '2026-05-10',
 img: "🌸",
 photo: "/mothers_day_mini.png",
 cls: "minis"
 },
 {
 id: 5,
 name: "Cake Pops",
 desc: "100x better than big box stores. Pick your flavor!",
 price: 24,
 img: "🍭",
 photo: "/cake_pops.png",
 cls: "cakepops",
 isCakePop: true,
 flavors: ['Chocolate', 'Vanilla', 'Funfetti', 'Red Velvet', 'Lemon', 'Strawberry']
 },
 {
 id: 7,
 sku: 'KRIS-DZ',
 name: "Rice Krispies",
 desc: "Marshmallow-y, drizzled & dreamy",
 price: 24,
 img: "🍡",
 photo: "/rice_krispies.png",
 cls: "ricecrispies",
 isYearRound: true
 },
 {
 id: 8,
 sku: 'PRETZ-DZ',
 name: "Dipped Pretzel Rods",
 desc: "Sweet & salty crunch, dressed up",
 price: 24,
 img: "🥨",
 photo: "/pretzel_rods.png",
 cls: "pretzels",
 isYearRound: true
 },
 {
 id: 2,
 sku: 'SET-JULY4',
 windowId: 'july-4-2026',
 name: "4th of July Set",
 cookieLabel: "4th of July Cookies",
 desc: "Stars, stripes & sparklers",
 price: 40,
 holidayDate: '2026-07-04',
 img: "🎆",
 cls: "july"
 },
 {
 id: 3,
 sku: 'SET-HALLOWEEN',
 windowId: 'halloween-2026',
 name: "Halloween Spooky Set",
 cookieLabel: "Halloween Cookies",
 desc: "Pumpkins, ghosts & black cats",
 price: 40,
 holidayDate: '2026-10-31',
 img: "🎃",
 cls: "summer"
 },
 {
 id: 4,
 sku: 'SET-XMAS',
 windowId: 'christmas-2026',
 name: "Christmas Cookie Box",
 cookieLabel: "Christmas Cookies",
 desc: "Trees, snowflakes & gingerbread",
 price: 40,
 holidayDate: '2026-12-25',
 img: "🎄",
 cls: "fall"
 }
 ];

 // Calculate ordering status for each product
 function getOrderStatus(holidayDateStr) {
 const holiday = new Date(holidayDateStr);
 const openDate = new Date(holiday); openDate.setDate(holiday.getDate() - 28); // 4 weeks before
 const pickupClose = new Date(holiday); pickupClose.setDate(holiday.getDate() - 3); // 3 days before

 const fmt = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

 if (TODAY < openDate) {
 return { state: 'soon', label: `Opens ${fmt(openDate)}`, canOrder: false, badge: 'Coming Soon', badgeClass: 'soon' };
 }
 if (TODAY > pickupClose) {
 return { state: 'closed', label: 'Orders closed', canOrder: false, badge: 'Sold Out', badgeClass: 'closed' };
 }
 return { state: 'open', label: `Order by ${fmt(pickupClose)} for pickup`, canOrder: true, badge: 'Now Open', badgeClass: 'open' };
 }

 // Cart is an array of line items: [{ sku, qty, windowId }]
 // Grouped by windowId at render time so each pickup batch checks out separately.
 let cart = [];
 let pendingProductId = null;
 let pendingFlavor = null;

 // ---------- Display helpers ----------

 // Intrinsic dimensions for every image we render. Used to emit width/height
 // attributes so the browser reserves the right space before images load
 // (eliminates Cumulative Layout Shift, a Core Web Vitals factor).
 // Keyed by absolute path; values are [width, height] in pixels.
 const IMAGE_DIMS = {
   '/cake_pops.png': [511, 488],
   '/maddie-mjs-sweets-baker.jpg': [705, 999],
   '/portfolio/baby-shower/baby-shower-cookies-elephant-lavender.jpg': [1366, 1600],
   '/portfolio/baby-shower/baby-shower-cookies-here-comes-the-sun.jpg': [1600, 1248],
   '/portfolio/baby-shower/baby-shower-cookies-mickey-blue-oh-boy.jpg': [1417, 1600],
   '/portfolio/baby-shower/baby-shower-cookies-mickey-pink-gold.jpg': [1200, 1600],
   '/portfolio/baby-shower/baby-shower-cookies-nautical-its-a-boy.jpg': [1200, 1600],
   '/portfolio/baby-shower/baby-shower-cookies-twins-sweet-peas.jpg': [1446, 1600],
   '/portfolio/baby-shower/baby-shower-cookies-winnie-the-pooh.jpg': [1200, 1600],
   '/portfolio/baby-shower/gender-reveal-cookies-pink-teal-oh-baby.jpg': [1600, 1267],
   '/portfolio/birthdays/birthday-cookies-aviator-stars-age-one.jpg': [1435, 1600],
   '/portfolio/birthdays/birthday-cookies-bluey-pastel.jpg': [1200, 1600],
   '/portfolio/birthdays/birthday-cookies-cow-print-pink-farmhouse.jpg': [1320, 1600],
   '/portfolio/birthdays/birthday-cookies-daisies-clover-monogram.jpg': [1350, 1600],
   '/portfolio/birthdays/birthday-cookies-dinosaurs-bright.jpg': [1600, 1200],
   '/portfolio/birthdays/birthday-cookies-dinosaurs-carter.jpg': [1600, 1514],
   '/portfolio/birthdays/birthday-cookies-farm-animals.jpg': [1600, 1170],
   '/portfolio/birthdays/birthday-cookies-fishing-reeling-in-the-big-one.jpg': [1600, 1200],
   '/portfolio/birthdays/birthday-cookies-fortnite-gamer.jpg': [1200, 1600],
   '/portfolio/birthdays/birthday-cookies-hello-kitty-age-six.jpg': [1200, 1600],
   '/portfolio/birthdays/birthday-cookies-jumping-silhouettes-green.jpg': [1200, 1600],
   '/portfolio/birthdays/birthday-cookies-mickey-minnie-mouse.jpg': [1473, 1600],
   '/portfolio/birthdays/birthday-cookies-pink-gold-monogram-adult.jpg': [1263, 1600],
   '/portfolio/birthdays/birthday-cookies-race-cars-speed-limit.jpg': [1600, 1221],
   '/portfolio/birthdays/birthday-cookies-summer-beach-sun-sunglasses.jpg': [1600, 1193],
   '/portfolio/birthdays/birthday-cookies-two-tti-frutti.jpg': [1495, 1600],
   '/portfolio/corporate/corporate-cookies-bulk-frosted-cookie-cups.jpg': [1494, 1600],
   '/portfolio/corporate/corporate-cookies-bulk-individually-wrapped-favors.jpg': [1200, 1600],
   '/portfolio/corporate/corporate-cookies-christmas-bulk-bow-boxes.jpg': [1600, 1141],
   '/portfolio/corporate/corporate-cookies-christmas-gift-boxes-personalized.jpg': [1200, 1600],
   '/portfolio/corporate/corporate-cookies-christmas-variety-boxes-santa-snowman.jpg': [1600, 1200],
   '/portfolio/corporate/corporate-cookies-holiday-gift-table-display.jpg': [1600, 1200],
   '/portfolio/faith/baptism-cookies-blue-made-new-bible-verse.jpg': [1200, 1600],
   '/portfolio/faith/baptism-cookies-white-gold-cross-dove.jpg': [1600, 1203],
   '/portfolio/faith/bible-study-cookies-take-what-you-need-crosses.jpg': [1200, 1600],
   '/portfolio/faith/first-communion-cookies-white-gold-floral.jpg': [1342, 1600],
   '/portfolio/graduation/graduation-cookies-bowling-senior-2026.jpg': [1316, 1600],
   '/portfolio/graduation/graduation-cookies-class-of-2025-congrats-maggie.jpg': [1600, 1568],
   '/portfolio/graduation/graduation-cookies-class-of-2031-paws.jpg': [1200, 1600],
   '/portfolio/graduation/graduation-cookies-maroon-personalized.jpg': [1600, 1129],
   '/portfolio/graduation/graduation-cookies-royal-blue-yellow.jpg': [960, 720],
   '/portfolio/graduation/graduation-cookies-star-wars-themed.jpg': [1600, 1239],
   '/portfolio/holidays/christmas-cookies-classic-santa-tree.jpg': [1600, 1200],
   '/portfolio/holidays/easter-cookies-bunny-peeps-eggs.jpg': [1200, 1600],
   '/portfolio/holidays/easter-cookies-peeps-he-is-risen.jpg': [1345, 1600],
   '/portfolio/holidays/halloween-cookies-spooky-classic.jpg': [1600, 1181],
   '/portfolio/holidays/valentines-cookies-conversation-hearts.jpg': [1200, 1600],
   '/portfolio/holidays/valentines-cookies-romantic-adult-pink-red.jpg': [1600, 1261],
   '/portfolio/wedding/bridal-cookies-modern-black-purple.jpg': [1200, 1600],
   '/portfolio/wedding/bridal-shower-cookies-pastel-blue-green.jpg': [1200, 1600],
   '/portfolio/wedding/bride-to-be-cookies-pink-rose.jpg': [1200, 1600],
   '/portfolio/wedding/engagement-cookies-blue-and-gold.jpg': [1200, 1600],
   '/portfolio/wedding/engagement-cookies-emerald-and-gold.jpg': [1200, 1600],
   '/portfolio/wedding/wedding-cookies-gold-monogram.jpg': [1200, 1600],
   '/pretzel_rods.png': [473, 528],
   '/rice_krispies.png': [454, 549],
   '/mothers_day_dozen.jpg': [1192, 999],
   '/mothers_day_mini.png': [447, 558],
 };

 // Convert any image path to its WebP variant (e.g., /foo.jpg → /foo.webp).
 // WebP files exist alongside the JPEGs/PNGs and are 25-40% smaller.
 function toWebP(src) {
   return src.replace(/\.(jpg|jpeg|png)$/i, '.webp');
 }

 // Render a product's visual: real photo as <picture> with WebP + JPEG/PNG
 // fallback, or emoji if no photo. The product's gradient background
 // (.cakepops, .mothers, etc.) shows through any transparent areas.
 function renderProductImage(p) {
   if (p.photo) {
     const dims = IMAGE_DIMS[p.photo] || [800, 800];
     return `<picture>
       <source srcset="${toWebP(p.photo)}" type="image/webp">
       <img src="${p.photo}" alt="${p.name}" class="product-photo"
            width="${dims[0]}" height="${dims[1]}" loading="lazy" decoding="async" />
     </picture>`;
   }
   return p.img;
 }

 // ---------- Cart helpers ----------

 // Map the compact priceUnit notation used on product cards ("/dz", "/4 pack")
 // to a clear unit label suitable for the cart, where the customer is
 // about to commit money and shouldn't be confused about what they're buying.
 function unitLabel(priceUnit) {
   if (!priceUnit || priceUnit === '/dz') return 'per dozen';
   if (priceUnit === '/4 pack') return 'per 4-pack';
   return priceUnit.replace(/^\//, 'per '); // graceful fallback
 }

 // Look up { product, flavor } given a SKU. SKU is the canonical identifier
 // because it matches the Square Item Library import.
 function getProductBySku(sku) {
   const direct = products.find(p => p.sku === sku);
   if (direct) return { product: direct, flavor: null };
   if (sku.startsWith('POP-')) {
     const cakePop = products.find(p => p.isCakePop);
     const flavor = Object.keys(FLAVOR_SKUS).find(f => FLAVOR_SKUS[f] === sku);
     if (cakePop && flavor) return { product: cakePop, flavor };
   }
   return null;
 }

 // Which seasonal windows are currently open for ordering? Returns an array of windowIds.
 function getActiveSeasonalWindows() {
   const seen = new Set();
   products.forEach(p => {
     if (!p.windowId || !p.holidayDate) return;
     if (getOrderStatus(p.holidayDate).canOrder) seen.add(p.windowId);
   });
   return Array.from(seen);
 }

 // Resolve which window a year-round / cake-pop item should attach to.
 // Soonest-active wins; if no seasonal is open, fall back to "next-available".
 function resolveYearRoundWindow() {
   const active = getActiveSeasonalWindows();
   if (active.length === 0) return 'next-available';
   const soonest = active
     .map(id => ({ id, date: new Date(PICKUP_WINDOWS[id].pickupDate) }))
     .sort((a, b) => a.date - b.date)[0];
   return soonest.id;
 }

 // ---------- Flavor picker (cake pops) ----------

 function openFlavorPicker(productId) {
 pendingProductId = productId;
 pendingFlavor = null;
 const product = products.find(p => p.id === productId);
 const grid = document.getElementById('flavorGrid');
 grid.innerHTML = product.flavors.map(f =>
 `<button class="flavor-chip" onclick="selectFlavor('${f}', this)">${f}</button>`
 ).join('');
 document.getElementById('flavorConfirm').disabled = true;
 document.getElementById('flavorModal').classList.add('open');
 }

 function selectFlavor(flavor, btn) {
 document.querySelectorAll('.flavor-chip').forEach(c => c.classList.remove('selected'));
 btn.classList.add('selected');
 pendingFlavor = flavor;
 document.getElementById('flavorConfirm').disabled = false;
 }

 function closeFlavorPicker() {
 document.getElementById('flavorModal').classList.remove('open');
 pendingProductId = null;
 pendingFlavor = null;
 }

 function confirmFlavor() {
 if (!pendingFlavor) return;
 const sku = FLAVOR_SKUS[pendingFlavor];
 if (!sku) return;
 addToCartBySku(sku);
 closeFlavorPicker();
 }

 function buildCard(p, options = {}) {
 const { compact = false } = options;
 const sizeClass = compact ? 'product-card-compact' : '';

 if (p.isCakePop) {
 return `
 <div class="product-card ${sizeClass}">
 <div class="product-img ${p.cls}">
 <span class="product-tag tag-yearround">Perfect Add-On ✨</span>
 ${renderProductImage(p)}
 </div>
 <div class="product-body">
 <div class="product-name">${p.name}</div>
 <div class="product-desc">${p.desc}</div>
 <div class="product-window">
 <span class="window-icon">🍭</span>
 6 flavors to choose from
 </div>
 <div class="product-foot">
 <div class="product-price">$${p.price}<small> /dz</small></div>
 <button class="add-btn" onclick="openFlavorPicker(${p.id})">Pick Flavor</button>
 </div>
 </div>
 </div>
 `;
 }

 if (p.isYearRound) {
 return `
 <div class="product-card ${sizeClass}">
 <div class="product-img ${p.cls}">
 <span class="product-tag tag-yearround">Perfect Add-On ✨</span>
 ${renderProductImage(p)}
 </div>
 <div class="product-body">
 <div class="product-name">${p.name}</div>
 <div class="product-desc">${p.desc}</div>
 <div class="product-window">
 <span class="window-icon">✨</span>
 Available year-round
 </div>
 <div class="product-foot">
 <div class="product-price">$${p.price}<small> ${p.priceUnit || '/dz'}</small></div>
 <button class="add-btn" id="btn-${p.id}" onclick="addToCartBySku('${p.sku}')">+ Add</button>
 </div>
 </div>
 </div>
 `;
 }

 const status = getOrderStatus(p.holidayDate);
 const buttonHtml = status.canOrder
 ? `<button class="add-btn" id="btn-${p.id}" onclick="addToCartBySku('${p.sku}')">+ Add</button>`
 : `<button class="add-btn disabled" disabled>${status.state === 'soon' ? 'Coming Soon' : 'Closed'}</button>`;

 if (compact) {
 return `
 <div class="product-card product-card-compact is-unavailable">
 <div class="product-img-compact ${p.cls}">
 ${renderProductImage(p)}
 </div>
 <div class="product-body-compact">
 <div class="product-name-compact">${p.name}</div>
 <div class="product-window-compact">
 <span>🗓️</span> ${status.label}
 </div>
 </div>
 </div>
 `;
 }

 return `
 <div class="product-card ${status.canOrder ? '' : 'is-unavailable'}" id="product-${p.id}">
 <div class="product-img ${p.cls}">
 <span class="product-tag tag-${status.badgeClass}">${status.badge}</span>
 ${renderProductImage(p)}
 </div>
 <div class="product-body">
 <div class="product-name">${p.name}</div>
 <div class="product-desc">${p.desc}</div>
 <div class="product-window">
 <span class="window-icon">${status.state === 'soon' ? '🗓️' : status.state === 'closed' ? '🔒' : '✓'}</span>
 ${status.label}
 </div>
 <div class="product-foot">
 <div class="product-price">$${p.price}<small> ${p.priceUnit || '/dz'}</small></div>
 ${buttonHtml}
 </div>
 </div>
 </div>
 `;
 }

 function renderProducts() {
 // Three groups:
 // 1. Featured: holiday products that are orderable now (full-size cards)
 // 2. Addons: cake pops + year-round items (compact horizontal cards)
 // 3. Upcoming: closed/coming-soon holiday products (compact tiles, info only)
 const featured = products.filter(p => {
 if (p.isCakePop || p.isYearRound) return false;
 const s = getOrderStatus(p.holidayDate);
 return s.canOrder;
 });
 const addons = products.filter(p => p.isCakePop || p.isYearRound);
 const upcoming = products.filter(p => {
 if (p.isCakePop || p.isYearRound) return false;
 const s = getOrderStatus(p.holidayDate);
 return !s.canOrder;
 });

 document.getElementById('productGrid').innerHTML = featured.map(p => buildCard(p)).join('');

 // Render addons in their own compact horizontal grid
 const addonContainer = document.getElementById('addonSection');
 if (addons.length > 0) {
 addonContainer.style.display = 'block';
 document.getElementById('addonGrid').innerHTML = addons.map(p => buildAddonCard(p)).join('');
 } else {
 addonContainer.style.display = 'none';
 }

 const upcomingContainer = document.getElementById('upcomingSection');
 if (upcoming.length > 0) {
 upcomingContainer.style.display = 'block';
 document.getElementById('upcomingGrid').innerHTML = upcoming.map(p => buildCard(p, { compact: true })).join('');
 } else {
 upcomingContainer.style.display = 'none';
 }
 }

 // Compact horizontal card for add-ons
 function buildAddonCard(p) {
 const isFlavored = p.isCakePop;
 const buttonText = isFlavored ? 'Pick Flavor' : '+ Add';
 const onclickAttr = isFlavored ? `openFlavorPicker(${p.id})` : `addToCartBySku('${p.sku}')`;
 const idAttr = isFlavored ? '' : `id="btn-${p.id}"`;
 // Unique slug per product so anchor links (used in JSON-LD Product schema)
 // can deep-link to a specific addon card. e.g. "Dipped Pretzel Rods" -> "dipped-pretzel-rods".
 const cardSlug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
 return `
 <div class="addon-card" id="${cardSlug}">
 <div class="addon-img ${p.cls}">${renderProductImage(p)}</div>
 <div class="addon-body">
 <div>
 <div class="addon-name">${p.name}</div>
 <div class="addon-desc">${p.desc}</div>
 </div>
 <div class="addon-foot">
 <div class="addon-price">$${p.price}<small> ${p.priceUnit || '/dz'}</small></div>
 <button class="addon-btn" ${idAttr} onclick="${onclickAttr}">${buttonText}</button>
 </div>
 </div>
 </div>
 `;
 }

 // Public addToCart entry — accepts a SKU. Resolves the right pickup window
 // (seasonal items = their own window; year-round/cake-pops = soonest active),
 // merges with an existing line if one exists, then re-renders.
 function addToCartBySku(sku) {
   const lookup = getProductBySku(sku);
   if (!lookup) return;
   const { product, flavor } = lookup;

   const windowId = (product.windowId)
     ? product.windowId
     : resolveYearRoundWindow();

   const existing = cart.find(e => e.sku === sku && e.windowId === windowId);
   if (existing) {
     existing.qty++;
   } else {
     cart.push({ sku, qty: 1, windowId });
   }
   updateCart();

   const winLabel = PICKUP_WINDOWS[windowId].label;
   const itemLabel = flavor ? `${flavor} cake pops` : product.name;
   showToast(`✓ ${itemLabel} → ${winLabel} pickup`);

   // Visual ack on the source button (only present for non-cake-pop adds)
   const btn = document.getElementById(`btn-${product.id}`);
   if (btn) {
     btn.textContent = '✓ Added';
     btn.classList.add('added');
     setTimeout(() => {
       btn.textContent = '+ Add';
       btn.classList.remove('added');
     }, 1500);
   }
 }

 function updateQty(sku, windowId, delta) {
   const entry = cart.find(e => e.sku === sku && e.windowId === windowId);
   if (!entry) return;
   entry.qty += delta;
   if (entry.qty <= 0) cart = cart.filter(e => e !== entry);
   updateCart();
 }

 function updateCart() {
   const count = cart.reduce((sum, e) => sum + e.qty, 0);
   document.getElementById('cartCount').textContent = count;

   const itemsEl = document.getElementById('cartItems');

   if (count === 0) {
     itemsEl.innerHTML = `
       <div class="cart-empty">
         <div class="cart-empty-icon">🍪</div>
         <p>Your cart's empty, let's fix that!</p>
       </div>`;
     return;
   }

   // Group line items by pickup window
   const groups = {};
   cart.forEach(entry => {
     (groups[entry.windowId] = groups[entry.windowId] || []).push(entry);
   });

   // Render groups in pickup-date order (sooner pickups first)
   const orderedWindowIds = Object.keys(groups).sort((a, b) => {
     const da = PICKUP_WINDOWS[a].pickupDate;
     const db = PICKUP_WINDOWS[b].pickupDate;
     if (!da) return 1;
     if (!db) return -1;
     return new Date(da) - new Date(db);
   });

   itemsEl.innerHTML = orderedWindowIds.map(wid => {
     const win = PICKUP_WINDOWS[wid];
     let subtotal = 0;
     const lineHtml = groups[wid].map(entry => {
       const lookup = getProductBySku(entry.sku);
       if (!lookup) return '';
       const { product, flavor } = lookup;
       const lineTotal = product.price * entry.qty;
       subtotal += lineTotal;
       const displayName = flavor ? `${product.name}, ${flavor}` : product.name;
       return `
         <div class="cart-item">
           <div class="cart-item-img ${product.cls}">${renderProductImage(product)}</div>
           <div class="cart-item-info">
             <div class="cart-item-name">${displayName}</div>
             <div class="cart-item-price">$${product.price.toFixed(2)} ${unitLabel(product.priceUnit)}</div>
             <div class="qty-controls">
               <button class="qty-btn" aria-label="Decrease quantity" onclick="updateQty('${entry.sku}', '${wid}', -1)">−</button>
               <span class="qty-num">${entry.qty}</span>
               <button class="qty-btn" aria-label="Increase quantity" onclick="updateQty('${entry.sku}', '${wid}', 1)">+</button>
             </div>
           </div>
         </div>`;
     }).join('');

     return `
       <div class="cart-group">
         <div class="cart-group-header">
           <div class="cart-group-title">${win.emoji} ${win.label} pickup</div>
           <div class="cart-group-range">${win.range}</div>
         </div>
         ${lineHtml}
         <div class="cart-group-foot">
           <div class="cart-group-subtotal">Subtotal: <strong>$${subtotal.toFixed(2)}</strong></div>
           <button class="checkout-group-btn" onclick="startCheckout('${wid}')">Checkout this batch →</button>
         </div>
       </div>`;
   }).join('');
 }

 function openCart() {
   document.getElementById('cartDrawer').classList.add('open');
   document.getElementById('cartOverlay').classList.add('open');
 }
 function closeCart() {
   document.getElementById('cartDrawer').classList.remove('open');
   document.getElementById('cartOverlay').classList.remove('open');
 }

 // ---------- Square Web Payments SDK integration ----------

 // Square SDK state — initialized lazily on first checkout.
 let squareConfig = null;          // { environment, applicationId, locationId }
 let squarePayments = null;        // Square.payments() instance
 let squareCard = null;            // Card form instance (re-created per modal open)
 let squareApplePay = null;        // Apple Pay instance (re-created per modal open)
 let squareGooglePay = null;       // Google Pay instance (re-created per modal open)
 let squareInitPromise = null;     // Memoized init promise so we only fetch /api/config once
 let activeCheckoutWindow = null;  // windowId currently being checked out

 function loadSquareSdkScript(environment) {
   const url = environment === 'production'
     ? 'https://web.squarecdn.com/v1/square.js'
     : 'https://sandbox.web.squarecdn.com/v1/square.js';

   return new Promise((resolve, reject) => {
     if (window.Square) return resolve(window.Square);
     const existing = document.querySelector(`script[src="${url}"]`);
     if (existing) {
       existing.addEventListener('load', () => resolve(window.Square));
       existing.addEventListener('error', () => reject(new Error('Square SDK failed to load')));
       return;
     }
     const s = document.createElement('script');
     s.src = url;
     s.async = true;
     s.onload = () => resolve(window.Square);
     s.onerror = () => reject(new Error('Square SDK failed to load'));
     document.head.appendChild(s);
   });
 }

 async function initSquare() {
   if (squareInitPromise) return squareInitPromise;
   squareInitPromise = (async () => {
     const res = await fetch('/api/config');
     if (!res.ok) throw new Error('Could not load checkout config');
     squareConfig = await res.json();
     await loadSquareSdkScript(squareConfig.environment);
     squarePayments = window.Square.payments(squareConfig.applicationId, squareConfig.locationId);
     // Show the sandbox banner so testers know which test card to use
     if (squareConfig.environment !== 'production') {
       const b = document.getElementById('sandboxBanner');
       if (b) b.hidden = false;
     }
     return squarePayments;
   })();
   return squareInitPromise;
 }

 // ---------- Checkout modal flow ----------

 async function startCheckout(windowId) {
   const items = cart.filter(e => e.windowId === windowId);
   if (items.length === 0) return;

   activeCheckoutWindow = windowId;
   const win = PICKUP_WINDOWS[windowId];

   // Reset modal state
   document.getElementById('checkoutFormView').hidden = false;
   document.getElementById('checkoutSuccessView').hidden = true;
   document.getElementById('checkoutError').hidden = true;
   document.getElementById('checkoutError').textContent = '';
   document.getElementById('checkoutForm').reset();

   // Header
   document.getElementById('checkoutWindowEmoji').textContent = win.emoji;
   document.getElementById('checkoutWindowLabel').textContent = win.label;
   document.getElementById('checkoutPickupRange').textContent = win.range;

   // Summary + total
   let total = 0;
   const summaryHtml = items.map(entry => {
     const lookup = getProductBySku(entry.sku);
     if (!lookup) return '';
     const { product, flavor } = lookup;
     const lineTotal = product.price * entry.qty;
     total += lineTotal;
     const displayName = flavor ? `${product.name}, ${flavor}` : product.name;
     return `
       <div class="checkout-summary-row">
         <div>${displayName} <span class="item-qty">× ${entry.qty}</span></div>
         <div>$${lineTotal.toFixed(2)}</div>
       </div>`;
   }).join('');
   document.getElementById('checkoutSummary').innerHTML = summaryHtml;
   document.getElementById('checkoutTotal').textContent = `$${total.toFixed(2)}`;
   document.getElementById('checkoutPayBtn').querySelector('.pay-btn-label').textContent = `Pay $${total.toFixed(2)}`;

   // Open the modal
   document.getElementById('checkoutModal').classList.add('open');
   document.body.style.overflow = 'hidden';

   // Lazy-init Square + mount payment methods
   const payBtn = document.getElementById('checkoutPayBtn');
   payBtn.disabled = true;
   try {
     await initSquare();

     // Build a paymentRequest object — required for Apple/Google Pay so the
     // wallet UIs show the correct total, currency, and (optionally) line items
     const paymentRequest = squarePayments.paymentRequest({
       countryCode: 'US',
       currencyCode: 'USD',
       total: { amount: total.toFixed(2), label: "MJ's Sweets" },
       lineItems: items.map(entry => {
         const lookup = getProductBySku(entry.sku);
         if (!lookup) return null;
         const { product, flavor } = lookup;
         const displayName = flavor ? `${product.name}, ${flavor}` : product.name;
         return {
           label: `${displayName} × ${entry.qty}`,
           amount: (product.price * entry.qty).toFixed(2),
         };
       }).filter(Boolean),
     });

     // Mount card (always available) and wallet methods in parallel.
     // Wallets fail silently if the device/browser doesn't support them.
     await Promise.all([
       mountSquareCard(),
       mountSquareApplePay(paymentRequest),
       mountSquareGooglePay(paymentRequest),
     ]);

     // Show the divider only if at least one wallet method rendered
     const anyWallet = !document.getElementById('apple-pay-button').hidden
                    || !document.getElementById('google-pay-button').hidden;
     document.getElementById('walletDivider').hidden = !anyWallet;

     payBtn.disabled = false;
   } catch (err) {
     console.error('Square init failed:', err);
     showCheckoutError('Couldn\'t load the payment form. Refresh the page or text Maddie.');
   }
 }

 // Apple Pay — only available in Safari on Mac/iOS with a card in Wallet.
 // Fails silently elsewhere; we hide the button if init throws.
 async function mountSquareApplePay(paymentRequest) {
   const btn = document.getElementById('apple-pay-button');
   btn.hidden = true;
   if (squareApplePay) {
     try { await squareApplePay.destroy(); } catch (_) {}
     squareApplePay = null;
   }
   try {
     squareApplePay = await squarePayments.applePay(paymentRequest);
     btn.hidden = false;
     btn.onclick = () => handleWalletPayment(squareApplePay, 'apple-pay', 'Apple Pay');
   } catch (err) {
     // Expected on non-Safari browsers / devices without Apple Pay set up
     console.log('Apple Pay unavailable:', err.message || err);
   }
 }

 // Google Pay — works in most modern browsers, especially Chrome.
 // Square's SDK renders the official Google Pay button into our container.
 async function mountSquareGooglePay(paymentRequest) {
   const container = document.getElementById('google-pay-button');
   container.hidden = true;
   container.innerHTML = '';
   if (squareGooglePay) {
     try { await squareGooglePay.destroy(); } catch (_) {}
     squareGooglePay = null;
   }
   try {
     squareGooglePay = await squarePayments.googlePay(paymentRequest);
     await squareGooglePay.attach('#google-pay-button', {
       buttonColor: 'black',
       buttonType: 'pay',
       buttonSizeMode: 'fill',
     });
     container.hidden = false;
     container.addEventListener('click', () => handleWalletPayment(squareGooglePay, 'google-pay', 'Google Pay'), { once: false });
   } catch (err) {
     console.log('Google Pay unavailable:', err.message || err);
   }
 }

 async function mountSquareCard() {
   // Square Card can only be attached once — destroy any previous instance
   if (squareCard) {
     try { await squareCard.destroy(); } catch (_) {}
     squareCard = null;
   }
   const container = document.getElementById('card-container');
   container.innerHTML = ''; // clear any leftover DOM
   squareCard = await squarePayments.card();
   await squareCard.attach('#card-container');

   // Visual focus ring on the wrapper while the iframe is focused
   squareCard.addEventListener('focusClassAdded', () => container.classList.add('is-focused'));
   squareCard.addEventListener('focusClassRemoved', () => container.classList.remove('is-focused'));
 }

 // Validate the customer fields + phone digit count + cart contents.
 // Returns { ok: true, customer, items, note } or { ok: false } and shows error.
 // Used by all payment methods (card, Apple Pay, Google Pay) before tokenizing.
 function validateCheckoutForm() {
   hideCheckoutError();
   const form = document.getElementById('checkoutForm');
   if (!form.reportValidity()) return { ok: false };

   const customer = {
     name: document.getElementById('checkoutName').value.trim(),
     phone: document.getElementById('checkoutPhone').value.trim(),
     email: document.getElementById('checkoutEmail').value.trim(),
   };
   const note = document.getElementById('checkoutNote').value.trim();

   const phoneDigits = customer.phone.replace(/\D/g, '');
   if (phoneDigits.length !== 10) {
     showCheckoutError('Please enter a valid 10-digit phone number.');
     document.getElementById('checkoutPhone').focus();
     return { ok: false };
   }

   const items = cart.filter(e => e.windowId === activeCheckoutWindow)
                     .map(e => ({ sku: e.sku, qty: e.qty }));
   if (items.length === 0) {
     showCheckoutError('Your cart for this batch is empty.');
     return { ok: false };
   }

   return { ok: true, customer, items, note };
 }

 // Shared "submit token to /api/checkout" used by card, Apple Pay, Google Pay.
 // Tokens are interchangeable — the backend doesn't care which method generated them.
 async function processPayment(paymentToken, methodName, validated) {
   const payBtn = document.getElementById('checkoutPayBtn');
   payBtn.disabled = true;
   payBtn.classList.add('is-loading');
   payBtn.querySelector('.pay-btn-label').textContent = 'Processing';

   try {
     const res = await fetch('/api/checkout', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({
         items: validated.items,
         paymentToken,
         customer: validated.customer,
         pickupWindow: activeCheckoutWindow,
         pickupNote: validated.note,
         paymentMethod: methodName,
       }),
     });
     const data = await res.json();
     if (!res.ok) throw new Error(data.detail || data.error || 'Payment failed.');

     cart = cart.filter(e => e.windowId !== activeCheckoutWindow);
     updateCart();
     showCheckoutSuccess(validated.customer.name, data);
   } catch (err) {
     console.error('Checkout error:', err);
     showCheckoutError(err.message || 'Something went wrong. Please try again.');
     payBtn.disabled = false;
     payBtn.classList.remove('is-loading');
     const total = validated.items.reduce((sum, e) => {
       const p = getProductBySku(e.sku)?.product;
       return sum + (p ? p.price * e.qty : 0);
     }, 0);
     payBtn.querySelector('.pay-btn-label').textContent = `Pay $${total.toFixed(2)}`;
   }
 }

 // Card form submit — tokenize via Square Card, then process
 async function handleCheckoutSubmit() {
   const payBtn = document.getElementById('checkoutPayBtn');
   if (payBtn.disabled) return;

   const v = validateCheckoutForm();
   if (!v.ok) return;

   try {
     const tokenResult = await squareCard.tokenize();
     if (tokenResult.status !== 'OK') {
       const errs = tokenResult.errors?.map(e => e.message).join(' · ') || 'Card details look invalid.';
       throw new Error(errs);
     }
     await processPayment(tokenResult.token, 'card', v);
   } catch (err) {
     console.error('Card checkout error:', err);
     showCheckoutError(err.message || 'Something went wrong with the card.');
   }
 }

 // Shared wallet click handler (Apple Pay / Google Pay)
 async function handleWalletPayment(walletInstance, methodName, methodDisplay) {
   const v = validateCheckoutForm();
   if (!v.ok) return;

   try {
     const tokenResult = await walletInstance.tokenize();
     if (tokenResult.status !== 'OK') {
       const firstErr = tokenResult.errors?.[0];
       const code = firstErr?.code || '';
       // User dismissed the wallet sheet — that's not an error worth surfacing
       if (code === 'CANCELED' || code === 'CANCELLED' || code === 'CANCEL') return;
       throw new Error(tokenResult.errors?.map(e => e.message).join(' · ') || `${methodDisplay} payment failed.`);
     }
     await processPayment(tokenResult.token, methodName, v);
   } catch (err) {
     // Some wallet errors look like "User cancelled" — swallow those quietly
     if ((err.message || '').toLowerCase().includes('cancel')) return;
     console.error(`${methodName} error:`, err);
     showCheckoutError(err.message || `${methodDisplay} failed. Try again or use card.`);
   }
 }

 function showCheckoutSuccess(name, data) {
   document.getElementById('checkoutFormView').hidden = true;
   document.getElementById('checkoutSuccessView').hidden = false;
   document.getElementById('successName').textContent = name.split(' ')[0] || name;
   document.getElementById('successOrderId').textContent = data.orderId || '-';

   const link = document.getElementById('successReceiptLink');
   const sandboxNote = document.getElementById('successSandboxNote');
   const isProduction = squareConfig?.environment === 'production';

   if (isProduction && data.receiptUrl) {
     // Production: Square hosts a public receipt page customers can view
     link.href = data.receiptUrl;
     link.style.display = '';
     if (sandboxNote) sandboxNote.hidden = true;
   } else {
     // Sandbox: receipt URLs Square returns aren't publicly hosted in test mode.
     // Hide the broken button and explain.
     link.style.display = 'none';
     if (sandboxNote) sandboxNote.hidden = false;
   }
 }

 function showCheckoutError(msg) {
   const el = document.getElementById('checkoutError');
   el.textContent = msg;
   el.hidden = false;
 }
 function hideCheckoutError() {
   const el = document.getElementById('checkoutError');
   el.hidden = true;
   el.textContent = '';
 }

 async function closeCheckoutModal() {
   document.getElementById('checkoutModal').classList.remove('open');
   document.body.style.overflow = '';
   // Tear down all payment method instances — they'll be re-created on next open.
   // Square's SDK requires destroy() before re-attaching to the same DOM node.
   const teardown = async (instance) => {
     if (!instance) return;
     try { await instance.destroy(); } catch (_) {}
   };
   await Promise.all([
     teardown(squareCard),
     teardown(squareApplePay),
     teardown(squareGooglePay),
   ]);
   squareCard = null;
   squareApplePay = null;
   squareGooglePay = null;
   activeCheckoutWindow = null;
 }

 // ---------- CUSTOM-ORDER PAID CHECKOUT FLOW ----------
 //
 // Mirrors the cart checkout above but on its own DOM (#customCheckout*) and
 // its own SDK instances. Square's Card SDK can only attach to one DOM node at
 // a time, so the cart modal and custom-order modal each get their own instance.

 // Display-only prices. The server fetches authoritative prices from Square
 // Catalog before charging, so a price mismatch here is a UI bug, not a money bug.
 const TIER_PRICE_CENTS = {
   'CUSTOM-SIG-DZN':  4000,
   'CUSTOM-SHOW-DZN': 4600,
 };
 const TIER_NAME = {
   'CUSTOM-SIG-DZN':  'Signature Custom Dozen',
   'CUSTOM-SHOW-DZN': 'Showstopper Custom Dozen',
 };

 // Optional add-ons appended to a custom order's Square Order as additional
 // line items. Cake pops require a flavor pick (one flavor per dozen, matches
 // the cart UX); rice krispies + pretzel rods are single-SKU.
 // Prices here are display-only; server validates against Square Catalog.
 const ADDON_DEFS = {
   'cake-pops': {
     label: 'Cake Pops',
     priceCents: 2400,
     needsFlavor: true,
     checkId: 'addonCakePopsCheck',
     qtyInputId: 'addonCakePopsQty',
     flavorSelectId: 'addonCakePopsFlavor',
     flavorByValue: {
       'POP-CHOC': 'Chocolate',
       'POP-VAN':  'Vanilla',
       'POP-FUN':  'Funfetti',
       'POP-RV':   'Red Velvet',
       'POP-LEM':  'Lemon',
       'POP-STR':  'Strawberry',
     },
   },
   'rice-krispies': {
     label: 'Rice Krispies Treats',
     priceCents: 2400,
     needsFlavor: false,
     sku: 'KRIS-DZ',
     checkId: 'addonRiceKrispiesCheck',
     qtyInputId: 'addonRiceKrispiesQty',
   },
   'pretzel-rods': {
     label: 'Dipped Pretzel Rods',
     priceCents: 2400,
     needsFlavor: false,
     sku: 'PRETZ-DZ',
     checkId: 'addonPretzelRodsCheck',
     qtyInputId: 'addonPretzelRodsQty',
   },
 };

 // Per-modal-session state
 let customSquareCard = null;
 let customSquareApplePay = null;
 let customSquareGooglePay = null;
 let customCheckoutCustomer = null;       // { name, phone, email } captured at modal open
 let customCheckoutPayload = null;        // { tier, dozens, totalCents }
 let customCheckoutIdempotencyKey = null; // stable for the lifetime of one modal session
 let customCheckoutInFlight = false;      // true while a charge is processing — blocks close

 // --- Form-side wiring (tier picker, qty stepper, live total, date min) ---
 function initCustomOrderForm() {
   const form = document.getElementById('customRequestForm');
   if (!form) return;

   // Lead time: today + 14 days, formatted as YYYY-MM-DD for <input type=date>.
   // Browser blocks earlier dates via the `min` attribute; handleRequest also
   // re-validates server-side semantics in case someone bypasses the picker.
   const dateInput = document.getElementById('reqDate');
   if (dateInput) {
     const min = new Date();
     min.setDate(min.getDate() + 14);
     const yyyy = min.getFullYear();
     const mm = String(min.getMonth() + 1).padStart(2, '0');
     const dd = String(min.getDate()).padStart(2, '0');
     dateInput.min = `${yyyy}-${mm}-${dd}`;
   }

   // Tier card click — the <label> wraps the radio so native click toggles it.
   // We only need to drive the .is-selected visual state and recompute total.
   form.querySelectorAll('.tier-radio').forEach(radio => {
     radio.addEventListener('change', () => {
       form.querySelectorAll('.tier-card').forEach(c => c.classList.remove('is-selected'));
       const card = radio.closest('.tier-card');
       if (radio.checked && card) card.classList.add('is-selected');
       updateCustomTotal();
     });
   });

   // Qty stepper
   const dozensInput = document.getElementById('reqDozens');
   const minusBtn   = document.getElementById('reqDozensMinus');
   const plusBtn    = document.getElementById('reqDozensPlus');
   const clamp = (n) => Math.max(1, Math.min(10, Math.round(Number(n) || 1)));

   if (minusBtn && plusBtn && dozensInput) {
     minusBtn.addEventListener('click', () => {
       dozensInput.value = String(clamp(parseInt(dozensInput.value, 10) - 1));
       updateCustomTotal();
     });
     plusBtn.addEventListener('click', () => {
       dozensInput.value = String(clamp(parseInt(dozensInput.value, 10) + 1));
       updateCustomTotal();
     });
     dozensInput.addEventListener('input', updateCustomTotal);
     dozensInput.addEventListener('blur', () => {
       dozensInput.value = String(clamp(dozensInput.value));
       updateCustomTotal();
     });
   }

   // --- Add-ons: checkbox toggles, flavor select, qty stepper buttons ---
   form.querySelectorAll('.addon-row').forEach(row => {
     const key = row.dataset.addonKey;
     const def = ADDON_DEFS[key];
     if (!def) return;
     const check = document.getElementById(def.checkId);
     const controls = row.querySelector('.addon-controls');
     const qtyInput = document.getElementById(def.qtyInputId);
     const flavor = def.needsFlavor ? document.getElementById(def.flavorSelectId) : null;
     if (!check || !controls || !qtyInput) return;

     // Checkbox toggle reveals/hides the qty + flavor controls and the
     // .is-active style. We always recompute total on change so an unchecked
     // add-on subtracts from the live total immediately.
     check.addEventListener('change', () => {
       if (check.checked) {
         row.classList.add('is-active');
         controls.hidden = false;
       } else {
         row.classList.remove('is-active');
         controls.hidden = true;
       }
       updateCustomTotal();
     });

     if (flavor) flavor.addEventListener('change', updateCustomTotal);

     qtyInput.addEventListener('input', updateCustomTotal);
     qtyInput.addEventListener('blur', () => {
       qtyInput.value = String(clamp(qtyInput.value));
       updateCustomTotal();
     });
   });

   // Add-on stepper buttons — wired via [data-action="addon-minus|plus"][data-key=...]
   form.querySelectorAll('.tier-qty-btn[data-action]').forEach(btn => {
     const action = btn.dataset.action;
     const key = btn.dataset.key;
     if (!action || !key) return;
     const def = ADDON_DEFS[key];
     if (!def) return;
     const qtyInput = document.getElementById(def.qtyInputId);
     if (!qtyInput) return;
     btn.addEventListener('click', () => {
       const cur = parseInt(qtyInput.value, 10);
       const next = action === 'addon-plus' ? cur + 1 : cur - 1;
       qtyInput.value = String(clamp(next));
       updateCustomTotal();
     });
   });

   // If browser restored cached form state (e.g., user hit back), sync the
   // visual state of any pre-checked add-ons to match.
   form.querySelectorAll('.addon-check').forEach(cb => {
     if (cb.checked) cb.dispatchEvent(new Event('change'));
   });

   updateCustomTotal();
 }

 function getSelectedTier() {
   const r = document.querySelector('input[name="tier"]:checked');
   return r ? r.value : null;
 }
 function getSelectedDozens() {
   const v = parseInt(document.getElementById('reqDozens')?.value, 10);
   return Number.isFinite(v) ? Math.max(1, Math.min(10, v)) : 1;
 }

 // Returns [{ sku, qty, displayName, priceCents }, ...] for every add-on
 // the customer has checked AND filled in (cake pops without flavor are
 // skipped here; handleRequest separately surfaces an error so they don't
 // submit silently). Used for both client-side total + checkout payload.
 function getSelectedAddons() {
   const out = [];
   for (const [key, def] of Object.entries(ADDON_DEFS)) {
     const check = document.getElementById(def.checkId);
     if (!check?.checked) continue;
     const qty = parseInt(document.getElementById(def.qtyInputId)?.value, 10);
     if (!Number.isInteger(qty) || qty < 1 || qty > 10) continue;

     let sku, displayName;
     if (def.needsFlavor) {
       const flavorVal = document.getElementById(def.flavorSelectId)?.value || '';
       if (!flavorVal) continue; // flavor not picked yet — don't count toward total
       sku = flavorVal;
       displayName = `${def.label}, ${def.flavorByValue[flavorVal] || flavorVal}`;
     } else {
       sku = def.sku;
       displayName = def.label;
     }
     out.push({ sku, qty, displayName, priceCents: def.priceCents });
   }
   return out;
 }

 function computeCustomTotalCents() {
   let cents = 0;
   const tier = getSelectedTier();
   if (tier && TIER_PRICE_CENTS[tier]) {
     cents += TIER_PRICE_CENTS[tier] * getSelectedDozens();
   }
   for (const a of getSelectedAddons()) {
     cents += a.priceCents * a.qty;
   }
   return cents;
 }
 function formatUSD(cents) {
   return `$${(cents / 100).toFixed(2)}`;
 }

 // Updates the live total row + the Pay & Reserve button label whenever tier
 // or qty changes. Also disables the +/- buttons at the [1, 10] bounds.
 function updateCustomTotal() {
   const totalCents = computeCustomTotalCents();
   const totalRow   = document.getElementById('reqTotalRow');
   const totalEl    = document.getElementById('reqTotal');
   const labelEl    = document.getElementById('reqSubmitLabel');
   const minusBtn   = document.getElementById('reqDozensMinus');
   const plusBtn    = document.getElementById('reqDozensPlus');

   if (totalCents > 0) {
     if (totalRow) totalRow.hidden = false;
     if (totalEl)  totalEl.textContent = formatUSD(totalCents);
     if (labelEl)  labelEl.innerHTML = `Pay &amp; Reserve ${formatUSD(totalCents)} →`;
   } else {
     if (totalRow) totalRow.hidden = true;
     if (totalEl)  totalEl.textContent = '$0.00';
     if (labelEl)  labelEl.innerHTML = 'Pay &amp; Reserve →';
   }

   const dz = getSelectedDozens();
   if (minusBtn) minusBtn.disabled = dz <= 1;
   if (plusBtn)  plusBtn.disabled  = dz >= 10;
 }

 // Date utility used by handleRequest as a belt-and-suspenders check on top
 // of the picker's `min` attribute. Returns true iff yyyyMmDd >= today + 14d.
 function isDateAtLeast14Days(yyyyMmDd) {
   if (!yyyyMmDd) return false;
   const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
   if (!m) return false;
   const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
   target.setHours(0, 0, 0, 0);
   const today = new Date();
   today.setHours(0, 0, 0, 0);
   const minDate = new Date(today);
   minDate.setDate(minDate.getDate() + 14);
   return target.getTime() >= minDate.getTime();
 }

 // Run wiring as soon as the script executes. The <script> tag sits at end of
 // <body>, so the form DOM is already in place.
 initCustomOrderForm();

 // --- Modal open / close ---

 // crypto.randomUUID is available everywhere this site supports (Chrome 92+,
 // Safari 15.4+, Firefox 95+). Math.random fallback for ancient browsers —
 // sufficient as an idempotency key on a single browser session.
 function newIdempotencyKey() {
   if (window.crypto?.randomUUID) return window.crypto.randomUUID();
   const rand = (n) => Array.from({ length: n }, () =>
     Math.floor(Math.random() * 16).toString(16)).join('');
   return `${rand(8)}-${rand(4)}-4${rand(3)}-${rand(4)}-${rand(12)}`;
 }

 // Opens the custom-order checkout modal with the given customer, tier, qty,
 // and optional add-ons. Idempotency key is generated once here and reused
 // across retries inside this modal session — protects against duplicate
 // Square Orders if the user double-clicks Pay or the network hiccups during
 // processCustomPayment.
 async function openCustomCheckout(customer, tier, dozens, addons) {
   const safeAddons = Array.isArray(addons) ? addons : [];
   const tierSubtotal = TIER_PRICE_CENTS[tier] * dozens;
   const addonsSubtotal = safeAddons.reduce((s, a) => s + a.priceCents * a.qty, 0);

   customCheckoutCustomer = customer;
   customCheckoutPayload = {
     tier,
     dozens,
     addons: safeAddons,
     totalCents: tierSubtotal + addonsSubtotal,
   };
   customCheckoutIdempotencyKey = newIdempotencyKey();
   customCheckoutInFlight = false;

   const total = customCheckoutPayload.totalCents;

   // Reset modal state — last session's success view, errors, fallback notice
   document.getElementById('customCheckoutFormView').hidden = false;
   document.getElementById('customSuccessView').hidden = true;
   document.getElementById('customSuccessNotifyFallback').hidden = true;
   document.getElementById('customCheckoutError').hidden = true;
   document.getElementById('customCheckoutError').textContent = '';

   // Multi-line summary: tier first, then each add-on.
   // displayName values come from our hardcoded ADDON_DEFS / TIER_NAME, so
   // they don't need HTML escaping. If we ever pull display names from a
   // remote source, escape them here.
   const summaryRows = [
     `<div class="checkout-summary-row">
        <div>${TIER_NAME[tier]} <span class="item-qty">× ${dozens}</span></div>
        <div>${formatUSD(tierSubtotal)}</div>
      </div>`,
     ...safeAddons.map(a => `
       <div class="checkout-summary-row">
         <div>${a.displayName} <span class="item-qty">× ${a.qty}</span></div>
         <div>${formatUSD(a.priceCents * a.qty)}</div>
       </div>`),
   ];
   document.getElementById('customCheckoutSummary').innerHTML = summaryRows.join('');
   document.getElementById('customCheckoutTotal').textContent = formatUSD(total);
   const payBtn = document.getElementById('customCheckoutPayBtn');
   payBtn.querySelector('.pay-btn-label').textContent = `Pay ${formatUSD(total)}`;
   payBtn.classList.remove('is-loading');

   // Open modal first (so user sees "loading payment form" UI rather than dead form)
   document.getElementById('customCheckoutModal').classList.add('open');
   document.body.style.overflow = 'hidden';

   // Lazy-init Square + mount payment methods. Pay button stays disabled
   // until everything's mounted; if any of this throws, surface the error.
   payBtn.disabled = true;
   try {
     await initSquare();
     const paymentRequest = squarePayments.paymentRequest({
       countryCode: 'US',
       currencyCode: 'USD',
       total: { amount: (total / 100).toFixed(2), label: "MJ's Sweets" },
       lineItems: [
         {
           label: `${TIER_NAME[tier]} × ${dozens}`,
           amount: (tierSubtotal / 100).toFixed(2),
         },
         ...safeAddons.map(a => ({
           label: `${a.displayName} × ${a.qty}`,
           amount: ((a.priceCents * a.qty) / 100).toFixed(2),
         })),
       ],
     });
     await Promise.all([
       mountCustomSquareCard(),
       mountCustomSquareApplePay(paymentRequest),
       mountCustomSquareGooglePay(paymentRequest),
     ]);
     const anyWallet = !document.getElementById('custom-apple-pay-button').hidden
                    || !document.getElementById('custom-google-pay-button').hidden;
     document.getElementById('customWalletDivider').hidden = !anyWallet;
     payBtn.disabled = false;
   } catch (err) {
     console.error('Square init failed (custom):', err);
     showCustomCheckoutError("Couldn't load the payment form. Refresh the page or text Maddie at (504) 559-6466.");
   }
 }

 async function mountCustomSquareCard() {
   if (customSquareCard) {
     try { await customSquareCard.destroy(); } catch (_) {}
     customSquareCard = null;
   }
   const container = document.getElementById('custom-card-container');
   container.innerHTML = '';
   customSquareCard = await squarePayments.card();
   await customSquareCard.attach('#custom-card-container');
   customSquareCard.addEventListener('focusClassAdded',   () => container.classList.add('is-focused'));
   customSquareCard.addEventListener('focusClassRemoved', () => container.classList.remove('is-focused'));
 }

 async function mountCustomSquareApplePay(paymentRequest) {
   const btn = document.getElementById('custom-apple-pay-button');
   btn.hidden = true;
   if (customSquareApplePay) {
     try { await customSquareApplePay.destroy(); } catch (_) {}
     customSquareApplePay = null;
   }
   try {
     customSquareApplePay = await squarePayments.applePay(paymentRequest);
     btn.hidden = false;
     btn.onclick = () => handleCustomWalletPayment(customSquareApplePay, 'apple-pay', 'Apple Pay');
   } catch (err) {
     console.log('Apple Pay unavailable (custom):', err.message || err);
   }
 }

 async function mountCustomSquareGooglePay(paymentRequest) {
   const container = document.getElementById('custom-google-pay-button');
   container.hidden = true;
   container.innerHTML = '';
   if (customSquareGooglePay) {
     try { await customSquareGooglePay.destroy(); } catch (_) {}
     customSquareGooglePay = null;
   }
   try {
     customSquareGooglePay = await squarePayments.googlePay(paymentRequest);
     await customSquareGooglePay.attach('#custom-google-pay-button', {
       buttonColor: 'black',
       buttonType: 'pay',
       buttonSizeMode: 'fill',
     });
     container.hidden = false;
     container.addEventListener('click', () => handleCustomWalletPayment(customSquareGooglePay, 'google-pay', 'Google Pay'), { once: false });
   } catch (err) {
     console.log('Google Pay unavailable (custom):', err.message || err);
   }
 }

 // --- Pay handlers ---

 async function handleCustomCheckoutSubmit() {
   const payBtn = document.getElementById('customCheckoutPayBtn');
   if (payBtn.disabled) return;
   if (!customSquareCard) return;
   try {
     const tokenResult = await customSquareCard.tokenize();
     if (tokenResult.status !== 'OK') {
       const errs = tokenResult.errors?.map(e => e.message).join(' · ') || 'Card details look invalid.';
       throw new Error(errs);
     }
     await processCustomPayment(tokenResult.token, 'card');
   } catch (err) {
     console.error('Custom card checkout error:', err);
     showCustomCheckoutError(err.message || 'Something went wrong with the card.');
   }
 }

 async function handleCustomWalletPayment(walletInstance, methodName, methodDisplay) {
   try {
     const tokenResult = await walletInstance.tokenize();
     if (tokenResult.status !== 'OK') {
       const code = tokenResult.errors?.[0]?.code || '';
       if (code === 'CANCELED' || code === 'CANCELLED' || code === 'CANCEL') return;
       throw new Error(tokenResult.errors?.map(e => e.message).join(' · ') || `${methodDisplay} payment failed.`);
     }
     await processCustomPayment(tokenResult.token, methodName);
   } catch (err) {
     if ((err.message || '').toLowerCase().includes('cancel')) return;
     console.error(`${methodName} error (custom):`, err);
     showCustomCheckoutError(err.message || `${methodDisplay} failed. Try again or use card.`);
   }
 }

 // Builds multipart FormData from the outer custom-order form (so photos
 // upload as part of the same request) and POSTs it to /api/contact along
 // with the payment token + idempotency key. Charge succeeds → success view.
 // Charge fails → re-enable Pay so user can retry. Notification failures
 // post-charge are non-fatal; backend returns 200 with `notificationsSent`.
 async function processCustomPayment(paymentToken, methodName) {
   const payBtn = document.getElementById('customCheckoutPayBtn');
   const labelEl = payBtn.querySelector('.pay-btn-label');
   const totalText = formatUSD(customCheckoutPayload.totalCents);
   payBtn.disabled = true;
   payBtn.classList.add('is-loading');
   labelEl.textContent = 'Processing';
   customCheckoutInFlight = true;

   try {
     const form = document.getElementById('customRequestForm');
     const formData = new FormData(form);
     formData.append('paymentToken', paymentToken);
     formData.append('paymentMethod', methodName);
     formData.append('idempotencyKey', customCheckoutIdempotencyKey);
     // Add-ons travel as a JSON-stringified array — server parses + validates
     // each {sku, qty} against the catalog. tier + dozens are already form
     // fields via the radios + number input, so they ride along automatically.
     const addonsForServer = (customCheckoutPayload.addons || [])
       .map(a => ({ sku: a.sku, qty: a.qty }));
     formData.append('addons', JSON.stringify(addonsForServer));

     const res = await fetch('/api/contact', { method: 'POST', body: formData });
     const data = await res.json().catch(() => ({}));
     if (!res.ok) {
       const msg = data.detail
         ? `${data.error || 'Error'}: ${data.detail}`
         : (data.error || 'Payment failed.');
       throw new Error(msg);
     }
     showCustomCheckoutSuccess(data);

     // Reset outer form so a second order doesn't carry stale state.
     // Photos preview + tier .is-selected + add-on UI all need explicit
     // cleanup since form.reset() doesn't touch class state or hidden=true.
     form.reset();
     document.getElementById('reqPhotoPreview').hidden = true;
     document.getElementById('reqPhotoPreview').innerHTML = '';
     form.querySelectorAll('.tier-card').forEach(c => c.classList.remove('is-selected'));
     form.querySelectorAll('.addon-row').forEach(row => {
       row.classList.remove('is-active');
       const ctrls = row.querySelector('.addon-controls');
       if (ctrls) ctrls.hidden = true;
     });
     updateCustomTotal();
   } catch (err) {
     console.error('Custom checkout submit error:', err);
     showCustomCheckoutError(err.message || 'Something went wrong. Please try again.');
     payBtn.disabled = false;
     payBtn.classList.remove('is-loading');
     labelEl.textContent = `Pay ${totalText}`;
   } finally {
     customCheckoutInFlight = false;
   }
 }

 function showCustomCheckoutSuccess(data) {
   document.getElementById('customCheckoutFormView').hidden = true;
   document.getElementById('customSuccessView').hidden = false;
   const firstName = (customCheckoutCustomer?.name || '').split(' ')[0] || 'there';
   document.getElementById('customSuccessName').textContent = firstName;
   document.getElementById('customSuccessOrderId').textContent = data.orderId || '-';

   // Show the "text Maddie the order ID" fallback ONLY when Maddie's notification
   // email failed. Customer's own confirmation email failure is logged but not
   // surfaced — they already see the order ID + receipt link, which is enough
   // self-recovery info.
   const notify = data.notificationsSent || {};
   const fallback = document.getElementById('customSuccessNotifyFallback');
   fallback.hidden = !(notify.maddieEmail === false);

   const link = document.getElementById('customSuccessReceiptLink');
   if (data.receiptUrl) {
     link.href = data.receiptUrl;
     link.style.display = '';
   } else {
     link.style.display = 'none';
   }
 }

 function showCustomCheckoutError(msg) {
   const el = document.getElementById('customCheckoutError');
   el.textContent = msg;
   el.hidden = false;
 }

 async function closeCustomCheckoutModal() {
   // Hard-refuse to close while a charge is in flight — closing mid-payment
   // would leave the user staring at a stale form while their card is being
   // charged. The Pay button is .is-loading during this time, so the UX
   // signal is already there.
   if (customCheckoutInFlight) return;

   document.getElementById('customCheckoutModal').classList.remove('open');
   document.body.style.overflow = '';

   const teardown = async (instance) => {
     if (!instance) return;
     try { await instance.destroy(); } catch (_) {}
   };
   await Promise.all([
     teardown(customSquareCard),
     teardown(customSquareApplePay),
     teardown(customSquareGooglePay),
   ]);
   customSquareCard = null;
   customSquareApplePay = null;
   customSquareGooglePay = null;
   customCheckoutCustomer = null;
   customCheckoutPayload = null;
   customCheckoutIdempotencyKey = null;
 }

 function showToast(msg) {
 const t = document.getElementById('toast');
 t.textContent = msg;
 t.classList.add('show');
 setTimeout(() => t.classList.remove('show'), 2200);
 }

 // Reuse the phone formatter on the custom-order form's phone field so the same
 // (XXX) XXX-XXXX live formatting + paste normalization applies.
 const reqPhoneEl = document.getElementById('reqPhone');
 if (reqPhoneEl) reqPhoneEl.addEventListener('input', formatPhoneInput);

 // Show / hide the "tell me more about the occasion" input based on dropdown choice.
 // When visible it becomes required; when hidden it's cleared so an old value
 // doesn't get submitted by mistake.
 const reqOccasionEl = document.getElementById('reqOccasion');
 if (reqOccasionEl) {
   reqOccasionEl.addEventListener('change', () => {
     const wrap = document.getElementById('reqOccasionOtherWrap');
     const input = document.getElementById('reqOccasionOther');
     if (reqOccasionEl.value === 'Other') {
       wrap.hidden = false;
       input.required = true;
       input.focus();
     } else {
       wrap.hidden = true;
       input.required = false;
       input.value = '';
     }
   });
 }

 // Inspiration photo preview — show small thumbnails as soon as files are picked
 const reqPhotosInput = document.getElementById('reqPhotos');
 if (reqPhotosInput) {
   reqPhotosInput.addEventListener('change', (e) => {
     const preview = document.getElementById('reqPhotoPreview');
     preview.innerHTML = '';
     const files = Array.from(e.target.files || []).slice(0, 5);
     if (files.length === 0) {
       preview.hidden = true;
       return;
     }
     files.forEach(file => {
       if (!file.type.startsWith('image/')) return;
       const img = document.createElement('img');
       img.src = URL.createObjectURL(file);
       img.alt = file.name;
       img.onload = () => URL.revokeObjectURL(img.src);
       preview.appendChild(img);
     });
     preview.hidden = false;
   });
 }

 // Custom-order form submit — pre-flight validation, then hand off to the
 // checkout modal. The actual /api/contact POST happens inside processCustomPayment
 // after Square tokenizes the card / wallet.
 async function handleRequest(e) {
   e.preventDefault();
   const errorEl = document.getElementById('reqError');
   errorEl.hidden = true;
   errorEl.textContent = '';

   const showError = (msg, focusEl) => {
     errorEl.textContent = msg;
     errorEl.hidden = false;
     if (focusEl) focusEl.focus();
   };

   // Phone digit-count check — the pattern attribute can be satisfied by
   // punctuation alone in some browsers, so verify exactly 10 digits.
   const phoneInput = document.getElementById('reqPhone');
   const phoneDigits = (phoneInput.value || '').replace(/\D/g, '');
   if (phoneDigits.length !== 10) {
     return showError('Please enter a valid 10-digit phone number.', phoneInput);
   }

   // Tier picked? (HTML `required` enforces this too, but explicit is friendlier.)
   const tier = getSelectedTier();
   if (!tier || !TIER_PRICE_CENTS[tier]) {
     return showError('Please pick a tier (Signature or Showstopper).');
   }

   const dozens = getSelectedDozens();
   if (dozens < 1 || dozens > 10) {
     return showError('Please pick a quantity between 1 and 10 dozen.', document.getElementById('reqDozens'));
   }

   // Belt-and-suspenders lead-time check — the date picker `min` already
   // blocks earlier dates, but typing an invalid date directly can bypass it
   // in some browsers.
   const dateStr = document.getElementById('reqDate').value;
   if (!isDateAtLeast14Days(dateStr)) {
     return showError('Custom orders need at least 14 days lead time. Please pick a later date.', document.getElementById('reqDate'));
   }

   // Add-on validation: if Cake Pops is checked but no flavor is selected,
   // the add-on would silently drop from getSelectedAddons(). Surface a clear
   // error instead so the customer knows why their cake-pop add-on isn't
   // appearing in the total.
   const cakePopsCheck = document.getElementById('addonCakePopsCheck');
   if (cakePopsCheck?.checked) {
     const flavorSel = document.getElementById('addonCakePopsFlavor');
     if (!flavorSel?.value) {
       return showError('Please pick a cake pop flavor (or uncheck Cake Pops).', flavorSel);
     }
   }
   const addons = getSelectedAddons();

   const customer = {
     name:  document.getElementById('reqName').value.trim(),
     phone: phoneInput.value.trim(),
     email: document.getElementById('reqEmail').value.trim(),
   };

   // Hand off to the checkout modal — it handles tokenization + POST.
   await openCustomCheckout(customer, tier, dozens, addons);
 }

 // Stamp current year in the footer so it never goes stale
 const footerYearEl = document.getElementById('footerYear');
 if (footerYearEl) footerYearEl.textContent = String(new Date().getFullYear());

 // ---------- PORTFOLIO GALLERY ----------
 // Real cookie photos shown in the Custom Orders section, with category filter
 // and lightbox viewer. To add new photos: process to /portfolio/[category]/...,
 // append to PORTFOLIO array. To add a new category: add to PORTFOLIO_CATEGORIES.
 const PORTFOLIO_CATEGORIES = {
   'birthdays':   { label: 'Birthdays',          emoji: '🎂' },
   'holidays':    { label: 'Holidays',           emoji: '🎄' },
   'wedding':     { label: 'Wedding & Bridal',   emoji: '💍' },
   'baby-shower': { label: 'Baby Shower',        emoji: '👶' },
   'faith':       { label: 'Faith & Milestones', emoji: '⛪' },
   'graduation':  { label: 'Graduation',         emoji: '🎓' },
   'corporate':   { label: 'Corporate',          emoji: '🎁' },
 };

 const PORTFOLIO = [
   // Birthdays — kids' themes + adult monograms, all in one bucket
   { src: '/portfolio/birthdays/birthday-cookies-cow-print-pink-farmhouse.jpg',
     alt: 'Pink cow print first birthday cookies for Emery with cow face and personalized number 1',
     category: 'birthdays', caption: 'Cow print · age 1' },
   { src: '/portfolio/birthdays/birthday-cookies-pink-gold-monogram-adult.jpg',
     alt: 'Adult birthday cookies in hot pink and gold with K monogram, Happy Birthday, candles, and gift designs',
     category: 'birthdays', caption: 'Pink & gold monogram · adult' },
   { src: '/portfolio/birthdays/birthday-cookies-fortnite-gamer.jpg',
     alt: 'Fortnite themed birthday cookies in blue and grey with Eat Sleep Fortnite Repeat for Mason age nine',
     category: 'birthdays', caption: 'Fortnite · "Eat Sleep Fortnite Repeat"' },
   { src: '/portfolio/birthdays/birthday-cookies-aviator-stars-age-one.jpg',
     alt: 'Red white and blue aviator first birthday cookies for Mav with airplane stars sunglasses and ONE design',
     category: 'birthdays', caption: 'Aviator stars · age 1' },
   { src: '/portfolio/birthdays/birthday-cookies-daisies-clover-monogram.jpg',
     alt: 'Adult birthday cookies with daisies, clover, pink Happy Birthday, and gold P monogram',
     category: 'birthdays', caption: 'Daisies & clover · adult' },
   { src: '/portfolio/birthdays/birthday-cookies-two-tti-frutti.jpg',
     alt: 'Two-tti Frutti themed second birthday cookies for Giavanna with watermelon, strawberry, lemon, lime, and orange',
     category: 'birthdays', caption: '"Two-tti Frutti" · age 2' },
   { src: '/portfolio/birthdays/birthday-cookies-bluey-pastel.jpg',
     alt: 'Pastel Bluey themed third birthday cookies for Giavanna with daisies, bone, and personalized name',
     category: 'birthdays', caption: 'Bluey · pastel age 3' },
   { src: '/portfolio/birthdays/birthday-cookies-mickey-minnie-mouse.jpg',
     alt: 'Mickey and Minnie Mouse first birthday cookies for Gia with iconic gloves, bows, and red polka dot designs',
     category: 'birthdays', caption: 'Mickey & Minnie · age 1' },
   { src: '/portfolio/birthdays/birthday-cookies-jumping-silhouettes-green.jpg',
     alt: 'Green and teal third birthday cookies for Eli with jumping silhouettes and personalized name',
     category: 'birthdays', caption: 'Jumping silhouettes · age 3' },
   { src: '/portfolio/birthdays/birthday-cookies-fishing-reeling-in-the-big-one.jpg',
     alt: 'Fishing themed first birthday cookies for Liam with bobbers, fish, and Reeling in the big ONE script',
     category: 'birthdays', caption: 'Fishing · "Reeling in the big one"' },
   { src: '/portfolio/birthdays/birthday-cookies-race-cars-speed-limit.jpg',
     alt: 'Race car themed second birthday cookies with checkered flags, tire tread number 2, and Speed Limit 2 sign',
     category: 'birthdays', caption: 'Race cars · "Speed Limit 2"' },
   { src: '/portfolio/birthdays/birthday-cookies-dinosaurs-carter.jpg',
     alt: 'Dinosaur themed third birthday cookies for Carter with T-rex, brontosaurus, dinosaur eggs, and footprints',
     category: 'birthdays', caption: 'Dinosaurs · age 3' },
   { src: '/portfolio/birthdays/birthday-cookies-dinosaurs-bright.jpg',
     alt: 'Bright multi-color dinosaur first birthday cookies in green, blue, and orange with footprints and number 1',
     category: 'birthdays', caption: 'Dinosaurs · bright & bold' },
   { src: '/portfolio/birthdays/birthday-cookies-farm-animals.jpg',
     alt: 'Farm animal first birthday cookies for Giavanna with pig, horse, cow, sheep, and chicken designs',
     category: 'birthdays', caption: 'Farm animals · age 1' },
   { src: '/portfolio/birthdays/birthday-cookies-summer-beach-sun-sunglasses.jpg',
     alt: 'Summer beach themed birthday cookies with smiling sun in sunglasses, ice cream cones, beach balls, and shades',
     category: 'birthdays', caption: 'Summer beach · sun & shades' },
   { src: '/portfolio/birthdays/birthday-cookies-hello-kitty-age-six.jpg',
     alt: 'Hello Kitty themed sixth birthday cookies in red and white with kitty faces, bows, and number 6',
     category: 'birthdays', caption: 'Hello Kitty · age 6' },
   // Holidays — Easter, Valentine's, Halloween, Christmas
   { src: '/portfolio/holidays/easter-cookies-peeps-he-is-risen.jpg',
     alt: 'Easter cookies featuring colorful peeps, decorated eggs, and "He is Risen" cross with floral designs in cellophane gift bags',
     category: 'holidays', caption: 'Easter · peeps & "He is Risen"' },
   { src: '/portfolio/holidays/easter-cookies-bunny-peeps-eggs.jpg',
     alt: 'Easter cookies with pastel bunny, peeps, decorated eggs, and chick designs on a rainbow gingham background',
     category: 'holidays', caption: 'Easter · bunny, peeps & eggs' },
   { src: '/portfolio/holidays/valentines-cookies-conversation-hearts.jpg',
     alt: "Valentine's conversation heart cookies with cutie pie, xoxo, be mine, bestie, love bug, hugs and pink hearts",
     category: 'holidays', caption: "Valentine's · conversation hearts" },
   { src: '/portfolio/holidays/valentines-cookies-romantic-adult-pink-red.jpg',
     alt: "Valentine's Day adult-themed romantic cookies in pink and red with hearts, conversation hearts, lingerie designs, and I LOVE U lettering",
     category: 'holidays', caption: "Valentine's · romantic adult set" },
   { src: '/portfolio/holidays/halloween-cookies-spooky-classic.jpg',
     alt: 'Classic Halloween spooky cookies with ghost, pumpkin, witch hat, RIP coffin, skull, eyeball, spider web, mummy, black cat, bat, and cauldron',
     category: 'holidays', caption: 'Halloween · classic spooky' },
   { src: '/portfolio/holidays/christmas-cookies-classic-santa-tree.jpg',
     alt: 'Classic Christmas cookies featuring Santa, Christmas tree, snowman, snowflake, gingerbread man, ornament, stocking, angel, candy cane, wreath, light bulb, and present',
     category: 'holidays', caption: 'Christmas · classic mix' },
   // Wedding & Bridal
   { src: '/portfolio/wedding/wedding-cookies-gold-monogram.jpg',
     alt: 'Custom hand-decorated wedding cookies in white and gold with monogram, diamond ring, and Mr. & Mrs. designs',
     category: 'wedding', caption: 'Wedding day · gold on white' },
   { src: '/portfolio/wedding/engagement-cookies-blue-and-gold.jpg',
     alt: 'Custom engagement cookies in dusty blue and gold featuring champagne flutes, dress, and floral ring',
     category: 'wedding', caption: 'Engagement · dusty blue & gold' },
   { src: '/portfolio/wedding/bridal-cookies-modern-black-purple.jpg',
     alt: 'Modern alternative bridal shower cookies in black and lavender with til death do us part theme',
     category: 'wedding', caption: 'Alt bridal · "til death do us part"' },
   { src: '/portfolio/wedding/bridal-shower-cookies-pastel-blue-green.jpg',
     alt: 'Pastel bridal shower cookies in soft blue and green with floral monogram and dress designs',
     category: 'wedding', caption: 'Bridal shower · pastel florals' },
   { src: '/portfolio/wedding/bride-to-be-cookies-pink-rose.jpg',
     alt: 'Pink and rose bride-to-be cookies with future Mrs monogram, ring, and elegant dress',
     category: 'wedding', caption: 'Bride-to-be · pink & rose' },
   { src: '/portfolio/wedding/engagement-cookies-emerald-and-gold.jpg',
     alt: 'Emerald green and gold engagement cookies with botanical accents and ring designs',
     category: 'wedding', caption: 'Engagement · emerald & gold' },
   // Baby Shower & Gender Reveal
   { src: '/portfolio/baby-shower/baby-shower-cookies-mickey-pink-gold.jpg',
     alt: 'Pink and gold Mickey Mouse themed baby shower cookies with bottle, bow, and personalized onesie',
     category: 'baby-shower', caption: 'Mickey · pink & gold' },
   { src: '/portfolio/baby-shower/baby-shower-cookies-here-comes-the-sun.jpg',
     alt: 'Yellow and orange Here Comes the Sun baby shower cookies with sun, clouds, and personalized onesies',
     category: 'baby-shower', caption: '"Here comes the sun"' },
   { src: '/portfolio/baby-shower/baby-shower-cookies-mickey-blue-oh-boy.jpg',
     alt: 'Blue Mickey Mouse Oh Boy baby shower cookies with onesie, footprints, and chocolate-dipped pretzel rods',
     category: 'baby-shower', caption: '"Oh boy" · Mickey blue' },
   { src: '/portfolio/baby-shower/baby-shower-cookies-elephant-lavender.jpg',
     alt: 'Lavender elephant baby shower cookies with rice krispies treats and cake pops',
     category: 'baby-shower', caption: 'Elephant · lavender' },
   { src: '/portfolio/baby-shower/baby-shower-cookies-twins-sweet-peas.jpg',
     alt: 'Sweet peas twins baby shower cookies in sage green and pink with two peas in a pod theme',
     category: 'baby-shower', caption: 'Twins · sweet peas' },
   { src: '/portfolio/baby-shower/baby-shower-cookies-winnie-the-pooh.jpg',
     alt: 'Winnie the Pooh themed baby shower cookies with bee, honeypot, and beehive designs',
     category: 'baby-shower', caption: 'Winnie the Pooh' },
   { src: '/portfolio/baby-shower/baby-shower-cookies-nautical-its-a-boy.jpg',
     alt: 'Nautical baby shower cookies in blue and red with anchor, ship wheel, life preserver, and sailor onesie',
     category: 'baby-shower', caption: 'Nautical · "It\'s a boy!"' },
   { src: '/portfolio/baby-shower/gender-reveal-cookies-pink-teal-oh-baby.jpg',
     alt: 'Pink and teal gender reveal cookies with question mark onesies and Oh Baby script',
     category: 'baby-shower', caption: 'Gender reveal · pink or teal' },
   // Faith & Milestones
   { src: '/portfolio/faith/baptism-cookies-white-gold-cross-dove.jpg',
     alt: 'White and gold baptism cookies with crosses, dove, angel, and personalized God Bless name designs',
     category: 'faith', caption: 'Baptism · twins, white & gold' },
   { src: '/portfolio/faith/baptism-cookies-blue-made-new-bible-verse.jpg',
     alt: 'Blue and gold baptism cookies featuring Made New 2 Cor 5:17 verse with cross, dove, and angel',
     category: 'faith', caption: 'Baptism · "Made New" 2 Cor 5:17' },
   { src: '/portfolio/faith/bible-study-cookies-take-what-you-need-crosses.jpg',
     alt: 'Pastel watercolor Bible study cookies with crosses inscribed prayer, faith, grace, courage, love, patience, guidance, strength',
     category: 'faith', caption: 'Bible study · "Take What You Need"' },
   { src: '/portfolio/faith/first-communion-cookies-white-gold-floral.jpg',
     alt: 'White and gold first communion cookies with floral cross, dress, and Isabella personalization',
     category: 'faith', caption: 'First Communion · floral & gold' },
   // Graduation
   { src: '/portfolio/graduation/graduation-cookies-star-wars-themed.jpg',
     alt: 'Star Wars themed graduation cookies with cap, gown, lightsabers, Yoda, Vader, and Stormtrooper',
     category: 'graduation', caption: 'Star Wars graduation' },
   { src: '/portfolio/graduation/graduation-cookies-royal-blue-yellow.jpg',
     alt: 'Royal blue and yellow graduation cookies with cap, gown, diploma, and personalized monogram letters',
     category: 'graduation', caption: 'School colors · blue & yellow' },
   { src: '/portfolio/graduation/graduation-cookies-class-of-2031-paws.jpg',
     alt: 'Blue and gold Class of 2031 graduation cookies with paw print mascot and Congrats Nate and Laney',
     category: 'graduation', caption: 'Class of 2031 · paw print pride' },
   { src: '/portfolio/graduation/graduation-cookies-maroon-personalized.jpg',
     alt: 'Maroon and pink personalized graduation cookies with hearts, cap, gown, and I\'ll Always Love You Papa note',
     category: 'graduation', caption: 'Personalized note · maroon & pink' },
   { src: '/portfolio/graduation/graduation-cookies-class-of-2025-congrats-maggie.jpg',
     alt: 'White and blue Class of 2025 graduation cookies for Maggie with cap, gown, diploma, and Congrats Maggie message',
     category: 'graduation', caption: 'Class of 2025 · "Congrats Maggie"' },
   { src: '/portfolio/graduation/graduation-cookies-bowling-senior-2026.jpg',
     alt: 'Bowling themed Senior 2026 graduation cookies with bowling pins, blue and green bowling balls, and class year designs',
     category: 'graduation', caption: 'Bowling · Senior 2026' },
   // Corporate & Bulk — large orders, gift boxes, employee/client appreciation
   { src: '/portfolio/corporate/corporate-cookies-christmas-gift-boxes-personalized.jpg',
     alt: 'Stacked white corporate Christmas cookie gift boxes with red ribbon bows and personalized "Merry Christmas Jim Mawger" name tags',
     category: 'corporate', caption: 'Christmas gift boxes · personalized' },
   { src: '/portfolio/corporate/corporate-cookies-bulk-individually-wrapped-favors.jpg',
     alt: 'Hundreds of individually packaged single cookie favors with MJ\'s Sweets branded labels for corporate event',
     category: 'corporate', caption: 'Bulk favors · individually wrapped' },
   { src: '/portfolio/corporate/corporate-cookies-bulk-frosted-cookie-cups.jpg',
     alt: 'Large quantity of single-serve frosted cookie cups with MJ\'s Sweets branded lids ready for corporate distribution',
     category: 'corporate', caption: 'Bulk frosted cookie cups' },
   { src: '/portfolio/corporate/corporate-cookies-christmas-bulk-bow-boxes.jpg',
     alt: 'Twenty-four matching white Christmas cookie boxes with red ribbon bows arranged in front of decorated tree',
     category: 'corporate', caption: 'Christmas bulk · 24 box order' },
   { src: '/portfolio/corporate/corporate-cookies-holiday-gift-table-display.jpg',
     alt: 'Holiday gift table display with dozens of white cookie boxes tied with red ribbons in front of decorated Christmas tree',
     category: 'corporate', caption: 'Holiday gift table display' },
   { src: '/portfolio/corporate/corporate-cookies-christmas-variety-boxes-santa-snowman.jpg',
     alt: 'Stacked clear-window Christmas cookie variety boxes featuring Santa, snowman, candy cane, and gingerbread designs',
     category: 'corporate', caption: 'Christmas variety boxes' },
 ];

 // How many photos to show before "Show all" reveals the rest. Keeps the
 // section scrollable in seconds and limits initial bandwidth — important for
 // mobile customers who don't want to scroll through 50+ images to reach the form.
 const PORTFOLIO_INITIAL_COUNT = 9;

 let portfolioActiveFilter = 'all';
 let portfolioShowAll = false;
 let lightboxIndex = 0;
 let lightboxFiltered = [];

 function escapeAttr(s) {
   return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
 }

 function renderPortfolioFilters() {
   const counts = {};
   PORTFOLIO.forEach(p => { counts[p.category] = (counts[p.category] || 0) + 1; });
   const total = PORTFOLIO.length;
   const cats = Object.keys(PORTFOLIO_CATEGORIES);

   const buttons = [
     { key: 'all', label: 'All', emoji: '✨', count: total },
     ...cats.filter(c => counts[c] > 0).map(c => ({
       key: c,
       label: PORTFOLIO_CATEGORIES[c].label,
       emoji: PORTFOLIO_CATEGORIES[c].emoji,
       count: counts[c]
     }))
   ];

   document.getElementById('portfolioFilters').innerHTML = buttons.map(b => `
     <button
       class="portfolio-filter ${portfolioActiveFilter === b.key ? 'active' : ''}"
       role="tab"
       aria-selected="${portfolioActiveFilter === b.key}"
       onclick="setPortfolioFilter('${b.key}')"
     >${b.emoji} ${b.label}<span class="portfolio-filter-count">${b.count}</span></button>
   `).join('');
 }

 function renderPortfolioGrid() {
   const filtered = portfolioActiveFilter === 'all'
     ? PORTFOLIO
     : PORTFOLIO.filter(p => p.category === portfolioActiveFilter);

   const visible = portfolioShowAll ? filtered : filtered.slice(0, PORTFOLIO_INITIAL_COUNT);
   const hiddenCount = filtered.length - visible.length;

   document.getElementById('portfolioGrid').innerHTML = visible.map((p, i) => {
     const dims = IMAGE_DIMS[p.src] || [1200, 1600];
     return `
     <button class="portfolio-tile" onclick="openLightbox(${i})" aria-label="View larger: ${escapeAttr(p.caption)}">
       <picture>
         <source srcset="${toWebP(p.src)}" type="image/webp">
         <img src="${p.src}" alt="${escapeAttr(p.alt)}"
              width="${dims[0]}" height="${dims[1]}" loading="lazy" decoding="async" />
       </picture>
     </button>`;
   }).join('');

   const moreBtn = document.getElementById('portfolioMoreBtn');
   if (hiddenCount > 0) {
     moreBtn.hidden = false;
     moreBtn.textContent = `Show ${hiddenCount} more →`;
   } else {
     moreBtn.hidden = true;
   }
 }

 function showAllPortfolio() {
   portfolioShowAll = true;
   renderPortfolioGrid();
 }

 function setPortfolioFilter(cat) {
   portfolioActiveFilter = cat;
   portfolioShowAll = false; // reset on filter change
   renderPortfolioFilters();
   renderPortfolioGrid();
 }

 function openLightbox(filteredIdx) {
   // Build the navigation set from whatever's currently filtered, so prev/next
   // moves through the visible photos rather than jumping into hidden categories.
   lightboxFiltered = portfolioActiveFilter === 'all'
     ? PORTFOLIO
     : PORTFOLIO.filter(p => p.category === portfolioActiveFilter);
   lightboxIndex = filteredIdx;
   showLightboxPhoto();
   const lb = document.getElementById('lightbox');
   lb.hidden = false;
   document.body.style.overflow = 'hidden';
 }

 function showLightboxPhoto() {
   const photo = lightboxFiltered[lightboxIndex];
   if (!photo) return;
   const src = document.getElementById('lightboxSource');
   const img = document.getElementById('lightboxImg');
   if (src) src.srcset = toWebP(photo.src);
   img.src = photo.src;
   img.alt = photo.alt;
   document.getElementById('lightboxCaption').textContent = photo.caption;
   // Hide prev/next nav when there's only one photo in this set (e.g., tier examples).
   const showNav = lightboxFiltered.length > 1;
   const prev = document.querySelector('.lightbox-prev');
   const next = document.querySelector('.lightbox-next');
   if (prev) prev.style.display = showNav ? '' : 'none';
   if (next) next.style.display = showNav ? '' : 'none';
 }

 // Single-photo lightbox opener used by the tier-picker thumbnails. Stops the
 // click from bubbling up to the wrapping <label>, which would otherwise also
 // toggle the radio button selection.
 function openTierLightbox(e, src, alt, caption) {
   if (e) { e.preventDefault(); e.stopPropagation(); }
   lightboxFiltered = [{ src: src, alt: alt, caption: caption }];
   lightboxIndex = 0;
   showLightboxPhoto();
   const lb = document.getElementById('lightbox');
   lb.hidden = false;
   document.body.style.overflow = 'hidden';
 }

 function lightboxNav(dir) {
   if (lightboxFiltered.length === 0) return;
   lightboxIndex = (lightboxIndex + dir + lightboxFiltered.length) % lightboxFiltered.length;
   showLightboxPhoto();
 }

 function closeLightbox() {
   document.getElementById('lightbox').hidden = true;
   document.body.style.overflow = '';
 }

 // Initial render
 renderPortfolioFilters();
 renderPortfolioGrid();

 // Mobile nav toggle
 function toggleNav() {
   const links = document.getElementById('navLinks');
   const burger = document.getElementById('hamburger');
   const isOpen = links.classList.toggle('open');
   burger.classList.toggle('open', isOpen);
   burger.setAttribute('aria-expanded', String(isOpen));
 }

 // Close the mobile menu after a link tap so users land on the section, not the open menu
 document.querySelectorAll('#navLinks a').forEach(a => {
   a.addEventListener('click', () => {
     document.getElementById('navLinks').classList.remove('open');
     const burger = document.getElementById('hamburger');
     burger.classList.remove('open');
     burger.setAttribute('aria-expanded', 'false');
   });
 });

 // Format the phone field as the user types: 5045596466 → (504) 559-6466.
 // Stripping non-digits first means paste-from-anywhere ((504)555-1234,
 // 504.555.1234, +1 504 555 1234, etc.) all normalize cleanly.
 function formatPhoneInput(e) {
   const input = e.target;
   const digits = input.value.replace(/\D/g, '').slice(0, 10);
   if (digits.length === 0) {
     input.value = '';
   } else if (digits.length <= 3) {
     input.value = `(${digits}`;
   } else if (digits.length <= 6) {
     input.value = `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
   } else {
     input.value = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
   }
 }
 const checkoutPhoneEl = document.getElementById('checkoutPhone');
 if (checkoutPhoneEl) checkoutPhoneEl.addEventListener('input', formatPhoneInput);

 // Keyboard: Esc closes any open overlay; arrow keys navigate the lightbox.
 document.addEventListener('keydown', (e) => {
   const lightbox = document.getElementById('lightbox');
   const lightboxOpen = lightbox && !lightbox.hidden;

   // Lightbox-specific keys take precedence when it's open
   if (lightboxOpen) {
     if (e.key === 'Escape') { closeLightbox(); return; }
     if (e.key === 'ArrowLeft') { lightboxNav(-1); return; }
     if (e.key === 'ArrowRight') { lightboxNav(1); return; }
   }

   if (e.key !== 'Escape') return;
   if (document.getElementById('checkoutModal').classList.contains('open')) closeCheckoutModal();
   else if (document.getElementById('cartDrawer').classList.contains('open')) closeCart();
   else if (document.getElementById('flavorModal').classList.contains('open')) closeFlavorPicker();
   else if (document.getElementById('navLinks').classList.contains('open')) toggleNav();
 });

 // Hero countdown — picks the soonest holiday whose ordering window is open
 // and rewrites the H1 + primary CTA to point at it.
 function setupHeroHeadline() {
   const headline = document.getElementById('heroHeadline');
   const cta = document.getElementById('heroCta');
   if (!headline || !cta) return;

   const openHolidays = products
     .filter(p => p.holidayDate && !p.isCakePop && !p.isYearRound)
     .map(p => ({ p, status: getOrderStatus(p.holidayDate) }))
     .filter(({ status }) => status.canOrder)
     .sort((a, b) => new Date(a.p.holidayDate) - new Date(b.p.holidayDate));

   if (openHolidays.length === 0) return; // Keep evergreen headline as fallback

   const { p } = openHolidays[0];

   // Parse holiday as a *local* date so day-counts don't drift with timezone
   const [y, mo, d] = p.holidayDate.split('-').map(Number);
   const pickupClose = new Date(y, mo - 1, d - 3);
   pickupClose.setHours(0, 0, 0, 0);

   const msPerDay = 24 * 60 * 60 * 1000;
   const daysLeft = Math.round((pickupClose - TODAY) / msPerDay);

   let html;
   if (daysLeft <= 0) {
     html = `Last day to order <em>${p.cookieLabel}!</em>`;
   } else if (daysLeft === 1) {
     html = `1 day left to order <em>${p.cookieLabel}!</em>`;
   } else {
     html = `${daysLeft} days left to order <em>${p.cookieLabel}!</em>`;
   }
   headline.innerHTML = html;

   cta.textContent = 'Order Now →';
   cta.href = `#product-${p.id}`;
   cta.addEventListener('click', () => {
     // Brief spotlight on the target card after the smooth scroll lands
     setTimeout(() => {
       const card = document.getElementById(`product-${p.id}`);
       if (!card) return;
       card.classList.add('is-spotlight');
       setTimeout(() => card.classList.remove('is-spotlight'), 2000);
     }, 600);
   });
 }

 renderProducts();
 setupHeroHeadline();
