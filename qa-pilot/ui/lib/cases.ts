import type { RunEvent } from "./events";

/*
 * The test-case view model. Everything here is derived from the plan (plan.json) and the
 * event stream, so the Test Cases, Test Runs and Coverage screens all agree with each other
 * and with a replayed run, and none of it needs a component to compute.
 */

export type Step = { action: "goto" | "fill" | "click" | "select" | "press" | "check"; target?: string; role?: string; name?: string; value?: string; intent?: string };
export type Expectation = { type: "visible" | "not_visible" | "text_contains" | "url_contains" | "url_stays" | "value_equals"; role?: string; name?: string; text_contains?: string; value?: string };
export type Priority = "P0" | "P1" | "P2" | "P3";
export type Flow = {
  id: string; title: string; category: "happy" | "negative" | "edge" | "error_state" | "authz"; priority: Priority;
  preconditions: Array<"logged_out" | "logged_in">; steps: Step[]; expected: Expectation[]; source: "explored" | "prd" | "intent";
};

/** What the runner puts on a `test_result` event. */
export type TestResultData = {
  id: string; title?: string; status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted"; error?: string; errorLine?: number;
  failingStep?: number; failingExpect?: number; network?: Array<{ method: string; url: string; status: number }>; consoleErrors?: string[]; pageErrors?: string[];
  tracePath?: string; videoPath?: string; durationMs?: number;
};
/** What the classifier puts on a `test_result` event. */
export type ClassificationData = { test: string; class: string; confidence: number; evidence?: string[]; action?: string; rationale?: string };

/** The word the UI shows for a classification: a test that passed after a heal is "healed", any other is its class. */
export function classificationLabel(c: ClassificationData): string {
  return c.action === "healed" ? "healed" : c.class;
}

export type CaseStatus = "planned" | "running" | "passed" | "failed" | "blocked";
export const CASE_STATUSES: CaseStatus[] = ["planned", "running", "passed", "failed", "blocked"];

export type CaseRow = {
  id: string;
  flow: Flow;
  useCase: string;
  status: CaseStatus;
  /** When the status last changed; undefined while still planned. */
  at?: string;
  result?: TestResultData;
  classification?: ClassificationData;
  /** Why a blocked test is blocked, in a few words. */
  blockedReason?: string;
};

const USE_CASES: Record<string, string> = {
  auth: "Authentication", login: "Authentication", signin: "Authentication", authz: "Access control", reg: "Registration", register: "Registration", signup: "Registration",
  checkout: "Checkout", cart: "Cart", basket: "Cart", product: "Product catalog", products: "Product catalog", catalog: "Product catalog", inventory: "Product catalog",
  item: "Product catalog", orders: "Orders", order: "Orders",
  account: "Account", profile: "Account", home: "Landing", landing: "Landing", nav: "Navigation", search: "Search", coupon: "Checkout", billing: "Billing",
};

/**
 * The planner prefixes every flow id with its area (auth-001, checkout-002), which is the
 * closest thing the plan has to a use case. Known prefixes get a proper name; anything else
 * is capitalised so a new area still groups sensibly instead of landing in "Other".
 */
export function areaOf(flowId: string): string {
  const prefix = flowId.split("-")[0]?.toLowerCase() ?? "";
  if (USE_CASES[prefix]) return USE_CASES[prefix];
  if (!prefix) return "Other";
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

export const PRIORITY_LABEL: Record<Priority, string> = { P0: "Critical", P1: "High", P2: "Medium", P3: "Low" };
export const PRIORITY_ORDER: Priority[] = ["P0", "P1", "P2", "P3"];

export const CATEGORY_LABEL: Record<Flow["category"], string> = {
  happy: "Happy path", negative: "Negative", edge: "Edge case", error_state: "Error state", authz: "Access control",
};

function resultStatus(status: TestResultData["status"]): CaseStatus {
  if (status === "passed") return "passed";
  if (status === "failed" || status === "timedOut") return "failed";
  return "blocked";
}

/**
 * One row per planned flow with its latest status, walking the event stream in order so a
 * rerun, a heal or a later classification always wins over what came before. A flow the
 * generator could not resolve on the live page is blocked, as is one the classifier handed
 * to a human or blamed on the environment: nothing more will happen to it in this run.
 */
export function caseRows(events: RunEvent[], plan: Flow[]): CaseRow[] {
  const rows = new Map<string, CaseRow>(plan.map((flow) => [flow.id, { id: flow.id, flow, useCase: areaOf(flow.id), status: "planned" }]));
  for (const e of events) {
    if (e.type === "test_start") {
      const d = e.data as { id?: string } | undefined;
      const row = d?.id ? rows.get(d.id) : undefined;
      if (row) { row.status = "running"; row.at = e.at; row.blockedReason = undefined; }
    } else if (e.type === "test_result") {
      const d = e.data as Partial<TestResultData & ClassificationData> | undefined;
      if (!d) continue;
      if (d.id && d.status) {
        const row = rows.get(d.id);
        if (!row) continue;
        row.result = d as TestResultData;
        row.status = resultStatus(d.status);
        row.at = e.at;
        row.blockedReason = row.status === "blocked" ? d.status : undefined;
        // A fresh result supersedes the classification of the previous attempt.
        row.classification = undefined;
      }
      if (d.test && d.class) {
        const row = rows.get(d.test);
        if (!row) continue;
        row.classification = d as ClassificationData;
        if (d.class === "needs_human" || d.class === "env") { row.status = "blocked"; row.blockedReason = d.class === "env" ? "environment" : "needs a human"; row.at = e.at; }
      }
    } else if (e.type === "node_end" && e.node === "generate" && e.message) {
      const status = (e.data as { status?: string } | undefined)?.status;
      const row = rows.get(e.message);
      if (row && status === "unresolved") { row.status = "blocked"; row.blockedReason = "could not be resolved on the live page"; row.at = e.at; }
    }
  }
  return [...rows.values()];
}

export function statusCounts(rows: CaseRow[]): Record<CaseStatus | "all", number> {
  const counts = { all: rows.length, planned: 0, running: 0, passed: 0, failed: 0, blocked: 0 };
  for (const r of rows) counts[r.status]++;
  return counts;
}

export type UseCaseGroup = { useCase: string; rows: CaseRow[] };

/** Groups in order of first appearance in the plan, so the table reads the way the planner wrote it. */
export function groupByUseCase(rows: CaseRow[]): UseCaseGroup[] {
  const groups = new Map<string, CaseRow[]>();
  for (const r of rows) groups.set(r.useCase, [...(groups.get(r.useCase) ?? []), r]);
  return [...groups].map(([useCase, list]) => ({ useCase, rows: list }));
}

export function filterRows(rows: CaseRow[], filter: { status?: CaseStatus | "all"; query?: string }): CaseRow[] {
  const q = (filter.query ?? "").trim().toLowerCase();
  return rows.filter((r) => {
    if (filter.status && filter.status !== "all" && r.status !== filter.status) return false;
    if (q && !r.id.toLowerCase().includes(q) && !r.flow.title.toLowerCase().includes(q) && !r.useCase.toLowerCase().includes(q)) return false;
    return true;
  });
}

export type RunProgress = { total: number; done: number; running: number; passed: number; failed: number; blocked: number; planned: number; passRate: number | null };

export function runProgress(rows: CaseRow[]): RunProgress {
  const c = statusCounts(rows);
  const done = c.passed + c.failed + c.blocked;
  return { total: rows.length, done, running: c.running, passed: c.passed, failed: c.failed, blocked: c.blocked, planned: c.planned, passRate: done === 0 ? null : c.passed / done };
}

/** Whether the run is parked at the plan-review gate: the review node has started and not ended. */
export function isAwaitingReview(events: RunEvent[]): boolean {
  let waiting = false;
  for (const e of events) {
    if (e.node !== "review") continue;
    if (e.type === "node_start") waiting = true;
    if (e.type === "node_end") waiting = false;
  }
  return waiting;
}

export function isDoneEvents(events: RunEvent[]): boolean {
  return events.some((e) => e.type === "done");
}

/** The node currently executing, or null between nodes and after the run is done. */
export function activeNode(events: RunEvent[]): string | null {
  let active: string | null = null;
  for (const e of events) {
    if (e.type === "node_start" && e.node) active = e.node;
    if (e.type === "node_end" && e.node === active) active = null;
    if (e.type === "done") active = null;
  }
  return active;
}

/**
 * Turns an absolute artifact path from the API host into the path the file route expects,
 * relative to the run directory. Null when the path is not inside this run.
 */
export function artifactRel(path: string | undefined, runId: string): string | null {
  if (!path) return null;
  const rel = path.split(`/${runId}/`)[1];
  return rel ?? null;
}

export const specPath = (flowId: string) => `tests/${flowId}.spec.ts`;
export const liveFramePath = (flowId: string) => `live/${flowId}/frame.jpg`;

/** The most recent screenshot taken by a given agent (for example `generator:auth-001`), as a run-relative path. */
export function latestScreenshotBy(events: RunEvent[], runId: string, agent: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "screenshot" || e.agent !== agent) continue;
    return artifactRel((e.data as { path?: string } | undefined)?.path, runId);
  }
  return null;
}

const q = (s: string | undefined) => `'${s ?? ""}'`;

/** A step as a sentence, the way a person would narrate it. */
export function stepLabel(step: Step): string {
  const target = `${step.name ?? ""}${step.role ? ` ${step.role}` : ""}`.trim();
  switch (step.action) {
    case "goto": return `Navigate to ${step.target ?? "/"}`;
    case "fill": return `Fill ${q(step.value)} into ${target}`;
    case "click": return `Click ${target}`;
    case "select": return `Select ${q(step.value)} in ${target}`;
    case "press": return `Press ${step.value ?? "Enter"} on ${target}`;
    case "check": return `Check ${target}`;
  }
}

export function expectationLabel(exp: Expectation): string {
  const target = exp.role || exp.name ? `${exp.role ?? "element"}${exp.name ? ` ${q(exp.name)}` : ""}` : "the page";
  switch (exp.type) {
    case "visible": return exp.text_contains ? `Verify ${target} shows ${q(exp.text_contains)}` : `Verify ${target} is visible`;
    case "not_visible": return `Verify ${target} is not visible`;
    case "text_contains": return `Verify ${target} contains ${q(exp.text_contains)}`;
    case "url_contains": return `Verify the URL contains ${q(exp.value ?? exp.text_contains)}`;
    case "url_stays": return `Verify the URL stays on ${q(exp.value ?? exp.text_contains)}`;
    case "value_equals": return `Verify ${target} has value ${q(exp.value)}`;
  }
}

/** A one-line description in the style of a test case card: the scenario, who runs it, and what is verified. */
export function describeFlow(flow: Flow): string {
  const outcome = flow.expected.map(expectationLabel).map((s) => s.replace(/^Verify /, "")).join(", and ");
  const who = flow.preconditions.includes("logged_in") ? "As a signed-in user" : "As a visitor";
  return `${who}: ${flow.title.replace(/\.$/, "")}. Verify ${outcome}.`;
}

export type StepState = "passed" | "failed" | "pending" | "skipped";

/**
 * Per-step outcome for a test, using the failing step the runner derived from the error
 * line. A failure with no failing step happened in an expectation, so every action passed;
 * when the runner says which expectation, the ones before it passed and the ones after it
 * never ran, otherwise all of them are shown as failed.
 */
export function stepStates(flow: Flow, row: Pick<CaseRow, "status" | "result">): { steps: StepState[]; expectations: StepState[] } {
  const n = flow.steps.length;
  const m = flow.expected.length;
  const fill = (count: number, state: StepState) => Array.from({ length: count }, () => state);
  if (row.status === "passed") return { steps: fill(n, "passed"), expectations: fill(m, "passed") };
  if (row.status !== "failed") return { steps: fill(n, "pending"), expectations: fill(m, "pending") };
  const failing = row.result?.failingStep;
  if (failing === undefined) {
    const failingExpect = row.result?.failingExpect;
    if (failingExpect === undefined) return { steps: fill(n, "passed"), expectations: fill(m, "failed") };
    return { steps: fill(n, "passed"), expectations: flow.expected.map((_, i) => (i < failingExpect ? "passed" : i === failingExpect ? "failed" : "skipped")) };
  }
  return {
    steps: flow.steps.map((_, i) => (i < failing ? "passed" : i === failing ? "failed" : "skipped")),
    expectations: fill(m, "skipped"),
  };
}
