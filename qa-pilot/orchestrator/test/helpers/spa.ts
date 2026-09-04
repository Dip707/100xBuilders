import { createServer, type Server } from "node:http";

/**
 * A single-page app the way the crawler is most likely to meet one: every path serves the
 * same shell, the navigation is rendered by JavaScript after load, one route is reached by a
 * button that calls pushState, and one uses a hash route. Nothing here is an <a href> at
 * the moment the HTML arrives.
 */
const SHELL = `<!doctype html><html><head><title>SPA</title></head><body>
<div id="app">Loading…</div>
<script>
function render() {
  var path = location.pathname + (location.hash.startsWith('#/') ? location.hash : '');
  var app = document.getElementById('app');
  var title = { '/': 'Home', '/about': 'About', '/contact': 'Contact', '/#/faq': 'FAQ' }[path] || 'Not found';
  app.innerHTML = '<nav><a href="/">Home</a><button id="about">About</button><a href="/contact">Contact</a><a href="#/faq">FAQ</a><button id="reset">Clear data</button></nav>' +
    '<h1>' + title + '</h1>' + (path === '/contact' ? '<form><label>Message <textarea name="m"></textarea></label><button type="submit">Send</button></form>' : '');
  document.getElementById('about').onclick = function () { history.pushState({}, '', '/about'); render(); };
  document.getElementById('reset').onclick = function () { fetch('/__destroy', { method: 'POST' }); };
}
window.addEventListener('popstate', render);
window.addEventListener('hashchange', render);
setTimeout(render, 150);
</script></body></html>`;

export async function startSpa(): Promise<{ base: string; stop: () => Promise<void>; destroyed: () => number }> {
  let destroyed = 0;
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/__destroy") {
      destroyed++;
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(SHELL);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((r) => server.close(() => r())), destroyed: () => destroyed };
}
