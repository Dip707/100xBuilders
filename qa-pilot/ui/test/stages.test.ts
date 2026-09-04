import { describe, it, expect } from "vitest";
import { STAGE_ORDER, nextStage, runIdFromPath, stageHref, stageOfPath, stages, waitingOn } from "@/lib/stages";
import type { RunEvent } from "@/lib/events";

const at = "2026-09-05T12:00:00.000Z";
const ev = (e: Partial<RunEvent>): RunEvent => ({ type: "agent_log", runId: "run-1", at, ...e });
const byId = (list: ReturnType<typeof stages>) => Object.fromEntries(list.map((s) => [s.id, s]));

describe("stages", () => {
  it("returns the four workspace stages in pipeline order", () => {
    expect(stages([]).map((s) => s.id)).toEqual([...STAGE_ORDER]);
  });

  it("marks every stage not_started before the run emits anything", () => {
    expect(stages([]).every((s) => s.status === "not_started")).toBe(true);
  });

  it("marks the stage owning the live node active", () => {
    const s = byId(stages([ev({ type: "node_start", node: "explore" })]));
    expect(s.sources.status).toBe("active");
    expect(s.coverage.status).toBe("not_started");
    expect(s.cases.status).toBe("not_started");
    expect(s.runs.status).toBe("not_started");
  });

  it("completes a stage once its node ends and the next one starts", () => {
    const s = byId(stages([
      ev({ type: "node_start", node: "explore" }), ev({ type: "node_end", node: "explore" }),
      ev({ type: "node_start", node: "plan" }),
    ]));
    expect(s.sources.status).toBe("complete");
    expect(s.coverage.status).toBe("active");
  });

  it("keeps a multi-node stage active across all of its nodes", () => {
    const s = byId(stages([
      ev({ type: "node_start", node: "plan" }), ev({ type: "node_end", node: "plan" }),
      ev({ type: "node_start", node: "evaluate_coverage" }),
    ]));
    expect(s.coverage.status).toBe("active");
  });

  // heal loops back to run, so the runs stage must not flicker backwards mid-execution.
  it("holds the runs stage active while heal loops back into run", () => {
    const s = byId(stages([
      ev({ type: "node_start", node: "run" }), ev({ type: "node_end", node: "run" }),
      ev({ type: "node_start", node: "classify" }), ev({ type: "node_end", node: "classify" }),
      ev({ type: "node_start", node: "heal" }), ev({ type: "node_end", node: "heal" }),
      ev({ type: "node_start", node: "run" }),
    ]));
    expect(s.runs.status).toBe("active");
    expect(s.cases.status).toBe("not_started");
  });

  it("completes every visited stage once the run is done", () => {
    const s = byId(stages([
      ev({ type: "node_start", node: "explore" }), ev({ type: "node_end", node: "explore" }),
      ev({ type: "node_start", node: "report" }), ev({ type: "node_end", node: "report" }),
      ev({ type: "done" }),
    ]));
    expect(s.sources.status).toBe("complete");
    expect(s.runs.status).toBe("complete");
  });

  // A stage that never ran on a finished run is not "waiting"; saying so would promise
  // work that is never coming.
  it("reports a never-visited stage as not_run once the run is over", () => {
    const s = byId(stages([
      ev({ type: "node_start", node: "explore" }), ev({ type: "node_end", node: "explore" }),
      ev({ type: "error", message: "browser crashed" }), ev({ type: "done", message: "failed" }),
    ]));
    expect(s.sources.status).toBe("complete");
    expect(s.coverage.status).toBe("not_run");
    expect(s.cases.status).toBe("not_run");
    expect(s.runs.status).toBe("not_run");
  });

  // A killed process never emits `done`; its events simply stop. Only the record knows.
  it("reports unreached stages as not_run for an interrupted run that never emitted done", () => {
    const s = byId(stages([
      ev({ type: "node_start", node: "explore" }), ev({ type: "node_end", node: "explore" }),
      ev({ type: "node_start", node: "plan" }),
    ], "interrupted"));
    expect(s.sources.status).toBe("complete");
    // plan started and never ended, but nothing is still running: it is finished, not live.
    expect(s.coverage.status).toBe("complete");
    expect(s.cases.status).toBe("not_run");
    expect(s.runs.status).toBe("not_run");
  });

  it("leaves no stage live once the run is done", () => {
    const list = stages([ev({ type: "node_start", node: "run" }), ev({ type: "done" })]);
    expect(list.some((s) => s.status === "active")).toBe(false);
  });

  it("keeps unreached stages waiting while the run is still going", () => {
    const events = [ev({ type: "node_start", node: "explore" })];
    expect(byId(stages(events, "running")).coverage.status).toBe("not_started");
    expect(byId(stages(events, "awaiting_review")).coverage.status).toBe("not_started");
  });

  it("treats the optional review gate as part of the coverage stage", () => {
    const s = byId(stages([ev({ type: "node_start", node: "review" })]));
    expect(s.coverage.status).toBe("active");
  });
});

describe("waitingOn", () => {
  it("names the nearest upstream stage that has not completed", () => {
    const list = stages([ev({ type: "node_start", node: "explore" })]);
    expect(waitingOn(list, "cases")?.id).toBe("sources");
  });

  it("names the immediate predecessor once everything upstream of it is done", () => {
    const list = stages([
      ev({ type: "node_start", node: "explore" }), ev({ type: "node_end", node: "explore" }),
      ev({ type: "node_start", node: "plan" }),
    ]);
    expect(waitingOn(list, "cases")?.id).toBe("coverage");
  });

  it("returns null for a stage with nothing left to wait on", () => {
    const list = stages([ev({ type: "node_start", node: "explore" })]);
    expect(waitingOn(list, "sources")).toBeNull();
  });
});

describe("nextStage", () => {
  it("returns the following stage once it has data to show", () => {
    const list = stages([
      ev({ type: "node_start", node: "explore" }), ev({ type: "node_end", node: "explore" }),
      ev({ type: "node_start", node: "plan" }),
    ]);
    expect(nextStage(list, "sources")?.id).toBe("coverage");
  });

  it("returns null while the following stage has not started", () => {
    const list = stages([ev({ type: "node_start", node: "explore" })]);
    expect(nextStage(list, "sources")).toBeNull();
  });

  it("returns null for the last stage", () => {
    const list = stages([ev({ type: "node_start", node: "run" })]);
    expect(nextStage(list, "runs")).toBeNull();
  });
});

describe("stageHref and stageOfPath", () => {
  it("round-trips every stage through its own href", () => {
    for (const id of STAGE_ORDER) expect(stageOfPath(stageHref("run-1", id))).toBe(id);
  });

  it("keeps the run root as the runs stage", () => {
    expect(stageOfPath("/runs/run-1")).toBe("runs");
  });

  it("encodes a run id with characters that need it", () => {
    expect(stageHref("a b/c", "cases")).toBe("/runs/a%20b%2Fc/cases");
  });

  it("returns null outside a run", () => {
    expect(stageOfPath("/runs/new")).toBeNull();
    expect(stageOfPath("/")).toBeNull();
  });
});

describe("runIdFromPath", () => {
  it("finds the run on every screen of its workspace", () => {
    for (const p of ["/runs/run-1", "/runs/run-1/sources", "/runs/run-1/cases?test=auth-001"]) {
      expect(runIdFromPath(p)).toBe("run-1");
    }
  });

  it("decodes an escaped run id", () => {
    expect(runIdFromPath("/runs/a%20b")).toBe("a b");
  });

  it("returns null for the start form and outside runs", () => {
    expect(runIdFromPath("/runs/new")).toBeNull();
    expect(runIdFromPath("/")).toBeNull();
  });
});
