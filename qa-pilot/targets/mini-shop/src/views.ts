import { chaos } from "./chaos.js";
import type { Product, Session, Order } from "./store.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function layout(title: string, body: string, user: string | null): string {
  const accent = chaos.cosmeticChange ? "#0a7" : "#25f";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} - Mini Shop</title>
<style>body{font-family:system-ui;margin:2rem;max-width:720px}nav a{margin-right:1rem}button{background:${accent};color:#fff;border:0;padding:.5rem 1rem;border-radius:4px}
[role=alert]{background:#fee;color:#900;padding:.5rem;border:1px solid #c66}.ok{background:#efe;color:#060;padding:.5rem;border:1px solid #6c6}label{display:block;margin:.5rem 0}</style></head>
<body><nav><a href="/">Home</a><a href="/products">Products</a><a href="/cart">Cart</a><a href="/checkout">Checkout</a><a href="/orders">Orders</a><a href="/account">Account</a>
${user ? `<span>Signed in as ${esc(user)}</span> <a href="/logout">Log out</a>` : `<a href="/login">Log in</a> <a href="/register">Register</a>`}</nav>
<main>${body}</main></body></html>`;
}

export const homeView = () => `<h1>Welcome to Mini Shop</h1><p>Browse our <a href="/products">products</a>.</p>`;

export const loginView = (error: string | null, next: string) => `<h1>Log in</h1>
${error ? `<div role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(next)}">
<label>Email <input type="email" name="email" required></label>
<label>Password <input type="password" name="password" required></label>
<button type="submit">Sign in</button></form>`;

export const registerView = (error: string | null) => `<h1>Register</h1>
${error ? `<div role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/register">
<label>Name <input type="text" name="name" required></label>
<label>Email <input type="email" name="email" required></label>
<label>Password <input type="password" name="password" required minlength="8"></label>
<button type="submit">Create account</button></form>`;

export const productsView = (products: Product[]) => `<h1>Products</h1><ul>${products
  .map((p) => `<li><a href="/products/${p.id}">${esc(p.name)}</a> - $${p.price}</li>`).join("")}</ul>`;

export const productView = (p: Product, added: boolean) => `<h1>${esc(p.name)}</h1><p>${esc(p.description)}</p><p>Price: $${p.price}</p>
${added ? `<div class="ok" role="status">Added to cart</div>` : ""}
<form method="post" action="/cart/add"><input type="hidden" name="id" value="${p.id}">
<label>Quantity <input type="number" name="qty" value="1" min="1" max="10"></label>
<button type="submit">Add to cart</button></form>`;

export const cartView = (s: Session | null, products: Product[], total: number) => {
  const items = s ? Object.entries(s.cart) : [];
  if (items.length === 0) return `<h1>Your cart</h1><p>Your cart is empty.</p>`;
  return `<h1>Your cart</h1><table><tr><th>Item</th><th>Qty</th></tr>${items
    .map(([id, qty]) => `<tr><td>${esc(products.find((p) => p.id === id)!.name)}</td><td>${qty}</td></tr>`).join("")}</table>
<p>Total: $${total}</p><a href="/checkout">Proceed to checkout</a>`;
};

export const checkoutView = (total: number, couponMsg: { ok: boolean; text: string } | null, error: string | null) => `<h1>Checkout</h1>
${error ? `<div role="alert">${esc(error)}</div>` : ""}
<section><h2>Coupon</h2>
<form id="coupon-form"><label>Coupon code <input type="text" name="code"></label><button type="submit">Apply coupon</button></form>
<div id="coupon-msg">${couponMsg ? (couponMsg.ok ? `<div class="ok" role="status">${esc(couponMsg.text)}</div>` : `<div role="alert">${esc(couponMsg.text)}</div>`) : ""}</div>
</section>
<p>Total: $<span id="total">${total}</span></p>
<form method="post" action="/checkout">
<label>Full name <input type="text" name="name" required></label>
<label>Address <input type="text" name="address" required></label>
<label>Card number <input type="text" name="card" required pattern="[0-9]{16}"></label>
<button type="submit">${chaos.renameCheckoutButton ? "Complete purchase" : "Place order"}</button></form>
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

export const orderDoneView = (o: Order) => `<h1>Order confirmed</h1><div class="ok" role="status">Thank you! Order ${esc(o.id)} placed. Total $${o.total}.</div><a href="/orders">View orders</a>`;
export const ordersView = (list: Order[]) => `<h1>Your orders</h1>${list.length === 0 ? "<p>No orders yet.</p>" : `<ul>${list.map((o) => `<li>${esc(o.id)} - $${o.total}</li>`).join("")}</ul>`}`;
export const accountView = (name: string, email: string) => `<h1>Account</h1><p>Name: ${esc(name)}</p><p>Email: ${esc(email)}</p>`;
