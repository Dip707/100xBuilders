import { marked } from "marked";
import type { RunState, RunUpdate } from "../state.js";
import { writeOutput } from "../output.js";
import type { NodeDeps } from "./deps.js";

const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;

export function renderReport(state: RunState): string {
  const tests = state.results?.tests ?? [];
  const passed = tests.filter((t) => t.status === "passed").length;
  const cls = new Map(state.classifications.map((c) => [c.test, c]));
  const md: string[] = [];
  md.push(`# qa-pilot report for ${state.url}`, "", `Run ${state.runId}${state.partial ? " (partial: budget exceeded)" : ""}.`, "");
  md.push("## Summary", "", row(["Flows planned", "Tests generated", "Passed", "Failed", "Heals", "Defects", "Coverage", "LLM calls"]), row(["---", "---", "---", "---", "---", "---", "---", "---"]),
    row([state.plan.length, tests.length, passed, tests.length - passed, state.healLog.filter((h) => h.accepted).length, state.defects.length, state.coverage?.score ?? "n/a", state.llmCalls]), "");
  md.push("## Flows by category", "");
  const cats = new Map<string, number>();
  for (const f of state.plan) cats.set(f.category, (cats.get(f.category) ?? 0) + 1);
  for (const [c, n] of cats) md.push(`- ${c}: ${n}`);
  if (state.unresolvedFlows.length) md.push(`- dropped as unresolvable: ${state.unresolvedFlows.join(", ")}`);
  md.push("", "## Results", "", row(["Test", "Title", "Status", "Classification"]), row(["---", "---", "---", "---"]));
  for (const t of tests) {
    const c = cls.get(t.id);
    md.push(row([t.id, t.title, t.status, c ? `${c.class} (${c.confidence})` : t.status === "passed" ? "pass" : "-"]));
  }
  md.push("", "## Heals", "");
  if (!state.healLog.length) md.push("No heals were needed.");
  for (const h of state.healLog) md.push(`### ${h.test} attempt ${h.attempt} (${h.accepted ? "accepted" : "rejected"})`, "", h.reason, "", "```diff", `- ${h.before}`, `+ ${h.after}`, "```", "");
  md.push("## Defects", "");
  if (!state.defects.length) md.push("No defects escalated.");
  for (const d of state.defects) {
    md.push(`### ${d.id}: ${d.title}`, "", `Severity: ${d.severity}. Flow: ${d.flow}.`, "", "Repro steps:", "", ...d.repro_steps.map((s) => `- ${s}`), "", `Expected: ${d.expected}`, "", `Actual: ${d.actual}`, "", "Evidence:", "", ...d.evidence.map((e) => `- ${e}`), "");
    const c = cls.get(d.flow);
    if (c?.rationale) md.push(`Classifier rationale: ${c.rationale}`, "");
    if (d.attachments.length) md.push(...d.attachments.map((a) => `- trace: ${a}`), "");
  }
  md.push("## Coverage gaps remaining", "");
  if (!state.coverage?.gaps.length) md.push("None.");
  for (const g of state.coverage?.gaps ?? []) md.push(`- ${g.kind} ${g.target ?? g.requirement ?? ""}: ${g.suggest}`);
  md.push("", "## Untested risk", "");
  if (!state.coverage?.untested_risk.length) md.push("None identified.");
  for (const r of state.coverage?.untested_risk ?? []) md.push(`- ${r.flow} (${r.risk}): ${r.reason}`);
  if (state.coverage?.prdRequirements.length) {
    md.push("", "## PRD gap matrix", "", row(["Requirement", "Flows"]), row(["---", "---"]));
    for (const r of state.coverage.prdRequirements) md.push(row([r, (state.coverage.prdMatrix[r] ?? []).join(", ") || "none"]));
  }
  md.push("", "## Decision timeline", "");
  for (const d of state.decisions) md.push(`- ${d.at} ${d.node}: ${d.reason} -> ${d.next}`);
  md.push("");
  return md.join("\n");
}

const CSS = `body{font-family:system-ui;max-width:960px;margin:2rem auto;padding:0 1rem;line-height:1.5}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.3rem .6rem}pre{background:#f6f6f6;padding:.6rem;overflow:auto}h2{border-bottom:1px solid #ddd;padding-bottom:.2rem}`;

export async function reportNode(state: RunState, deps: NodeDeps): Promise<RunUpdate> {
  deps.bus.emit({ type: "node_start", node: "report" });
  const md = renderReport(state);
  writeOutput(state.runId, "report.md", md);
  writeOutput(state.runId, "report.html", `<!doctype html><meta charset="utf-8"><title>qa-pilot report</title><style>${CSS}</style>${await marked.parse(md)}`);
  writeOutput(state.runId, "defects.json", state.defects);
  deps.bus.emit({ type: "node_end", node: "report" });
  deps.bus.emit({ type: "done", message: state.partial ? "partial" : "complete", data: { defects: state.defects.length, passed: state.results?.tests.filter((t) => t.status === "passed").length ?? 0, total: state.results?.tests.length ?? 0 } });
  return {};
}
