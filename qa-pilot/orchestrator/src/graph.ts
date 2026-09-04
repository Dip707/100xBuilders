import { StateGraph, START, END, Send } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { RunStateAnnotation, type RunState, type RunUpdate } from "./state.js";
import { budgetExceeded } from "./budget.js";
import { exploreNode } from "./nodes/explore.js";
import { planNode } from "./nodes/plan.js";
import { coverageNode, afterCoverage } from "./nodes/coverage.js";
import { generateFlowNode, fanOutGenerate } from "./nodes/generate.js";
import { runNode } from "./nodes/run.js";
import { classifyNode, afterClassify } from "./nodes/classify.js";
import { healNode, afterHeal } from "./nodes/heal.js";
import { reportNode } from "./nodes/report.js";
import { now, type NodeDeps } from "./nodes/deps.js";

type NodeFn = (state: RunState, deps: NodeDeps) => Promise<RunUpdate>;

export function buildGraph(deps: NodeDeps, opts: { checkpointPath?: string } = {}) {
  /** Skips the node and marks the run partial when the budget is gone. */
  const guarded = (name: string, fn: NodeFn) => async (state: RunState): Promise<RunUpdate> => {
    if (state.partial) return {};
    const why = budgetExceeded(state);
    if (why) {
      deps.bus.decision({ node: name, reason: `budget exceeded (${why}); finishing with partial results`, evidence: [why], next: "report", at: now() });
      return { partial: true, partialReason: `budget exceeded: ${why}` };
    }
    try {
      return await fn(state, deps);
    } catch (err) {
      const firstLine = (err as Error).message.split("\n")[0];
      deps.bus.emit({ type: "error", node: name, message: (err as Error).message });
      deps.bus.decision({ node: name, reason: `node failed: ${firstLine}; finishing with partial results`, evidence: [], next: "report", at: now() });
      return { partial: true, partialReason: `${name} failed: ${firstLine}` };
    }
  };
  const orReport = <T extends string>(next: T) => (state: RunState): T | "report" => (state.partial ? "report" : next);

  const prepareRerun = async (state: RunState): Promise<RunUpdate> => {
    const ids = state.classifications.filter((c) => c.action === "rerun").map((c) => c.test);
    const rerunAttempts: Record<string, number> = {};
    for (const id of ids) rerunAttempts[id] = (state.rerunAttempts[id] ?? 0) + 1;
    return { testsToRun: ids, rerunAttempts };
  };

  // The state annotation has a "plan" channel (the Flow[] test plan), and LangGraph rejects a node whose
  // name collides with a state channel name - so the plan node is graphed as "planFlows" while the
  // `guarded("plan", ...)` label (used only for decision/event logging) stays "plan".
  const graph = new StateGraph(RunStateAnnotation)
    .addNode("explore", guarded("explore", exploreNode))
    .addNode("planFlows", guarded("plan", planNode))
    .addNode("evaluate_coverage", guarded("evaluate_coverage", coverageNode))
    .addNode("generateFlow", guarded("generate", generateFlowNode))
    .addNode("run", guarded("run", runNode))
    .addNode("classify", guarded("classify", classifyNode))
    .addNode("prepareRerun", prepareRerun)
    .addNode("heal", guarded("heal", healNode))
    .addNode("report", (state: RunState) => reportNode(state, deps))
    .addEdge(START, "explore")
    .addConditionalEdges("explore", orReport("planFlows"), ["planFlows", "report"])
    .addConditionalEdges("planFlows", orReport("evaluate_coverage"), ["evaluate_coverage", "report"])
    .addConditionalEdges("evaluate_coverage", (state: RunState): string | Send[] => {
      if (state.partial) return "report";
      const next = afterCoverage(state, deps);
      if (next === "plan") return "planFlows";
      if (state.plan.length === 0) {
        deps.bus.decision({ node: "evaluate_coverage", reason: "no flows survived planning", evidence: [], next: "report", at: now() });
        return "report";
      }
      return fanOutGenerate(state);
    }, ["planFlows", "generateFlow", "report"])
    .addConditionalEdges("generateFlow", orReport("run"), ["run", "report"])
    .addConditionalEdges("run", orReport("classify"), ["classify", "report"])
    .addConditionalEdges("classify", (state: RunState): string => {
      if (state.partial) return "report";
      const next = afterClassify(state, deps);
      return next === "rerun" ? "prepareRerun" : next;
    }, ["heal", "prepareRerun", "report"])
    .addEdge("prepareRerun", "run")
    .addConditionalEdges("heal", (state: RunState): string => (state.partial ? "report" : afterHeal(state, deps)), ["run", "report"])
    .addEdge("report", END);

  const checkpointer = SqliteSaver.fromConnString(opts.checkpointPath ?? ":memory:");
  return graph.compile({ checkpointer });
}

export type CompiledGraph = ReturnType<typeof buildGraph>;
export { Send };
