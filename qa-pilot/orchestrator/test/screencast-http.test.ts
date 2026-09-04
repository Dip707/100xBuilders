import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { startShop } from "./helpers/shop.js";
import { createApi } from "../src/api.js";
import { BrowserToolkit } from "../src/browser/toolkit.js";
import { disposeScreencast } from "../src/browser/screencast.js";
import { memoryStore } from "../src/store/memory.js";
import { hashToken, mintToken, SESSION_COOKIE, SESSION_TTL_MS } from "../src/auth/session.js";
import { clearSessionCache } from "../src/auth/middleware.js";
import type { Store } from "../src/store/types.js";

const RUN_ID = "cast-http-1";

let shop: Awaited<ReturnType<typeof startShop>>;
let server: Server;
let base: string;
let cookie: string;
let store: Store;

beforeAll(async () => {
  process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-cast-http-")) + "/";
  clearSessionCache();
  shop = await startShop();
  store = memoryStore();
  const user = await store.createUser("cast@example.test", "unused");
  const token = mintToken();
  await store.createSession(hashToken(token), user.id, new Date(Date.now() + SESSION_TTL_MS));
  cookie = `${SESSION_COOKIE}=${token}`;
  await store.insertRun({ id: RUN_ID, userId: user.id, url: shop.base, hasPrd: false, status: "running", startedAt: new Date().toISOString() });

  const app = createApi({ store, start: () => ({ runId: RUN_ID }) });
  server = serve({ fetch: app.fetch, port: 0 }) as Server;
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  disposeScreencast(RUN_ID);
  await new Promise<void>((r) => server.close(() => r()));
  await shop.stop();
});

/** Reads `event: frame` payloads off a real SSE socket until `want` have arrived or time runs out. */
async function readFrames(res: Response, want: number, timeoutMs = 15_000): Promise<Array<{ agent: string; jpeg: string | null }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<{ agent: string; jpeg: string | null }> = [];
  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  while (frames.length < want && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE records are separated by a blank line; keep any partial record for the next read.
    const records = buffer.split("\n\n");
    buffer = records.pop() ?? "";
    for (const record of records) {
      if (!record.includes("event: frame")) continue;
      const line = record.split("\n").find((l) => l.startsWith("data: "));
      if (line) frames.push(JSON.parse(line.slice(6)));
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}

describe("screencast over HTTP", () => {
  it("carries real browser frames from a headless agent to an SSE client", async () => {
    const kit = await BrowserToolkit.launch({ headless: true, baseUrl: shop.base, runId: RUN_ID, agent: "planner" });
    try {
      const res = await fetch(`${base}/screencast/${RUN_ID}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      // Driven only once the client is listening, so what arrives is genuinely streamed
      // rather than replayed from the snapshot the connection opens with. Chromium emits a
      // screencast frame per paint, and a static page paints once, so a second navigation is
      // what proves the stream keeps delivering rather than sending one opening picture.
      const driving = kit.newPage().then(async (page) => {
        await page.goto(shop.base + "/products");
        await page.waitForTimeout(400);
        await page.goto(shop.base + "/cart");
      });
      const frames = await readFrames(res, 2);
      await driving;

      expect(frames.length).toBeGreaterThanOrEqual(2);
      expect(frames.every((f) => f.agent === "planner")).toBe(true);
      const bytes = Buffer.from(frames[0].jpeg!, "base64");
      expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      expect(bytes.length).toBeGreaterThan(1000);
    } finally {
      await kit.close();
    }
  }, 40_000);
});
