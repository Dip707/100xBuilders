import type { RunState, RunUpdate, TestResult, HealRecord, Defect, Decision, Classification } from "../state.js";
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

// ---------- HTML report ----------
// A hand-built document rather than markdown-through-marked: gives us stat cards, colored status
// pills and a real timeline instead of default browser table/heading styling. `renderReport`
// above stays the source of truth for report.md and is untouched; this reads the same `state`.
//
// The palette below is not invented for the report - it's lifted straight from the main UI's
// design tokens (ui/app/globals.css): the Raycast-derived surface ladder, hairline borders, no
// drop shadows, and the same five status hues the classifier's own categories map onto
// (pass/fail/flaky/defect/env/human), so a report opened on its own reads as the same product
// as the live run screen, not a themed-differently export.

const REPORT_CSS = `
:root{
  --app:#07080a;--surface:#0d0d0d;--inset:#101111;--raised:#16171a;
  --line:#242728;--line-strong:rgba(255,255,255,.16);
  --fg:#f4f4f6;--body:#cdcdcd;--muted:#9c9c9d;--subtle:#6a6b6c;
  --accent:#ffffff;--accent-fg:#000000;
  --pass:#59d499;--fail:#ff6161;--flaky:#ffc533;--info:#57c1ff;--defect:#ff5252;--env:#9c9c9d;--human:#b08cff;
  --radius-chip:6px;--radius-input:8px;--radius-box:10px;--radius-card:12px;
}
@media (prefers-color-scheme: light){
  :root{
    --app:#f7f7f8;--surface:#ffffff;--inset:#f1f1f3;--raised:#e9e9ec;
    --line:#e4e4e7;--line-strong:rgba(0,0,0,.14);
    --fg:#131316;--body:#3f3f46;--muted:#71717a;--subtle:#a1a1aa;
    --accent:#18191a;--accent-fg:#ffffff;
    --pass:#17915c;--fail:#d93a3a;--flaky:#a86a12;--info:#0b7ec4;--defect:#c2282e;--env:#71717a;--human:#7c3aed;
  }
}
*{box-sizing:border-box}
body{margin:0;font-family:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;font-feature-settings:"calt","kern","liga","ss03";background:var(--app);color:var(--body);line-height:1.55}
a{color:var(--fg)}
h1,h2,h3{font-weight:800;letter-spacing:-.02em;margin:0;color:var(--fg)}
code{font-family:ui-monospace,Menlo,Consolas,monospace}
.doc{max-width:920px;margin:0 auto;padding:0 1.5rem 4rem}
header.report-header{background:var(--surface);border-bottom:1px solid var(--line);padding:2rem 0;margin-bottom:2rem}
.report-header-inner{max-width:920px;margin:0 auto;padding:0 1.5rem;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:1rem}
.brand{display:flex;align-items:center;gap:.6rem;font-weight:600;font-size:.85rem;color:var(--fg)}
.brand-mark{width:26px;height:26px;flex-shrink:0;border-radius:var(--radius-input);background:var(--accent);color:var(--accent-fg);display:flex;align-items:center;justify-content:center}
.header-actions{display:flex;align-items:center;gap:.6rem}
/* Same box on both: line-height:1 plus identical padding/font-size/border is what actually
   keeps a pill and a button the same height - text metrics alone drift by a pixel or two. */
.btn,.pill{display:inline-flex;align-items:center;line-height:1;padding:.5rem .75rem;border-radius:999px;font-size:.78rem;font-weight:700;white-space:nowrap;border:1px solid var(--line)}
.btn{gap:.4rem;background:var(--raised);color:var(--fg);font-family:inherit;text-decoration:none;cursor:pointer}
.btn:hover{background:var(--inset)}
.btn svg{flex-shrink:0}
.run-title{font-size:1.6rem;margin:.3rem 0 .2rem;word-break:break-all;color:var(--fg)}
.run-sub{color:var(--muted);font-size:.85rem;font-family:ui-monospace,Menlo,Consolas,monospace}
.pill{gap:.35rem}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill-pass{color:var(--pass)}
.pill-fail{color:var(--fail)}
.pill-flaky{color:var(--flaky)}
.pill-info{color:var(--info)}
.pill-defect{color:var(--defect)}
.pill-env{color:var(--env)}
.pill-human{color:var(--human)}
.pill-muted{color:var(--subtle)}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:.9rem;margin-bottom:2.5rem}
.stat-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-card);padding:1rem 1.1rem}
.stat-value{font-size:1.6rem;font-weight:800;letter-spacing:-.02em;color:var(--fg)}
.stat-label{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-top:.15rem}
.meter{height:6px;border-radius:999px;background:var(--inset);overflow:hidden;margin-top:.5rem}
.meter-fill{height:100%;background:var(--accent);border-radius:999px}
section{margin-bottom:2.5rem}
section h2{font-size:1.05rem;padding-bottom:.6rem;margin-bottom:1rem;border-bottom:1px solid var(--line)}
.chip-row{display:flex;flex-wrap:wrap;gap:.5rem}
.chip{background:var(--raised);border:1px solid var(--line);border-radius:var(--radius-chip);padding:.35rem .8rem;font-size:.8rem;font-weight:600;color:var(--muted)}
.chip b{color:var(--fg)}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-card);overflow:hidden}
th,td{text-align:left;padding:.6rem .8rem;border-bottom:1px solid var(--line);font-size:.85rem;vertical-align:top}
th{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;background:var(--raised)}
tr:last-child td{border-bottom:0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-card);padding:1.1rem 1.25rem;margin-bottom:.9rem}
.card-title{font-weight:700;margin-bottom:.3rem;color:var(--fg)}
.card-meta{color:var(--muted);font-size:.8rem;margin-bottom:.6rem}
.diff{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.8rem;border-radius:var(--radius-box);overflow:hidden;border:1px solid var(--line)}
.diff div{padding:.4rem .7rem;white-space:pre-wrap;word-break:break-word}
.diff .del{background:color-mix(in srgb, var(--fail) 14%, var(--surface));color:var(--fail)}
.diff .add{background:color-mix(in srgb, var(--pass) 14%, var(--surface));color:var(--pass)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:.2rem .8rem;font-size:.85rem;margin:.5rem 0}
.kv dt{color:var(--muted);font-weight:600}
.kv dd{margin:0;color:var(--body)}
ul.plain{margin:.4rem 0;padding-left:1.1rem;font-size:.85rem}
ul.plain li{margin:.2rem 0}
.empty{color:var(--muted);font-size:.85rem;font-style:italic}
.timeline{border-left:2px solid var(--line);margin-left:.4rem;padding-left:1.2rem}
.timeline-item{position:relative;padding-bottom:1rem;font-size:.85rem}
.timeline-item::before{content:"";position:absolute;left:-1.53rem;top:.3rem;width:9px;height:9px;border-radius:50%;background:var(--accent)}
.timeline-at{color:var(--muted);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.75rem}
`;

const escAttr = (s: string) => text(s).replace(/"/g, "&quot;");

// The exact qa-pilot mark from ui/components/ui/Logo.tsx (hub-and-three-satellites), redrawn
// here as static SVG rather than imported - this document ships standalone, with no build step
// and no access to the UI's React tree.
const LOGO_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 14.35 12 4.95M12 14.35 20.14 19.05M12 14.35 3.86 19.05" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="14.35" r="3.35" fill="currentColor"/><circle cx="12" cy="4.95" r="2.1" fill="currentColor"/><circle cx="20.14" cy="19.05" r="2.1" fill="currentColor"/><circle cx="3.86" cy="19.05" r="2.1" fill="currentColor"/></svg>`;
const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 17v3h16v-3"/></svg>`;

function statCard(label: string, value: string | number, sub?: string): string {
  return `<div class="stat-card"><div class="stat-value">${text(String(value))}</div><div class="stat-label">${text(label)}</div>${sub ? `<div class="run-sub" style="margin-top:.25rem">${text(sub)}</div>` : ""}</div>`;
}
function statusPill(status: string): string {
  const cls = status === "passed" ? "pill-pass" : status === "failed" || status === "timedOut" ? "pill-fail" : "pill-muted";
  return `<span class="pill ${cls}">${text(status)}</span>`;
}
// Colors mirror the classifier's own category tokens (pass/fail/flaky/info/defect/env/human) so a
// class reads with the same hue here as it would on the live run screen.
function classificationPill(c: Classification | undefined, fallbackPassed: boolean): string {
  if (!c) return fallbackPassed ? `<span class="pill pill-pass">pass</span>` : `<span class="pill pill-muted">-</span>`;
  if (c.action === "healed") return `<span class="pill pill-pass">healed (${c.confidence})</span>`;
  const cls = { script: "pill-info", defect: "pill-defect", flaky: "pill-flaky", env: "pill-env", needs_human: "pill-human" }[c.class] ?? "pill-muted";
  return `<span class="pill ${cls}">${text(c.class)} (${c.confidence})</span>`;
}
function severityPill(sev: string): string {
  const cls = sev === "critical" || sev === "high" ? "pill-defect" : sev === "medium" ? "pill-flaky" : "pill-env";
  return `<span class="pill ${cls}">${text(sev)}</span>`;
}
function riskPill(risk: string): string {
  const cls = risk === "high" ? "pill-defect" : risk === "medium" ? "pill-flaky" : "pill-env";
  return `<span class="pill ${cls}">${text(risk)}</span>`;
}

function renderResultsTable(tests: TestResult[], cls: Map<string, Classification>): string {
  if (!tests.length) return `<p class="empty">No tests were executed.</p>`;
  const rows = tests
    .map((t) => `<tr><td><code>${text(t.id)}</code></td><td>${text(t.title)}</td><td>${statusPill(t.status)}</td><td>${classificationPill(cls.get(t.id), t.status === "passed")}</td></tr>`)
    .join("");
  return `<table><thead><tr><th>Test</th><th>Title</th><th>Status</th><th>Classification</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function renderHeals(heals: HealRecord[]): string {
  if (!heals.length) return `<p class="empty">No heals were needed.</p>`;
  return heals
    .map(
      (h) => `<div class="card">
<div class="card-title">${text(h.test)} <span class="run-sub">attempt ${h.attempt}</span> ${h.accepted ? `<span class="pill pill-pass">accepted</span>` : `<span class="pill pill-fail">rejected</span>`}</div>
<div class="card-meta">${text(h.reason)} &middot; confidence ${h.confidence}</div>
<div class="diff"><div class="del">&minus; ${text(h.before)}</div><div class="add">+ ${text(h.after)}</div></div>
</div>`,
    )
    .join("");
}
function renderDefects(defects: Defect[], cls: Map<string, Classification>): string {
  if (!defects.length) return `<p class="empty">No defects escalated.</p>`;
  return defects
    .map((d) => {
      const c = cls.get(d.flow);
      return `<div class="card">
<div class="card-title">${severityPill(d.severity)} ${text(d.id)}: ${text(d.title)}</div>
<div class="card-meta">Flow: <code>${text(d.flow)}</code></div>
<dl class="kv"><dt>Expected</dt><dd>${text(d.expected)}</dd><dt>Actual</dt><dd>${text(d.actual)}</dd></dl>
${d.repro_steps.length ? `<div class="card-meta" style="margin-top:.5rem">Repro steps</div><ul class="plain">${d.repro_steps.map((s) => `<li>${text(s)}</li>`).join("")}</ul>` : ""}
${d.evidence.length ? `<div class="card-meta">Evidence</div><ul class="plain">${d.evidence.map((e) => `<li>${text(e)}</li>`).join("")}</ul>` : ""}
${c?.rationale ? `<div class="card-meta">Classifier rationale: ${text(c.rationale)}</div>` : ""}
${d.attachments.length ? `<ul class="plain">${d.attachments.map((a) => `<li>trace: <code>${text(a)}</code></li>`).join("")}</ul>` : ""}
</div>`;
    })
    .join("");
}
function renderTimeline(decisions: Decision[]): string {
  if (!decisions.length) return `<p class="empty">No decisions recorded.</p>`;
  return `<div class="timeline">${decisions
    .map((d) => `<div class="timeline-item"><span class="timeline-at">${text(d.at)}</span> &middot; <strong>${text(d.node)}</strong>: ${text(d.reason)} &rarr; ${text(d.next)}</div>`)
    .join("")}</div>`;
}

function renderReportHtml(state: RunState): string {
  const tests = state.results?.tests ?? [];
  const passed = tests.filter((t) => t.status === "passed").length;
  const cls = new Map(state.classifications.map((c) => [c.test, c]));
  const heals = state.healLog.filter((h) => h.accepted).length;
  const coveragePct = state.coverage ? Math.round(state.coverage.score * 100) : null;
  const cats = new Map<string, number>();
  for (const f of state.plan) cats.set(f.category, (cats.get(f.category) ?? 0) + 1);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>qa-pilot report - ${escAttr(state.url)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${REPORT_CSS}</style></head>
<body>
<header class="report-header"><div class="report-header-inner">
<div>
<div class="brand"><span class="brand-mark">${LOGO_SVG}</span>qa-pilot</div>
<h1 class="run-title">${text(state.url)}</h1>
<div class="run-sub">run ${text(state.runId)}</div>
</div>
<div class="header-actions">
${state.partial ? `<span class="pill pill-flaky">partial: ${text(state.partialReason ?? "unknown reason")}</span>` : `<span class="pill pill-pass">complete</span>`}
<a class="btn" href="?download=1" download="${escAttr(state.runId)}-report.html">${DOWNLOAD_ICON} Download</a>
</div>
</div></header>
<main class="doc">

<section class="stat-grid">
${statCard("Flows planned", state.plan.length)}
${statCard("Tests generated", tests.length)}
${statCard("Passed", passed)}
${statCard("Failed", tests.length - passed)}
${statCard("Heals accepted", heals)}
${statCard("Defects", state.defects.length)}
<div class="stat-card"><div class="stat-value">${coveragePct === null ? "n/a" : coveragePct + "%"}</div><div class="stat-label">Coverage</div>${coveragePct !== null ? `<div class="meter"><div class="meter-fill" style="width:${coveragePct}%"></div></div>` : ""}</div>
${statCard("LLM calls", state.llmCalls)}
</section>

<section><h2>Flows by category</h2>
<div class="chip-row">${[...cats].map(([c, n]) => `<span class="chip"><b>${n}</b> ${text(c)}</span>`).join("")}
${state.unresolvedFlows.length ? `<span class="chip">dropped as unresolvable: ${state.unresolvedFlows.map(text).join(", ")}</span>` : ""}</div>
</section>

<section><h2>Results</h2>${renderResultsTable(tests, cls)}</section>

<section><h2>Heals</h2>${renderHeals(state.healLog)}</section>

<section><h2>Defects</h2>${renderDefects(state.defects, cls)}</section>

<section><h2>Coverage gaps remaining</h2>
${!state.coverage?.gaps.length ? `<p class="empty">None.</p>` : `<ul class="plain">${(state.coverage?.gaps ?? []).map((g) => `<li><code>${text(g.kind)}</code> ${text(g.target ?? g.requirement ?? "")}: ${text(g.suggest)}</li>`).join("")}</ul>`}
</section>

<section><h2>Untested risk</h2>
${!state.coverage?.untested_risk.length ? `<p class="empty">None identified.</p>` : `<ul class="plain">${(state.coverage?.untested_risk ?? []).map((r) => `<li>${riskPill(r.risk)} ${text(r.flow)}: ${text(r.reason)}</li>`).join("")}</ul>`}
</section>

${
  state.coverage?.prdRequirements.length
    ? `<section><h2>PRD gap matrix</h2><table><thead><tr><th>Requirement</th><th>Flows</th></tr></thead><tbody>${state.coverage.prdRequirements
        .map((r) => `<tr><td>${text(r)}</td><td>${text((state.coverage!.prdMatrix[r] ?? []).join(", ") || "none")}</td></tr>`)
        .join("")}</tbody></table></section>`
    : ""
}

<section><h2>Decision timeline</h2>${renderTimeline(state.decisions)}</section>

</main>
</body></html>`;
}

export async function reportNode(state: RunState, deps: NodeDeps): Promise<RunUpdate> {
  deps.bus.emit({ type: "node_start", node: "report" });
  const md = renderReport(state);
  writeOutput(state.runId, "report.md", md);
  writeOutput(state.runId, "report.html", renderReportHtml(state));
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
