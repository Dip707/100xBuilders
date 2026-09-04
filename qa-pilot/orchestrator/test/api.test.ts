import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.js";
import { getBus } from "../src/events.js";
import { memoryStore } from "../src/store/memory.js";
import type { Store } from "../src/store/types.js";
import { hashToken, mintToken, SESSION_COOKIE, SESSION_TTL_MS } from "../src/auth/session.js";
import { clearSessionCache } from "../src/auth/middleware.js";

const ORIGIN = "http://localhost:4000";

let store: Store;
let cookie: string;
let userId: string;

/** Registers a run in the store so ownership passes and the route's own guards are what gets tested. */
async function own(runId: string): Promise<void> {
  await store.insertRun({ id: runId, userId, url: "http://localhost:3005", hasPrd: false, status: "done", startedAt: new Date().toISOString() });
}

beforeEach(async () => {
  clearSessionCache();
  store = memoryStore();
  const user = await store.createUser("api@example.com", "unused");
  userId = user.id;
  const token = mintToken();
  await store.createSession(hashToken(token), user.id, new Date(Date.now() + SESSION_TTL_MS));
  cookie = `${SESSION_COOKIE}=${token}`;
});

describe("api", () => {
  it("validates POST /run and returns a runId", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api-")) + "/";
    const started: unknown[] = [];
    const app = createApi({ store, start: (input) => { started.push(input); return { runId: input.runId }; } });
    const headers = { cookie, "content-type": "application/json" };

    const bad = await app.request(`${ORIGIN}/run`, { method: "POST", body: JSON.stringify({ url: "nope" }), headers });
    expect(bad.status).toBe(400);

    const ok = await app.request(`${ORIGIN}/run`, { method: "POST", body: JSON.stringify({ url: "http://localhost:3005", intent: "auth" }), headers });
    expect(ok.status).toBe(200);
    const { runId } = await ok.json();
    expect(runId).toMatch(/^run-/);
    expect(started).toHaveLength(1);
  });

  it("replays events over SSE and serves the report", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api2-")) + "/";
    const bus = getBus("api-r1");
    bus.log("planner", "hello");
    bus.emit({ type: "done", message: "complete" });
    mkdirSync(process.env.QA_PILOT_OUTPUT + "api-r1", { recursive: true });
    writeFileSync(process.env.QA_PILOT_OUTPUT + "api-r1/report.html", "<h1>ok</h1>");
    await own("api-r1");

    const app = createApi({ store, start: () => ({ runId: "x" }) });
    const res = await app.request(`${ORIGIN}/events/api-r1`, { headers: { cookie } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: agent_log");
    expect(text).toContain("event: done");

    const report = await app.request(`${ORIGIN}/report/api-r1`, { headers: { cookie } });
    expect(report.status).toBe(200);
    expect(await report.text()).toContain("<h1>ok</h1>");

    // Owned, but the file is absent: "report not ready" rather than a 404 for the run.
    await own("api-r1-noreport");
    mkdirSync(process.env.QA_PILOT_OUTPUT + "api-r1-noreport", { recursive: true });
    const notReady = await app.request(`${ORIGIN}/report/api-r1-noreport`, { headers: { cookie } });
    expect(notReady.status).toBe(404);
    expect(await notReady.text()).toBe("report not ready");

    // Not a run of ours at all.
    expect((await app.request(`${ORIGIN}/report/missing`, { headers: { cookie } })).status).toBe(404);
  });

  it("serves run files and blocks path traversal", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api3-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "api-r2/screenshots", { recursive: true });
    writeFileSync(process.env.QA_PILOT_OUTPUT + "api-r2/screenshots/step1.png", "fake-png-bytes");
    writeFileSync(process.env.QA_PILOT_OUTPUT + "secret.txt", "top secret");
    await own("api-r2");

    const app = createApi({ store, start: () => ({ runId: "x" }) });

    const file = await app.request(`${ORIGIN}/runs/api-r2/files/screenshots/step1.png`, { headers: { cookie } });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(await file.text()).toBe("fake-png-bytes");

    expect((await app.request(`${ORIGIN}/runs/api-r2/files/nope.png`, { headers: { cookie } })).status).toBe(404);
    // The run IS owned, so this exercises the traversal guard rather than the ownership check.
    expect((await app.request(`${ORIGIN}/runs/api-r2/files/..%2Fsecret.txt`, { headers: { cookie } })).status).toBe(404);
  });

  it("serves a file whose path contains a nested /files/ segment", async () => {
    // split("/files/")[1] truncates at the FIRST occurrence, so a naive implementation
    // would resolve "a" instead of "a/files/b.png" here and either 404 or 500 (EISDIR).
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api3b-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "api-r2b/a/files", { recursive: true });
    writeFileSync(process.env.QA_PILOT_OUTPUT + "api-r2b/a/files/b.png", "nested-png-bytes");
    await own("api-r2b");

    const app = createApi({ store, start: () => ({ runId: "x" }) });
    const res = await app.request(`${ORIGIN}/runs/api-r2b/files/a/files/b.png`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("nested-png-bytes");
  });

  it("rejects sibling-run traversal via a shared runId prefix", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api4-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "run-2026-victim", { recursive: true });
    writeFileSync(process.env.QA_PILOT_OUTPUT + "run-2026-victim/report.html", "<h1>victim</h1>");
    // Both runs are owned by the caller, so ownership cannot be what makes the traversal fail.
    await own("run-");
    await own("run-2026-victim");

    const app = createApi({ store, start: () => ({ runId: "x" }) });

    const traversal = await app.request(`${ORIGIN}/runs/run-/files/..%2Frun-2026-victim%2Freport.html`, { headers: { cookie } });
    expect(traversal.status).toBe(404);

    const positive = await app.request(`${ORIGIN}/runs/run-2026-victim/files/report.html`, { headers: { cookie } });
    expect(positive.status).toBe(200);
    expect(await positive.text()).toBe("<h1>victim</h1>");
  });

  it("404s a malformed runId on every run-scoped route", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api5-")) + "/";
    const app = createApi({ store, start: () => ({ runId: "x" }) });
    // Previously 400 "invalid runId". Now a malformed id is indistinguishable from one
    // that is not yours, for the same reason ownership failures are 404 and not 403.
    for (const p of ["/events/..%2Fetc", "/report/..%2Fetc", "/runs/..%2F/files/x"]) {
      expect((await app.request(ORIGIN + p, { headers: { cookie } })).status, p).toBe(404);
    }
  });
});
