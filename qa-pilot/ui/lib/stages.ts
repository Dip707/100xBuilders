import { isDone, pipelineState, type NodeName } from "./derive";
import type { RunEvent } from "./events";
import type { RunStatus } from "./api";
import type { IconName } from "@/components/ui";

/*
 * The run workspace as four stages rather than nine graph nodes.
 *
 * The sidebar, the four run screens and the "next stage is ready" prompts all read this
 * one derivation, so the rail, the screen you are on and the screen you are about to open
 * can never disagree about where the run has got to.
 */

export type StageId = "sources" | "coverage" | "cases" | "runs";
export type StageStatus = "not_started" | "active" | "complete" | "not_run";

export type Stage = {
  id: StageId;
  label: string;
  icon: IconName;
  /** The graph nodes whose progress this stage reports. */
  nodes: NodeName[];
  status: StageStatus;
  /** What the stage is for, shown while it is still waiting. */
  blurb: string;
};

export const STAGE_ORDER = ["sources", "coverage", "cases", "runs"] as const;

const DEFINITIONS: Record<StageId, Omit<Stage, "status">> = {
  sources: {
    id: "sources", label: "Sources", icon: "compass", nodes: ["explore"],
    blurb: "qa-pilot browses the app to learn its pages, forms and gated routes.",
  },
  coverage: {
    id: "coverage", label: "Test coverage", icon: "target", nodes: ["plan", "evaluate_coverage", "review"],
    blurb: "The planner writes the flows worth testing and the evaluator scores them for gaps.",
  },
  cases: {
    id: "cases", label: "Test cases", icon: "list", nodes: ["generate"],
    blurb: "The generator turns each planned flow into a Playwright test, validating every selector live.",
  },
  runs: {
    id: "runs", label: "Test runs", icon: "play", nodes: ["run", "classify", "heal", "report"],
    blurb: "The suite executes, failures are classified, and the healer repairs what it can.",
  },
};

/**
 * Every stage with its current status.
 *
 * `active` beats `complete`: the runs stage owns run, classify, heal and report, and heal
 * loops back into run, so a stage stays active while any of its nodes is live rather than
 * flickering back and forth as the loop turns. A stage nothing ever entered reads as
 * `not_started` while the run is alive and `not_run` once it is over - a failed run must
 * not leave three screens claiming they are still waiting their turn.
 *
 * `status` matters as well as the stream because a run whose process was killed never got
 * to emit `done`: its events just stop. Without the record's own verdict, an interrupted
 * run would sit there promising work that nothing is left to do.
 */
export function stages(events: RunEvent[], status?: RunStatus): Stage[] {
  const nodes = new Map(pipelineState(events).map((n) => [n.node, n]));
  const over = isDone(events) || (status !== undefined && status !== "running" && status !== "awaiting_review");
  return STAGE_ORDER.map((id) => {
    const def = DEFINITIONS[id];
    const own = def.nodes.map((n) => nodes.get(n)!);
    // `over` gates active as well as not_started: a run whose process was killed left its
    // last node started and never ended, and nothing about that node is still live.
    const status: StageStatus = !over && own.some((n) => n.active)
      ? "active"
      : own.some((n) => n.visits > 0)
        ? "complete"
        : over
          ? "not_run"
          : "not_started";
    return { ...def, status };
  });
}

/** Whether a stage has produced anything worth opening its screen for. */
export function hasStarted(stage: Stage): boolean {
  return stage.status === "active" || stage.status === "complete";
}

/**
 * The stage a waiting screen is waiting on: the earliest one before it that has not
 * finished. Pointing at the immediate predecessor would be wrong while the run is still
 * three stages back - the honest answer is the one actually holding things up.
 */
export function waitingOn(list: Stage[], id: StageId): Stage | null {
  const index = list.findIndex((s) => s.id === id);
  if (index < 1) return null;
  return list.slice(0, index).find((s) => s.status !== "complete") ?? list[index - 1];
}

/** The stage after this one, once it has something to show; null while it is still waiting. */
export function nextStage(list: Stage[], id: StageId): Stage | null {
  const after = list[list.findIndex((s) => s.id === id) + 1];
  return after && hasStarted(after) ? after : null;
}

export function stageHref(runId: string, id: StageId): string {
  const base = `/runs/${encodeURIComponent(runId)}`;
  return id === "runs" ? base : `${base}/${id}`;
}

/** The run a pathname is inside, or null when it is not a run screen. "new" is the start form, not a run. */
export function runIdFromPath(pathname: string): string | null {
  const m = /^\/runs\/([^/]+)/.exec(pathname);
  if (!m || m[1] === "new") return null;
  return decodeURIComponent(m[1]);
}

/** Which stage a pathname addresses, or null when it is not a run screen. "new" is the start form. */
export function stageOfPath(pathname: string): StageId | null {
  const m = /^\/runs\/([^/]+)(?:\/([^/?#]+))?/.exec(pathname);
  if (!m || m[1] === "new") return null;
  if (!m[2]) return "runs";
  return (STAGE_ORDER as readonly string[]).includes(m[2]) ? (m[2] as StageId) : null;
}
