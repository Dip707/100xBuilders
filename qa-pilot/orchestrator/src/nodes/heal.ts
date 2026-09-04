import { z } from "zod";
import { readFileSync } from "node:fs";
import { BrowserToolkit } from "../browser/toolkit.js";
import { resolveLocator } from "../browser/locators.js";
import { actionCode, expectLines } from "../codegen/template.js";
import { effectiveExpectations, outputDir, type Classification, type Defect, type HealRecord, type RunState, type RunUpdate } from "../state.js";
import { writeOutput } from "../output.js";
import { makeDefect } from "./defects.js";
import { now, type NodeDeps } from "./deps.js";

export const HealSuggestionSchema = z.object({ role: z.string(), name: z.string(), reason: z.string(), confidence: z.number().min(0).max(1) });

export function stepLineIndex(lines: string[], step: number): number {
  return lines.findIndex((l) => new RegExp(`^\\s*// step ${step}$`).test(l));
}

export function patchStep(source: string, step: number, newLine: string): string {
  const lines = source.split("\n");
  const idx = stepLineIndex(lines, step);
  if (idx < 0 || idx + 1 >= lines.length) throw new Error(`step ${step} not found in source`);
  const indent = /^\s*/.exec(lines[idx + 1])![0];
  lines[idx + 1] = indent + newLine;
  return lines.join("\n");
}

/** Replaces the N-th expect line of a spec (0-based) with a new one, indentation preserved. */
export function patchExpect(source: string, index: number, newLine: string): string {
  const lines = source.split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*await expect\(/.test(lines[i])) continue;
    if (seen++ === index) {
      lines[i] = /^\s*/.exec(lines[i])![0] + newLine;
      return lines.join("\n");
    }
  }
  throw new Error(`expect line ${index} not found in source`);
}

/**
 * What an expect line asserts, with the target's accessible name stripped: the role of the
 * element (or `page` / `body`), the matcher, its negation and its arguments. Two lines with
 * the same signature prove the same thing about the same kind of element, even if the
 * element's name differs.
 */
export function expectSignature(line: string): string {
  const m = /^\s*await expect\((.*)\)\.((?:not\.)?\w+\(.*\));\s*$/.exec(line);
  if (!m) return line.trim();
  const role = /^page\.getByRole\('([a-z]+)'/.exec(m[1]);
  return `${role ? role[1] : m[1]}|${m[2]}`;
}

/**
 * The heal rule: a patch may change how a test reaches an expectation, and may re-target an
 * expectation to another element of the same role, but never what is asserted: no expect
 * line may be added, removed, negated, given another matcher, another value, or another
 * kind of target.
 */
export function guardExpects(before: string, after: string): boolean {
  return JSON.stringify(expectLines(before).map(expectSignature)) === JSON.stringify(expectLines(after).map(expectSignature));
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
  const kit = await BrowserToolkit.launch({ headless: deps.headless, baseUrl: state.url, bus: deps.bus, runId: state.runId, agent: "healer", screenshotDir: outputDir(state.runId) + "traces/heal" });
  try {
    for (const c of targets) {
      try {
        const test = state.results!.tests.find((t) => t.id === c.test)!;
        const flow = state.plan.find((f) => f.id === c.test)!;
        const attempt = (state.healAttempts[c.test] ?? 0) + 1;
        healAttempts[c.test] = attempt;
        const stepIdx = test.failingStep;
        const step = stepIdx !== undefined ? flow.steps[stepIdx] : undefined;
        // A failure on an expect line is healable only when the expectation names an element.
        const expected = effectiveExpectations(state, flow);
        const expIdx = step === undefined ? test.failingExpect : undefined;
        const exp = expIdx !== undefined ? expected[expIdx] : undefined;
        const source = readFileSync(test.file, "utf8");
        const reclassify = (why: string, evidence: string[]) => {
          const i = classifications.findIndex((x) => x.test === c.test);
          classifications[i] = { ...classifications[i], class: "defect", action: "escalate", evidence: [...classifications[i].evidence, why] };
          defects.push(makeDefect(state, c.test, test.error ?? why, [why, ...evidence]));
          deps.bus.decision({ node: "heal", reason: `${c.test}: ${why}; reclassified as defect`, evidence, next: "escalate", at: now() });
        };
        const healableStep = step !== undefined && step.action !== "goto";
        const healableExpect = exp !== undefined && Boolean(exp.role && exp.name);
        if (!healableStep && !healableExpect) {
          reclassify("failure is not at a locatable step or a named assertion target; healing would require weakening an assertion", c.evidence);
          continue;
        }
        const target = healableStep
          ? { what: `STEP ${stepIdx}: ${step!.action} ${step!.role} "${step!.name}" intent: ${step!.intent ?? "(none)"}`, intent: step!.intent ?? step!.name!, replayTo: stepIdx! }
          : { what: `EXPECTATION ${expIdx}: ${exp!.type} ${exp!.role} "${exp!.name}" intent: assert this element is ${exp!.type === "not_visible" ? "absent" : "present"} after the flow`, intent: `${exp!.role} "${exp!.name}"`, replayTo: flow.steps.length };

        const page = await kit.newPage();
        try {
          if (flow.preconditions.includes("logged_in")) for (const s of state.siteMap?.loginSteps ?? []) await kit.act(page, s);
          for (let i = 0; i < target.replayTo; i++) await kit.act(page, flow.steps[i]);
          const snapshot = await kit.snapshot(page);
          let suggestion: z.infer<typeof HealSuggestionSchema>;
          try {
            suggestion = await deps.llm.complete({
              prompt: "heal",
              input: `FLOW: ${flow.title}\n${target.what}\nSNAPSHOT:\n${snapshot}`,
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
            reclassify(`no element accomplishes "${target.intent}" (healer confidence ${suggestion.confidence})`, [suggestion.reason]);
            continue;
          }
          if (healableExpect) {
            if (suggestion.role !== exp!.role) {
              reclassify(`re-targeting the assertion from ${exp!.role} "${exp!.name}" to ${suggestion.role} "${suggestion.name}" would change what it asserts`, [suggestion.reason]);
              continue;
            }
            const check = await kit.checkExpectation(page, { ...exp!, name: suggestion.name }, page.url());
            const before = expectLines(source)[expIdx!];
            const patched = check.ok ? patchExpect(source, expIdx!, check.code) : source;
            const accepted = check.ok && guardExpects(source, patched);
            healLog.push({ test: c.test, attempt, expectation: expIdx!, before, after: check.code, reason: suggestion.reason, confidence: suggestion.confidence, accepted });
            if (!accepted) {
              reclassify(check.ok ? "patch would change what the assertion proves" : `assertion still fails against ${suggestion.role} "${suggestion.name}" (actual: ${check.actual.slice(0, 80)})`, [suggestion.reason]);
              continue;
            }
            writeOutput(state.runId, `tests/${c.test}.spec.ts`, patched);
            testsToRun.push(c.test);
            deps.bus.decision({ node: "heal", reason: `${c.test}: re-targeted assertion ${expIdx} to ${suggestion.role} "${suggestion.name}"`, evidence: [suggestion.reason, `before: ${before}`, `after: ${check.code}`], next: "run", at: now() });
            continue;
          }
          const resolved = await resolveLocator(page, { role: suggestion.role, name: suggestion.name });
          if (!resolved) {
            reclassify(`suggested element ${suggestion.role} "${suggestion.name}" could not be resolved live`, [suggestion.reason]);
            continue;
          }
          const ok = await kit.act(page, { ...step!, role: suggestion.role, name: suggestion.name });
          if (!ok) {
            reclassify(`acting on ${suggestion.role} "${suggestion.name}" failed live`, [suggestion.reason]);
            continue;
          }
          for (let i = stepIdx! + 1; i < flow.steps.length; i++) await kit.act(page, flow.steps[i]);
          const startUrl = page.url();
          const checks = await Promise.all(expected.map((e) => kit.checkExpectation(page, e, startUrl)));
          const newLine = actionCode(step!, resolved.code);
          const patched = patchStep(source, stepIdx!, newLine);
          const before = source.split("\n")[stepLineIndex(source.split("\n"), stepIdx!) + 1].trim();
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
      } catch (e) {
        const message = (e as Error).message;
        deps.bus.emit({ type: "error", node: "heal", message: `heal failed for ${c.test}: ${message}` });
        deps.bus.decision({ node: "heal", reason: `${c.test}: heal failed (${message})`, evidence: [message], next: "skip", at: now() });
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
