import { describe, it, expect, beforeEach } from "vitest";
import { memoryStore } from "../src/store/memory.js";
import { withDerivedStatus, STALE_HEARTBEAT_MS, EmailTakenError, type Store, type RunRecord } from "../src/store/types.js";

function runRec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1", userId: "u1", url: "http://localhost:3005",
    hasPrd: false, status: "running", startedAt: new Date().toISOString(), ...over,
  };
}

const factories: Array<[string, () => Promise<Store>]> = [["memory", async () => memoryStore()]];

describe.each(factories)("store contract (%s)", (_name, make) => {
  let store: Store;
  beforeEach(async () => { store = await make(); });

  it("creates a user and finds it by email, case-insensitively", async () => {
    const u = await store.createUser("Foo@Example.com", "hash1");
    expect(u.id).toMatch(/./);
    expect(u.email).toBe("foo@example.com");
    const found = await store.findUserByEmail("foo@EXAMPLE.com");
    expect(found?.passwordHash).toBe("hash1");
    expect(await store.findUserById(u.id)).toMatchObject({ email: "foo@example.com" });
  });

  it("rejects a duplicate email with EmailTakenError regardless of case", async () => {
    await store.createUser("dup@example.com", "h");
    await expect(store.createUser("DUP@example.com", "h2")).rejects.toBeInstanceOf(EmailTakenError);
  });

  it("returns null for an unknown user", async () => {
    expect(await store.findUserByEmail("nobody@example.com")).toBeNull();
    expect(await store.findUserById("nope")).toBeNull();
  });

  it("stores and deletes a session and honours expiry", async () => {
    const future = new Date(Date.now() + 60_000);
    await store.createSession("hash-a", "u1", future);
    expect(await store.findSession("hash-a")).toMatchObject({ userId: "u1" });
    await store.deleteSession("hash-a");
    expect(await store.findSession("hash-a")).toBeNull();

    await store.createSession("hash-b", "u1", new Date(Date.now() - 1000));
    expect(await store.findSession("hash-b")).toBeNull();
  });

  it("inserts, patches, and reads a run", async () => {
    await store.insertRun(runRec());
    await store.updateRun("run-1", { status: "done", testsPassed: 3, testsFailed: 1 });
    const got = await store.getRun("run-1");
    expect(got).toMatchObject({ status: "done", testsPassed: 3, testsFailed: 1 });
    expect(await store.getRun("missing")).toBeNull();
  });

  it("lists a user's runs newest first and never another user's", async () => {
    await store.insertRun(runRec({ id: "run-old", startedAt: "2026-01-01T00:00:00.000Z" }));
    await store.insertRun(runRec({ id: "run-new", startedAt: "2026-02-01T00:00:00.000Z" }));
    await store.insertRun(runRec({ id: "run-other", userId: "u2" }));
    const mine = await store.listRuns("u1");
    expect(mine.map((r) => r.id)).toEqual(["run-new", "run-old"]);
  });

  it("touchRun advances the heartbeat", async () => {
    await store.insertRun(runRec({ heartbeatAt: "2026-01-01T00:00:00.000Z" }));
    await store.touchRun("run-1");
    const got = await store.getRun("run-1");
    expect(new Date(got!.heartbeatAt!).getTime()).toBeGreaterThan(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("reads a running run with a stale heartbeat as interrupted", async () => {
    const stale = new Date(Date.now() - STALE_HEARTBEAT_MS - 1000).toISOString();
    await store.insertRun(runRec({ id: "run-stale", heartbeatAt: stale }));
    expect((await store.getRun("run-stale"))!.status).toBe("interrupted");
    const listed = await store.listRuns("u1");
    expect(listed.find((r) => r.id === "run-stale")!.status).toBe("interrupted");
  });
});

describe("withDerivedStatus", () => {
  it("leaves a fresh running run alone", () => {
    const rec = runRec({ heartbeatAt: new Date().toISOString() });
    expect(withDerivedStatus(rec).status).toBe("running");
  });
  it("leaves a running run with no heartbeat alone, since it may have just started", () => {
    expect(withDerivedStatus(runRec()).status).toBe("running");
  });
  it("does not touch a terminal status even with an ancient heartbeat", () => {
    const rec = runRec({ status: "done", heartbeatAt: "2020-01-01T00:00:00.000Z" });
    expect(withDerivedStatus(rec).status).toBe("done");
  });
});
