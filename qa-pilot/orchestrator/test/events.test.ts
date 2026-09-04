import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/events.js";

describe("EventBus", () => {
  it("writes events.jsonl, decisions.jsonl and fans out to subscribers", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-bus-")) + "/";
    const bus = new EventBus("r1", dir);
    const seen: string[] = [];
    const unsub = bus.subscribe((e) => seen.push(e.type));
    bus.log("planner", "hello");
    bus.decision({ node: "evaluate_coverage", reason: "score 0.6 < 0.75", evidence: ["gap: x"], next: "plan", at: new Date().toISOString() });
    unsub();
    bus.log("planner", "not seen");
    expect(seen).toEqual(["agent_log", "decision"]);
    const events = readFileSync(dir + "events.jsonl", "utf8").trim().split("\n");
    expect(events).toHaveLength(3);
    const decisions = readFileSync(dir + "decisions.jsonl", "utf8").trim().split("\n");
    expect(decisions).toHaveLength(1);
    expect(JSON.parse(decisions[0]).next).toBe("plan");
    expect(bus.replay()).toHaveLength(3);
  });

  it("replays events from existing events.jsonl when recreating EventBus", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-bus-")) + "/";
    const bus1 = new EventBus("r2", dir);
    bus1.log("agent1", "first event");
    bus1.decision({ node: "step1", reason: "test", evidence: [], next: "step2", at: new Date().toISOString() });

    const bus2 = new EventBus("r2", dir);
    const replayed = bus2.replay();
    expect(replayed).toHaveLength(2);
    expect(replayed[0].type).toBe("agent_log");
    expect(replayed[1].type).toBe("decision");

    bus2.log("agent2", "third event");
    const events = readFileSync(dir + "events.jsonl", "utf8").trim().split("\n");
    expect(events).toHaveLength(3);
  });
});
