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
});
