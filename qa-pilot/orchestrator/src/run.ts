import "./env.js";
import { getBus } from "./events.js";
import { makeLlmClient, type LlmClient } from "./llm/client.js";
import { buildGraph } from "./graph.js";
import { initialState, outputDir, RunInputSchema, type RunInput, type RunState } from "./state.js";
import { writeOutput } from "./output.js";
import { mkdirSync } from "node:fs";

export function newRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

export function startRun(input: RunInput, opts: { headless?: boolean; llm?: LlmClient } = {}): { runId: string; done: Promise<RunState> } {
  const parsed = RunInputSchema.parse(input);
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
  bus.emit({ type: "agent_log", agent: "orchestrator", message: `run ${parsed.runId} started for ${parsed.url}` });
  const done = graph
    .invoke(state, { configurable: { thread_id: parsed.runId }, recursionLimit: 100 })
    .then((s) => ({ ...s, llmCalls: Math.max(s.llmCalls, llm.calls) }) as RunState)
    .catch((err: Error) => {
      bus.emit({ type: "error", message: err.message });
      bus.emit({ type: "done", message: "failed" });
      throw err;
    });
  return { runId: parsed.runId, done };
}
