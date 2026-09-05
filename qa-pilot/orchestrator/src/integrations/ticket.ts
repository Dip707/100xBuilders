import type { Defect, Flow } from "../state.js";

/**
 * The ticket as the trackers do not see it: one structure, rendered to markdown for Linear
 * and to Atlassian Document Format for Jira, so the two never drift in what they say.
 */
export type TicketSection = { heading: string; lines?: string[]; bullets?: string[] };
export type TicketBody = { title: string; severity: Defect["severity"]; sections: TicketSection[] };

/** Characters of the rerun error kept on the ticket: the assertion, not the stack. */
const ERROR_HEAD = 300;

const firstLine = (s: string) => s.split("\n")[0].trim().slice(0, ERROR_HEAD);

/** The same words the defect node uses, so a ticket filed without a defect record ranks the same way. */
function severityOf(flow: Flow): Defect["severity"] {
  return flow.priority === "P0" ? "critical" : flow.priority === "P1" ? "high" : "medium";
}

/** The repro steps the defect node would write, for a test that was never escalated. */
function stepsOf(flow: Flow): string[] {
  const login = flow.preconditions.includes("logged_in") ? ["Log in with the test credentials"] : [];
  return [...login, ...flow.steps.map((s, i) => `${i + 1}. ${s.action} ${s.target ?? `${s.role} "${s.name}"`}${s.value ? ` with "${s.value}"` : ""}`)];
}

function expectedOf(flow: Flow): string {
  return flow.expected.map((e) => `${e.type} ${e.role ?? ""} ${e.name ?? ""} ${e.text_contains ?? e.value ?? ""}`.replace(/\s+/g, " ").trim()).join("; ");
}

export function buildTicket(args: {
  runId: string;
  url: string;
  testId: string;
  flow: Flow;
  defect?: Defect;
  verdict?: { class: string; confidence: number };
  latest?: { error?: string; at: string };
  /** Where the UI lives, so the ticket links back to the case page with the trace and video. */
  uiOrigin: string;
}): TicketBody {
  const { flow, defect, verdict, latest } = args;
  const severity = defect?.severity ?? severityOf(flow);
  const summary = [
    `Target: ${args.url}`,
    `Run: ${args.runId}`,
    `Test: ${args.testId}`,
    `Severity: ${severity}`,
    `Classifier verdict: ${verdict ? `${verdict.class} (${verdict.confidence.toFixed(2)})` : "none"}`,
  ];
  const rerun = latest
    ? [latest.error ? firstLine(latest.error) : "No error text was recorded.", `At: ${latest.at}`]
    : ["This test has not been rerun since the pipeline run."];
  return {
    title: `[qa-pilot] ${defect ? defect.title : `${flow.title} still fails`}`.slice(0, 200),
    severity,
    sections: [
      { heading: "Summary", lines: summary },
      { heading: "Steps to reproduce", bullets: defect?.repro_steps ?? stepsOf(flow) },
      { heading: "Expected", lines: [defect?.expected ?? expectedOf(flow)] },
      { heading: "Actual", lines: [defect?.actual ?? (latest?.error ? firstLine(latest.error) : "The test failed.")] },
      { heading: "Evidence", bullets: defect?.evidence.length ? defect.evidence : ["No classifier evidence was recorded."] },
      { heading: "Latest rerun", lines: rerun },
      { heading: "Links", lines: [`${args.uiOrigin.replace(/\/$/, "")}/runs/${encodeURIComponent(args.runId)}/cases?test=${encodeURIComponent(args.testId)}`] },
    ],
  };
}

export function renderMarkdown(body: TicketBody): string {
  return body.sections
    .map((s) => {
      const parts = [`## ${s.heading}`];
      if (s.lines) parts.push(...s.lines);
      if (s.bullets) parts.push(...s.bullets.map((b) => `- ${b}`));
      return parts.join("\n");
    })
    .join("\n\n");
}

// ---------- Atlassian Document Format ----------

export type AdfNode = { type: string; attrs?: Record<string, unknown>; text?: string; content?: AdfNode[] };
export type AdfDoc = { type: "doc"; version: 1; content: AdfNode[] };

const text = (t: string): AdfNode => ({ type: "text", text: t });
const paragraph = (t: string): AdfNode => ({ type: "paragraph", content: [text(t || " ")] });

export function renderAdf(body: TicketBody): AdfDoc {
  const content: AdfNode[] = [];
  for (const s of body.sections) {
    content.push({ type: "heading", attrs: { level: 3 }, content: [text(s.heading)] });
    for (const line of s.lines ?? []) content.push(paragraph(line));
    if (s.bullets?.length) {
      content.push({ type: "bulletList", content: s.bullets.map((b) => ({ type: "listItem", content: [paragraph(b)] })) });
    }
  }
  return { type: "doc", version: 1, content };
}
