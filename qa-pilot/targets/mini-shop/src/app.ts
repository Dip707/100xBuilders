import express from "express";
import cookieParser from "cookie-parser";
import { chaos, setChaos } from "./chaos.js";
import { products, users, sessions, orders, newSessionId, cartTotal, type Session } from "./store.js";
import * as v from "./views.js";

export function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(cookieParser());

  const getSession = (req: express.Request): Session | null => {
    const sid = req.cookies?.sid as string | undefined;
    return sid ? sessions.get(sid) ?? null : null;
  };
  const requireLogin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (getSession(req)) return next();
    res.redirect(`/login?next=${encodeURIComponent(req.path)}`);
  };
  const userOf = (req: express.Request) => getSession(req)?.email ?? null;

  app.get("/", (req, res) => res.send(v.layout("Home", v.homeView(), userOf(req))));

  app.get("/login", (req, res) => res.send(v.layout("Log in", v.loginView(null, String(req.query.next ?? "/products")), userOf(req))));
  app.post("/login", (req, res) => {
    const { email, password, next } = req.body as Record<string, string>;
    const u = users.find((x) => x.email === email && x.password === password);
    if (!u) return res.status(401).send(v.layout("Log in", v.loginView("Invalid email or password", next || "/"), null));
    const sid = newSessionId();
    sessions.set(sid, { email: u.email, cart: {}, coupon: null });
    res.cookie("sid", sid, { httpOnly: true });
    res.redirect(next && next.startsWith("/") ? next : "/products");
  });
  app.get("/logout", (req, res) => {
    const sid = req.cookies?.sid as string | undefined;
    if (sid) sessions.delete(sid);
    res.clearCookie("sid");
    res.redirect("/");
  });

  app.get("/register", (req, res) => res.send(v.layout("Register", v.registerView(null), userOf(req))));
  app.post("/register", (req, res) => {
    const { name, email, password } = req.body as Record<string, string>;
    if (!name || !email || !password) return res.status(400).send(v.layout("Register", v.registerView("All fields are required"), null));
    if (password.length < 8) return res.status(400).send(v.layout("Register", v.registerView("Password must be at least 8 characters"), null));
    if (users.some((u) => u.email === email)) return res.status(409).send(v.layout("Register", v.registerView("An account with this email already exists"), null));
    users.push({ name, email, password });
    res.redirect("/login");
  });

  app.get("/products", (req, res) => res.send(v.layout("Products", v.productsView(products), userOf(req))));
  app.get("/products/:id", (req, res) => {
    const p = products.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).send(v.layout("Not found", "<h1>Product not found</h1>", userOf(req)));
    res.send(v.layout(p.name, v.productView(p, req.query.added === "1"), userOf(req)));
  });
  app.post("/cart/add", requireLogin, (req, res) => {
    const s = getSession(req)!;
    const { id, qty } = req.body as Record<string, string>;
    const n = Math.max(1, Math.min(10, Number(qty) || 1));
    if (!products.some((p) => p.id === id)) return res.status(400).send("bad product");
    s.cart[id] = (s.cart[id] ?? 0) + n;
    res.redirect(`/products/${id}?added=1`);
  });
  app.get("/cart", (req, res) => {
    const s = getSession(req);
    res.send(v.layout("Cart", v.cartView(s, products, s ? cartTotal(s) : 0), userOf(req)));
  });

  app.get("/checkout", requireLogin, (req, res) => {
    const s = getSession(req)!;
    res.send(v.layout("Checkout", v.checkoutView(cartTotal(s), null, null), userOf(req)));
  });
  app.post("/api/coupon", requireLogin, (req, res) => {
    if (chaos.breakCoupon) return res.status(500).json({ error: "internal error" });
    const s = getSession(req)!;
    const code = String((req.body as { code?: string }).code ?? "").trim().toUpperCase();
    if (code !== "SAVE10") return res.status(400).json({ error: "invalid coupon" });
    s.coupon = code;
    res.json({ ok: true, total: cartTotal(s) });
  });
  app.post("/checkout", requireLogin, (req, res) => {
    const s = getSession(req)!;
    const { name, address, card } = req.body as Record<string, string>;
    if (!name || !address || !card) return res.status(400).send(v.layout("Checkout", v.checkoutView(cartTotal(s), null, "All fields are required"), userOf(req)));
    if (!/^[0-9]{16}$/.test(card)) return res.status(400).send(v.layout("Checkout", v.checkoutView(cartTotal(s), null, "Card number must be 16 digits"), userOf(req)));
    if (Object.keys(s.cart).length === 0) return res.status(400).send(v.layout("Checkout", v.checkoutView(0, null, "Your cart is empty"), userOf(req)));
    const order = { id: `ORD-${orders.length + 1}`, email: s.email, total: cartTotal(s), items: Object.entries(s.cart).map(([id, qty]) => ({ id, qty })) };
    orders.push(order);
    s.cart = {};
    s.coupon = null;
    res.send(v.layout("Order confirmed", v.orderDoneView(order), userOf(req)));
  });

  app.get("/orders", requireLogin, (req, res) => {
    const s = getSession(req)!;
    res.send(v.layout("Orders", v.ordersView(orders.filter((o) => o.email === s.email)), userOf(req)));
  });
  app.get("/account", requireLogin, (req, res) => {
    const s = getSession(req)!;
    const u = users.find((x) => x.email === s.email)!;
    res.send(v.layout("Account", v.accountView(u.name, u.email), userOf(req)));
  });

  app.get("/__chaos", (_req, res) => res.json(chaos));
  app.post("/__chaos", (req, res) => res.json(setChaos(req.body ?? {})));

  return app;
}
