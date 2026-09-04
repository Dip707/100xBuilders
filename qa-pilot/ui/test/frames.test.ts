import { describe, it, expect } from "vitest";
import { exploreFrames, exploreSteps, frameCaption, pagesVisited } from "@/lib/frames";
import type { RunEvent } from "@/lib/events";

const at = (s: number) => new Date(Date.UTC(2026, 8, 5, 12, 0, s)).toISOString();
const ev = (e: Partial<RunEvent>, sec = 0): RunEvent => ({ type: "agent_log", runId: "run-1", at: at(sec), ...e });
const shot = (path: string, message: string, sec = 0, agent = "explorer") =>
  ev({ type: "screenshot", agent, message, data: { path } }, sec);

describe("exploreFrames", () => {
  it("returns the explorer's screenshots in order, as run-relative paths", () => {
    const frames = exploreFrames([
      shot("/out/run-1/traces/explore/1-goto.png", "goto /", 0),
      shot("/out/run-1/traces/explore/2-click.png", "click Sign In", 3),
    ], "run-1");
    expect(frames.map((f) => f.rel)).toEqual(["traces/explore/1-goto.png", "traces/explore/2-click.png"]);
    expect(frames.map((f) => f.label)).toEqual(["goto /", "click Sign In"]);
  });

  it("numbers frames from one and offsets each from the first frame", () => {
    const frames = exploreFrames([
      shot("/out/run-1/traces/explore/a.png", "goto /", 0),
      shot("/out/run-1/traces/explore/b.png", "goto /login", 7),
    ], "run-1");
    expect(frames.map((f) => f.index)).toEqual([1, 2]);
    expect(frames.map((f) => f.offsetMs)).toEqual([0, 7000]);
  });

  // Every other agent has its own browser tile; the Sources recording is the crawl alone.
  it("ignores screenshots taken by other agents", () => {
    const frames = exploreFrames([
      shot("/out/run-1/traces/explore/a.png", "goto /", 0),
      shot("/out/run-1/traces/gen/b.png", "click Buy", 1, "generator:checkout-001"),
    ], "run-1");
    expect(frames).toHaveLength(1);
  });

  it("drops a screenshot whose path is not inside this run", () => {
    expect(exploreFrames([shot("/somewhere/else/a.png", "goto /")], "run-1")).toEqual([]);
  });

  it("drops a screenshot with no path at all", () => {
    expect(exploreFrames([ev({ type: "screenshot", agent: "explorer", message: "goto /" })], "run-1")).toEqual([]);
  });
});

describe("pagesVisited", () => {
  it("counts the structured visit logs the explorer emits", () => {
    const count = pagesVisited([
      ev({ type: "agent_log", agent: "explorer", message: "visited /", data: { visited: "/", forms: 0, buttons: 4 } }),
      ev({ type: "agent_log", agent: "explorer", message: "visited /login", data: { visited: "/login", forms: 1, buttons: 3 } }),
    ]);
    expect(count).toBe(2);
  });

  it("counts each path once however often it is revisited", () => {
    const count = pagesVisited([
      ev({ type: "agent_log", agent: "explorer", data: { visited: "/login" } }),
      ev({ type: "agent_log", agent: "explorer", data: { visited: "/login" } }),
    ]);
    expect(count).toBe(1);
  });

  it("ignores logs that carry no visited path", () => {
    expect(pagesVisited([ev({ type: "agent_log", agent: "explorer", message: "logged in via /login" })])).toBe(0);
  });

  // Runs recorded before the visit logs carried a payload still have the explorer's closing
  // decision, which lists the finished site map.
  it("counts the site map on the explore decision when the visit logs carry no payload", () => {
    const count = pagesVisited([
      ev({ type: "agent_log", agent: "explorer", message: "visited /login (1 forms, 3 buttons)" }),
      ev({ type: "decision", node: "explore", data: { node: "explore", reason: "discovered 3 pages", evidence: ["/", "/login", "/cart"] } }),
    ]);
    expect(count).toBe(3);
  });

  it("does not double-count a page that both sources report", () => {
    const count = pagesVisited([
      ev({ type: "agent_log", agent: "explorer", data: { visited: "/login" } }),
      ev({ type: "decision", node: "explore", data: { node: "explore", evidence: ["/", "/login"] } }),
    ]);
    expect(count).toBe(2);
  });

  it("ignores decisions from other nodes", () => {
    expect(pagesVisited([ev({ type: "decision", node: "plan", data: { node: "plan", evidence: ["auth-001", "cart-001"] } })])).toBe(0);
  });
});

describe("exploreSteps", () => {
  it("numbers the explorer's actions and notes, newest last", () => {
    const steps = exploreSteps([
      shot("/out/run-1/traces/explore/a.png", "goto /login", 0),
      ev({ type: "agent_log", agent: "explorer", message: "logged in via /login" }, 2),
      ev({ type: "agent_log", agent: "generator:x", message: "not the explorer" }, 3),
    ], "run-1");
    expect(steps.map((s) => [s.index, s.label])).toEqual([[1, "goto /login"], [2, "logged in via /login"]]);
  });

  it("links a step to the frame it captured, and leaves notes without one", () => {
    const steps = exploreSteps([
      shot("/out/run-1/traces/explore/a.png", "goto /", 0),
      ev({ type: "agent_log", agent: "explorer", message: "extraction failed for /cart" }, 1),
    ], "run-1");
    expect(steps[0].frame).toBe(1);
    expect(steps[1].frame).toBeNull();
  });

  it("surfaces an explorer error as a step so a stalled crawl is visible", () => {
    const steps = exploreSteps([ev({ type: "error", agent: "explorer", message: "browser crashed" })], "run-1");
    expect(steps).toHaveLength(1);
    expect(steps[0].tone).toBe("error");
  });
});

describe("frameCaption", () => {
  it("reads as the action, then where it happened, then the elapsed time", () => {
    expect(frameCaption({ index: 2, rel: "traces/explore/b.png", label: "click Sign In", at: at(7), offsetMs: 7000 }))
      .toBe("click Sign In · 0:07");
  });

  it("keeps minutes for a long crawl", () => {
    expect(frameCaption({ index: 9, rel: "x.png", label: "goto /cart", at: at(0), offsetMs: 754_000 }))
      .toBe("goto /cart · 12:34");
  });
});
