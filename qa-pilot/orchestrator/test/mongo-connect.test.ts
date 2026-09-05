import { describe, it, expect } from "vitest";
import { MongoServerSelectionError, MongoNetworkError, MongoParseError, MongoServerError } from "mongodb";
import { connectWithRetry, isTransientConnectError, CONNECT_ATTEMPTS } from "../src/store/mongo.js";

/**
 * Boot used to die on the first slow answer from the cluster: the store is built before
 * serve() is ever called, so one blown server-selection window took the whole API down.
 * Measured cold-connect latency against the project's M0 Atlas cluster ranged from 2.2s to
 * 25s, with one attempt in six exceeding the old 8s budget outright, so a single attempt is
 * not a sound boot strategy. These cover the retry without needing a live cluster.
 */

const selectionTimeout = () =>
  new MongoServerSelectionError("Server selection timed out after 8000 ms", {} as never);

function attemptCounter(failures: number, error: () => Error) {
  let calls = 0;
  return {
    calls: () => calls,
    connect: async () => {
      calls += 1;
      if (calls <= failures) throw error();
      return { tag: "client" } as never;
    },
  };
}

describe("isTransientConnectError", () => {
  it("treats a server-selection timeout as transient", () => {
    expect(isTransientConnectError(selectionTimeout())).toBe(true);
  });

  it("treats a mid-handshake network reset as transient", () => {
    expect(isTransientConnectError(new MongoNetworkError("tlsv1 alert internal error"))).toBe(true);
  });

  it("does not retry a malformed connection string", () => {
    expect(isTransientConnectError(new MongoParseError("Invalid scheme"))).toBe(false);
  });

  it("does not retry a rejected credential", () => {
    const err = new MongoServerError({ message: "bad auth : authentication failed", codeName: "AuthenticationFailed" });
    expect(isTransientConnectError(err)).toBe(false);
  });

  it("does not retry a selection failure whose cause was authentication", () => {
    // Atlas reports a wrong password as a selection failure whose nested server error is the
    // auth rejection. Retrying that just delays a permanent failure by the whole budget.
    const err = selectionTimeout();
    (err as { reason?: unknown }).reason = { servers: new Map([["h:27017", { error: new Error("bad auth : authentication failed") }]]) };
    expect(isTransientConnectError(err)).toBe(false);
  });
});

describe("connectWithRetry", () => {
  it("returns the client when the first attempt succeeds", async () => {
    const c = attemptCounter(0, selectionTimeout);
    await expect(connectWithRetry(c.connect, { attempts: 3, delayMs: 0 })).resolves.toEqual({ tag: "client" });
    expect(c.calls()).toBe(1);
  });

  it("recovers when a slow cluster answers on a later attempt", async () => {
    const c = attemptCounter(2, selectionTimeout);
    await expect(connectWithRetry(c.connect, { attempts: 3, delayMs: 0 })).resolves.toEqual({ tag: "client" });
    expect(c.calls()).toBe(3);
  });

  it("gives up after the configured number of attempts and rethrows the last error", async () => {
    const c = attemptCounter(99, selectionTimeout);
    await expect(connectWithRetry(c.connect, { attempts: 3, delayMs: 0 })).rejects.toThrow(/Server selection timed out/);
    expect(c.calls()).toBe(3);
  });

  it("fails fast on a permanent error without burning the remaining attempts", async () => {
    const c = attemptCounter(99, () => new MongoParseError("Invalid scheme"));
    await expect(connectWithRetry(c.connect, { attempts: 3, delayMs: 0 })).rejects.toThrow(/Invalid scheme/);
    expect(c.calls()).toBe(1);
  });

  it("retries more than once by default", () => {
    expect(CONNECT_ATTEMPTS).toBeGreaterThan(1);
  });
});
