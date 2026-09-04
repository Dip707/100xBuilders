import { z } from "zod";
import { readFileSync } from "node:fs";
import { BrowserToolkit } from "../browser/toolkit.js";
import { resolveLocator } from "../browser/locators.js";
import { actionCode, expectLines } from "../codegen/template.js";
import { outputDir, type Classification, type Defect, type HealRecord, type RunState, type RunUpdate } from "../state.js";
import { writeOutput } from "../output.js";
import { makeDefect } from "./defects.js";
import { now, type NodeDeps } from "./deps.js";

export const HealSuggestionSchema = z.object({ role: z.string(), name: z.string(), reason: z.string(), confidence: z.number().min(0).max(1) });

export function patchStep(source: string, step: number, newLine: string): string {
  const lines = source.split("\n");
  const idx = lines.findIndex((l) => new RegExp(`^\\s*// step ${step}$`).test(l));
  if (idx < 0 || idx + 1 >= lines.length) throw new Error(`step ${step} not found in source`);
  const indent = /^\s*/.exec(lines[idx + 1])![0];
  lines[idx + 1] = indent + newLine;
  return lines.join("\n");
}

export function guardExpects(before: string, after: string): boolean {
  return JSON.stringify(expectLines(before)) === JSON.stringify(expectLines(after));
}

export async function healNode(state: RunState, deps: NodeDeps): Promise<RunUpdate> {
  deps.bus.emit({ type: "node_start", node: "heal" });
  const targets = state.classifications.filter((c) => c.action === "heal");
  const healAttempts: Record<string, number> = {};
  const healLog: HealRecord[] = [];
  const testsToRun: string[] = [];
  const defects: Defect[] = [];
  const classifications: Classification[] = state.classifications.map((c) => ({ ...c }));
  let llmCalls = state.llmCalls;
  const kit = await BrowserToolkit.launch({ headless: deps.headless, baseUrl: state.url, bus: deps.bus, agent: "healer", screenshotDir: outputDir(state.runId) + "traces/heal" });
  try {
    for (const c of targets) {
      const test = state.results!.tests.find((t) => t.id === c.test)!;
      const flow = state.plan.find((f) => f.id === c.test)!;
      const attempt = (state.healAttempts[c.test] ?? 0) + 1;
      healAttempts[c.test] = attempt;
      const stepIdx = test.failingStep;
      const step = stepIdx !== undefined ? flow.steps[stepIdx] : undefined;
      const source = readFileSync(test.file, "utf8");
      const reclassify = (why: string, evidence: string[]) => {
        const i = classifications.findIndex((x) => x.test === c.test);
        classifications[i] = { ...classifications[i], class: "defect", action: "escalate", evidence: [...classifications[i].evidence, why] };
        defects.push(makeDefect(state, c.test, test.error ?? why, [why, ...evidence]));
        deps.bus.decision({ node: "heal", reason: `${c.test}: ${why}; reclassified as defect`, evidence, next: "escalate", at: now() });
      };
      if (!step || step.action === "goto") {
        reclassify("failure is not at a locatable step; healing would require weakening an assertion", c.evidence);
        continue;
      }

      const page = await kit.newPage();
      try {
        if (flow.preconditions.includes("logged_in")) for (const s of state.siteMap?.loginSteps ?? []) await kit.act(page, s);
        for (let i = 0; i < stepIdx!; i++) await kit.act(page, flow.steps[i]);
        const snapshot = await kit.snapshot(page);
        let suggestion: z.infer<typeof HealSuggestionSchema>;
        try {
          suggestion = await deps.llm.complete({
            prompt: "heal",
            input: `FLOW: ${flow.title}\nSTEP ${stepIdx}: ${step.action} ${step.role} "${step.name}" intent: ${step.intent ?? "(none)"}\nSNAPSHOT:\n${snapshot}`,
            schema: HealSuggestionSchema,
            effort: "medium",
          });
          llmCalls++;
        } catch (e) {
          const message = (e as Error).message;
          deps.bus.emit({ type: "error", node: "heal", message: `${c.test}: healer LLM call failed: ${message}` });
          deps.bus.decision({ node: "heal", reason: `${c.test}: healer LLM call failed (${message}); leaving test unhealed`, evidence: [message], next: "report", at: now() });
          continue;
        }
        if (suggestion.confidence < 0.5) {
          reclassify(`no element accomplishes "${step.intent ?? step.name}" (healer confidence ${suggestion.confidence})`, [suggestion.reason]);
          continue;
        }
        const resolved = await resolveLocator(page, { role: suggestion.role, name: suggestion.name });
        if (!resolved) {
          reclassify(`suggested element ${suggestion.role} "${suggestion.name}" could not be resolved live`, [suggestion.reason]);
          continue;
        }
        const ok = await kit.act(page, { ...step, role: suggestion.role, name: suggestion.name });
        if (!ok) {
          reclassify(`acting on ${suggestion.role} "${suggestion.name}" failed live`, [suggestion.reason]);
          continue;
        }
        for (let i = stepIdx! + 1; i < flow.steps.length; i++) await kit.act(page, flow.steps[i]);
        const startUrl = page.url();
        const checks = await Promise.all(flow.expected.map((e) => kit.checkExpectation(page, e, startUrl)));
        const newLine = actionCode(step, resolved.code);
        const patched = patchStep(source, stepIdx!, newLine);
        const before = source.split("\n")[source.split("\n").findIndex((l) => new RegExp(`^\\s*// step ${stepIdx}$`).test(l)) + 1].trim();
        const accepted = checks.every((x) => x.ok) && guardExpects(source, patched);
        healLog.push({ test: c.test, attempt, step: stepIdx!, before, after: newLine, reason: suggestion.reason, confidence: suggestion.confidence, accepted });
        if (!accepted) {
          reclassify(checks.every((x) => x.ok) ? "patch would change an expect line" : `expectations still fail after using ${suggestion.role} "${suggestion.name}" (actual: ${checks.find((x) => !x.ok)?.actual.slice(0, 80)})`, [suggestion.reason]);
          continue;
        }
        writeOutput(state.runId, `tests/${c.test}.spec.ts`, patched);
        testsToRun.push(c.test);
        deps.bus.decision({ node: "heal", reason: `${c.test}: patched step ${stepIdx} to ${suggestion.role} "${suggestion.name}"`, evidence: [suggestion.reason, `before: ${before}`, `after: ${newLine}`], next: "run", at: now() });
      } finally {
        await page.close();
      }
    }
  } finally {
    await kit.close();
  }
  writeOutput(state.runId, "heal-log.json", [...state.healLog, ...healLog]);
  deps.bus.emit({ type: "node_end", node: "heal", data: { healed: testsToRun.length, escalated: defects.length } });
  return { healAttempts, healLog, testsToRun, defects, classifications, llmCalls };
}

export function afterHeal(state: RunState, deps: NodeDeps): "run" | "report" {
  if (state.testsToRun && state.testsToRun.length) {
    deps.bus.decision({ node: "heal", reason: `${state.testsToRun.length} healed test(s) to rerun`, evidence: state.testsToRun, next: "run", at: now() });
    return "run";
  }
  deps.bus.decision({ node: "heal", reason: "no healed tests", evidence: [], next: "report", at: now() });
  return "report";
}
