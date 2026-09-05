import { describe, it, expect } from "vitest";
import { gotoWithRetry, actionTimeoutMs, navigationTimeoutMs, navRetryAttempts } from "../src/browser/toolkit.js";

/** A page stub whose goto fails a set number of times with a given error. */
function page(failures: number, message: string) {
  let calls = 0;
  return {
    calls: () => calls,
    goto: async () => {
      calls++;
      if (calls <= failures) throw new Error(message);
      return null;
    },
  };
}

const opts = { attempts: 3, delayMs: 0, sleep: async () => {} };

describe("gotoWithRetry", () => {
  it("returns as soon as a navigation succeeds", async () => {
    const p = page(0, "");
    await gotoWithRetry(p, "https://example.test/");
    expect(p.calls()).toBe(1);
  });

  it("rides out a transient timeout", async () => {
    const p = page(2, "page.goto: Timeout 30000ms exceeded.");
    await gotoWithRetry(p, "https://example.test/", opts);
    expect(p.calls()).toBe(3);
  });

  it("rides out a dropped connection", async () => {
    const p = page(1, "page.goto: net::ERR_CONNECTION_RESET at https://example.test/");
    await gotoWithRetry(p, "https://example.test/", opts);
    expect(p.calls()).toBe(2);
  });

  it("gives up after the attempt limit and rethrows the real error", async () => {
    const p = page(99, "page.goto: Timeout 30000ms exceeded.");
    await expect(gotoWithRetry(p, "https://example.test/", opts)).rejects.toThrow(/Timeout 30000ms/);
    expect(p.calls()).toBe(3);
  });

  it("does not retry an error that another attempt cannot fix", async () => {
    // A navigation the browser refused outright is not a slow network; retrying it just
    // spends the run's clock on a URL that will never load.
    const p = page(99, "page.goto: net::ERR_BLOCKED_BY_CLIENT at https://example.test/");
    await expect(gotoWithRetry(p, "https://example.test/", opts)).rejects.toThrow(/BLOCKED_BY_CLIENT/);
    expect(p.calls()).toBe(1);
  });

  it("backs off further on each attempt", async () => {
    const waits: number[] = [];
    const p = page(2, "page.goto: Timeout 30000ms exceeded.");
    await gotoWithRetry(p, "https://example.test/", { attempts: 3, delayMs: 100, sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([100, 200]);
  });

  it("reports each retry so a slow target is visible, not silent", async () => {
    const logs: string[] = [];
    const p = page(1, "page.goto: Timeout 30000ms exceeded.");
    await gotoWithRetry(p, "https://example.test/", { ...opts, log: (m) => logs.push(m) });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("retrying 2/3");
  });
});

describe("timeout budgets", () => {
  const saved = { ...process.env };
  const reset = () => {
    delete process.env.QA_PILOT_ACTION_TIMEOUT_MS;
    delete process.env.QA_PILOT_NAV_TIMEOUT_MS;
    delete process.env.QA_PILOT_NAV_RETRIES;
  };

  it("keeps actions on a short leash and navigation on a long one", () => {
    reset();
    expect(actionTimeoutMs()).toBe(5000);
    expect(navigationTimeoutMs()).toBe(30000);
    // The gap is the point: a slow site must not look like a missing element.
    expect(navigationTimeoutMs()).toBeGreaterThan(actionTimeoutMs());
    Object.assign(process.env, saved);
  });

  it("is tunable, and ignores junk values", () => {
    reset();
    process.env.QA_PILOT_ACTION_TIMEOUT_MS = "9000";
    process.env.QA_PILOT_NAV_TIMEOUT_MS = "45000";
    process.env.QA_PILOT_NAV_RETRIES = "5";
    expect(actionTimeoutMs()).toBe(9000);
    expect(navigationTimeoutMs()).toBe(45000);
    expect(navRetryAttempts()).toBe(5);
    process.env.QA_PILOT_NAV_TIMEOUT_MS = "not-a-number";
    process.env.QA_PILOT_NAV_RETRIES = "0";
    expect(navigationTimeoutMs()).toBe(30000);
    expect(navRetryAttempts()).toBe(3);
    Object.assign(process.env, saved);
  });
});
