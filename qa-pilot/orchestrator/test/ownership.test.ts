import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.js";
import { getBus } from "../src/events.js";
import { memoryStore } from "../src/store/memory.js";
import type { Store } from "../src/store/types.js";
import { hashToken, mintToken, SESSION_COOKIE, SESSION_TTL_MS } from "../src/auth/session.js";
import { clearSessionCache } from "../src/auth/middleware.js";

const ORIGIN = "http://localhost:4000";

/** Creates an account with a live session and returns the cookie header for it. */
async function account(store: Store, email: string): Promise<{ id: string; cookie: string }> {
  const user = await store.createUser(email, "unused-in-this-test");
  const token = mintToken();
  await store.createSession(hashToken(token), user.id, new Date(Date.now() + SESSION_TTL_MS));
  return { id: user.id, cookie: `${SESSION_COOKIE}=${token}` };
}

describe("run ownership", () => {
  let store: Store;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let runId: string;
  let paths: string[];
  let seq = 0;

  beforeEach(async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-own-")) + "/";
    clearSessionCache();
    store = memoryStore();
    alice = await account(store, "alice@example.com");
    bob = await account(store, "bob@example.com");

    // A UNIQUE id per test, deliberately (Ruling 2). getBus memoises an EventBus per runId
    // in a module-level registry, but QA_PILOT_OUTPUT changes every beforeEach - so reusing
    // one id would leave the bus writing to and replaying from the FIRST test's temp dir.
    runId = `run-alice-${++seq}`;
    await store.insertRun({ id: runId, userId: alice.id, url: "http://localhost:3005", hasPrd: false, status: "done", startedAt: new Date().toISOString() });
    const dir = process.env.QA_PILOT_OUTPUT + runId + "/";
    mkdirSync(dir + "traces", { recursive: true });
    writeFileSync(dir + "report.html", "<h1>alice</h1>");
    writeFileSync(dir + "plan.md", "# alice plan");

    // Terminate the event log, so /events replays and closes instead of leaving a stream
    // pending on live events that will never arrive (Ruling 2).
    getBus(runId).emit({ type: "done", message: "complete" });

    paths = [`/runs/${runId}`, `/events/${runId}`, `/report/${runId}`, `/runs/${runId}/files/plan.md`];
  });

  it("lets the owner through on every run-scoped route", async () => {
    const app = createApi({ start: () => ({ runId: "x" }), store });
    for (const p of paths) {
      const res = await app.request(ORIGIN + p, { headers: { cookie: alice.cookie } });
      expect(res.status, p).toBe(200);
    }
  });

  it("gives another account 404, never 403, so run ids are not confirmed", async () => {
    const app = createApi({ start: () => ({ runId: "x" }), store });
    for (const p of paths) {
      const res = await app.request(ORIGIN + p, { headers: { cookie: bob.cookie } });
      expect(res.status, p).toBe(404);
    }
  });

  it("401s every run-scoped route with no session at all", async () => {
    const app = createApi({ start: () => ({ runId: "x" }), store });
    for (const p of [...paths, "/run", "/runs"]) {
      const res = await app.request(ORIGIN + p, { headers: {} });
      expect(res.status, p).toBe(401);
    }
  });

  it("lists only the caller's runs", async () => {
    await store.insertRun({ id: "run-bob", userId: bob.id, url: "http://localhost:3005", hasPrd: false, status: "done", startedAt: new Date().toISOString() });
    const app = createApi({ start: () => ({ runId: "x" }), store });

    const mine = await app.request(`${ORIGIN}/runs`, { headers: { cookie: alice.cookie } });
    expect((await mine.json()).runs.map((r: { id: string }) => r.id)).toEqual([runId]);

    const theirs = await app.request(`${ORIGIN}/runs`, { headers: { cookie: bob.cookie } });
    expect((await theirs.json()).runs.map((r: { id: string }) => r.id)).toEqual(["run-bob"]);
  });

  it("returns the run record with its artifact manifest", async () => {
    const app = createApi({ start: () => ({ runId: "x" }), store });
    const res = await app.request(`${ORIGIN}/runs/${runId}`, { headers: { cookie: alice.cookie } });
    const body = await res.json();
    expect(body.run).toMatchObject({ id: runId, status: "done" });
    expect(body.manifest.hasReport).toBe(true);
    expect(body.manifest.files).toContain("plan.md");
  });

  it("attributes a started run to the caller", async () => {
    const started: Array<{ userId: string; url: string }> = [];
    const app = createApi({ start: (input) => { started.push(input); return { runId: input.runId }; }, store });
    const res = await app.request(`${ORIGIN}/run`, {
      method: "POST", headers: { cookie: alice.cookie, "content-type": "application/json" },
      body: JSON.stringify({ url: "http://localhost:3005", intent: "auth" }),
    });
    expect(res.status).toBe(200);
    expect(started[0].userId).toBe(alice.id);
  });

  it("answers /health without a session", async () => {
    const app = createApi({ start: () => ({ runId: "x" }), store });
    const res = await app.request(`${ORIGIN}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("does not leak the driver error message when /health's store probe fails", async () => {
    // A real MongoNetworkError's .message carries the cluster hostname or IP verbatim
    // (e.g. "getaddrinfo ENOTFOUND cluster0-xxxxx.mongodb.net"). /health is unauthenticated,
    // so that text must never reach the response body.
    const failingStore: Store = {
      createUser: () => Promise.reject(new Error("unused")),
      findUserByEmail: () => Promise.reject(new Error("unused")),
      findUserById: () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:27017")),
      createSession: () => Promise.reject(new Error("unused")),
      findSession: () => Promise.reject(new Error("unused")),
      deleteSession: () => Promise.reject(new Error("unused")),
      insertRun: () => Promise.reject(new Error("unused")),
      updateRun: () => Promise.reject(new Error("unused")),
      touchRun: () => Promise.reject(new Error("unused")),
      getRun: () => Promise.reject(new Error("unused")),
      insertChat: () => Promise.reject(new Error("unused")),
      getChat: () => Promise.reject(new Error("unused")),
      listChats: () => Promise.reject(new Error("unused")),
      appendChatTurn: () => Promise.reject(new Error("unused")),
      deleteChat: () => Promise.reject(new Error("unused")),
      listRuns: () => Promise.reject(new Error("unused")),
      close: () => Promise.resolve(),
    };
    const app = createApi({ start: () => ({ runId: "x" }), store: failingStore });
    const res = await app.request(`${ORIGIN}/health`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["ok", "store", "mongo"]);
    // The point of the test: whatever the shape grows to, none of it may carry the host.
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
  });

  describe("isValidRunId guards a run the caller genuinely owns", () => {
    // Two malformed ids, both rejected by isValidRunId (the regex, or the explicit "."/".."
    // check), but for different reasons - and only one of them actually proves the guard runs.
    //
    // "../escape": the obvious path-traversal id. outputDir("../escape") resolves OUTSIDE the
    // test's temp dir, where no report.html and no file "x" ever get created. So /report and
    // /files/x already answer 404 from a plain existsSync check, with or without the guard -
    // this id alone would let a deleted isValidRunId slip through undetected.
    //
    // "sub/dir": contains a forward slash, which RUN_ID_RE (^[A-Za-z0-9._-]+$) still rejects,
    // but outputDir("sub/dir") resolves to "<temp>/sub/dir/" - INSIDE the test's temp dir. By
    // creating a real report.html and a real file "x" there, /report/sub%2Fdir and
    // /runs/sub%2Fdir/files/x would genuinely succeed (200) if isValidRunId were removed, since
    // the files exist and the run record is owned by alice. So a 404 for this id can only be
    // coming from the format guard itself, not from a missing store record or a missing file.
    const malformedIds = ["../escape", "sub/dir"];

    beforeEach(async () => {
      for (const id of malformedIds) {
        await store.insertRun({ id, userId: alice.id, url: "http://localhost:3005", hasPrd: false, status: "done", startedAt: new Date().toISOString() });
      }
      const dir = process.env.QA_PILOT_OUTPUT + "sub/dir/";
      mkdirSync(dir, { recursive: true });
      writeFileSync(dir + "report.html", "<h1>sub/dir</h1>");
      writeFileSync(dir + "x", "payload");
    });

    it.each(malformedIds)("404s /runs/:id for an owned but malformed id (%s)", async (id) => {
      const app = createApi({ start: () => ({ runId: "x" }), store });
      const res = await app.request(`${ORIGIN}/runs/${encodeURIComponent(id)}`, { headers: { cookie: alice.cookie } });
      expect(res.status).toBe(404);
    });

    it.each(malformedIds)("404s /events/:id for an owned but malformed id (%s)", async (id) => {
      const app = createApi({ start: () => ({ runId: "x" }), store });
      const res = await app.request(`${ORIGIN}/events/${encodeURIComponent(id)}`, { headers: { cookie: alice.cookie } });
      expect(res.status).toBe(404);
    });

    it.each(malformedIds)("404s /report/:id for an owned but malformed id (%s)", async (id) => {
      const app = createApi({ start: () => ({ runId: "x" }), store });
      const res = await app.request(`${ORIGIN}/report/${encodeURIComponent(id)}`, { headers: { cookie: alice.cookie } });
      expect(res.status).toBe(404);
    });

    it.each(malformedIds)("404s /runs/:id/files/x for an owned but malformed id (%s)", async (id) => {
      const app = createApi({ start: () => ({ runId: "x" }), store });
      const res = await app.request(`${ORIGIN}/runs/${encodeURIComponent(id)}/files/x`, { headers: { cookie: alice.cookie } });
      expect(res.status).toBe(404);
    });
  });
});
