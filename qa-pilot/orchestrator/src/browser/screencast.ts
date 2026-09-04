/**
 * Live viewport frames from the agents' browsers, for the run screen's browser panel.
 *
 * Frames deliberately do NOT travel on the EventBus. That bus appends every event to
 * events.jsonl and keeps the whole history in memory so a late subscriber can replay it;
 * a JPEG every 150ms from a dozen concurrent generator agents would turn a run's event
 * log into hundreds of megabytes and the replay into an OOM. A screencast is only
 * meaningful while it is happening, so this hub keeps just the newest frame per agent,
 * persists nothing, and replays nothing.
 */

/** One viewport update. A null `jpeg` means that agent's browser is gone and its tile should go. */
export type Frame = {
  agent: string;
  /** Monotonic per hub, so a client can tell a redelivered frame from a new one. */
  seq: number;
  at: number;
  /** Base64 JPEG exactly as Chromium's Page.screencastFrame delivers it, or null on close. */
  jpeg: string | null;
};

type Listener = (f: Frame) => void;

/** Chromium emits frames as fast as the page paints; nobody needs to watch faster than this. */
const DEFAULT_INTERVAL_MS = 150;

export class ScreencastHub {
  private latest = new Map<string, Frame>();
  private lastAt = new Map<string, number>();
  private listeners = new Set<Listener>();
  private seq = 0;
  private done = false;

  constructor(private readonly minIntervalMs: number = DEFAULT_INTERVAL_MS) {}

  get ended(): boolean {
    return this.done;
  }

  /**
   * Offers a frame for `agent`. Returns false when it was dropped by the rate limit, which
   * is the common case and not an error: the caller must still acknowledge it to Chromium
   * or the screencast stalls.
   */
  push(agent: string, jpeg: string, now = Date.now()): boolean {
    if (this.done) return false;
    const last = this.lastAt.get(agent) ?? 0;
    if (now - last < this.minIntervalMs) return false;
    this.lastAt.set(agent, now);
    this.publish({ agent, seq: this.seq++, at: now, jpeg });
    return true;
  }

  /** That agent's browser has closed: drop its tile. */
  close(agent: string, now = Date.now()): void {
    if (this.done || !this.latest.has(agent)) return;
    this.latest.delete(agent);
    this.lastAt.delete(agent);
    this.publish({ agent, seq: this.seq++, at: now, jpeg: null });
  }

  /** The run is over. Every open viewport is closed and later frames are ignored. */
  end(now = Date.now()): void {
    if (this.done) return;
    for (const agent of [...this.latest.keys()]) this.close(agent, now);
    this.done = true;
    for (const l of [...this.listeners]) l({ agent: "", seq: this.seq++, at: now, jpeg: null });
    this.listeners.clear();
  }

  private publish(f: Frame): void {
    if (f.jpeg !== null) this.latest.set(f.agent, f);
    for (const l of [...this.listeners]) l(f);
  }

  /** The newest frame of every live agent, so a client that connects mid-run starts full. */
  snapshot(): Frame[] {
    return [...this.latest.values()].sort((a, b) => a.seq - b.seq);
  }

  subscribe(fn: Listener): () => void {
    if (this.done) return () => {};
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Live viewports, for tests and diagnostics. */
  agents(): string[] {
    return [...this.latest.keys()];
  }
}

const registry = new Map<string, ScreencastHub>();

/** On unless explicitly disabled, so a demo never has to remember a flag. */
export function screencastEnabled(): boolean {
  return process.env.QA_PILOT_SCREENCAST !== "0";
}

export function getScreencast(runId: string): ScreencastHub {
  let hub = registry.get(runId);
  if (!hub) {
    hub = new ScreencastHub();
    registry.set(runId, hub);
  }
  return hub;
}

/**
 * Ends the run's hub and forgets it. Unlike the EventBus registry, this one must evict:
 * a retained hub holds a JPEG per agent, and a long-lived API process would otherwise
 * accumulate one such set per run it has ever served.
 */
export function disposeScreencast(runId: string): void {
  registry.get(runId)?.end();
  registry.delete(runId);
}
