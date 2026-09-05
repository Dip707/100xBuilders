import { describe, it, expect } from "vitest";
import { plannerProgress } from "@/lib/planner";
import type { RunEvent } from "@/lib/events";

const at = "2026-09-05T12:00:00.000Z";
const ev = (e: Partial<RunEvent>): RunEvent => ({ type: "agent_log", runId: "run-1", at, ...e });
const log = (message: string, data?: unknown): RunEvent => ev({ agent: "planner", message, data });

const started = [ev({ type: "node_start", node: "plan" })];
const drafting = log("reading the site map: 2 pages, 1 form", { phase: "drafting", pages: 2, forms: 1, gaps: 0, iteration: 1, routes: ["/", "/cart"] });
const drafted = log("LLM proposed 2 flows", {
  phase: "drafted",
  ids: ["auth-001", "cart-001"],
  flows: [
    { id: "auth-001", title: "Signs in", category: "happy", priority: "P0" },
    { id: "cart-001", title: "Adds to cart", category: "happy", priority: "P1" },
  ],
});

describe("plannerProgress", () => {
  it("reports nothing when the plan node has not started", () => {
    expect(plannerProgress([])).toBeNull();
    expect(plannerProgress([ev({ type: "node_start", node: "explore" })])).toBeNull();
  });

  it("reports nothing once the plan node has ended, so a finished plan never shows progress", () => {
    expect(plannerProgress([...started, drafting, ev({ type: "node_end", node: "plan" })])).toBeNull();
  });

  it("reports nothing for a finished run, however its events happen to end", () => {
    expect(plannerProgress([...started, drafting, ev({ type: "done" })])).toBeNull();
  });

  it("reports the drafting phase with what the planner is reading", () => {
    const p = plannerProgress([...started, drafting])!;
    expect(p.phase).toBe("drafting");
    expect(p.pages).toBe(2);
    expect(p.forms).toBe(1);
    expect(p.routes).toEqual(["/", "/cart"]);
    expect(p.flows).toEqual([]);
    expect(p.startedAt).toBe(at);
  });

  it("lists the proposed flows as queued the moment the model returns them", () => {
    const p = plannerProgress([...started, drafting, drafted])!;
    expect(p.phase).toBe("validating");
    expect(p.flows.map((f) => [f.id, f.status])).toEqual([["auth-001", "pending"], ["cart-001", "pending"]]);
  });

  it("moves a flow through walking, repairing and its verdict", () => {
    const events = [
      ...started, drafting, drafted,
      log("walking auth-001 on the live app", { phase: "validating", flow: "auth-001", index: 1, total: 2 }),
      log("flow auth-001 step 2 unresolved, asking for repair", { phase: "repairing", flow: "auth-001", step: 2 }),
      log("kept auth-001", { phase: "validated", flow: "auth-001", ok: true }),
      log("walking cart-001 on the live app", { phase: "validating", flow: "cart-001", index: 2, total: 2 }),
    ];
    expect(plannerProgress(events.slice(0, 4))!.flows[0].status).toBe("walking");
    expect(plannerProgress(events.slice(0, 5))!.flows[0].status).toBe("repairing");
    const p = plannerProgress(events)!;
    expect(p.flows.map((f) => f.status)).toEqual(["kept", "walking"]);
    expect(p.kept).toBe(1);
    expect(p.dropped).toBe(0);
  });

  it("counts a dropped flow without removing it, so the walk's progress stays honest", () => {
    const p = plannerProgress([
      ...started, drafting, drafted,
      log("dropped cart-001", { phase: "validated", flow: "cart-001", ok: false }),
    ])!;
    expect(p.dropped).toBe(1);
    expect(p.flows).toHaveLength(2);
  });

  it("takes the last unphased planner line as the browser's current action", () => {
    const p = plannerProgress([...started, drafting, drafted, log("goto /"), log("click button Login")])!;
    expect(p.action).toBe("click button Login");
  });

  it("ignores a verdict for a flow that was never proposed rather than inventing a row", () => {
    const p = plannerProgress([...started, drafting, drafted, log("kept ghost-001", { phase: "validated", flow: "ghost-001", ok: true })])!;
    expect(p.flows).toHaveLength(2);
    expect(p.kept).toBe(0);
  });

  it("reads only the newest visit, so a re-plan does not inherit the last pass's flows", () => {
    const p = plannerProgress([
      ...started, drafting, drafted,
      log("kept auth-001", { phase: "validated", flow: "auth-001", ok: true }),
      ev({ type: "node_end", node: "plan" }),
      ev({ type: "node_start", node: "plan" }),
      log("rewriting the plan to close 2 coverage gaps", { phase: "drafting", pages: 2, forms: 1, gaps: 2, iteration: 2, routes: ["/", "/cart"] }),
    ])!;
    expect(p.iteration).toBe(2);
    expect(p.gaps).toBe(2);
    expect(p.phase).toBe("drafting");
    expect(p.flows).toEqual([]);
  });

  it("ignores logs from the other agents sharing the run's stream", () => {
    const p = plannerProgress([...started, drafting, ev({ agent: "explorer", message: "goto /checkout" })])!;
    expect(p.action).toBeNull();
  });
});
