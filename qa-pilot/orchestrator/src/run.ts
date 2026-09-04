import "./env.js";
import { getBus, type EventBus } from "./events.js";
import { makeLlmClient, type LlmClient } from "./llm/client.js";
import { buildGraph } from "./graph.js";
import { initialState, outputDir, StartRunInputSchema, type StartRunInput, type RunState } from "./state.js";
import { writeOutput } from "./output.js";
import { defaultStore } from "./store/index.js";
import type { RunRecord, Store } from "./store/types.js";
import { mkdirSync } from "node:fs";

export function newRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

/** Derives the stored summary from the graph's final state. Pure, so it is unit-tested directly. */
export function summarise(state: RunState, startedAt: string, finishedAt: string = new Date().toISOString()): Partial<RunRecord> {
  const tests = state.results?.tests ?? [];
  return {
    status: state.partial ? "partial" : "done",
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    coverageScore: state.coverage?.score,
    planIterations: state.planIterations,
    flowsTotal: state.plan.length,
    testsPassed: tests.filter((t) => t.status === "passed").length,
    // Anything that is not "passed" counts against the run: timedOut, interrupted and
    // skipped are all failures from the point of view of a history row.
    testsFailed: tests.filter((t) => t.status !== "passed").length,
    healsAccepted: state.healLog.filter((h) => h.accepted).length,
    defectsCount: state.defects.length,
    llmCalls: state.llmCalls,
    partialReason: state.partialReason,
  };
}

/** Recording must never take a run down with it, so every store write here is best-effort and reported. */
async function record(store: Store, bus: EventBus, runId: string, patch: Partial<RunRecord>): Promise<void> {
  try {
    await store.updateRun(runId, patch);
  } catch (err) {
    bus.log("orchestrator", `could not record run summary: ${(err as Error).message}`);
  }
}

export async function startRun(
  input: StartRunInput,
  opts: { headless?: boolean; llm?: LlmClient; store?: Store } = {},
): Promise<{ runId: string; done: Promise<RunState> }> {
  const parsed = StartRunInputSchema.parse(input);
  const store = opts.store ?? (await defaultStore());
  mkdirSync(outputDir(parsed.runId), { recursive: true });
  // heal.ts only writes heal-log.json when the heal node actually runs; many runs never hit a
  // "heal" classification (e.g. straight to rerun/escalate), so seed the file here to guarantee
  // the output contract - it's overwritten with the real log if heal does run.
  writeOutput(parsed.runId, "heal-log.json", []);

  const bus = getBus(parsed.runId);
  const llm = opts.llm ?? makeLlmClient(bus);
  const headless = opts.headless ?? process.env.QA_PILOT_HEADLESS === "1";
  const graph = buildGraph({ bus, llm, headless }, { checkpointPath: outputDir(parsed.runId) + "checkpoint.db" });
  const state = initialState(parsed);

  // Inserted before this function resolves, so a caller that immediately navigates to
  // /runs/<id> cannot race a 404. Only url, intent and a hasPrd flag are stored: the
  // credentials for the application under test stay in memory for the run's lifetime.
  await store.insertRun({
    id: parsed.runId,
    userId: parsed.userId,
    url: state.url,
    intent: parsed.intent,
    hasPrd: Boolean(parsed.prdText),
    status: "running",
    startedAt: state.startedAt,
  });

  // A run whose process dies would say "running" forever. Each finished node stamps a
  // heartbeat, and the store reports a running record with a stale heartbeat as
  // interrupted. Fire and forget: a slow store must not stall the graph.
  const unsubscribe = bus.subscribe((e) => {
    if (e.type === "node_end") void store.touchRun(parsed.runId).catch(() => {});
  });

  bus.emit({ type: "agent_log", agent: "orchestrator", message: `run ${parsed.runId} started for ${parsed.url}` });

  const done = graph
    .invoke(state, { configurable: { thread_id: parsed.runId }, recursionLimit: 100 })
    .then((s) => ({ ...s, llmCalls: Math.max(s.llmCalls, llm.calls) }) as RunState)
    .then(async (s) => {
      unsubscribe();
      await record(store, bus, parsed.runId, summarise(s, state.startedAt));
      return s;
    })
    .catch(async (err: Error) => {
      unsubscribe();
      const finishedAt = new Date().toISOString();
      await record(store, bus, parsed.runId, {
        status: "failed",
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(state.startedAt),
        partialReason: err.message,
      });
      bus.emit({ type: "error", message: err.message });
      bus.emit({ type: "done", message: "failed" });
      throw err;
    });

  return { runId: parsed.runId, done };
}
