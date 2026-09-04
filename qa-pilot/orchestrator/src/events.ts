import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Decision } from "./state.js";
import { outputDir } from "./state.js";

export type RunEventType = "node_start" | "node_end" | "decision" | "agent_log" | "screenshot" | "test_result" | "error" | "done";
export type RunEvent = {
  type: RunEventType;
  runId: string;
  at: string;
  node?: string;
  agent?: string;
  message?: string;
  data?: unknown;
};
type Listener = (e: RunEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private events: RunEvent[] = [];
  constructor(public readonly runId: string, public readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    if (existsSync(dir + "events.jsonl")) {
      this.events = readFileSync(dir + "events.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    }
  }
  emit(e: Omit<RunEvent, "runId" | "at">): RunEvent {
    const full: RunEvent = { ...e, runId: this.runId, at: new Date().toISOString() };
    this.events.push(full);
    appendFileSync(this.dir + "events.jsonl", JSON.stringify(full) + "\n");
    if (full.type === "decision") appendFileSync(this.dir + "decisions.jsonl", JSON.stringify(full.data) + "\n");
    for (const l of this.listeners) l(full);
    return full;
  }
  log(agent: string, message: string, data?: unknown): void {
    this.emit({ type: "agent_log", agent, message, data });
  }
  decision(d: Decision): void {
    this.emit({ type: "decision", node: d.node, message: `${d.reason} -> ${d.next}`, data: d });
  }
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  replay(): RunEvent[] {
    return [...this.events];
  }
}

const registry = new Map<string, EventBus>();
export function getBus(runId: string): EventBus {
  let bus = registry.get(runId);
  if (!bus) {
    bus = new EventBus(runId, outputDir(runId));
    registry.set(runId, bus);
  }
  return bus;
}
