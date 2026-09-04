import "./env.js";
import { getBus, type EventBus } from "./events.js";
import { disposeScreencast } from "./browser/screencast.js";
import { makeLlmClient, type LlmClient } from "./llm/client.js";
import { buildGraph, REVIEW_NODE } from "./graph.js";
import { FlowSchema, initialState, outputDir, StartRunInputSchema, type Flow, type StartRunInput, type RunState } from "./state.js";
import { z } from "zod";
import { readOutput, writeOutput } from "./output.js";
import { defaultStore } from "./store/index.js";
import type { RunRecord, Store } from "./store/types.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { runPlaywright } from "./nodes/run.js";
import type { RunResults, Step, TestResult } from "./state.js";

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

// ---------- Plan review ----------

/**
 * Runs paused at the review gate, keyed by run id. The graph is checkpointed, so the pause
 * itself survives anything; this map only holds the resolver that wakes the in-process
 * loop in `startRun`. A run that is not in here is not waiting for review.
 */
const pendingReviews = new Map<string, (plan: Flow[]) => void>();

export const ReviewSubmissionSchema = z.object({ flows: z.array(FlowSchema) });

export function awaitingReview(runId: string): boolean {
  return pendingReviews.has(runId);
}

/**
 * Hands the reviewed plan to the paused run and lets it continue. Returns false when the
 * run is not waiting, so the API can answer 409 instead of silently dropping the plan.
 */
export function submitReview(runId: string, flows: Flow[]): boolean {
  const resume = pendingReviews.get(runId);
  if (!resume) return false;
  pendingReviews.delete(runId);
  resume(flows);
  return true;
}

function waitForReview(runId: string): Promise<Flow[]> {
  return new Promise((resolve) => pendingReviews.set(runId, resolve));
}

// ---------- Single-test rerun ----------

/**
 * What a finished run leaves behind in memory so one of its tests can be executed again:
 * the target and the login steps, which carry the target app's credentials and are
 * therefore deliberately never written to disk. A run from an earlier process has no
 * context here and cannot be re-run; the caller reports that rather than failing at login.
 */
const runContexts = new Map<string, { url: string; loginSteps: Step[] }>();
const rerunsInFlight = new Set<string>();

const specPath = (runId: string, testId: string) => `${outputDir(runId)}tests/${testId}.spec.ts`;

/** Whether a generated spec relies on the login fixture, which needs the credentials only a live run context holds. */
function needsLogin(file: string): boolean {
  return /\bawait login\(\)/.test(readFileSync(file, "utf8"));
}

/**
 * Why a test cannot be re-run right now, or null when it can. A run from an earlier API
 * process has no context here, so its tests can still be re-run only if they never sign in.
 */
export async function rerunBlocker(runId: string, testId: string, store: Store): Promise<string | null> {
  const file = specPath(runId, testId);
  if (!existsSync(file)) return "test not found";
  if (runContexts.has(runId)) return null;
  if (needsLogin(file)) return "this test signs in to the target app and the run's credentials are no longer in memory; start a new run to test it again";
  return (await store.getRun(runId)) ? null : "run not found";
}

/**
 * Re-executes one generated test in place. The new result is emitted on the bus like any
 * other, merged into results.json, and reflected in the stored pass/fail counts, so the
 * "latest status" of the test moves without starting a whole new run. Returns null when the
 * test cannot run (see `rerunBlocker`) or is already being re-run.
 */
export async function rerunTest(runId: string, testId: string, store: Store): Promise<TestResult | null> {
  if (await rerunBlocker(runId, testId, store)) return null;
  const file = specPath(runId, testId);
  const ctx = runContexts.get(runId) ?? { url: (await store.getRun(runId))!.url, loginSteps: [] };
  const key = `${runId}/${testId}`;
  if (rerunsInFlight.has(key)) return null;
  rerunsInFlight.add(key);
  const bus = getBus(runId);
  try {
    bus.log("orchestrator", `re-running ${testId}`);
    const fresh = await runPlaywright({ runId, baseUrl: ctx.url, loginSteps: ctx.loginSteps, files: [file], bus });
    const result = fresh.tests.find((t) => t.id === testId) ?? null;
    if (!result) return null;
    const previous = JSON.parse(readOutput(runId, "results.json") ?? '{"tests":[]}') as RunResults;
    const merged = new Map(previous.tests.map((t) => [t.id, t]));
    merged.set(testId, result);
    const tests = [...merged.values()];
    writeOutput(runId, "results.json", { tests, at: fresh.at });
    await record(store, bus, runId, {
      testsPassed: tests.filter((t) => t.status === "passed").length,
      testsFailed: tests.filter((t) => t.status !== "passed").length,
    });
    return result;
  } finally {
    rerunsInFlight.delete(key);
  }
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
  const headless = opts.headless ?? process.env.QA_PILOT_HEADLESS !== "0";
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

  const config = { configurable: { thread_id: parsed.runId }, recursionLimit: 100 };

  /**
   * Drives the graph to completion. `invoke` returns early when it reaches the review
   * interrupt; the loop then parks until the reviewer submits a plan, writes that plan into
   * the checkpoint as the review node's own output, and resumes from there. The reviewed
   * plan is also written to disk so plan.json reflects what actually ran.
   */
  const drive = async (): Promise<RunState> => {
    let s = (await graph.invoke(state, config)) as RunState;
    while ((await graph.getState(config)).next.includes(REVIEW_NODE)) {
      bus.emit({ type: "node_start", node: REVIEW_NODE, data: { flows: s.plan.length } });
      bus.log("orchestrator", `plan ready: ${s.plan.length} flows held for review`);
      await record(store, bus, parsed.runId, { status: "awaiting_review" });
      const plan = await waitForReview(parsed.runId);
      await record(store, bus, parsed.runId, { status: "running" });
      bus.log("orchestrator", `review submitted: ${plan.length} of ${s.plan.length} flows kept`);
      writeOutput(parsed.runId, "plan.json", plan);
      // Written as the review node's own output, which marks the node executed; the graph
      // resumes from its outgoing edge, so the node body itself never runs.
      await graph.updateState(config, { plan }, REVIEW_NODE);
      bus.emit({ type: "node_end", node: REVIEW_NODE, data: { flows: plan.length } });
      s = (await graph.invoke(null, config)) as RunState;
    }
    return s;
  };

  const done = drive()
    .then((s) => ({ ...s, llmCalls: Math.max(s.llmCalls, llm.calls) }) as RunState)
    .then(async (s) => {
      unsubscribe();
      // Frames are only meaningful while the run is live, and each hub retains a JPEG per
      // agent; releasing it here keeps a long-lived API process from hoarding one set per run.
      disposeScreencast(parsed.runId);
      runContexts.set(parsed.runId, { url: s.url, loginSteps: s.siteMap?.loginSteps ?? [] });
      await record(store, bus, parsed.runId, summarise(s, state.startedAt));
      return s;
    })
    .catch(async (err: Error) => {
      unsubscribe();
      disposeScreencast(parsed.runId);
      pendingReviews.delete(parsed.runId);
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
