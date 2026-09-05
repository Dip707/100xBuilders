import { existsSync } from "node:fs";
import { readOutput } from "../output.js";
import { needsLogin, specPath } from "../run.js";
import type { Classification, Defect, Flow, HealRecord, RunResults } from "../state.js";
import type { RunRecord } from "../store/types.js";

/** How much of an error message the model and the chat see. Enough to name the assertion, not the stack. */
const ERROR_HEAD = 240;

export type CatalogueEntry = {
  id: string;
  title: string;
  category: string;
  priority: string;
  preconditions: string[];
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted" | "not_run";
  /** Whether a spec exists on disk. A planned flow the generator gave up on has none and cannot be rerun. */
  generated: boolean;
  /** Whether the spec calls the login fixture, which decides whether a rerun needs credentials. */
  signsIn: boolean;
  error?: string;
  verdict?: { class: string; confidence: number; action: string; rationale?: string };
  heal?: { accepted: boolean; before: string; after: string; reason: string };
  defectId?: string;
};

export type Catalogue = { runId: string; url: string; status: string; finishedAt?: string; tests: CatalogueEntry[] };

function readJson<T>(runId: string, name: string, fallback: T): T {
  const raw = readOutput(runId, name);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * The newest classification per test. Classifications are not written to their own file: the
 * classify node emits each one as a `test_result` event whose data carries `test` and `class`,
 * so they are read back from events.jsonl. A plain runner result on the same event type has
 * `id` and `status` instead and is skipped.
 */
function latestClassifications(runId: string): Map<string, Classification> {
  const raw = readOutput(runId, "events.jsonl") ?? "";
  const out = new Map<string, Classification>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e: { type?: string; data?: unknown };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "test_result" || !e.data || typeof e.data !== "object") continue;
    const d = e.data as Partial<Classification>;
    if (typeof d.test === "string" && typeof d.class === "string") out.set(d.test, d as Classification);
  }
  return out;
}

/** Everything known about a run's tests, joined per test from the artifacts on disk. */
export function buildCatalogue(run: RunRecord): Catalogue {
  const plan = readJson<Flow[]>(run.id, "plan.json", []);
  const results = readJson<RunResults>(run.id, "results.json", { tests: [], at: "" });
  const defects = readJson<Defect[]>(run.id, "defects.json", []);
  const heals = readJson<HealRecord[]>(run.id, "heal-log.json", []);
  const verdicts = latestClassifications(run.id);
  const byId = new Map((Array.isArray(results.tests) ? results.tests : []).map((t) => [t.id, t]));

  const tests: CatalogueEntry[] = (Array.isArray(plan) ? plan : []).map((flow) => {
    const file = specPath(run.id, flow.id);
    const generated = existsSync(file);
    const result = byId.get(flow.id);
    const entry: CatalogueEntry = {
      id: flow.id,
      title: flow.title,
      category: flow.category,
      priority: flow.priority,
      preconditions: flow.preconditions,
      status: result?.status ?? "not_run",
      generated,
      signsIn: generated && needsLogin(file),
    };
    if (result?.error) entry.error = result.error.slice(0, ERROR_HEAD);
    const v = verdicts.get(flow.id);
    if (v) entry.verdict = { class: v.class, confidence: v.confidence, action: v.action, ...(v.rationale ? { rationale: v.rationale } : {}) };
    // The last heal attempt is the one that describes the spec as it stands now.
    const heal = (Array.isArray(heals) ? heals : []).filter((h) => h.test === flow.id).at(-1);
    if (heal) entry.heal = { accepted: heal.accepted, before: heal.before, after: heal.after, reason: heal.reason };
    const defect = (Array.isArray(defects) ? defects : []).find((d) => d.flow === flow.id);
    if (defect) entry.defectId = defect.id;
    return entry;
  });

  return { runId: run.id, url: run.url, status: run.status, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}), tests };
}

/** Generated tests whose latest status is anything but passed, in plan order. */
export function failedIds(c: Catalogue): string[] {
  return c.tests.filter((t) => t.generated && t.status !== "passed" && t.status !== "not_run").map((t) => t.id);
}

/** The catalogue as the model reads it: one line per test, terse, every field the model may pick on. */
export function renderCatalogue(c: Catalogue): string {
  const head = `run ${c.runId} | ${c.url} | ${c.status}${c.finishedAt ? ` | finished ${c.finishedAt}` : ""}`;
  if (c.tests.length === 0) return `${head}\n(no tests: this run has no plan or never generated any)`;
  const lines = c.tests.map((t) => {
    if (!t.generated) return `${t.id} | not generated | ${t.category} ${t.priority} | ${t.title}`;
    const parts = [t.id, t.status, `${t.category} ${t.priority}`, t.signsIn ? "signs in" : "no login", t.title];
    const extra: string[] = [];
    if (t.error) extra.push(`error: ${t.error.replace(/\s+/g, " ")}`);
    if (t.verdict) extra.push(`verdict ${t.verdict.class} ${t.verdict.confidence} ${t.verdict.action}${t.verdict.rationale ? `: ${t.verdict.rationale}` : ""}`);
    if (t.heal) extra.push(`heal ${t.heal.accepted ? "accepted" : "rejected"}: ${t.heal.reason}`);
    if (t.defectId) extra.push(`defect ${t.defectId}`);
    return parts.join(" | ") + (extra.length ? `\n    ${extra.join("\n    ")}` : "");
  });
  return [head, ...lines].join("\n");
}
