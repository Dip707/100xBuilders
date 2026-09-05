import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.js";
import { memoryStore } from "../src/store/memory.js";
import { FakeLlmClient } from "../src/llm/client.js";
import type { Store, RunRecord } from "../src/store/types.js";
import type { Step, TestResult } from "../src/state.js";
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

function seedRun(id: string, opts: { loginFile?: boolean } = {}) {
  const dir = process.env.QA_PILOT_OUTPUT + id + "/";
  mkdirSync(dir + "tests", { recursive: true });
  const flow = (fid: string, title: string) => ({ id: fid, title, category: "happy", priority: "P1", preconditions: ["logged_in"], steps: [{ action: "goto", target: "/" }], expected: [{ type: "url_contains", value: "/" }], source: "explored" });
  writeFileSync(dir + "plan.json", JSON.stringify([flow("auth-001", "Login"), flow("checkout-001", "Coupon"), flow("checkout-002", "Order")]));
  writeFileSync(dir + "tests/auth-001.spec.ts", "test('x', async ({ page }) => {});");
  writeFileSync(dir + "tests/checkout-001.spec.ts", "test('x', async ({ page, login }) => { await login(); });");
  writeFileSync(dir + "tests/checkout-002.spec.ts", "test('x', async ({ page, login }) => { await login(); });");
  const r = (fid: string, status: string) => ({ id: fid, file: "f", title: fid, status, network: [], consoleErrors: [], pageErrors: [], durationMs: 1 });
  writeFileSync(dir + "results.json", JSON.stringify({ at: "x", tests: [r("auth-001", "passed"), r("checkout-001", "failed"), r("checkout-002", "failed")] }));
  if (opts.loginFile) writeFileSync(dir + "login-steps.json", JSON.stringify([{ action: "fill", role: "textbox", name: "Email", value: "{{username}}" }, { action: "fill", role: "textbox", name: "Password", value: "{{password}}" }]));
}

type Answer = unknown | ((input: string) => unknown);
const calls: { runId: string; testIds: string[]; loginSteps: Step[] }[] = [];

function api(answer: Answer, opts: { context?: Step[] | null } = {}) {
  return createApi({
    store,
    start: (input) => ({ runId: input.runId }),
    llm: new FakeLlmClient({ "copilot-turn": answer }),
    contextLoginSteps: () => opts.context ?? null,
    rerunTests: async (runId, testIds, loginSteps) => {
      calls.push({ runId, testIds, loginSteps });
      return testIds.map((id): TestResult => ({ id, file: "f", title: id, status: id === "checkout-001" ? "failed" : "passed", error: id === "checkout-001" ? "Error: still 500" : undefined, network: [], consoleErrors: [], pageErrors: [], durationMs: 5 }));
    },
  });
}

async function newChat(app: ReturnType<typeof api>, scope: Record<string, string> = {}) {
  const res = await app.request(`${ORIGIN}/copilot/chats`, { method: "POST", headers, body: JSON.stringify(scope) });
  expect(res.status).toBe(200);
  return (await res.json()).chat as { id: string };
}

const send = (app: ReturnType<typeof api>, id: string, text: string) =>
  app.request(`${ORIGIN}/copilot/chats/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ text }) });
const execute = (app: ReturnType<typeof api>, id: string, body: Record<string, unknown> = {}) =>
  app.request(`${ORIGIN}/copilot/chats/${id}/execute`, { method: "POST", headers, body: JSON.stringify(body) });

const RERUN = { reply: "Rerunning the failed checkout tests.", action: "rerun", testIds: ["checkout-001", "checkout-002"], title: "Rerun failed checkout tests" };

beforeEach(async () => {
  clearSessionCache();
  calls.length = 0;
  store = memoryStore();
  ({ userId, headers } = await signIn("copilot@example.com"));
  process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-copilot-")) + "/";
  await store.insertRun(run("shop-1"));
  seedRun("shop-1", { loginFile: true });
});

describe("copilot chats", () => {
  it("requires a session", async () => {
    const app = api(RERUN);
    for (const [method, path] of [["GET", "/copilot/chats"], ["POST", "/copilot/chats"], ["POST", "/copilot/chats/x/messages"], ["POST", "/copilot/chats/x/execute"]] as const) {
      const res = await app.request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("creates a copilot chat with a scope and lists only copilot chats", async () => {
    const app = api(RERUN);
    const chat = await newChat(app, { url: "http://localhost:3005", runId: "shop-1" });
    expect(await store.getChat(chat.id)).toMatchObject({ kind: "copilot", scope: { url: "http://localhost:3005", runId: "shop-1" }, draft: {} });
    await app.request(`${ORIGIN}/chats`, { method: "POST", headers });
    const list = await (await app.request(`${ORIGIN}/copilot/chats`, { headers })).json();
    expect(list.chats.map((c: { id: string }) => c.id)).toEqual([chat.id]);
    const intake = await (await app.request(`${ORIGIN}/chats`, { headers })).json();
    expect(intake.chats.some((c: { id: string }) => c.id === chat.id)).toBe(false);
  });

  it("refuses a scope naming a run the caller does not own", async () => {
    const app = api(RERUN);
    await store.insertRun(run("theirs", { userId: "someone-else" }));
    const res = await app.request(`${ORIGIN}/copilot/chats`, { method: "POST", headers, body: JSON.stringify({ runId: "theirs" }) });
    expect(res.status).toBe(404);
  });
});

describe("copilot turn", () => {
  it("decides a rerun, validates the ids, stores both messages and the pending plan, and titles the chat", async () => {
    const app = api({ ...RERUN, testIds: ["checkout-001", "checkout-002", "ghost-9"] }, { context: [] });
    const chat = await newChat(app);
    const res = await send(app, chat.id, "rerun the checkout tests that failed last time");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe("rerun");
    expect(body.plan).toEqual({ kind: "rerun_plan", runId: "shop-1", testIds: ["checkout-001", "checkout-002"], blocked: [] });
    expect(body.needs).toEqual([]);
    expect(body.title).toBe("Rerun failed checkout tests");
    const stored = (await store.getChat(chat.id))!;
    expect(stored.title).toBe("Rerun failed checkout tests");
    expect(stored.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(stored.messages[1].data).toEqual(body.plan);
    expect(stored.pending).toEqual({ runId: "shop-1", testIds: ["checkout-001", "checkout-002"] });
    expect(stored.scope).toEqual({ url: "http://localhost:3005", runId: "shop-1" });
  });

  it("asks for credentials when the signed-in tests can only run with fresh ones", async () => {
    const app = api(RERUN, { context: null });
    const chat = await newChat(app);
    const body = await (await send(app, chat.id, "rerun the failed checkout tests")).json();
    expect(body.needs).toEqual(["credentials"]);
    expect(body.plan.testIds).toEqual(["checkout-001", "checkout-002"]);
  });

  it("blocks signed-in tests when no login can be replayed, and still runs the rest", async () => {
    await store.insertRun(run("shop-0", { startedAt: "2026-09-01T10:00:00.000Z" }));
    seedRun("shop-0", { loginFile: false });
    const app = api({ reply: "ok", action: "rerun", testIds: ["auth-001", "checkout-001"] }, { context: null });
    const chat = await newChat(app, { runId: "shop-0" });
    const body = await (await send(app, chat.id, "rerun auth-001 and checkout-001")).json();
    expect(body.plan.testIds).toEqual(["auth-001"]);
    expect(body.plan.blocked[0].id).toBe("checkout-001");
    expect(body.needs).toEqual([]);
  });

  it("downgrades a rerun of invented ids to a clarification and stores no pending plan", async () => {
    const app = api({ reply: "Rerunning payments-009.", action: "rerun", testIds: ["payments-009"] });
    const chat = await newChat(app);
    const body = await (await send(app, chat.id, "rerun payments")).json();
    expect(body.action).toBe("clarify");
    expect(body.reply).toContain("checkout-001");
    expect(body.plan).toBeUndefined();
    expect((await store.getChat(chat.id))!.pending).toBeUndefined();
  });

  it("answers a question without touching pending", async () => {
    const app = api({ reply: "checkout-001 failed on a 500 from POST /api/coupon.", action: "answer" });
    const chat = await newChat(app);
    const body = await (await send(app, chat.id, "why did the coupon test fail?")).json();
    expect(body.action).toBe("answer");
    expect(body.reply).toContain("500");
    expect((await store.getChat(chat.id))!.pending).toBeUndefined();
  });

  it("explains when there is no finished run to work from, without calling the model", async () => {
    const llm = new FakeLlmClient({});
    const app = createApi({ store, start: (i) => ({ runId: i.runId }), llm, contextLoginSteps: () => null, rerunTests: async () => [] });
    const { headers: h2 } = await signIn("nobody@example.com");
    const res = await app.request(`${ORIGIN}/copilot/chats`, { method: "POST", headers: h2, body: "{}" });
    const { chat } = await res.json();
    const body = await (await app.request(`${ORIGIN}/copilot/chats/${chat.id}/messages`, { method: "POST", headers: h2, body: JSON.stringify({ text: "rerun what failed" }) })).json();
    expect(body.action).toBe("clarify");
    expect(body.reply).toMatch(/no finished run/i);
    expect(llm.calls).toBe(0);
  });

  it("rejects an empty message and a foreign chat", async () => {
    const app = api(RERUN);
    const chat = await newChat(app);
    expect((await send(app, chat.id, "   ")).status).toBe(400);
    const { headers: h2 } = await signIn("other@example.com");
    const foreign = await app.request(`${ORIGIN}/copilot/chats/${chat.id}/messages`, { method: "POST", headers: h2, body: JSON.stringify({ text: "hi" }) });
    expect(foreign.status).toBe(404);
  });

  it("does not serve an intake chat through the copilot routes", async () => {
    const app = api(RERUN);
    const { chat } = await (await app.request(`${ORIGIN}/chats`, { method: "POST", headers })).json();
    expect((await send(app, chat.id, "hi")).status).toBe(404);
  });
});

describe("copilot execute", () => {
  it("runs the pending plan with the in-memory login, stores the result and clears pending", async () => {
    const app = api(RERUN, { context: [{ action: "goto", target: "/login" }] });
    const chat = await newChat(app);
    await send(app, chat.id, "rerun the failed checkout tests");
    const res = await execute(app, chat.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toBe("1 of 2 passed. checkout-001 still fails: Error: still 500");
    expect(body.result.kind).toBe("rerun_result");
    expect(body.result.results.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([["checkout-001", "failed"], ["checkout-002", "passed"]]);
    expect(calls).toEqual([{ runId: "shop-1", testIds: ["checkout-001", "checkout-002"], loginSteps: [{ action: "goto", target: "/login" }] }]);
    const stored = (await store.getChat(chat.id))!;
    expect(stored.pending).toBeUndefined();
    expect(stored.messages.at(-1)).toMatchObject({ role: "assistant", text: body.reply, data: body.result });
  });

  it("hydrates the login file with the credentials from the request and never stores them", async () => {
    const app = api(RERUN, { context: null });
    const chat = await newChat(app);
    await send(app, chat.id, "rerun the failed checkout tests");
    const res = await execute(app, chat.id, { credentials: { username: "demo@shop.test", password: "demo1234" } });
    expect(res.status).toBe(200);
    expect(calls[0].loginSteps.map((s) => s.value)).toEqual(["demo@shop.test", "demo1234"]);
    expect(JSON.stringify(await store.getChat(chat.id))).not.toContain("demo1234");
  });

  it("answers 409 with needs when credentials are required but missing", async () => {
    const app = api(RERUN, { context: null });
    const chat = await newChat(app);
    await send(app, chat.id, "rerun the failed checkout tests");
    const res = await execute(app, chat.id);
    expect(res.status).toBe(409);
    expect((await res.json()).needs).toEqual(["credentials"]);
    expect(calls).toEqual([]);
    expect((await store.getChat(chat.id))!.pending).toBeDefined();
  });

  it("answers 409 when nothing is pending", async () => {
    const app = api(RERUN);
    const chat = await newChat(app);
    expect((await execute(app, chat.id)).status).toBe(409);
  });

  it("answers 409 while the run is in progress", async () => {
    const app = api(RERUN, { context: [] });
    const chat = await newChat(app);
    await send(app, chat.id, "rerun the failed checkout tests");
    await store.updateRun("shop-1", { status: "running", heartbeatAt: new Date().toISOString() });
    expect((await execute(app, chat.id)).status).toBe(409);
  });

  it("answers 409 to a second execute while the first is in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const app = createApi({
      store, start: (i) => ({ runId: i.runId }),
      llm: new FakeLlmClient({ "copilot-turn": RERUN }),
      contextLoginSteps: () => [],
      rerunTests: async (_runId, testIds) => { await gate; return testIds.map((id): TestResult => ({ id, file: "f", title: id, status: "passed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 })); },
    });
    const chat = await newChat(app);
    await send(app, chat.id, "rerun the failed checkout tests");
    const first = execute(app, chat.id);
    const second = await execute(app, chat.id);
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });
});
