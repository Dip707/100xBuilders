import { z } from "zod";
import { Send } from "@langchain/langgraph";
import { BrowserToolkit } from "../browser/toolkit.js";
import { outputDir, type Flow, type RunState, type RunUpdate } from "../state.js";
import { actionCode, expectLines, renderSpec, DEFAULT_FIXTURES_IMPORT } from "../codegen/template.js";
import { writeOutput } from "../output.js";
import { runPlaywright } from "./run.js";
import { now, type NodeDeps } from "./deps.js";

export const SelfRepairSchema = z.object({ source: z.string(), reason: z.string() });

export function fanOutGenerate(state: RunState): Send[] {
  return state.plan.map((flow) => new Send("generateFlow", { ...state, currentFlow: flow } as RunState));
}

export async function generateFlowNode(state: RunState, deps: NodeDeps): Promise<RunUpdate> {
  const flow = state.currentFlow!;
  const agent = `generator:${flow.id}`;
  deps.bus.emit({ type: "node_start", node: "generate", message: flow.id });
  const kit = await BrowserToolkit.launch({ headless: deps.headless, baseUrl: state.url, bus: deps.bus, agent, screenshotDir: outputDir(state.runId) + "traces/generate" });
  try {
    const page = await kit.newPage();
    const stepCodes: string[] = [];
    const expectCodes: string[] = [];
    try {
      if (flow.preconditions.includes("logged_in")) {
        for (const s of state.siteMap?.loginSteps ?? []) if (!(await kit.act(page, s))) return unresolved(deps, flow, "login fixture failed");
      }
      for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i];
        const r = await kit.act(page, step);
        if (!r) return unresolved(deps, flow, `step ${i} (${step.role} "${step.name}") not found`);
        stepCodes.push(actionCode(step, r.code));
      }
      const startUrl = page.url();
      for (const exp of flow.expected) {
        const check = await kit.checkExpectation(page, exp, startUrl);
        if (!check.ok) deps.bus.log(agent, `expectation ${exp.type} not true live (actual: ${check.actual.slice(0, 80)}); emitting for the runner to judge`);
        expectCodes.push(check.code);
      }
    } finally {
      await page.close();
    }

    let source = renderSpec(flow, stepCodes, expectCodes, process.env.QA_PILOT_FIXTURES ?? DEFAULT_FIXTURES_IMPORT);
    const file = writeOutput(state.runId, `tests/${flow.id}.spec.ts`, source);
    const loginSteps = state.siteMap?.loginSteps ?? [];
    let results = await runPlaywright({ runId: state.runId, baseUrl: state.url, loginSteps, files: [file], bus: deps.bus });
    let result = results.tests.find((t) => t.id === flow.id);
    let llmCalls = 0;

    if (result && result.status !== "passed" && result.failingStep !== undefined) {
      const snapPage = await kit.newPage();
      let snapshot = "";
      try {
        if (flow.preconditions.includes("logged_in")) for (const s of loginSteps) await kit.act(snapPage, s);
        for (let i = 0; i < result.failingStep; i++) await kit.act(snapPage, flow.steps[i]);
        snapshot = await kit.snapshot(snapPage);
      } finally {
        await snapPage.close();
      }
      const before = expectLines(source);
      const repaired = await deps.llm.complete({ prompt: "self-repair", input: `SOURCE:\n${source}\n\nERROR:\n${result.error}\n\nSNAPSHOT AT STEP ${result.failingStep}:\n${snapshot}`, schema: SelfRepairSchema, effort: "medium" });
      llmCalls = 1;
      if (JSON.stringify(expectLines(repaired.source)) === JSON.stringify(before)) {
        source = repaired.source;
        writeOutput(state.runId, `tests/${flow.id}.spec.ts`, source);
        deps.bus.log(agent, `self-repair applied: ${repaired.reason}`);
        results = await runPlaywright({ runId: state.runId, baseUrl: state.url, loginSteps, files: [file], bus: deps.bus });
        result = results.tests.find((t) => t.id === flow.id);
      } else {
        deps.bus.log(agent, "self-repair rejected: it changed an expect line");
      }
    }
    deps.bus.emit({ type: "node_end", node: "generate", message: flow.id, data: { status: result?.status } });
    return { testFiles: [file], llmCalls: state.llmCalls + llmCalls };
  } finally {
    await kit.close();
  }
}

function unresolved(deps: NodeDeps, flow: Flow, why: string): RunUpdate {
  deps.bus.decision({ node: "generate", reason: `flow ${flow.id} skipped: ${why}`, evidence: [flow.title], next: "continue", at: now() });
  deps.bus.emit({ type: "node_end", node: "generate", message: flow.id, data: { status: "unresolved" } });
  return { unresolvedFlows: [flow.id] };
}
