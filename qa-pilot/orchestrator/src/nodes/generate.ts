import { z } from "zod";
import { Send } from "@langchain/langgraph";
import type { Page } from "playwright";
import { BrowserToolkit } from "../browser/toolkit.js";
import { outputDir, type Expectation, type Flow, type RunState, type RunUpdate } from "../state.js";
import { actionCode, expectLines, renderSpec, DEFAULT_FIXTURES_IMPORT } from "../codegen/template.js";
import { writeOutput } from "../output.js";
import { runPlaywright } from "./run.js";
import { now, type NodeDeps } from "./deps.js";

export const SelfRepairSchema = z.object({ source: z.string(), reason: z.string() });
export const ExpectRepairSchema = z.object({ role: z.string(), name: z.string(), value: z.string().optional(), reason: z.string(), confidence: z.number().min(0).max(1) });

/** A URL fragment worth asserting: a real path or route, not the bare root that every URL contains. */
const MEANINGFUL_URL_FRAGMENT = /^[A-Za-z0-9/._~%?=&#-]+$/;
const isMeaningfulFragment = (v: string) => MEANINGFUL_URL_FRAGMENT.test(v) && /[A-Za-z0-9]/.test(v);

/**
 * Live assertion validation. An expectation that is false on the page the flow just
 * produced is either a planner slip or a real defect. One LLM call decides which, and its
 * answer is kept only when it verifies live:
 * - an element expectation may move to another element of the same role, or to an element
 *   of any role when the expectation carries text, since the text is then what is asserted;
 * - a URL expectation may take the route the app really reached, provided it is a real path.
 * When nothing fits, the original expectation is emitted unchanged, so the runner fails on it
 * and the classifier gets to call the defect. Returns the expect line to emit.
 */
async function validateExpectation(
  kit: BrowserToolkit, page: Page, flow: Flow, index: number, startUrl: string, deps: NodeDeps, agent: string,
): Promise<{ code: string; expectation: Expectation; llmCalls: number }> {
  const exp = flow.expected[index];
  const check = await kit.checkExpectation(page, exp, startUrl);
  if (check.ok) return { code: check.code, expectation: exp, llmCalls: 0 };
  const isUrl = exp.type === "url_contains" || exp.type === "url_stays";
  const describe = isUrl
    ? `${exp.type} "${exp.value ?? exp.text_contains ?? ""}"`
    : `${exp.type} ${exp.role ?? ""} ${exp.name ? `"${exp.name}"` : ""}${exp.text_contains ? ` containing "${exp.text_contains}"` : ""}`.replace(/\s+/g, " ").trim();
  if (!isUrl && !exp.role) {
    deps.bus.log(agent, `expectation ${index} (${describe}) not true live (actual: ${check.actual.slice(0, 80)}); emitting for the runner to judge`);
    return { code: check.code, expectation: exp, llmCalls: 0 };
  }
  try {
    const snapshot = await kit.snapshot(page);
    const repair = await deps.llm.complete({
      prompt: "expect-repair",
      input: `FLOW: ${flow.title}\nEXPECTATION ${index}: ${describe}\nACTUAL: ${check.actual.slice(0, 200)}\nCURRENT URL: ${page.url()}\nSNAPSHOT:\n${snapshot}`,
      schema: ExpectRepairSchema,
      effort: "medium",
    });
    const accept = async (candidate: Expectation, label: string) => {
      const again = await kit.checkExpectation(page, candidate, startUrl);
      if (again.ok) {
        deps.bus.decision({ node: "generate", reason: `${flow.id}: re-targeted expectation ${index} from ${describe} to ${label}`, evidence: [repair.reason, `before: ${check.code}`, `after: ${again.code}`], next: "continue", at: now() });
        return { code: again.code, expectation: candidate };
      }
      deps.bus.log(agent, `expectation ${index}: suggested ${label} is not true live either (actual: ${again.actual.slice(0, 80)}); keeping the original`);
      return null;
    };
    let code: { code: string; expectation: Expectation } | null = null;
    if (repair.confidence < 0.5) {
      deps.bus.log(agent, `expectation ${index} (${describe}) has no substitute on the page (${repair.reason}); emitting for the runner to judge`);
    } else if (isUrl) {
      const value = repair.value ?? "";
      if (isMeaningfulFragment(value)) code = await accept({ ...exp, value, text_contains: undefined }, `${exp.type} "${value}"`);
      else deps.bus.log(agent, `expectation ${index}: rejected URL fragment "${value}"; keeping the original`);
    } else if (repair.role === exp.role || exp.text_contains) {
      const candidate = { ...exp, role: repair.role, name: repair.name || undefined };
      code = await accept(candidate, `${repair.role} ${repair.name ? `"${repair.name}"` : ""}`.trim());
    } else {
      deps.bus.log(agent, `expectation ${index}: rejected re-target to ${repair.role} "${repair.name}", which would change what is asserted; keeping the original`);
    }
    return { code: code?.code ?? check.code, expectation: code?.expectation ?? exp, llmCalls: 1 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.bus.emit({ type: "error", node: "generate", message: `expectation repair failed for ${flow.id}: ${message}` });
    return { code: check.code, expectation: exp, llmCalls: 0 };
  }
}

export function fanOutGenerate(state: RunState): Send[] {
  return state.plan.map((flow) => new Send("generateFlow", { ...state, currentFlow: flow } as RunState));
}

export async function generateFlowNode(state: RunState, deps: NodeDeps): Promise<RunUpdate> {
  const flow = state.currentFlow!;
  const agent = `generator:${flow.id}`;
  deps.bus.emit({ type: "node_start", node: "generate", message: flow.id });
  const kit = await BrowserToolkit.launch({ headless: deps.headless, baseUrl: state.url, bus: deps.bus, runId: state.runId, agent, screenshotDir: outputDir(state.runId) + "traces/generate" });
  try {
    const page = await kit.newPage();
    const stepCodes: string[] = [];
    const expectCodes: string[] = [];
    const effective: Expectation[] = [];
    let llmCalls = 0;
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
      for (let i = 0; i < flow.expected.length; i++) {
        const validated = await validateExpectation(kit, page, flow, i, startUrl, deps, agent);
        expectCodes.push(validated.code);
        effective.push(validated.expectation);
        llmCalls += validated.llmCalls;
      }
    } finally {
      await page.close();
    }

    let source = renderSpec(flow, stepCodes, expectCodes, process.env.QA_PILOT_FIXTURES ?? DEFAULT_FIXTURES_IMPORT);
    const file = writeOutput(state.runId, `tests/${flow.id}.spec.ts`, source);
    const loginSteps = state.siteMap?.loginSteps ?? [];
    let results = await runPlaywright({ runId: state.runId, baseUrl: state.url, loginSteps, files: [file], bus: deps.bus });
    let result = results.tests.find((t) => t.id === flow.id);

    if (result && result.status !== "passed" && result.failingStep !== undefined) {
      try {
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
        llmCalls += 1;
        if (JSON.stringify(expectLines(repaired.source)) === JSON.stringify(before)) {
          source = repaired.source;
          writeOutput(state.runId, `tests/${flow.id}.spec.ts`, source);
          deps.bus.log(agent, `self-repair applied: ${repaired.reason}`);
          results = await runPlaywright({ runId: state.runId, baseUrl: state.url, loginSteps, files: [file], bus: deps.bus });
          result = results.tests.find((t) => t.id === flow.id);
        } else {
          deps.bus.log(agent, "self-repair rejected: it changed an expect line");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.bus.log(agent, `self-repair failed: ${message}`);
        deps.bus.emit({ type: "error", node: "generate", message: `self-repair failed for ${flow.id}: ${message}` });
      }
    }
    deps.bus.emit({ type: "node_end", node: "generate", message: flow.id, data: { status: result?.status } });
    const retargeted = JSON.stringify(effective) !== JSON.stringify(flow.expected);
    return { testFiles: [file], llmCalls: state.llmCalls + llmCalls, ...(retargeted ? { expectations: { [flow.id]: effective } } : {}) };
  } finally {
    await kit.close();
  }
}

function unresolved(deps: NodeDeps, flow: Flow, why: string): RunUpdate {
  deps.bus.decision({ node: "generate", reason: `flow ${flow.id} skipped: ${why}`, evidence: [flow.title], next: "continue", at: now() });
  deps.bus.emit({ type: "node_end", node: "generate", message: flow.id, data: { status: "unresolved" } });
  return { unresolvedFlows: [flow.id] };
}
