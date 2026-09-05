import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSelect } from "@/components/copilot/RunSelect";
import { runLabel, selectableRuns } from "@/lib/copilot";
import type { RunRecord } from "@/lib/api";

const run = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id, userId: "u1", url: "http://localhost:3005", hasPrd: false, status: "done",
  startedAt: new Date(Date.now() - 120_000).toISOString(), testsPassed: 8, testsFailed: 2, ...over,
});

const RUNS = [
  run("run-2026-09-05T10-00-00"),
  run("run-2026-09-04T09-00-00", { url: "https://www.saucedemo.com", status: "partial" }),
  run("run-2026-09-03T08-00-00", { status: "interrupted", testsPassed: undefined, testsFailed: undefined }),
];

const select = (over: Partial<Parameters<typeof RunSelect>[0]> = {}) =>
  renderToStaticMarkup(<RunSelect runs={RUNS} value={null} open={false} onOpen={() => {}} onSelect={() => {}} {...over} />);

describe("selectableRuns", () => {
  it("offers only runs the copilot can act on", () => {
    const all = [run("a"), run("b", { status: "running" }), run("c", { status: "awaiting_review" }), run("d", { status: "partial" }), run("e", { status: "failed" }), run("f", { status: "interrupted" })];
    expect(selectableRuns(all).map((r) => r.id)).toEqual(["a", "d", "e", "f"]);
  });
});

describe("runLabel", () => {
  it("names the target and when it ran", () => {
    expect(runLabel(run("a"))).toBe("localhost:3005 · 2 minutes ago");
  });
});

describe("RunSelect", () => {
  it("reads as the most recent finished run until one is picked", () => {
    expect(select()).toContain("Most recent finished run");
  });

  it("names the picked run by target and time", () => {
    expect(select({ value: "run-2026-09-04T09-00-00" })).toContain("www.saucedemo.com · 2 minutes ago");
  });

  it("falls back to the bare id for a pinned run the list does not carry", () => {
    const html = select({ value: "run-2026-01-01T00-00-00" });
    expect(html).toContain("run-2026-01-01T00-00-00");
  });

  it("still names the pinned run while the list is loading", () => {
    expect(select({ runs: null, value: "run-2026-09-05T10-00-00" })).toContain("run-2026-09-05T10-00-00");
  });

  it("cannot be opened while a turn or rerun is in flight", () => {
    expect(select({ disabled: true })).toContain("disabled");
  });

  it("lists every run with its target and full id, and carries the outcome in the counts", () => {
    const html = select({ open: true, value: "run-2026-09-05T10-00-00" });
    expect(html).toContain("Most recent finished run");
    expect(html).toContain("localhost:3005");
    expect(html).toContain("www.saucedemo.com");
    for (const r of RUNS) expect(html).toContain(r.id);
    expect(html).toContain(">8<");
    expect(html).toContain(">2<");
    // A run with results says nothing about its status; only one with none falls back to it.
    expect(html).not.toContain(">done<");
    expect(html).not.toContain("partial");
    expect(html).toContain("interrupted");
  });

  it("says so when there is nothing to pick, and while the runs load", () => {
    expect(select({ open: true, runs: [] })).toContain("No finished runs yet.");
    expect(select({ open: true, runs: null })).toContain("Loading runs");
  });
});
