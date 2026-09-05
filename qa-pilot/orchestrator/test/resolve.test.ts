import { describe, it, expect, beforeEach } from "vitest";
import { memoryStore } from "../src/store/memory.js";
import type { RunRecord, Store } from "../src/store/types.js";
import { resolveRun, sameTarget } from "../src/copilot/resolve.js";

let store: Store;
const rec = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id, userId: "u1", url: "http://localhost:3005", hasPrd: false, status: "done",
  startedAt: `2026-09-0${id.slice(-1)}T10:00:00.000Z`, heartbeatAt: new Date().toISOString(), ...over,
});

beforeEach(async () => {
  store = memoryStore();
  await store.insertRun(rec("shop-1"));
  await store.insertRun(rec("shop-2", { status: "partial" }));
  await store.insertRun(rec("shop-3", { status: "running" }));
  await store.insertRun(rec("blog-4", { url: "https://blog.example.com/" }));
  await store.insertRun(rec("other-5", { userId: "u2" }));
});

describe("sameTarget", () => {
  it("compares origins, ignoring trailing slashes and paths", () => {
    expect(sameTarget("http://localhost:3005", "http://localhost:3005/")).toBe(true);
    expect(sameTarget("http://localhost:3005/login", "http://localhost:3005")).toBe(true);
    expect(sameTarget("http://localhost:3005", "http://localhost:3006")).toBe(false);
    expect(sameTarget("not a url", "http://localhost:3005")).toBe(false);
  });
});

describe("resolveRun", () => {
  it("prefers a run id named in the message, when the caller owns it", async () => {
    expect((await resolveRun(store, "u1", {}, "rerun shop-1 failures"))?.id).toBe("shop-1");
    expect((await resolveRun(store, "u1", {}, "look at other-5"))?.id).not.toBe("other-5");
  });

  it("then the scope's run id", async () => {
    expect((await resolveRun(store, "u1", { runId: "shop-1" }, "what failed?"))?.id).toBe("shop-1");
  });

  it("then the newest finished run for the scope's URL, skipping runs still in progress", async () => {
    expect((await resolveRun(store, "u1", { url: "http://localhost:3005/" }, "what failed last time?"))?.id).toBe("shop-2");
  });

  it("then the newest finished run of any URL", async () => {
    expect((await resolveRun(store, "u1", {}, "what failed last time?"))?.id).toBe("blog-4");
  });

  it("is null for a user with no finished runs", async () => {
    expect(await resolveRun(store, "u3", {}, "anything")).toBeNull();
  });

  it("never returns another user's run through the scope", async () => {
    expect(await resolveRun(store, "u1", { runId: "other-5" }, "x")).toBeNull();
  });
});
