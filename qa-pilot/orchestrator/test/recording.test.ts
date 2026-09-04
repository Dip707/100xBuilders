import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { FakeLlmClient } from "../src/llm/client.js";
import { memoryStore } from "../src/store/memory.js";
import type { Store } from "../src/store/types.js";
import { startRun, summarise } from "../src/run.js";
import { initialState, type RunState } from "../src/state.js";

function state(over: Partial<RunState> = {}): RunState {
  // initialState parses RunInputSchema, which per Ruling 1 deliberately has no userId field -
  // it is not needed here since summarise() reads only graph state, never the account.
  return { ...initialState({ runId: "r", url: "http://localhost:3005" }), ...over };
}

describe("summarise", () => {
  it("maps a completed run onto the record fields", () => {
    const s = state({
      partial: false,
      coverage: { score: 0.82, gaps: [], untested_risk: [], checks: {}, prdRequirements: [], prdMatrix: {} },
      planIterations: 2,
      plan: [{ id: "a" }, { id: "b" }, { id: "c" }] as RunState["plan"],
      results: { at: "now", tests: [
        { status: "passed" }, { status: "passed" }, { status: "failed" }, { status: "timedOut" },
      ] as NonNullable<RunState["results"]>["tests"] },
      healLog: [{ accepted: true }, { accepted: false }, { accepted: true }] as RunState["healLog"],
      defects: [{ id: "d1" }] as RunState["defects"],
      llmCalls: 17,
    });
    const out = summarise(s, "2026-09-04T10:00:00.000Z", "2026-09-04T10:05:00.000Z");
    expect(out).toMatchObject({
      status: "done", coverageScore: 0.82, planIterations: 2, flowsTotal: 3,
      testsPassed: 2, testsFailed: 2, healsAccepted: 2, defectsCount: 1,
      llmCalls: 17, durationMs: 300_000, finishedAt: "2026-09-04T10:05:00.000Z",
    });
  });

  it("reports a budget-stopped run as partial and keeps the reason", () => {
    const out = summarise(state({ partial: true, partialReason: "llm budget exceeded" }), new Date().toISOString());
    expect(out.status).toBe("partial");
    expect(out.partialReason).toBe("llm budget exceeded");
  });

  it("counts anything that is not passed as a failure, and copes with no results at all", () => {
    expect(summarise(state(), new Date().toISOString())).toMatchObject({ testsPassed: 0, testsFailed: 0, flowsTotal: 0 });
  });
});

describe("startRun recording", () => {
  // The real FakeLlmClient from src/llm/client.ts, with no canned answers: exploration of
  // mini-shop succeeds, then the plan node throws "no canned answer for prompt plan". That is
  // deterministic, unlike relying on a refused TCP port, where whether the graph rejects
  // depends on how the explore node handles a connection error. Every node graph.ts wraps
  // with `guarded()` (see buildGraph) catches its own error and turns it into
  // { partial: true, partialReason }, then routes straight to report - so the graph resolves
  // rather than rejecting for a node-level failure.
  let shop: Awaited<ReturnType<typeof startShop>>;
  let store: Store;

  beforeAll(async () => { shop = await startShop(); });
  afterAll(async () => { await shop.stop(); });
  beforeEach(() => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-rec-")) + "/";
    store = memoryStore();
  });

  it("inserts the run as running before it resolves, and never stores target credentials", async () => {
    const { runId, done } = await startRun(
      { runId: "rec-1", url: shop.base + "/", userId: "u1", intent: "focus on auth",
        credentials: { username: "demo@shop.test", password: "demo1234" },
        prdText: "the app must let a user log in", maxFlows: 12, budget: { maxLlmCalls: 200, maxMinutes: 40 } },
      { headless: true, store, llm: new FakeLlmClient({}) },
    );
    // The document exists the moment startRun resolves, before the graph has finished.
    const rec = await store.getRun(runId);
    expect(rec).toMatchObject({ id: "rec-1", userId: "u1", status: "running", intent: "focus on auth", hasPrd: true });
    expect(rec!.url).toBe(shop.base);                        // trailing slash normalised away
    expect(JSON.stringify(rec)).not.toContain("demo1234");    // credentials are never persisted
    expect(JSON.stringify(rec)).not.toContain("must let a user log in");

    await done.catch(() => {});
  });

  it("marks the run partial with the error message when a node fails", async () => {
    const { done } = await startRun(
      { runId: "rec-2", url: shop.base, userId: "u1", maxFlows: 12, budget: { maxLlmCalls: 200, maxMinutes: 40 } },
      { headless: true, store, llm: new FakeLlmClient({}) },
    );
    // The plan node's error is caught inside graph.ts's guarded() wrapper, so `done`
    // resolves (not rejects) with state.partial = true; startRun's normal completion path
    // records the reason via summarise().
    await done;
    const rec = await store.getRun("rec-2");
    expect(rec!.status).toBe("partial");
    expect(rec!.partialReason).toContain("canned answer");
    expect(rec!.finishedAt).toBeTruthy();
  });

  it("advances the heartbeat as nodes finish", async () => {
    const { done } = await startRun(
      { runId: "rec-3", url: shop.base, userId: "u1", maxFlows: 12, budget: { maxLlmCalls: 200, maxMinutes: 40 } },
      { headless: true, store, llm: new FakeLlmClient({}) },
    );
    await done.catch(() => {});
    // explore emits node_end before plan throws, so a heartbeat must have been stamped.
    expect((await store.getRun("rec-3"))!.heartbeatAt).toBeTruthy();
  });
});
