import { marked } from "marked";
import type { RunState, RunUpdate } from "../state.js";
import { writeOutput } from "../output.js";
import { writeSuite } from "../suite/bundle.js";
import type { NodeDeps } from "./deps.js";
import { writeRedactedLoginSteps } from "../copilot/login-steps.js";

// Escapes untrusted text before it is interpolated into markdown that will
// later be rendered to HTML by `marked` (which passes inline HTML through).
function text(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Escapes and sanitizes a single markdown table cell: HTML-escapes strings,
// then neutralizes characters that would corrupt the table's row/column structure.
function cell(s: string | number): string {
  if (typeof s === "number") return String(s);
  return text(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// Prevents untrusted text placed inside a ``` fenced code block from closing
// the fence early by replacing runs of 3+ backticks with the same number of quotes.
function fenceGuard(s: string): string {
  return s.replace(/`{3,}/g, (m) => "'".repeat(m.length));
}

const row = (cells: (string | number)[]) => `| ${cells.map(cell).join(" | ")} |`;

export function renderReport(state: RunState): string {
  const tests = state.results?.tests ?? [];
  const passed = tests.filter((t) => t.status === "passed").length;
  const cls = new Map(state.classifications.map((c) => [c.test, c]));
  const md: string[] = [];
  md.push(`# qa-pilot report for ${text(state.url)}`, "", `Run ${text(state.runId)}${state.partial ? ` (partial: ${text(state.partialReason ?? "unknown reason")})` : ""}.`, "");
  md.push("## Summary", "", row(["Flows planned", "Tests generated", "Passed", "Failed", "Heals", "Defects", "Coverage", "LLM calls"]), row(["---", "---", "---", "---", "---", "---", "---", "---"]),
    row([state.plan.length, tests.length, passed, tests.length - passed, state.healLog.filter((h) => h.accepted).length, state.defects.length, state.coverage?.score ?? "n/a", state.llmCalls]), "");
  md.push("## Flows by category", "");
  const cats = new Map<string, number>();
  for (const f of state.plan) cats.set(f.category, (cats.get(f.category) ?? 0) + 1);
  for (const [c, n] of cats) md.push(`- ${text(c)}: ${n}`);
  if (state.unresolvedFlows.length) md.push(`- dropped as unresolvable: ${state.unresolvedFlows.map(text).join(", ")}`);
  md.push("", "## Results", "", row(["Test", "Title", "Status", "Classification"]), row(["---", "---", "---", "---"]));
  for (const t of tests) {
    const c = cls.get(t.id);
    md.push(row([t.id, t.title, t.status, c ? `${c.action === "healed" ? "healed" : c.class} (${c.confidence})` : t.status === "passed" ? "pass" : "-"]));
  }
  md.push("", "## Heals", "");
  if (!state.healLog.length) md.push("No heals were needed.");
  for (const h of state.healLog) md.push(`### ${text(h.test)} attempt ${h.attempt} (${h.accepted ? "accepted" : "rejected"})`, "", text(h.reason), "", "```diff", `- ${fenceGuard(text(h.before))}`, `+ ${fenceGuard(text(h.after))}`, "```", "");
  md.push("## Defects", "");
  if (!state.defects.length) md.push("No defects escalated.");
  for (const d of state.defects) {
    md.push(`### ${text(d.id)}: ${text(d.title)}`, "", `Severity: ${d.severity}. Flow: ${text(d.flow)}.`, "", "Repro steps:", "", ...d.repro_steps.map((s) => `- ${text(s)}`), "", `Expected: ${text(d.expected)}`, "", `Actual: ${text(d.actual)}`, "", "Evidence:", "", ...d.evidence.map((e) => `- ${text(e)}`), "");
    const c = cls.get(d.flow);
    if (c?.rationale) md.push(`Classifier rationale: ${text(c.rationale)}`, "");
    if (d.attachments.length) md.push(...d.attachments.map((a) => `- trace: ${text(a)}`), "");
  }
  md.push("## Coverage gaps remaining", "");
  if (!state.coverage?.gaps.length) md.push("None.");
  for (const g of state.coverage?.gaps ?? []) md.push(`- ${g.kind} ${text(g.target ?? g.requirement ?? "")}: ${text(g.suggest)}`);
  md.push("", "## Untested risk", "");
  if (!state.coverage?.untested_risk.length) md.push("None identified.");
  for (const r of state.coverage?.untested_risk ?? []) md.push(`- ${text(r.flow)} (${r.risk}): ${text(r.reason)}`);
  if (state.coverage?.prdRequirements.length) {
    md.push("", "## PRD gap matrix", "", row(["Requirement", "Flows"]), row(["---", "---"]));
    for (const r of state.coverage.prdRequirements) md.push(row([r, (state.coverage.prdMatrix[r] ?? []).join(", ") || "none"]));
  }
  md.push("", "## Decision timeline", "");
  for (const d of state.decisions) md.push(`- ${d.at} ${text(d.node)}: ${text(d.reason)} -> ${text(d.next)}`);
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
  // What a later copilot rerun needs to sign in again, with the credential values redacted.
  writeRedactedLoginSteps(state.runId, state.siteMap?.loginSteps ?? [], state.credentials);
  // The suite an engineer takes away. Never allowed to cost the run its report, so a failure
  // here is reported and swallowed.
  try {
    const files = writeSuite(state);
    deps.bus.log("reporter", `suite bundled: ${files.length} files under suite/`);
  } catch (err) {
    deps.bus.emit({ type: "error", node: "report", message: `could not bundle the suite: ${(err as Error).message}` });
  }
  deps.bus.emit({ type: "node_end", node: "report" });
  deps.bus.emit({ type: "done", message: state.partial ? "partial" : "complete", data: { defects: state.defects.length, passed: state.results?.tests.filter((t) => t.status === "passed").length ?? 0, total: state.results?.tests.length ?? 0 } });
  return {};
}
