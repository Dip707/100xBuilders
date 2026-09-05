import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { BrowserToolkit, ELEMENT_TIMEOUT_MS, NAVIGATION_TIMEOUT_MS } from "../src/browser/toolkit.js";

/** A target that takes longer to answer than the element timeout, the way a real site on a
 *  slow link does. Nothing here is broken - it is just slow. */
const DELAY_MS = ELEMENT_TIMEOUT_MS + 2000;
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Slow</title><h1>Slow</h1>"), DELAY_MS);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("browser timeouts", () => {
  it("gives navigation its own budget, so a slow page load does not fail the run", async () => {
    expect(NAVIGATION_TIMEOUT_MS).toBeGreaterThan(ELEMENT_TIMEOUT_MS);
    const kit = await BrowserToolkit.launch({ headless: true, baseUrl: base });
    try {
      const page = await kit.newPage();
      await kit.act(page, { action: "goto", target: "/" });
      expect(await page.locator("h1").innerText()).toBe("Slow");
    } finally {
      await kit.close();
    }
  }, 60_000);

  it("still resolves elements on the short element budget", async () => {
    const kit = await BrowserToolkit.launch({ headless: true, baseUrl: base });
    try {
      const page = await kit.newPage();
      await kit.act(page, { action: "goto", target: "/" });
      // An element that never appears is a verdict, not a hang: it comes back on the short budget.
      const started = Date.now();
      await expect(page.locator("h2").waitFor({ state: "visible" })).rejects.toThrow(/Timeout/);
      expect(Date.now() - started).toBeLessThan(ELEMENT_TIMEOUT_MS * 2);
    } finally {
      await kit.close();
    }
  }, 60_000);
});
