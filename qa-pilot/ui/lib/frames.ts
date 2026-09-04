import { artifactRel } from "./cases";
import type { RunEvent } from "./events";

/*
 * The explorer's crawl, as something you can scrub through.
 *
 * The toolkit already saves a screenshot after every action it takes and puts the path on
 * a `screenshot` event, so a run's whole exploration is sitting in events.jsonl unused.
 * Reading it back here means the thumbnail strip and the recording are the same array,
 * and that a run replays frame for frame long after its browsers are gone.
 */

export const EXPLORER = "explorer";

export type Frame = {
  /** 1-based, as the strip numbers them. */
  index: number;
  /** Path relative to the run directory, ready for `fileUrl`. */
  rel: string;
  /** What the agent did to produce this frame, e.g. `click Sign In`. */
  label: string;
  at: string;
  /** Milliseconds since the first frame, for the player's clock. */
  offsetMs: number;
};

export type Step = {
  index: number;
  label: string;
  at: string;
  tone: "action" | "note" | "error";
  /** The frame this step captured, by `Frame.index`; null for a step that took no picture. */
  frame: number | null;
};

const isExplorerShot = (e: RunEvent) => e.type === "screenshot" && e.agent === EXPLORER;

/** Every frame the explorer captured, oldest first. Frames outside the run directory cannot be served, so they are dropped. */
export function exploreFrames(events: RunEvent[], runId: string): Frame[] {
  const frames: Frame[] = [];
  let first: number | null = null;
  for (const e of events) {
    if (!isExplorerShot(e)) continue;
    const rel = artifactRel((e.data as { path?: string } | undefined)?.path, runId);
    if (!rel) continue;
    const ms = Date.parse(e.at);
    first ??= ms;
    frames.push({ index: frames.length + 1, rel, label: e.message ?? "step", at: e.at, offsetMs: Math.max(0, ms - first) });
  }
  return frames;
}

/**
 * How many distinct pages the crawl reached.
 *
 * Two structured sources, never the prose of a log line. The explorer's per-visit logs
 * carry the path they landed on, which is what makes the count climb while the crawl is
 * still running; its closing decision carries the finished site map as evidence, which is
 * authoritative and is also the only one of the two that runs recorded before the visit
 * logs gained a payload have. Taking the union means a live crawl counts up and an old run
 * still reports its real total.
 */
export function pagesVisited(events: RunEvent[]): number {
  const paths = new Set<string>();
  for (const e of events) {
    if (e.type === "decision" && (e.data as { node?: string } | undefined)?.node === "explore") {
      const evidence = (e.data as { evidence?: unknown }).evidence;
      if (Array.isArray(evidence)) for (const path of evidence) if (typeof path === "string") paths.add(path);
    }
    if (e.type !== "agent_log" || e.agent !== EXPLORER) continue;
    const visited = (e.data as { visited?: string } | undefined)?.visited;
    if (visited) paths.add(visited);
  }
  return paths.size;
}

/**
 * The crawl as a numbered list: every action the explorer took, plus the notes and errors
 * it logged along the way, in the order they happened. Actions carry the frame they
 * captured so the rail can drive the player.
 */
export function exploreSteps(events: RunEvent[], runId: string): Step[] {
  const steps: Step[] = [];
  let frame = 0;
  for (const e of events) {
    if (e.agent !== EXPLORER) continue;
    const push = (tone: Step["tone"], at: number | null) =>
      steps.push({ index: steps.length + 1, label: e.message ?? "", at: e.at, tone, frame: at });
    if (isExplorerShot(e)) {
      // Only a servable screenshot advances the frame counter, so step -> frame stays in
      // step with `exploreFrames`, which drops the unservable ones.
      if (!artifactRel((e.data as { path?: string } | undefined)?.path, runId)) continue;
      push("action", ++frame);
    } else if (e.type === "error") {
      push("error", null);
    } else if (e.type === "agent_log" && e.message) {
      push("note", null);
    }
  }
  return steps;
}

function clock(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** A frame's one-line caption: what the agent did, and how far into the crawl it did it. */
export function frameCaption(frame: Frame): string {
  return `${frame.label} · ${clock(frame.offsetMs)}`;
}
