import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.js";
import { memoryStore } from "../src/store/memory.js";
import { TrackerError } from "../src/integrations/errors.js";
import type { Destination, TrackerClient } from "../src/integrations/index.js";
import type { TicketBody } from "../src/integrations/ticket.js";
import type { Store, RunRecord, TrackerProvider } from "../src/store/types.js";
import { hashToken, mintToken, SESSION_COOKIE, SESSION_TTL_MS } from "../src/auth/session.js";
import { clearSessionCache } from "../src/auth/middleware.js";

const ORIGIN = "http://localhost:4000";
let store: Store;
let headers: Record<string, string>;
let userId: string;

async function signIn(email: string) {
  const user = await store.createUser(email, "unused");
  const token = mintToken();
  await store.createSession(hashToken(token), user.id, new Date(Date.now() + SESSION_TTL_MS));
  return { userId: user.id, headers: { cookie: `${SESSION_COOKIE}=${token}`, "content-type": "application/json" } };
}

const run = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id, userId, url: "http://localhost:3005", hasPrd: false, status: "done",
  startedAt: "2026-09-05T10:00:00.000Z", finishedAt: "2026-09-05T10:09:00.000Z", ...over,
});

/** A finished run whose coupon test the classifier escalated as a defect. */
function seedRun(id: string) {
  const dir = process.env.QA_PILOT_OUTPUT + id + "/";
  mkdirSync(dir + "tests", { recursive: true });
  const flow = (fid: string, title: string, priority: string) => ({ id: fid, title, category: "happy", priority, preconditions: [], steps: [{ action: "goto", target: "/" }], expected: [{ type: "url_contains", value: "/" }], source: "explored" });
  writeFileSync(dir + "plan.json", JSON.stringify([flow("auth-001", "Login", "P1"), flow("checkout-001", "Coupon", "P0")]));
  writeFileSync(dir + "tests/auth-001.spec.ts", "test('x', async ({ page }) => {});");
  writeFileSync(dir + "tests/checkout-001.spec.ts", "test('x', async ({ page }) => {});");
  const r = (fid: string, status: string, error?: string) => ({ id: fid, file: "f", title: fid, status, error, network: [], consoleErrors: [], pageErrors: [], durationMs: 1 });
  writeFileSync(dir + "results.json", JSON.stringify({ at: "2026-09-05T10:08:00.000Z", tests: [r("auth-001", "passed"), r("checkout-001", "failed", "Error: expect failed")] }));
  writeFileSync(dir + "defects.json", JSON.stringify([{ id: "DEF-1-checkout-001", title: "Coupon: POST /api/coupon returned 500", severity: "critical", flow: "checkout-001", repro_steps: ["1. goto /"], expected: "url_contains /", actual: "Error: expect failed", evidence: ["POST /api/coupon returned 500"], attachments: [] }]));
  writeFileSync(dir + "events.jsonl", JSON.stringify({ type: "test_result", at: "2026-09-05T10:08:30.000Z", data: { test: "checkout-001", class: "defect", confidence: 0.9, evidence: ["POST /api/coupon returned 500"], action: "escalate" } }) + "\n");
}

type Filed = { userId: string; provider: TrackerProvider; connectedAccountId: string; destination: Destination; body: TicketBody };

const ENG = { id: "t1", label: "Engineering (ENG)" };
const OPS = { id: "t2", label: "Ops (OPS)" };

function fakeTrackers(over: Partial<TrackerClient> & { destinations?: Destination[]; outcome?: "active" | "failed" | "timeout" } = {}) {
  const filed: Filed[] = [];
  const disconnected: string[] = [];
  const started: { userId: string; provider: string; callbackUrl: string }[] = [];
  let n = 0;
  const trackers: TrackerClient = {
    authConfigId: async () => "ac_1",
    startConnection: async (uid, provider, callbackUrl) => { started.push({ userId: uid, provider, callbackUrl }); n += 1; return { connectedAccountId: `ca_${n}`, redirectUrl: `https://backend.composio.dev/oauth/${provider}` }; },
    awaitConnection: async () => over.outcome ?? "active",
    listDestinations: async () => over.destinations ?? [ENG],
    createIssue: async (uid, provider, connectedAccountId, destination, body) => { filed.push({ userId: uid, provider, connectedAccountId, destination, body }); return { key: "ENG-9", url: "https://linear.app/acme/issue/ENG-9" }; },
    disconnect: async (id) => { disconnected.push(id); },
    ...over,
  };
  return { trackers, filed, disconnected, started };
}

const api = (trackers: TrackerClient) => createApi({ store, start: (input) => ({ runId: input.runId }), trackers });
const get = (app: ReturnType<typeof api>, path: string) => app.request(ORIGIN + path, { headers, redirect: "manual" });
const send = (app: ReturnType<typeof api>, method: string, path: string, body?: unknown) =>
  app.request(ORIGIN + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });

/** Connects Linear end to end through the fake: connect, then the callback. */
async function connectLinear(app: ReturnType<typeof api>, returnTo?: string) {
  const res = await send(app, "POST", "/integrations/connect", { provider: "linear", ...(returnTo ? { return: returnTo } : {}) });
  expect(res.status).toBe(200);
  return get(app, `/integrations/callback?status=success${returnTo ? `&return=${encodeURIComponent(returnTo)}` : ""}`);
}

beforeEach(async () => {
  clearSessionCache();
  store = memoryStore();
  process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-tickets-")) + "/";
  ({ userId, headers } = await signIn("tickets@example.com"));
  await store.insertRun(run("shop-1"));
  seedRun("shop-1");
});

describe("connecting", () => {
  it("starts with nothing, then creates the OAuth link, storing a pending record that names no account id to the client", async () => {
    const { trackers, started } = fakeTrackers();
    const app = api(trackers);
    expect(await (await get(app, "/integrations")).json()).toEqual({ integration: null });

    const res = await send(app, "POST", "/integrations/connect", { provider: "linear", return: "/copilot?chat=abc" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirectUrl: "https://backend.composio.dev/oauth/linear" });
    expect(started[0]).toEqual({ userId, provider: "linear", callbackUrl: "http://localhost:4000/integrations/callback?return=%2Fcopilot%3Fchat%3Dabc" });

    const pending = await (await get(app, "/integrations")).json();
    expect(pending.integration).toMatchObject({ provider: "linear", status: "pending", label: "Linear" });
    expect(JSON.stringify(pending)).not.toContain("ca_1");
    expect((await store.getIntegration(userId))!.connectedAccountId).toBe("ca_1");
  });

  it("drops a return path that is not a path on this site", async () => {
    const { trackers, started } = fakeTrackers();
    await send(api(trackers), "POST", "/integrations/connect", { provider: "jira", return: "https://evil.example/x" });
    expect(started[0].callbackUrl).toBe("http://localhost:4000/integrations/callback");
  });

  it("disconnects the previous account before starting a new connection", async () => {
    const { trackers, disconnected } = fakeTrackers();
    const app = api(trackers);
    await connectLinear(app);
    await send(app, "POST", "/integrations/connect", { provider: "jira" });
    expect(disconnected).toEqual(["ca_1"]);
    expect((await store.getIntegration(userId))!).toMatchObject({ provider: "jira", connectedAccountId: "ca_2", status: "pending" });
  });

  it("rejects an unknown provider and answers 502 with Composio's words when the link cannot be made", async () => {
    expect((await send(api(fakeTrackers().trackers), "POST", "/integrations/connect", { provider: "github" })).status).toBe(400);
    const failing = fakeTrackers({ startConnection: async () => { throw new TrackerError("Composio returned no authorisation link for Linear"); } });
    const res = await send(api(failing.trackers), "POST", "/integrations/connect", { provider: "linear" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/no authorisation link/);
    expect(await store.getIntegration(userId)).toBeNull();
  });
});

describe("callback", () => {
  it("activates the connection, picks the only destination, and returns to Settings with the return path", async () => {
    const app = api(fakeTrackers().trackers);
    const res = await connectLinear(app, "/copilot?chat=abc");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/settings?return=%2Fcopilot%3Fchat%3Dabc");
    const shown = (await (await get(app, "/integrations")).json()).integration;
    expect(shown).toMatchObject({ provider: "linear", status: "active", destination: ENG, label: "Linear · Engineering (ENG)" });
  });

  it("leaves the destination unset when there are several", async () => {
    const app = api(fakeTrackers({ destinations: [ENG, OPS] }).trackers);
    await connectLinear(app);
    const shown = (await (await get(app, "/integrations")).json()).integration;
    expect(shown).toMatchObject({ status: "active", label: "Linear" });
    expect(shown.destination).toBeUndefined();
  });

  it("deletes the record and explains when the tracker refused, timed out, or failed", async () => {
    for (const [query, outcome, words] of [["failed", "active", /did not authorise/], ["success", "timeout", /in time/], ["success", "failed", /failed/]] as const) {
      store = memoryStore();
      ({ userId, headers } = await signIn(`cb-${query}-${outcome}@example.com`));
      const app = api(fakeTrackers({ outcome }).trackers);
      await send(app, "POST", "/integrations/connect", { provider: "linear" });
      const res = await get(app, `/integrations/callback?status=${query}`);
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toMatch(words);
      expect(await store.getIntegration(userId)).toBeNull();
    }
  });

  it("needs a session and a connection in progress", async () => {
    const app = api(fakeTrackers().trackers);
    expect((await app.request(ORIGIN + "/integrations/callback?status=success", { redirect: "manual" })).status).toBe(401);
    const res = await get(app, "/integrations/callback?status=success");
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toMatch(/no connection was in progress/);
  });
});

describe("destinations", () => {
  it("lists them for an active connection and stores a chosen one, refusing an id that is not on the list", async () => {
    const app = api(fakeTrackers({ destinations: [ENG, OPS] }).trackers);
    expect((await get(app, "/integrations/destinations")).status).toBe(409);
    await connectLinear(app);
    expect(await (await get(app, "/integrations/destinations")).json()).toEqual({ destinations: [ENG, OPS] });

    expect((await send(app, "PUT", "/integrations/destination", { id: "t9" })).status).toBe(400);
    const res = await send(app, "PUT", "/integrations/destination", { id: "t2" });
    expect(res.status).toBe(200);
    expect((await res.json()).integration).toMatchObject({ destination: OPS, label: "Linear · Ops (OPS)" });
  });
});

describe("disconnecting", () => {
  it("removes the record and the Composio account", async () => {
    const { trackers, disconnected } = fakeTrackers();
    const app = api(trackers);
    await connectLinear(app);
    expect((await send(app, "DELETE", "/integrations")).status).toBe(204);
    expect(await (await get(app, "/integrations")).json()).toEqual({ integration: null });
    expect(disconnected).toEqual(["ca_1"]);
  });
});

describe("tickets", () => {
  it("asks for a connection while nothing, a pending link, or an active link without a destination is there", async () => {
    const app = api(fakeTrackers({ destinations: [ENG, OPS] }).trackers);
    const needs = async () => {
      const res = await send(app, "POST", "/runs/shop-1/tests/checkout-001/ticket");
      expect(res.status).toBe(412);
      expect(await res.json()).toMatchObject({ needs: ["integration"] });
    };
    await needs();
    await send(app, "POST", "/integrations/connect", { provider: "linear" });
    await needs();
    await get(app, "/integrations/callback?status=success");
    await needs();
  });

  it("files once through the connected account and destination, and returns the same ticket on a second click", async () => {
    const { trackers, filed } = fakeTrackers();
    const app = api(trackers);
    await connectLinear(app);

    const first = await send(app, "POST", "/runs/shop-1/tests/checkout-001/ticket");
    expect(first.status).toBe(200);
    const { ticket } = await first.json();
    expect(ticket).toMatchObject({ runId: "shop-1", testId: "checkout-001", provider: "linear", key: "ENG-9", url: "https://linear.app/acme/issue/ENG-9" });

    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ userId, provider: "linear", connectedAccountId: "ca_1", destination: ENG });
    expect(filed[0].body.title).toBe("[qa-pilot] Coupon: POST /api/coupon returned 500");
    expect(filed[0].body.sections[0].lines!.join("\n")).toContain("Classifier verdict: defect (0.90)");
    expect(filed[0].body.sections[6].lines![0]).toBe("http://localhost:3000/runs/shop-1/cases?test=checkout-001");

    const second = await send(app, "POST", "/runs/shop-1/tests/checkout-001/ticket");
    expect((await second.json()).ticket.id).toBe(ticket.id);
    expect(filed).toHaveLength(1);
    expect((await (await get(app, "/runs/shop-1/tickets")).json()).tickets.map((t: { key: string }) => t.key)).toEqual(["ENG-9"]);
  });

  it("answers 404 for a run the user does not own and for a test not in the plan", async () => {
    const app = api(fakeTrackers().trackers);
    await connectLinear(app);
    await store.insertRun(run("theirs", { userId: "someone-else" }));
    seedRun("theirs");
    expect((await send(app, "POST", "/runs/theirs/tests/checkout-001/ticket")).status).toBe(404);
    expect((await get(app, "/runs/theirs/tickets")).status).toBe(404);
    expect((await send(app, "POST", "/runs/shop-1/tests/ghost-9/ticket")).status).toBe(404);
  });

  it("answers 502 with the tracker's words when filing fails, and stores nothing", async () => {
    const app = api(fakeTrackers({ createIssue: async () => { throw new TrackerError("JIRA_CREATE_ISSUE: Field 'priority' cannot be set"); } }).trackers);
    await connectLinear(app);
    const res = await send(app, "POST", "/runs/shop-1/tests/checkout-001/ticket");
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/cannot be set/);
    expect(await store.listTickets(userId, "shop-1")).toEqual([]);
  });
});
