import { describe, it, expect } from "vitest";
import { ScreencastHub, getScreencast, disposeScreencast, screencastEnabled } from "../src/browser/screencast.js";
import type { Frame } from "../src/browser/screencast.js";

describe("ScreencastHub", () => {
  it("keeps only the newest frame per agent, never a history", () => {
    const hub = new ScreencastHub(0);
    hub.push("planner", "a");
    hub.push("planner", "b");
    hub.push("explorer", "c");

    expect(hub.snapshot().map((f) => [f.agent, f.jpeg])).toEqual([
      ["planner", "b"],
      ["explorer", "c"],
    ]);
  });

  it("drops frames inside the rate limit but keeps the stream moving after it", () => {
    const hub = new ScreencastHub(150);
    expect(hub.push("planner", "a", 1000)).toBe(true);
    expect(hub.push("planner", "b", 1100)).toBe(false);
    expect(hub.push("planner", "c", 1200)).toBe(true);
    // A dropped frame must not become the tile: the last accepted one stands.
    expect(hub.snapshot()[0].jpeg).toBe("c");
  });

  it("rate-limits each agent independently", () => {
    const hub = new ScreencastHub(150);
    expect(hub.push("generator:a", "1", 1000)).toBe(true);
    expect(hub.push("generator:b", "1", 1010)).toBe(true);
  });

  it("notifies subscribers and stops on unsubscribe", () => {
    const hub = new ScreencastHub(0);
    const seen: Frame[] = [];
    const off = hub.subscribe((f) => seen.push(f));
    hub.push("planner", "a");
    off();
    hub.push("planner", "b");
    expect(seen.map((f) => f.jpeg)).toEqual(["a"]);
  });

  it("announces a closed viewport with a null frame and forgets the agent", () => {
    const hub = new ScreencastHub(0);
    const seen: Frame[] = [];
    hub.push("planner", "a");
    hub.subscribe((f) => seen.push(f));
    hub.close("planner");

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agent: "planner", jpeg: null });
    expect(hub.agents()).toEqual([]);
    // Closing an agent that was never live is a no-op, not a spurious tile removal.
    hub.close("nobody");
    expect(seen).toHaveLength(1);
  });

  it("closes every live viewport on end and ignores later frames", () => {
    const hub = new ScreencastHub(0);
    hub.push("planner", "a");
    hub.push("explorer", "b");
    const seen: Frame[] = [];
    hub.subscribe((f) => seen.push(f));

    hub.end();

    expect(hub.ended).toBe(true);
    expect(seen.filter((f) => f.agent && f.jpeg === null).map((f) => f.agent).sort()).toEqual(["explorer", "planner"]);
    expect(hub.push("planner", "c")).toBe(false);
    expect(hub.snapshot()).toEqual([]);
    // A late subscriber on an ended hub gets a working no-op unsubscribe, not a leak.
    expect(() => hub.subscribe(() => {})()).not.toThrow();
  });

  it("issues one hub per run and evicts it on dispose", () => {
    const a = getScreencast("run-screencast-1");
    expect(getScreencast("run-screencast-1")).toBe(a);
    a.push("planner", "x");

    disposeScreencast("run-screencast-1");

    expect(a.ended).toBe(true);
    expect(getScreencast("run-screencast-1")).not.toBe(a);
    disposeScreencast("run-screencast-1");
  });

  it("is on unless explicitly disabled", () => {
    const before = process.env.QA_PILOT_SCREENCAST;
    delete process.env.QA_PILOT_SCREENCAST;
    expect(screencastEnabled()).toBe(true);
    process.env.QA_PILOT_SCREENCAST = "0";
    expect(screencastEnabled()).toBe(false);
    if (before === undefined) delete process.env.QA_PILOT_SCREENCAST;
    else process.env.QA_PILOT_SCREENCAST = before;
  });
});
