import { chaos } from "./chaos.js";
import type { Product, Session, Order } from "./store.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------- Product art: a deterministic gradient blob + flat icon, no image files or network requests ----------
function hueOf(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 360;
}
function iconFor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("mug") || n.includes("cup")) return "☕";
  if (n.includes("notebook") || n.includes("book")) return "📓";
  if (n.includes("lamp") || n.includes("light")) return "💡";
  return "🛍️";
}
const productArt = (p: Product) => {
  const h = hueOf(p.id);
  return `<div class="product-art" style="background:linear-gradient(135deg, hsl(${h} 90% 93%), hsl(${(h + 45) % 360} 85% 86%))" aria-hidden="true"><span class="product-icon">${iconFor(p.name)}</span></div>`;
};

export function layout(title: string, body: string, user: string | null): string {
  const accent = chaos.cosmeticChange ? "#0EA672" : "#4F46E5";
  const favicon = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='${accent}'/><text x='16' y='22' font-size='17' text-anchor='middle' fill='white' font-family='sans-serif' font-weight='bold'>M</text></svg>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Mini Shop</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(favicon)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --accent:${accent}; --accent-ink:#fff;
  --bg:#FAFAF9; --surface:#FFFFFF; --ink:#171717; --muted:#6B7280; --border:#E7E5E4;
  --warn-bg:#FEF2F2; --warn-border:#FCA5A5; --warn-ink:#991B1B;
  --ok-bg:#F0FDF4; --ok-border:#86EFAC; --ok-ink:#166534;
  --radius:14px;
  --shadow:0 1px 2px rgba(23,23,23,.04), 0 8px 24px -12px rgba(23,23,23,.12);
}
*{box-sizing:border-box}
body{margin:0;font-family:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink);line-height:1.5}
a{color:inherit;text-decoration:none}
h1,h2,h3{font-weight:800;letter-spacing:-.02em;margin:0 0 .4rem}
.page{max-width:960px;margin:0 auto;padding:0 1.5rem 4rem}
header.site{position:sticky;top:0;z-index:10;background:rgba(250,250,249,.85);backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
.site-inner{max-width:960px;margin:0 auto;display:flex;flex-wrap:nowrap;align-items:center;gap:1.25rem;padding:1rem 1.5rem;overflow-x:auto}
.brand{display:flex;align-items:center;gap:.5rem;font-weight:800;font-size:1.05rem;margin-right:auto;white-space:nowrap;flex-shrink:0}
.brand-mark{width:28px;height:28px;border-radius:8px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0}
nav.site-nav{display:flex;gap:.25rem;align-items:center;flex-shrink:0}
nav.site-nav a{padding:.5rem .8rem;border-radius:999px;font-size:.9rem;font-weight:600;color:var(--muted);white-space:nowrap}
nav.site-nav a:hover{background:var(--surface);color:var(--ink)}
.auth-area{display:flex;align-items:center;gap:.6rem;font-size:.85rem;color:var(--muted);white-space:nowrap;flex-shrink:0}
.auth-area a{font-weight:700;color:var(--accent);white-space:nowrap}
.user-chip{background:var(--surface);border:1px solid var(--border);padding:.3rem .7rem;border-radius:999px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:middle}
button,.btn{font-family:inherit;font-weight:700;font-size:.92rem;border:0;border-radius:999px;padding:.7rem 1.4rem;cursor:pointer;background:var(--accent);color:var(--accent-ink);box-shadow:var(--shadow);display:inline-block}
button:hover,.btn:hover{filter:brightness(1.05)}
.btn-secondary{background:var(--surface);color:var(--ink);border:1px solid var(--border);box-shadow:none}
[role=alert]{background:var(--warn-bg);border:1px solid var(--warn-border);color:var(--warn-ink);padding:.8rem 1rem;border-radius:var(--radius);margin:0 0 1rem;font-size:.9rem}
[role=status]{background:var(--ok-bg);border:1px solid var(--ok-border);color:var(--ok-ink);padding:.8rem 1rem;border-radius:var(--radius);margin:0 0 1rem;font-size:.9rem}
label{display:block;margin:0 0 .9rem;font-size:.85rem;font-weight:600;color:var(--muted)}
label input{display:block;width:100%;margin-top:.35rem;padding:.65rem .8rem;border:1px solid var(--border);border-radius:10px;font-size:.95rem;font-family:inherit;background:var(--surface);color:var(--ink)}
label input:focus{outline:2px solid var(--accent);outline-offset:1px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:1.5rem}
.hero{border-radius:20px;padding:3rem 2rem;margin:2rem 0 2.5rem;text-align:center;border:1px solid var(--border);
  background:radial-gradient(circle at 20% 20%, hsl(243 90% 95%), transparent 60%),radial-gradient(circle at 80% 0%, hsl(28 95% 92%), transparent 55%),var(--surface)}
.hero h1{font-size:2.2rem;margin-bottom:.6rem}
.hero p{color:var(--muted);max-width:34rem;margin:0 auto 1.5rem;font-size:1.02rem}
.feature-row{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-top:2.5rem}
.feature-row .card{text-align:center;padding:1.2rem}
.feature-icon{font-size:1.4rem;margin-bottom:.4rem}
.page-header{margin:2rem 0 1rem}
.page-sub{color:var(--muted);margin:0}
.chip-row{display:flex;gap:.5rem;margin-bottom:1.5rem;flex-wrap:wrap}
.chip{padding:.4rem .9rem;border-radius:999px;background:var(--surface);border:1px solid var(--border);font-size:.82rem;font-weight:600;color:var(--muted)}
.chip-active{background:var(--ink);color:#fff;border-color:var(--ink)}
.product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1.25rem}
.product-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow);transition:transform .15s ease,box-shadow .15s ease;position:relative}
.product-card:hover{transform:translateY(-3px);box-shadow:0 20px 30px -18px rgba(23,23,23,.25)}
.product-art{height:120px;display:flex;align-items:center;justify-content:center}
.product-icon{font-size:2.4rem}
.badge{position:absolute;top:.6rem;left:.6rem;background:var(--ink);color:#fff;font-size:.7rem;font-weight:700;padding:.25rem .55rem;border-radius:999px;z-index:1}
.product-body{padding:1rem}
.product-name{font-weight:700;font-size:1rem;display:inline-block;margin-bottom:.25rem}
.product-name:hover{text-decoration:underline}
/* Stretched-link: the whole card becomes a click target for the SAME <a>, so accessible name/role stay
   exactly "link, <product name>" for locators, while visually the entire card invites the click. */
.product-name::after{content:"";position:absolute;inset:0}
.product-desc{color:var(--muted);font-size:.85rem;margin:0 0 .8rem;min-height:2.5em}
.product-footer{display:flex;align-items:center;justify-content:space-between}
.price{font-weight:800}
.stars{color:#F59E0B;font-size:.8rem;letter-spacing:1px}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:2.5rem;align-items:start;margin-top:2rem}
.detail-grid .product-art{height:280px;border-radius:var(--radius)}
.detail-grid .product-icon{font-size:5rem}
table{width:100%;border-collapse:collapse;margin:1.5rem 0}
th,td{text-align:left;padding:.75rem .5rem;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
.summary-row{display:flex;justify-content:space-between;padding:.4rem 0;font-size:.95rem}
.summary-total{font-weight:800;font-size:1.15rem;border-top:1px solid var(--border);margin-top:.5rem;padding-top:.8rem}
.empty-state{text-align:center;padding:3rem 1rem;color:var(--muted)}
.empty-state .empty-icon{font-size:2.4rem;display:block;margin-bottom:.6rem}
.auth-wrap{display:flex;justify-content:center;padding-top:2.5rem}
.auth-card{max-width:380px;width:100%}
footer.site-footer{text-align:center;color:var(--muted);font-size:.8rem;padding:2.5rem 0 1rem}
@media (max-width:680px){.detail-grid,.feature-row{grid-template-columns:1fr}}
</style></head>
<body>
<header class="site"><div class="site-inner">
<a class="brand" href="/"><span class="brand-mark">M</span>Mini Shop</a>
<nav class="site-nav"><a href="/">Home</a><a href="/products">Products</a><a href="/cart">Cart</a><a href="/checkout">Checkout</a><a href="/orders">Orders</a><a href="/account">Account</a></nav>
<div class="auth-area">${user ? `<span class="user-chip" title="${esc(user)}">${esc(user)}</span><a href="/logout">Log out</a>` : `<a href="/login">Log in</a><a href="/register">Register</a>`}</div>
</div></header>
<main class="page">${body}</main>
<footer class="site-footer">Mini Shop &middot; a demo storefront for autonomous QA</footer>
</body></html>`;
}

export const homeView = () => `
<section class="hero">
<h1>Everyday things, thoughtfully made.</h1>
<p>A small batch of desk and home essentials &mdash; quick checkout, honest pricing, and easy returns.</p>
<a class="btn" href="/products">Shop the collection</a>
</section>
<div class="feature-row">
<div class="card"><div class="feature-icon">🚚</div><strong>Fast shipping</strong><div class="page-sub">Out the door in 24h</div></div>
<div class="card"><div class="feature-icon">🔒</div><strong>Secure checkout</strong><div class="page-sub">Encrypted end to end</div></div>
<div class="card"><div class="feature-icon">↩️</div><strong>Easy returns</strong><div class="page-sub">30-day, no questions</div></div>
</div>`;

export const loginView = (error: string | null, next: string) => `
<div class="auth-wrap"><div class="card auth-card">
<h1>Welcome back</h1><p class="page-sub" style="margin-bottom:1.2rem">Sign in to continue to your cart and orders.</p>
${error ? `<div role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(next)}">
<label>Email <input type="email" name="email" required></label>
<label>Password <input type="password" name="password" required></label>
<button type="submit" style="width:100%">Sign in</button></form>
<p class="page-sub" style="margin-top:1rem;text-align:center">No account? <a href="/register" style="color:var(--accent);font-weight:700">Create one</a></p>
</div></div>`;

export const registerView = (error: string | null) => `
<div class="auth-wrap"><div class="card auth-card">
<h1>Create your account</h1><p class="page-sub" style="margin-bottom:1.2rem">Takes less than a minute.</p>
${error ? `<div role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/register">
<label>Name <input type="text" name="name" required></label>
<label>Email <input type="email" name="email" required></label>
<label>Password <input type="password" name="password" required minlength="8"></label>
<button type="submit" style="width:100%">Create account</button></form>
</div></div>`;

export const productsView = (products: Product[]) => `
<div class="page-header"><h1>Products</h1><p class="page-sub">Handpicked essentials, ready to ship today.</p></div>
<div class="chip-row"><span class="chip chip-active">All</span><span class="chip">New</span><span class="chip">Best sellers</span></div>
<div class="product-grid">${products
  .map(
    (p, i) => `<article class="product-card">
${productArt(p)}${i === 0 ? `<span class="badge">New</span>` : ""}
<div class="product-body">
<a href="/products/${p.id}" class="product-name">${esc(p.name)}</a>
<p class="product-desc">${esc(p.description)}</p>
<div class="product-footer"><span class="price">$${p.price}</span><span class="stars" aria-hidden="true">★★★★★</span></div>
</div></article>`,
  )
  .join("")}</div>`;

export const productView = (p: Product, added: boolean) => `
<div class="detail-grid">
${productArt(p)}
<div>
<h1>${esc(p.name)}</h1>
<div class="stars" aria-hidden="true">★★★★★</div>
<p class="page-sub">${esc(p.description)}</p>
<p class="price" style="font-size:1.4rem">$${p.price}</p>
${added ? `<div class="ok" role="status">Added to cart</div>` : ""}
<form method="post" action="/cart/add"><input type="hidden" name="id" value="${p.id}">
<label>Quantity <input type="number" name="qty" value="1" min="1" max="10"></label>
<button type="submit">Add to cart</button></form>
</div></div>`;

export const cartView = (s: Session | null, products: Product[], total: number) => {
  const items = s ? Object.entries(s.cart) : [];
  if (items.length === 0)
    return `<div class="page-header"><h1>Your cart</h1></div>
<div class="empty-state"><span class="empty-icon">🛒</span>Your cart is empty.<br>
<a class="btn" style="display:inline-block;margin-top:1rem" href="/products">Browse products</a></div>`;
  return `<div class="page-header"><h1>Your cart</h1></div>
<table><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody>${items
    .map(([id, qty]) => `<tr><td>${esc(products.find((p) => p.id === id)!.name)}</td><td>${qty}</td></tr>`)
    .join("")}</tbody></table>
<div class="card"><div class="summary-row summary-total"><span>Total</span><span>$${total}</span></div></div>
<p style="margin-top:1.2rem"><a class="btn" href="/checkout">Proceed to checkout</a></p>`;
};

export const checkoutView = (total: number, couponMsg: { ok: boolean; text: string } | null, error: string | null) => `
<div class="page-header"><h1>Checkout</h1></div>
${error ? `<div role="alert">${esc(error)}</div>` : ""}
<div class="detail-grid" style="grid-template-columns:1.4fr 1fr">
<div class="card">
<form method="post" action="/checkout">
<label>Full name <input type="text" name="name" required></label>
<label>Address <input type="text" name="address" required></label>
<label>Card number <input type="text" name="card" required pattern="[0-9]{16}"></label>
<button type="submit" style="width:100%">${chaos.renameCheckoutButton ? "Complete purchase" : "Place order"}</button>
</form></div>
<div class="card">
<h3>Order summary</h3>
<div class="summary-row"><span>Subtotal</span><span>$${total}</span></div>
<form id="coupon-form" style="display:flex;gap:.5rem;align-items:flex-end;margin:1rem 0 0">
<label style="flex:1;margin:0">Coupon code <input type="text" name="code" style="margin-top:.35rem"></label>
<button type="submit" class="btn-secondary" style="padding:.65rem 1.1rem">Apply coupon</button>
</form>
<div id="coupon-msg">${couponMsg ? (couponMsg.ok ? `<div class="ok" role="status">${esc(couponMsg.text)}</div>` : `<div role="alert">${esc(couponMsg.text)}</div>`) : ""}</div>
<div class="summary-row summary-total"><span>Total</span><span>$<span id="total">${total}</span></span></div>
</div></div>
<script>
document.getElementById('coupon-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = new FormData(e.target).get('code');
  const res = await fetch('/api/coupon', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({code})});
  const box = document.getElementById('coupon-msg');
  if (res.ok) { const j = await res.json(); box.innerHTML = '<div class="ok" role="status">Coupon applied</div>'; document.getElementById('total').textContent = j.total; }
  else if (res.status === 400) { box.innerHTML = '<div role="alert">Invalid coupon code</div>'; }
  else { box.innerHTML = '<div role="alert">Something went wrong</div>'; }
});
</script>`;

export const orderDoneView = (o: Order) => `
<div class="page-header"><h1>Order confirmed</h1></div>
<div role="status" class="card" style="max-width:420px">
<span style="font-size:1.6rem">🎉</span>
<p style="margin:.6rem 0 0">Thank you! Order ${esc(o.id)} placed. Total $${o.total}.</p>
</div>
<p style="margin-top:1.2rem"><a class="btn" href="/orders">View orders</a></p>`;

export const ordersView = (list: Order[]) => `
<div class="page-header"><h1>Your orders</h1></div>
${
  list.length === 0
    ? `<div class="empty-state"><span class="empty-icon">📦</span>No orders yet.</div>`
    : `<div class="product-grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">${list
        .map((o) => `<div class="card"><strong>${esc(o.id)}</strong><div class="page-sub">$${o.total}</div></div>`)
        .join("")}</div>`
}`;

export const accountView = (name: string, email: string) => `
<div class="page-header"><h1>Account</h1></div>
<div class="card" style="max-width:420px">
<p><strong>Name:</strong> ${esc(name)}</p>
<p><strong>Email:</strong> ${esc(email)}</p>
</div>`;
