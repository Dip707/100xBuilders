import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AnthropicLlmClient, isRetryable, retryAfterMs, backoffMs, RETRYABLE_STATUS } from "../src/llm/client.js";

/** An error shaped like the SDK's APIError: a numeric status and Headers. */
function apiError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`${status} upstream said no`), { status, headers: new Headers(headers) });
}

/** A reply the client will accept, so a test can assert it recovered. */
const okMessage = { stop_reason: "end_turn", content: [{ type: "text", text: '{"answer":42}' }] };

/** A fake `messages.create` that fails a given number of times, then succeeds. */
function flaky(failures: number, err: () => unknown) {
  let calls = 0;
  const create = async () => {
    calls++;
    if (calls <= failures) throw err();
    return okMessage;
  };
  return { client: { messages: { create } } as never, calls: () => calls };
}

const schema = z.object({ answer: z.number() });
const fastRetry = { attempts: 5, baseMs: 1, capMs: 2 };

describe("isRetryable", () => {
  it("accepts every status in the retry set", () => {
    for (const s of RETRYABLE_STATUS) expect(isRetryable(apiError(s))).toBe(true);
  });

  it("rejects client errors that another attempt cannot fix", () => {
    for (const s of [400, 401, 403, 404, 422]) expect(isRetryable(apiError(s))).toBe(false);
  });

  it("accepts a connection error, which has no status at all", () => {
    expect(isRetryable(Object.assign(new Error("socket hang up"), { name: "APIConnectionError" }))).toBe(true);
  });

  it("does not retry a user abort", () => {
    expect(isRetryable(Object.assign(new Error("aborted"), { name: "APIUserAbortError" }))).toBe(false);
  });

  it("does not retry a plain error", () => {
    expect(isRetryable(new Error("something else"))).toBe(false);
  });
});

describe("retryAfterMs", () => {
  it("prefers retry-after-ms", () => {
    expect(retryAfterMs(apiError(429, { "retry-after-ms": "1500", "retry-after": "60" }))).toBe(1500);
  });

  it("reads retry-after as seconds", () => {
    expect(retryAfterMs(apiError(429, { "retry-after": "3" }))).toBe(3000);
  });

  it("reads retry-after as an HTTP date", () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    const ms = retryAfterMs(apiError(503, { "retry-after": at }));
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(6000);
  });

  it("is undefined when the server said nothing", () => {
    expect(retryAfterMs(apiError(503))).toBeUndefined();
    expect(retryAfterMs(new Error("no headers"))).toBeUndefined();
  });
});

describe("backoffMs", () => {
  const cfg = { attempts: 5, baseMs: 1000, capMs: 30000 };

  it("grows exponentially and stays inside the jitter window", () => {
    for (const [attempt, lo, hi] of [[0, 500, 1000], [1, 1000, 2000], [2, 2000, 4000]] as const) {
      for (const r of [0, 0.5, 0.999]) {
        const ms = backoffMs(attempt, apiError(503), cfg, () => r);
        expect(ms).toBeGreaterThanOrEqual(lo);
        expect(ms).toBeLessThanOrEqual(hi);
      }
    }
  });

  it("jitters, so a fan-out does not retry in lockstep", () => {
    expect(backoffMs(3, apiError(503), cfg, () => 0)).not.toBe(backoffMs(3, apiError(503), cfg, () => 0.99));
  });

  it("obeys the server's retry-after over its own schedule", () => {
    expect(backoffMs(0, apiError(429, { "retry-after": "7" }), cfg)).toBe(7000);
  });

  it("caps a server asking for an unreasonable wait, so a run cannot hang", () => {
    expect(backoffMs(0, apiError(429, { "retry-after": "600" }), cfg)).toBe(cfg.capMs);
  });

  it("caps its own exponential growth too", () => {
    expect(backoffMs(20, apiError(503), cfg, () => 1)).toBeLessThanOrEqual(cfg.capMs);
  });
});

describe("AnthropicLlmClient retries", () => {
  const complete = (client: never, extra: Record<string, unknown> = {}) =>
    new AnthropicLlmClient({ client, compat: true, retry: fastRetry, sleep: async () => {}, ...extra }).complete({
      prompt: "_smoke",
      input: "x",
      schema,
    });

  it("rides out a 503 and returns the eventual answer", async () => {
    const f = flaky(3, () => apiError(503));
    await expect(complete(f.client)).resolves.toEqual({ answer: 42 });
    expect(f.calls()).toBe(4);
  });

  it("gives up after the configured number of attempts", async () => {
    const f = flaky(99, () => apiError(503));
    await expect(complete(f.client)).rejects.toThrow(/503/);
    expect(f.calls()).toBe(fastRetry.attempts);
  });

  it("does not retry a non-retryable status", async () => {
    const f = flaky(99, () => apiError(400));
    await expect(complete(f.client)).rejects.toThrow(/400/);
    expect(f.calls()).toBe(1);
  });

  it("does not charge transport retries to the LLM budget", async () => {
    // A 503 spends no tokens, so counting it would make an outage look like work and
    // could exhaust maxLlmCalls without the model ever having answered once.
    const f = flaky(3, () => apiError(503));
    const c = new AnthropicLlmClient({ client: f.client, compat: true, retry: fastRetry, sleep: async () => {} });
    await c.complete({ prompt: "_smoke", input: "x", schema });
    expect(c.calls).toBe(1);
  });

  it("still counts a validation retry, which does spend tokens", async () => {
    let n = 0;
    const client = {
      messages: {
        create: async () => {
          n++;
          return n === 1
            ? { stop_reason: "end_turn", content: [{ type: "text", text: "not json at all" }] }
            : okMessage;
        },
      },
    } as never;
    const c = new AnthropicLlmClient({ client, compat: true, retry: fastRetry, sleep: async () => {} });
    await expect(c.complete({ prompt: "_smoke", input: "x", schema })).resolves.toEqual({ answer: 42 });
    expect(c.calls).toBe(2);
  });

  it("waits the amount backoff asks for", async () => {
    const waits: number[] = [];
    const f = flaky(2, () => apiError(503, { "retry-after": "2" }));
    await new AnthropicLlmClient({
      client: f.client,
      compat: true,
      retry: { attempts: 5, baseMs: 1000, capMs: 30000 },
      sleep: async (ms) => void waits.push(ms),
    }).complete({ prompt: "_smoke", input: "x", schema });
    expect(waits).toEqual([2000, 2000]);
  });
});
