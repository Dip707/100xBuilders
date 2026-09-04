import { effectiveExpectations, type Defect, type RunState } from "../state.js";

/** Builds a paste-ready ticket from the flow, the test result, and the evidence list. */
export function makeDefect(state: RunState, testId: string, actual: string, evidence: string[]): Defect {
  const flow = state.plan.find((f) => f.id === testId)!;
  const test = state.results?.tests.find((t) => t.id === testId);
  return {
    id: `DEF-${state.defects.length + 1}-${testId}`,
    title: `${flow.title}: ${evidence[0] ?? "unexpected behaviour"}`.slice(0, 120),
    severity: flow.priority === "P0" ? "critical" : flow.priority === "P1" ? "high" : "medium",
    flow: testId,
    repro_steps: [...(flow.preconditions.includes("logged_in") ? ["Log in with the test credentials"] : []), ...flow.steps.map((s, i) => `${i + 1}. ${s.action} ${s.target ?? `${s.role} "${s.name}"`}${s.value ? ` with "${s.value}"` : ""}`)],
    expected: effectiveExpectations(state, flow).map((e) => `${e.type} ${e.role ?? ""} ${e.name ?? ""} ${e.text_contains ?? e.value ?? ""}`.replace(/\s+/g, " ").trim()).join("; "),
    actual: actual.split("\n")[0].slice(0, 200),
    evidence,
    attachments: test?.tracePath ? [test.tracePath] : [],
  };
}
