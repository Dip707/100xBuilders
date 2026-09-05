import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.js";
import { memoryStore } from "../src/store/memory.js";
import { TrackerError } from "../src/integrations/errors.js";
import { open } from "../src/integrations/crypto.js";
import type { Trackers } from "../src/integrations/index.js";
import type { TicketBody } from "../src/integrations/ticket.js";
import type { Store, RunRecord } from "../src/store/types.js";
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

type Filed = { provider: string; config: unknown; body: TicketBody };

function fakeTrackers(over: Partial<Trackers> = {}) {
  const filed: Filed[] = [];
  const trackers: Trackers = {
    verify: async (provider, input) => ({ config: { ...input, teamId: "t1" }, label: provider === "linear" ? "Linear · Engineering" : "Jira · Acme" }),
    createIssue: async (provider, config, body) => {
      filed.push({ provider, config, body });
      return { key: "ENG-9", url: "https://linear.app/acme/issue/ENG-9" };
    },
    ...over,
  };
  return { trackers, filed };
}

const api = (trackers: Trackers) => createApi({ store, start: (input) => ({ runId: input.runId }), trackers });
const get = (app: ReturnType<typeof api>, path: string) => app.request(ORIGIN + path, { headers });
const send = (app: ReturnType<typeof api>, method: string, path: string, body?: unknown) =>
  app.request(ORIGIN + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });

const LINEAR = { provider: "linear", apiKey: "lin_api_secret", teamKey: "ENG" };

beforeEach(async () => {
  clearSessionCache();
  store = memoryStore();
  process.env.QA_PILOT_SECRET = "test-secret";
  process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-tickets-")) + "/";
  ({ userId, headers } = await signIn("tickets@example.com"));
  await store.insertRun(run("shop-1"));
  seedRun("shop-1");
});

describe("integrations", () => {
  it("reports nothing connected, then the public shape of a connection, never the key", async () => {
    const app = api(fakeTrackers().trackers);
    expect(await (await get(app, "/integrations")).json()).toEqual({ integration: null });

    const res = await send(app, "PUT", "/integrations", LINEAR);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.integration).toMatchObject({ provider: "linear", label: "Linear · Engineering" });
    expect(JSON.stringify(body)).not.toContain("lin_api_secret");

    const again = await (await get(app, "/integrations")).json();
    expect(again.integration).toMatchObject({ provider: "linear", label: "Linear · Engineering" });
    expect(JSON.stringify(again)).not.toContain("lin_api_secret");

    const stored = (await store.getIntegration(userId))!;
    expect(stored.secret).not.toContain("lin_api_secret");
    expect(open(stored.secret)).toMatchObject({ apiKey: "lin_api_secret", teamId: "t1" });
  });

  it("answers 400 with the tracker's words when verification fails, and stores nothing", async () => {
    const app = api(fakeTrackers({ verify: async () => { throw new TrackerError("Linear rejected the API key"); } }).trackers);
    const res = await send(app, "PUT", "/integrations", LINEAR);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Linear rejected the API key");
    expect(await store.getIntegration(userId)).toBeNull();
  });

  it("rejects a malformed body", async () => {
    const app = api(fakeTrackers().trackers);
    expect((await send(app, "PUT", "/integrations", { provider: "github" })).status).toBe(400);
    expect((await send(app, "PUT", "/integrations", { provider: "jira", baseUrl: "https://x.atlassian.net" })).status).toBe(400);
  });

  it("disconnects", async () => {
    const app = api(fakeTrackers().trackers);
    await send(app, "PUT", "/integrations", LINEAR);
    expect((await send(app, "DELETE", "/integrations")).status).toBe(204);
    expect(await (await get(app, "/integrations")).json()).toEqual({ integration: null });
  });

  it("requires a session", async () => {
    const app = api(fakeTrackers().trackers);
    expect((await app.request(ORIGIN + "/integrations")).status).toBe(401);
  });
});

describe("tickets", () => {
  it("asks for a connection before filing", async () => {
    const app = api(fakeTrackers().trackers);
    const res = await send(app, "POST", "/runs/shop-1/tests/checkout-001/ticket");
    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({ needs: ["integration"] });
  });

  it("files once from the defect record and returns the same ticket on a second click", async () => {
    const { trackers, filed } = fakeTrackers();
    const app = api(trackers);
    await send(app, "PUT", "/integrations", LINEAR);

    const first = await send(app, "POST", "/runs/shop-1/tests/checkout-001/ticket");
    expect(first.status).toBe(200);
    const { ticket } = await first.json();
    expect(ticket).toMatchObject({ runId: "shop-1", testId: "checkout-001", provider: "linear", key: "ENG-9", url: "https://linear.app/acme/issue/ENG-9" });

    expect(filed).toHaveLength(1);
    expect(filed[0].provider).toBe("linear");
    expect(filed[0].config).toMatchObject({ apiKey: "lin_api_secret" });
    expect(filed[0].body.title).toBe("[qa-pilot] Coupon: POST /api/coupon returned 500");
    expect(filed[0].body.severity).toBe("critical");
    expect(filed[0].body.sections[0].lines!.join("\n")).toContain("Classifier verdict: defect (0.90)");
    expect(filed[0].body.sections[6].lines![0]).toBe("http://localhost:3000/runs/shop-1/cases?test=checkout-001");

    const second = await send(app, "POST", "/runs/shop-1/tests/checkout-001/ticket");
    expect(second.status).toBe(200);
    expect((await second.json()).ticket.id).toBe(ticket.id);
    expect(filed).toHaveLength(1);

    const list = await (await get(app, "/runs/shop-1/tickets")).json();
    expect(list.tickets.map((t: { key: string }) => t.key)).toEqual(["ENG-9"]);
  });

  it("files a test with no defect record from the flow and its latest result", async () => {
    const { trackers, filed } = fakeTrackers();
    const app = api(trackers);
    await send(app, "PUT", "/integrations", LINEAR);
    const res = await send(app, "POST", "/runs/shop-1/tests/auth-001/ticket");
    expect(res.status).toBe(200);
    expect(filed[0].body.title).toBe("[qa-pilot] Login still fails");
    expect(filed[0].body.severity).toBe("high");
  });

  it("answers 404 for a run the user does not own and for a test not in the plan", async () => {
    const app = api(fakeTrackers().trackers);
    await send(app, "PUT", "/integrations", LINEAR);
    await store.insertRun(run("theirs", { userId: "someone-else" }));
    seedRun("theirs");
    expect((await send(app, "POST", "/runs/theirs/tests/checkout-001/ticket")).status).toBe(404);
    expect((await get(app, "/runs/theirs/tickets")).status).toBe(404);
    expect((await send(app, "POST", "/runs/shop-1/tests/ghost-9/ticket")).status).toBe(404);
  });

  it("answers 502 with the tracker's words when filing fails, and stores nothing", async () => {
    const app = api(fakeTrackers({ createIssue: async () => { throw new TrackerError("Jira: Field 'priority' cannot be set"); } }).trackers);
    await send(app, "PUT", "/integrations", LINEAR);
    const res = await send(app, "POST", "/runs/shop-1/tests/checkout-001/ticket");
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Jira: Field 'priority' cannot be set");
    expect(await store.listTickets(userId, "shop-1")).toEqual([]);
  });

  it("lists nothing for a run with no tickets", async () => {
    const app = api(fakeTrackers().trackers);
    expect(await (await get(app, "/runs/shop-1/tickets")).json()).toEqual({ tickets: [] });
  });
});
