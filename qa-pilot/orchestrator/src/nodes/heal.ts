import { z } from "zod";
import { readFileSync } from "node:fs";
import { BrowserToolkit } from "../browser/toolkit.js";
import { resolveLocator } from "../browser/locators.js";
import { findNearTwins, nameSimilarity, parseSnapshot, type SnapshotNode } from "../browser/snapshot.js";
import { actionCode, expectLines } from "../codegen/template.js";
import { effectiveExpectations, outputDir, type Classification, type Defect, type ElementRef, type HealRecord, type RunState, type RunUpdate, type Step } from "../state.js";
import { writeOutput } from "../output.js";
import { makeDefect } from "./defects.js";
import { now, type NodeDeps } from "./deps.js";

// Field order is load-bearing: generation is left-to-right, so `reason` placed after
// `candidate` would be a rationalisation of a token already committed rather than the
// thinking that chose it. Reasoning first, decision second, confidence last.
export const HealSuggestionSchema = z.object({ reason: z.string(), candidate: z.number().int(), confidence: z.number().min(0).max(1) });

/** How many ranked candidates the step healer is shown; keeps the prompt small and the model's
 * choice bounded to elements that actually exist on the page. */
const MAX_STEP_CANDIDATES = 30;

/**
 * The elements a step heal may choose from, ranked so the model never has to read the raw
 * (and untruncated) page snapshot to find them.
 *
 * Only named elements are candidates: an unnamed node gives `resolveLocator` nothing to key
 * on, and would let the healer "pick" an element it can't actually act on. Same-role nodes are
 * ranked first because a step almost always keeps its role, but other roles are kept in the
 * list (not dropped) so a link that replaced a button is still reachable - the healer's whole
 * purpose is recognising that kind of substitution.
 */
export function stepCandidates(snapshot: string, step: Step): SnapshotNode[] {
  const named = parseSnapshot(snapshot).filter((n) => n.name);
  return named
    .map((node) => ({ node, sameRole: node.role === step.role, similarity: nameSimilarity(node.name, step.name ?? "") }))
    .sort((a, b) => (Number(b.sameRole) - Number(a.sameRole)) || (b.similarity - a.similarity))
    .slice(0, MAX_STEP_CANDIDATES)
    .map((x) => x.node);
}

/** Renders ranked candidates as a numbered list for the prompt: `0: role "name"` per line. */
export function renderCandidates(candidates: SnapshotNode[]): string {
  return candidates.map((c, i) => `${i}: ${c.role} "${c.name}"`).join("\n");
}

/**
 * How alike two accessible names must be before a heal may re-target an assertion.
 *
 * `expectSignature` strips the target's name on purpose: for a *step* the name is only how
 * the element is addressed, so a renamed button is a locator problem. For an *assertion* the
 * name is often the very thing being proven. An app that loses its "Log In" button while
 * keeping a "Sign Up" button still satisfies `expect(getByRole('button')).toBeVisible()`
 * under an identical signature, so a healer free to swap the name can turn a broken login
 * page green - the precise failure this project exists to catch.
 *
 * Bigram similarity separates a rename that is cosmetic ("Log In" -> "Log in", 1.0) from one
 * that changes what is asserted ("Log In" -> "Sign Up", 0.0). Below this bar the failure
 * escalates as a defect rather than healing: a false alarm a human dismisses in seconds is
 * cheaper than a regression the suite silently absorbs.
 */
export const MIN_ASSERTION_NAME_SIMILARITY = 0.8;

/**
 * A resolved heal decision: the element to act on or re-target to, plus why. This is the
 * common currency both heal paths produce - `pickAssertionTarget`'s ranking and the step
 * path's index-into-candidates - so the rest of `healNode` (live verification, patching,
 * logging) doesn't need to know which path produced it. `HealSuggestionSchema` is narrower
 * on purpose: it is only the shape the step-heal LLM call is allowed to return.
 */
export type HealTarget = { reason: string; role: string; name: string; confidence: number };

/**
 * Chooses the element an assertion should be re-targeted to, without asking a model.
 *
 * `MIN_ASSERTION_NAME_SIMILARITY` narrows the admissible set to same-role elements whose name
 * is a near-copy of the one the plan asked for, which leaves nothing for a model to judge:
 * ranking answers "which of these did the planner mean" as well as reasoning would. Keeping
 * this deterministic costs no LLM call, cannot hallucinate a locator that is not on the page,
 * and keeps the untrusted page snapshot away from the LLM on this path entirely.
 *
 * `confidence` is the similarity itself, so the heal log carries the number the decision
 * actually turned on rather than a model's self-report.
 */
export function pickAssertionTarget(snapshot: string, ref: ElementRef): { ok: true; suggestion: HealTarget } | { ok: false; why: string } {
  const best = findNearTwins(parseSnapshot(snapshot), ref)[0];
  if (!best) return { ok: false, why: `no ${ref.role} element remains on the page to re-target the assertion to` };
  if (best.similarity < MIN_ASSERTION_NAME_SIMILARITY) {
    return { ok: false, why: `the closest ${ref.role} on the page is "${best.node.name}" (name similarity ${best.similarity.toFixed(2)} < ${MIN_ASSERTION_NAME_SIMILARITY}); re-targeting to it would change which element the assertion proves` };
  }
  return { ok: true, suggestion: { reason: `same-role ${ref.role} with a near-identical name (similarity ${best.similarity.toFixed(2)})`, role: best.node.role, name: best.node.name, confidence: best.similarity } };
}

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

        // Every flow starts from a clean session: sharing one context across every healed
        // target lets one flow's login bleed into the next flow's replay.
        await kit.clearCookies();
        const page = await kit.newPage();
        try {
          if (flow.preconditions.includes("logged_in")) for (const s of state.siteMap?.loginSteps ?? []) await kit.act(page, s);
          for (let i = 0; i < target.replayTo; i++) await kit.act(page, flow.steps[i]);
          const snapshot = await kit.snapshot(page);
          let suggestion: HealTarget;
          if (healableExpect) {
            // Assertions are re-targeted by ranking, not by prompting: see pickAssertionTarget.
            const picked = pickAssertionTarget(snapshot, { role: exp!.role!, name: exp!.name! });
            if (!picked.ok) {
              reclassify(`cannot re-target assertion ${expIdx} (${exp!.role} "${exp!.name}"): ${picked.why}`, c.evidence);
              continue;
            }
            suggestion = picked.suggestion;
          } else {
            // Steps are re-targeted by index into a ranked, real-element candidate list rather
            // than by free-text role+name: see stepCandidates. This makes a hallucinated target
            // structurally impossible - the model can only point at something on the page - and
            // shrinks the prompt from the full snapshot to just the names worth considering.
            const candidates = stepCandidates(snapshot, step!);
            if (candidates.length === 0) {
              reclassify(`no named elements remain on the page to satisfy "${target.intent}"`, []);
              continue;
            }
            let raw: z.infer<typeof HealSuggestionSchema>;
            try {
              raw = await deps.llm.complete({
                prompt: "heal",
                input: `FLOW: ${flow.title}\n${target.what}\nCANDIDATES:\n${renderCandidates(candidates)}`,
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
            const chosen = candidates[raw.candidate];
            if (!chosen) {
              // An out-of-range index is a hallucination the same way a bogus free-text name
              // used to be - treat it exactly like the low-confidence case below, not as a bug.
              reclassify(`healer chose candidate ${raw.candidate}, which is out of range (0-${candidates.length - 1})`, [raw.reason]);
              continue;
            }
            if (raw.confidence < 0.5) {
              reclassify(`no element accomplishes "${target.intent}" (healer confidence ${raw.confidence})`, [raw.reason]);
              continue;
            }
            suggestion = { reason: raw.reason, role: chosen.role, name: chosen.name, confidence: raw.confidence };
          }
          if (healableExpect) {
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
  // Tests the classifier sent for a rerun ride along with the healed ones. The graph visits
  // the healer before the rerun path, and a heal that did not take is no reason to drop a
  // navigation timeout that only needed a second try; without this those tests were reported
  // as failures they never got to shake off.
  const rerunAttempts: Record<string, number> = {};
  for (const c of state.classifications) {
    if (c.action !== "rerun" || testsToRun.includes(c.test)) continue;
    testsToRun.push(c.test);
    rerunAttempts[c.test] = (state.rerunAttempts[c.test] ?? 0) + 1;
  }
  deps.bus.emit({ type: "node_end", node: "heal", data: { healed: testsToRun.length - Object.keys(rerunAttempts).length, escalated: defects.length, reruns: Object.keys(rerunAttempts).length } });
  return { healAttempts, healLog, testsToRun, rerunAttempts, defects, classifications, llmCalls };
}

export function afterHeal(state: RunState, deps: NodeDeps): "run" | "report" {
  if (state.testsToRun && state.testsToRun.length) {
    deps.bus.decision({ node: "heal", reason: `${state.testsToRun.length} test(s) to run again: healed, or sent back by the classifier for a second try`, evidence: state.testsToRun, next: "run", at: now() });
    return "run";
  }
  deps.bus.decision({ node: "heal", reason: "no healed tests and nothing to rerun", evidence: [], next: "report", at: now() });
  return "report";
}
