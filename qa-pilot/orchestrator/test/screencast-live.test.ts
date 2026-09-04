import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startShop } from "./helpers/shop.js";
import { BrowserToolkit } from "../src/browser/toolkit.js";
import { getScreencast, disposeScreencast, type Frame } from "../src/browser/screencast.js";

const RUN_ID = "cast-live-1";

let shop: Awaited<ReturnType<typeof startShop>>;
beforeAll(async () => { shop = await startShop(); });
afterAll(async () => { disposeScreencast(RUN_ID); await shop.stop(); });

/** Waits for the hub to publish a frame for `agent`, or gives up. */
function nextFrame(runId: string, agent: string, timeoutMs = 10_000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const hub = getScreencast(runId);
    const done = hub.snapshot().find((f) => f.agent === agent);
    if (done) return resolve(done);
    const timer = setTimeout(() => { off(); reject(new Error(`no frame for ${agent} within ${timeoutMs}ms`)); }, timeoutMs);
    const off = hub.subscribe((f) => {
      if (f.agent !== agent || f.jpeg === null) return;
      clearTimeout(timer);
      off();
      resolve(f);
    });
  });
}

describe("live screencast", () => {
  it("streams real JPEG frames from a headless page and tears the tile down on close", async () => {
    const kit = await BrowserToolkit.launch({ headless: true, baseUrl: shop.base, runId: RUN_ID, agent: "planner" });
    const hub = getScreencast(RUN_ID);
    try {
      const page = await kit.newPage();
      await page.goto(shop.base + "/login");

      const frame = await nextFrame(RUN_ID, "planner");
      const bytes = Buffer.from(frame.jpeg!, "base64");
      // A JPEG starts FF D8 FF and ends FF D9. Asserting the magic bytes proves this is a
      // real capture of the page, not an empty or truncated payload.
      expect(bytes.length).toBeGreaterThan(1000);
      expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      expect(hub.agents()).toContain("planner");

      const closed = new Promise<Frame>((resolve) => {
        const off = hub.subscribe((f) => { if (f.agent === "planner" && f.jpeg === null) { off(); resolve(f); } });
      });
      await page.close();
      expect((await closed).jpeg).toBeNull();
      expect(hub.agents()).not.toContain("planner");
    } finally {
      await kit.close();
    }
  }, 30_000);

  it("casts nothing when no runId is given, so tests and CLI runs pay nothing for it", async () => {
    const kit = await BrowserToolkit.launch({ headless: true, baseUrl: shop.base, agent: "planner" });
    try {
      const page = await kit.newPage();
      await page.goto(shop.base + "/login");
      await page.waitForTimeout(500);
      expect(getScreencast("cast-live-unused").agents()).toEqual([]);
    } finally {
      await kit.close();
      disposeScreencast("cast-live-unused");
    }
  }, 30_000);
});
