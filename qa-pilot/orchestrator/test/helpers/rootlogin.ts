import { createServer, type Server } from "node:http";

/**
 * An app whose landing page *is* its login page, with nothing linking to a login route.
 *
 * This is the shape saucedemo.com has, and it is what most internal tools and admin panels
 * look like. It is deliberately not mini-shop: mini-shop's home page carries a "/login"
 * link, which is the only reason the crawler's link-scanning login discovery ever worked.
 */
const LOGIN = `<!doctype html><html><head><title>Root Login</title></head><body>
<h1>Sign in</h1>
<form method="POST" action="/">
  <label>Username <input name="username" type="text"></label>
  <label>Password <input name="password" type="password"></label>
  <button type="submit">Login</button>
</form>
</body></html>`;

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>
<nav><a href="/inventory">Inventory</a><a href="/cart">Cart</a><a href="/account">Account</a></nav>
<h1>${title}</h1>${body}</body></html>`;

export async function startRootLogin(): Promise<{ base: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const authed = (req.headers.cookie ?? "").includes("session=yes");

    if (req.method === "POST" && url.pathname === "/") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const ok = body.includes("username=demo") && body.includes("password=secret");
        if (!ok) {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(LOGIN.replace("<h1>Sign in</h1>", "<h1>Sign in</h1><p role=alert>Wrong credentials</p>"));
          return;
        }
        res.writeHead(302, { "set-cookie": "session=yes; Path=/", location: "/inventory" }).end();
      });
      return;
    }

    // Every real route is behind the session; unauthenticated visits bounce to "/".
    if (url.pathname !== "/") {
      if (!authed) {
        res.writeHead(302, { location: "/" }).end();
        return;
      }
      const title = url.pathname.slice(1);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(title[0].toUpperCase() + title.slice(1), url.pathname === "/cart" ? "<form><label>Coupon <input name=c></label><button type=submit>Apply</button></form>" : ""));
      return;
    }

    // "/" is the login page when signed out, and the inventory once signed in.
    res.writeHead(200, { "content-type": "text/html" });
    res.end(authed ? page("Home", "") : LOGIN);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((r) => server.close(() => r())) };
}
