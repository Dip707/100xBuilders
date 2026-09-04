import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { relativeTime, formatDuration, hostOf } from "@/lib/format";

function isoOffset(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

// relativeTime reads the clock itself. Without a frozen clock, the milliseconds that pass
// between building the fixture and formatting it tip the rounding ("5 seconds ago" became
// "6 seconds ago" whenever the machine was busy), which made this file flaky.
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z")); });
afterAll(() => { vi.useRealTimers(); });

describe("relativeTime", () => {
  it("renders a past timestamp a few seconds ago", () => {
    expect(relativeTime(isoOffset(-5_000))).toBe("5 seconds ago");
  });

  it("renders a past timestamp a few minutes ago", () => {
    expect(relativeTime(isoOffset(-3 * 60_000))).toBe("3 minutes ago");
  });

  it("renders a past timestamp a few hours ago", () => {
    expect(relativeTime(isoOffset(-2 * 3_600_000))).toBe("2 hours ago");
  });

  it("renders a past timestamp a couple of days ago", () => {
    expect(relativeTime(isoOffset(-2 * 86_400_000))).toBe("2 days ago");
  });

  it("scales a future timestamp by the same units as a past one", () => {
    const result = relativeTime(isoOffset(3_600_000));
    expect(result).not.toContain("seconds");
    expect(result).toBe("in 1 hour");
  });

  it("falls back to a locale date for a timestamp more than a week in the past", () => {
    const iso = isoOffset(-8 * 86_400_000);
    expect(relativeTime(iso)).toBe(new Date(iso).toLocaleDateString());
  });

  it("falls back to a locale date for a timestamp more than a week in the future", () => {
    const iso = isoOffset(8 * 86_400_000);
    expect(relativeTime(iso)).toBe(new Date(iso).toLocaleDateString());
  });

  it("returns unknown for an unparseable date", () => {
    expect(relativeTime("not-a-date")).toBe("unknown");
  });
});

describe("formatDuration", () => {
  it("returns a dash for undefined", () => {
    expect(formatDuration(undefined)).toBe("-");
  });

  it("returns a dash for a negative value", () => {
    expect(formatDuration(-1)).toBe("-");
  });

  it("returns a dash for a non-finite value", () => {
    expect(formatDuration(Infinity)).toBe("-");
    expect(formatDuration(NaN)).toBe("-");
  });

  it("renders sub-minute durations in seconds", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });

  it("renders durations over a minute as Xm SSs with zero-padded seconds", () => {
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(125_000)).toBe("2m 05s");
  });
});

describe("hostOf", () => {
  it("returns the host and port of a normal URL", () => {
    expect(hostOf("http://localhost:3005/some/path")).toBe("localhost:3005");
  });

  it("returns a non-URL string unchanged", () => {
    expect(hostOf("not a url")).toBe("not a url");
  });
});
