import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.js";
import { getBus } from "../src/events.js";
import { getScreencast, disposeScreencast } from "../src/browser/screencast.js";
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

  it("streams the newest viewport frame per agent and closes when the run ends", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api-cast-")) + "/";
    await own("api-cast");
    const hub = getScreencast("api-cast");
    // Frames already captured before anyone opened the run screen: the connection must
    // start from the current picture rather than an empty panel.
    hub.push("planner", "AAA", 1000);
    hub.push("generator:checkout", "BBB", 1000);
    // The stream ends only when the hub does, so end it once the response is being read.
    setTimeout(() => disposeScreencast("api-cast"), 50);

    const app = createApi({ store, start: () => ({ runId: "x" }) });
    const res = await app.request(`${ORIGIN}/screencast/api-cast`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("event: frame");
    expect(text).toContain('"agent":"planner"');
    expect(text).toContain('"jpeg":"AAA"');
    expect(text).toContain('"agent":"generator:checkout"');
    // Ending the run tears every tile down, so the panel does not freeze on a dead frame.
    expect(text).toContain('"jpeg":null');
  });

  it("does not stream a screencast for a run we do not own", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api-cast2-")) + "/";
    const app = createApi({ store, start: () => ({ runId: "x" }) });
    expect((await app.request(`${ORIGIN}/screencast/someone-elses-run`, { headers: { cookie } })).status).toBe(404);
    expect((await app.request(`${ORIGIN}/screencast/..`, { headers: { cookie } })).status).toBe(404);
    expect((await app.request(`${ORIGIN}/screencast/api-cast`)).status).toBe(401);
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

describe("plan review and single-test rerun routes", () => {
  it("409s a review for a run that is not waiting, 400s an invalid plan, 404s a foreign run", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api-review-")) + "/";
    await own("rv-1");
    const app = createApi({ store, start: () => ({ runId: "x" }) });
    const headers = { cookie, "content-type": "application/json" };
    const flows = [{ id: "auth-001", title: "Sign in works", category: "happy", priority: "P0", preconditions: ["logged_out"], source: "explored",
      steps: [{ action: "goto", target: "/login" }], expected: [{ type: "url_contains", value: "/products" }] }];

    const notWaiting = await app.request(`${ORIGIN}/runs/rv-1/review`, { method: "POST", body: JSON.stringify({ flows }), headers });
    expect(notWaiting.status).toBe(409);

    const invalid = await app.request(`${ORIGIN}/runs/rv-1/review`, { method: "POST", body: JSON.stringify({ flows: [{ id: "BAD ID" }] }), headers });
    expect(invalid.status).toBe(400);

    const foreign = await app.request(`${ORIGIN}/runs/somebody-elses/review`, { method: "POST", body: JSON.stringify({ flows }), headers });
    expect(foreign.status).toBe(404);
  });

  it("re-runs one test of a finished run, and refuses while the run is in progress or its session is gone", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api-rerun-")) + "/";
    await own("rr-done");
    await store.insertRun({ id: "rr-live", userId, url: "http://localhost:3005", hasPrd: false, status: "running", startedAt: new Date().toISOString() });
    const calls: string[] = [];
    const app = createApi({
      store, start: () => ({ runId: "x" }),
      rerunBlocker: async (runId, testId) => (testId === "nope" ? "test not found" : runId === "rr-done" ? null : "credentials are no longer in memory"),
      rerun: async (runId, testId) => { calls.push(`${runId}/${testId}`); return { id: testId, status: "passed" }; },
    });
    const headers = { cookie };

    const live = await app.request(`${ORIGIN}/runs/rr-live/tests/auth-001/rerun`, { method: "POST", headers });
    expect(live.status).toBe(409);

    const ok = await app.request(`${ORIGIN}/runs/rr-done/tests/auth-001/rerun`, { method: "POST", headers });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ result: { id: "auth-001", status: "passed" } });
    expect(calls).toEqual(["rr-done/auth-001"]);

    const unknownTest = await app.request(`${ORIGIN}/runs/rr-done/tests/nope/rerun`, { method: "POST", headers });
    expect(unknownTest.status).toBe(404);

    await own("rr-old");
    const gone = await app.request(`${ORIGIN}/runs/rr-old/tests/auth-001/rerun`, { method: "POST", headers });
    expect(gone.status).toBe(409);
    expect((await gone.json()).error).toContain("no longer in memory");
    // Only the runnable request reached the rerun function; the in-progress, unknown-test and gone-session ones never did.
    expect(calls).toEqual(["rr-done/auth-001"]);
  });

  it("serves live preview frames uncached and videos as webm", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api-live-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "lv/live/auth-001", { recursive: true });
    mkdirSync(process.env.QA_PILOT_OUTPUT + "lv/traces/videos", { recursive: true });
    writeFileSync(process.env.QA_PILOT_OUTPUT + "lv/live/auth-001/frame.jpg", "jpeg-bytes");
    writeFileSync(process.env.QA_PILOT_OUTPUT + "lv/traces/videos/auth-001.webm", "webm-bytes");
    await own("lv");
    const app = createApi({ store, start: () => ({ runId: "x" }) });

    const frame = await app.request(`${ORIGIN}/runs/lv/files/live/auth-001/frame.jpg`, { headers: { cookie } });
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/jpeg");
    expect(frame.headers.get("cache-control")).toBe("no-store");

    const video = await app.request(`${ORIGIN}/runs/lv/files/traces/videos/auth-001.webm`, { headers: { cookie } });
    expect(video.headers.get("content-type")).toBe("video/webm");
    expect(video.headers.get("cache-control")).not.toBe("no-store");
  });
});


describe("suite download", () => {
  it("serves the run's suite as a zip the owner can open, and hides it from everyone else", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api-suite-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "api-r9/suite/tests", { recursive: true });
    writeFileSync(process.env.QA_PILOT_OUTPUT + "api-r9/suite/README.md", "# Suite");
    writeFileSync(process.env.QA_PILOT_OUTPUT + "api-r9/suite/tests/auth-001.spec.ts", "import { test } from '../fixtures';");
    await own("api-r9");
    const app = createApi({ store, start: () => ({ runId: "x" }) });

    const res = await app.request(`${ORIGIN}/runs/api-r9/suite.zip`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("api-r9");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 2).toString("binary")).toBe("PK");
    expect(body.toString("binary")).toContain("tests/auth-001.spec.ts");

    expect((await app.request(`${ORIGIN}/runs/api-r9/suite.zip`)).status).toBe(401);
    expect((await app.request(`${ORIGIN}/runs/missing/suite.zip`, { headers: { cookie } })).status).toBe(404);
  });

  it("says the suite is not ready rather than serving an empty archive", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api-nosuite-")) + "/";
    await own("api-r10");
    const app = createApi({ store, start: () => ({ runId: "x" }) });
    expect((await app.request(`${ORIGIN}/runs/api-r10/suite.zip`, { headers: { cookie } })).status).toBe(404);
  });
});
