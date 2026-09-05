import { createServer, type Server } from "node:http";

/**
 * An app shaped the way a login-walled demo app usually is, and the way the crawler used to
 * fail on: the login form is the landing page itself (there is no "Log in" link to find), the
 * pages behind it are reached only by JavaScript click handlers on anchors with no usable href
 * and on submit-styled buttons that sit outside any form, and a gated route answers an
 * anonymous visitor by rendering the login screen at the same URL instead of redirecting.
 *
 * Everything worth testing here lives behind that wall, so a crawler that stops at the login
 * page sees one page and one use case.
 */

const LOGIN_BODY = (message: string) => `<h1>Kiosk</h1>${message ? `<p role="alert">${message}</p>` : ""}
<form method="POST" action="/session">
  <label>Username <input name="user" required></label>
  <label>Password <input name="pass" type="password" required></label>
  <button type="submit">Login</button>
</form>`;

/** Chrome every signed-in page carries: a cart anchor with no href at all, and a menu button. */
const CHROME = `<div class="chrome">
  <button id="menu" type="button">Open Menu</button>
  <a data-test="cart-link" class="cart"></a>
  <a id="logout" href="#">Logout</a>
</div>
<script>
  document.querySelector('.cart').onclick = function () { location.href = '/basket.html'; };
  document.getElementById('menu').onclick = function () { document.body.classList.toggle('menu-open'); };
  document.getElementById('logout').onclick = function () { document.cookie = 'kiosk=; Max-Age=0; path=/'; location.href = '/'; };
</script>`;

const PAGES: Record<string, string> = {
  "/catalog.html": `<h1>Catalog</h1>${CHROME}
    <ul>
      <li><a href="#" data-test="item-1-link">Widget</a> <button type="submit" id="add-1">Add to cart</button></li>
      <li><a href="#" data-test="item-2-link">Gadget</a> <button type="submit" id="add-2">Add to cart</button></li>
    </ul>
    <script>
      document.querySelectorAll('[data-test^=item-]').forEach(function (a, i) {
        a.onclick = function (e) { e.preventDefault(); location.href = '/item.html?id=' + (i + 1); };
      });
    </script>`,
  "/basket.html": `<h1>Your basket</h1>${CHROME}
    <button type="submit" id="continue-shopping">Continue Shopping</button>
    <button type="submit" id="checkout">Checkout</button>
    <script>
      document.getElementById('checkout').onclick = function () { location.href = '/pay.html'; };
      document.getElementById('continue-shopping').onclick = function () { location.href = '/catalog.html'; };
    </script>`,
  "/item.html": `<h1>Item</h1>${CHROME}<button type="submit" id="back">Back to products</button>
    <script>document.getElementById('back').onclick = function () { location.href = '/catalog.html'; };</script>`,
  "/pay.html": `<h1>Payment</h1>${CHROME}
    <form method="POST" action="/pay">
      <label>Card <input name="card" required></label>
      <label>Zip <input name="zip" required></label>
      <button type="submit">Place order</button>
      <button type="submit" name="cancel">Cancel</button>
    </form>`,
};

/** The cart anchor carries no text: like the real thing, only CSS gives it a size and a glyph. */
const STYLE = `<style>.cart { display: inline-block; width: 32px; height: 32px; background: #333; }</style>`;

const html = (body: string) => `<!doctype html><html><head><title>Kiosk</title>${STYLE}</head><body>${body}</body></html>`;

export async function startKiosk(): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://kiosk");
    const signedIn = (req.headers.cookie ?? "").includes("kiosk=in");

    if (req.method === "POST" && url.pathname === "/session") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        if (form.get("user") === "shopper" && form.get("pass") === "hunter2") {
          res.writeHead(302, { location: "/catalog.html", "set-cookie": "kiosk=in; path=/" }).end();
        } else {
          res.writeHead(200, { "content-type": "text/html" }).end(html(LOGIN_BODY("Those credentials did not work.")));
        }
      });
      return;
    }

    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" }).end(html(LOGIN_BODY("")));
      return;
    }

    const page = PAGES[url.pathname];
    if (!page) {
      res.writeHead(404, { "content-type": "text/html" }).end(html("<h1>Not found</h1>"));
      return;
    }
    // A gated route answers an anonymous visitor in place: same URL, login screen. No redirect,
    // so a crawler that only watches for one never marks these routes gated.
    if (!signedIn) {
      res.writeHead(200, { "content-type": "text/html" }).end(html(LOGIN_BODY(`You can only access '${url.pathname}' when you are logged in.`)));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(html(page));
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((r) => server.close(() => r())) };
}
