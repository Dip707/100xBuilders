import type { RunEvent } from "./events";

/*
 * What the planner is doing right now, for the Test coverage screen to show while there is
 * still no plan to draw.
 *
 * The plan node is the longest silence in a run - about a minute inside a single LLM call,
 * then a minute or two dry-walking every proposed flow on the live app - and it writes
 * plan.json only at the very end. A screen that renders only the finished artifact
 * therefore sits empty for the whole of it and reads as a hung app. The node now puts a
 * `phase` on its agent logs; this folds those back into the progress the screen reports.
 */

export const PLANNER = "planner";

export type PlannerFlowStatus = "pending" | "walking" | "repairing" | "kept" | "dropped";
export type PlannerFlow = { id: string; title: string; category: string; status: PlannerFlowStatus };

export type PlannerProgress = {
  /** `drafting` is the LLM writing the flows; `validating` is the dry walk on the live app. */
  phase: "drafting" | "validating";
  /** When this visit to the plan node started, for the elapsed clock. */
  startedAt: string | null;
  /** 1 on the first pass; higher when the evaluator sent the plan back to close gaps. */
  iteration: number;
  /** How many gaps this pass was asked to close; 0 on the first pass. */
  gaps: number;
  pages: number;
  forms: number;
  /** The flow budget this pass is writing to, so the waiting list can show the right number of rows. */
  maxFlows: number;
  /** The routes the explorer found, named while the planner is still reading them. */
  routes: string[];
  flows: PlannerFlow[];
  kept: number;
  dropped: number;
  /** The last thing the planner's browser did, for the live viewport's caption. */
  action: string | null;
};

type Payload = {
  phase?: string; flow?: string; title?: string; ok?: boolean; pages?: number; forms?: number;
  gaps?: number; maxFlows?: number; iteration?: number; routes?: unknown; flows?: unknown;
};

const payload = (e: RunEvent): Payload => (e.data ?? {}) as Payload;

/**
 * Moves a flow the walk has reached to its new status. A log naming a flow that was never
 * announced is ignored rather than inventing a row: the list is the model's proposal, and
 * a phantom entry in it would misreport how much of the walk is left.
 */
function mark(byId: Map<string, PlannerFlow>, id: string | undefined, status: PlannerFlowStatus): void {
  const flow = id ? byId.get(id) : undefined;
  if (flow) flow.status = status;
}
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The plan node's progress, or null when it is not currently running.
 *
 * "Running" is the node's own start and end rather than the pipeline's notion of an active
 * node: the graph starts the next node in the same instant the plan node ends, and a
 * progress panel that outlived its node by even one render would flash stale phases at the
 * user. A finished run never reports progress, however its events happen to end.
 */
export function plannerProgress(events: RunEvent[]): PlannerProgress | null {
  let start = -1;
  let end = -1;
  let over = false;
  events.forEach((e, i) => {
    if (e.type === "node_start" && e.node === "plan") start = i;
    if (e.type === "node_end" && e.node === "plan") end = i;
    if (e.type === "done") over = true;
  });
  if (over || start < 0 || end > start) return null;

  const p: PlannerProgress = {
    phase: "drafting", startedAt: events[start].at, iteration: 1, gaps: 0,
    pages: 0, forms: 0, maxFlows: 0, routes: [], flows: [], kept: 0, dropped: 0, action: null,
  };
  const byId = new Map<string, PlannerFlow>();

  for (const e of events.slice(start + 1)) {
    if (e.agent !== PLANNER || e.type !== "agent_log") continue;
    const d = payload(e);
    switch (d.phase) {
      case "drafting":
        p.iteration = d.iteration ?? 1;
        p.gaps = d.gaps ?? 0;
        p.pages = d.pages ?? 0;
        p.forms = d.forms ?? 0;
        p.maxFlows = d.maxFlows ?? 0;
        p.routes = strings(d.routes);
        break;
      case "drafted":
        p.phase = "validating";
        for (const raw of Array.isArray(d.flows) ? d.flows : []) {
          const f = raw as { id?: string; title?: string; category?: string };
          if (!f.id) continue;
          byId.set(f.id, { id: f.id, title: f.title ?? f.id, category: f.category ?? "", status: "pending" });
        }
        break;
      case "validating":
        mark(byId, d.flow, "walking");
        break;
      case "repairing":
        mark(byId, d.flow, "repairing");
        break;
      case "validated":
        mark(byId, d.flow, d.ok ? "kept" : "dropped");
        break;
      default:
        // Not a phase log: the toolkit's own line for whatever the browser just did.
        if (e.message) p.action = e.message;
    }
  }

  p.flows = [...byId.values()];
  p.kept = p.flows.filter((f) => f.status === "kept").length;
  p.dropped = p.flows.filter((f) => f.status === "dropped").length;
  return p;
}
