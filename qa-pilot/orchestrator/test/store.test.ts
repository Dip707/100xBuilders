import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { memoryStore } from "../src/store/memory.js";
import { withDerivedStatus, STALE_HEARTBEAT_MS, CHAT_MESSAGE_CAP, EmailTakenError, RunIdTakenError, type Store, type RunRecord, type ChatRecord, type ChatMessage } from "../src/store/types.js";

function runRec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1", userId: "u1", url: "http://localhost:3005",
    hasPrd: false, status: "running", startedAt: new Date().toISOString(), ...over,
  };
}

function chatRec(over: Partial<ChatRecord> = {}): ChatRecord {
  const now = new Date().toISOString();
  return { id: "chat-1", userId: "u1", kind: "intake", title: "New chat", createdAt: now, updatedAt: now, messages: [], draft: {}, ...over };
}

// The Mongo pass runs only when a URL is configured. It forces a database name ending in
// "_test" and refuses to drop anything else, so a stray run can never wipe the real
// qa_pilot database on a shared Atlas cluster.
// Deliberately reads the environment WITHOUT loading .env, so the default `npm test`
// stays hermetic and offline. MONGO_URI is accepted alongside the canonical name because
// that is what the operator's .env already uses (Rulings 4 and 5).
const mongoUrl = process.env.QA_PILOT_MONGO_URL ?? process.env.MONGO_URI;
const mongoDb = `qa_pilot_contract_${process.pid}_test`;

const factories: Array<[string, () => Promise<Store>]> = [["memory", async () => memoryStore()]];
if (mongoUrl) factories.push(["mongo", async () => {
  const { mongoStore, dropDatabaseForTests } = await import("../src/store/mongo.js");
  await dropDatabaseForTests(mongoUrl, mongoDb);
  return mongoStore({ url: mongoUrl, db: mongoDb });
}]);

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

  // A run that stops before the coverage gate summarises with `coverageScore: undefined`, and
  // Mongo's driver writes an undefined `$set` value as BSON null unless told otherwise. A null
  // reaching the UI crashed the run table on `coverageScore.toFixed`, because the guard there
  // tests for undefined. Optional fields a run never set must read back absent from every store.
  it("reads optional fields a run never set as undefined, not null", async () => {
    await store.insertRun(runRec({ intent: undefined }));
    await store.updateRun("run-1", { status: "partial", coverageScore: undefined, partialReason: undefined, testsPassed: 0 });

    const got = (await store.getRun("run-1"))!;
    expect(got.intent).toBeUndefined();
    expect(got.coverageScore).toBeUndefined();
    expect(got.partialReason).toBeUndefined();
    expect(got.testsPassed).toBe(0);
    expect((await store.listRuns("u1"))[0].coverageScore).toBeUndefined();
  });

  // A patch of nothing but undefined must stay a no-op rather than reaching the driver as an
  // empty $set, which Mongo rejects.
  it("ignores a patch whose every field is undefined", async () => {
    await store.insertRun(runRec({ testsPassed: 2 }));
    await store.updateRun("run-1", { coverageScore: undefined });
    expect((await store.getRun("run-1"))!.testsPassed).toBe(2);
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

  it("inserts and reads a chat", async () => {
    await store.insertChat(chatRec({ id: "chat-a", title: "Checkout run" }));
    const got = await store.getChat("chat-a");
    expect(got).toMatchObject({ id: "chat-a", userId: "u1", title: "Checkout run", messages: [], draft: {} });
    expect(await store.getChat("nope")).toBeNull();
  });

  it("appendChatTurn appends messages and merges the draft and title in one write", async () => {
    await store.insertChat(chatRec({ id: "chat-b" }));
    await store.appendChatTurn(
      "chat-b",
      [{ role: "user", text: "test the shop", at: new Date().toISOString() }],
      { draft: { url: "http://localhost:3005" }, title: "Mini shop" },
    );
    await store.appendChatTurn(
      "chat-b",
      [{ role: "assistant", text: "which flows?", at: new Date().toISOString() }],
      { draft: { url: "http://localhost:3005", intent: "checkout" } },
    );

    const got = (await store.getChat("chat-b"))!;
    expect(got.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(got.messages[1].text).toBe("which flows?");
    expect(got.draft).toEqual({ url: "http://localhost:3005", intent: "checkout" });
    expect(got.title).toBe("Mini shop");
  });

  it("appendChatTurn on an unknown chat is a no-op, never an upsert", async () => {
    await store.appendChatTurn("ghost", [{ role: "user", text: "hi", at: new Date().toISOString() }], {});
    expect(await store.getChat("ghost")).toBeNull();
  });

  it("keeps only the newest CHAT_MESSAGE_CAP messages", async () => {
    await store.insertChat(chatRec({ id: "chat-cap" }));
    const at = new Date().toISOString();
    const msgs = (from: number, to: number): ChatMessage[] =>
      Array.from({ length: to - from }, (_, i) => ({ role: "user", text: `m${from + i}`, at }));
    // Two turns rather than one message per turn: the cap still has to survive both a single
    // oversized push and a later append onto an already-full transcript, and CHAT_MESSAGE_CAP
    // sequential round-trips to a remote cluster times this out on latency alone.
    await store.appendChatTurn("chat-cap", msgs(0, CHAT_MESSAGE_CAP), {});
    await store.appendChatTurn("chat-cap", msgs(CHAT_MESSAGE_CAP, CHAT_MESSAGE_CAP + 5), {});

    const got = (await store.getChat("chat-cap"))!;
    expect(got.messages).toHaveLength(CHAT_MESSAGE_CAP);
    expect(got.messages[0].text).toBe("m5");
    expect(got.messages.at(-1)!.text).toBe(`m${CHAT_MESSAGE_CAP + 4}`);
  });

  it("lists a user's chats newest-updated first and never another user's", async () => {
    await store.insertChat(chatRec({ id: "chat-old", title: "Old", updatedAt: "2026-01-01T00:00:00.000Z" }));
    await store.insertChat(chatRec({ id: "chat-new", title: "New", updatedAt: "2026-02-01T00:00:00.000Z" }));
    await store.insertChat(chatRec({ id: "chat-other", userId: "u2", updatedAt: "2026-03-01T00:00:00.000Z" }));

    const listed = await store.listChats("u1");
    expect(listed.map((c) => c.id)).toEqual(["chat-new", "chat-old"]);
    expect(listed[0]).toMatchObject({ title: "New", updatedAt: "2026-02-01T00:00:00.000Z" });
  });

  it("summaries carry the started runId but not the transcript", async () => {
    await store.insertChat(chatRec({ id: "chat-run" }));
    await store.appendChatTurn("chat-run", [{ role: "user", text: "go", at: new Date().toISOString() }], { runId: "run-9" });
    const [summary] = await store.listChats("u1");
    expect(summary.runId).toBe("run-9");
    expect(summary).not.toHaveProperty("messages");
  });

  it("deletes a chat", async () => {
    await store.insertChat(chatRec({ id: "chat-del" }));
    await store.deleteChat("chat-del");
    expect(await store.getChat("chat-del")).toBeNull();
  });

  it("listChats filters by kind and reads a legacy chat without kind as intake", async () => {
    await store.insertChat(chatRec({ id: "intake-1" }));
    await store.insertChat(chatRec({ id: "copilot-1", kind: "copilot", scope: { url: "http://localhost:3005" } }));
    // Simulates a document written before `kind` existed.
    await store.insertChat({ ...chatRec({ id: "legacy-1" }), kind: undefined as unknown as "intake" });

    const intake = (await store.listChats("u1", { kind: "intake" })).map((c) => c.id).sort();
    expect(intake).toEqual(["intake-1", "legacy-1"]);
    const copilot = await store.listChats("u1", { kind: "copilot" });
    expect(copilot.map((c) => c.id)).toEqual(["copilot-1"]);
    expect(copilot[0].url).toBe("http://localhost:3005");
    expect(copilot[0]).not.toHaveProperty("pending");
    expect((await store.listChats("u1")).length).toBe(3);
    expect((await store.getChat("legacy-1"))!.kind).toBe("intake");
  });

  it("appendChatTurn stores message data, scope and pending, and null clears pending", async () => {
    await store.insertChat(chatRec({ id: "cp", kind: "copilot", scope: {} }));
    const at = new Date().toISOString();
    const plan = { kind: "rerun_plan" as const, runId: "run-1", testIds: ["checkout-001"], blocked: [] };
    await store.appendChatTurn("cp", [{ role: "assistant", text: "Rerunning 1 test", at, data: plan }], {
      scope: { url: "http://localhost:3005", runId: "run-1" },
      pending: { runId: "run-1", testIds: ["checkout-001"] },
    });
    let chat = (await store.getChat("cp"))!;
    expect(chat.messages[0].data).toEqual(plan);
    expect(chat.scope).toEqual({ url: "http://localhost:3005", runId: "run-1" });
    expect(chat.pending).toEqual({ runId: "run-1", testIds: ["checkout-001"] });

    await store.appendChatTurn("cp", [], { pending: null });
    chat = (await store.getChat("cp"))!;
    expect(chat.pending).toBeUndefined();
    expect(chat.scope).toEqual({ url: "http://localhost:3005", runId: "run-1" });
  });
});

afterAll(async () => {
  if (!mongoUrl) return;
  const { dropDatabaseForTests } = await import("../src/store/mongo.js");
  await dropDatabaseForTests(mongoUrl, mongoDb);
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

describe("run id collisions", () => {
  it("refuses to start a second run under an id that is already taken, with a message that says so", async () => {
    const store = memoryStore();
    const user = await store.createUser("collide@example.com", "pw");
    const rec = { id: "taken", userId: user.id, url: "http://x", hasPrd: false, status: "done" as const, startedAt: new Date().toISOString() };
    await store.insertRun(rec);
    await expect(store.insertRun(rec)).rejects.toThrow(RunIdTakenError);
    await expect(store.insertRun(rec)).rejects.toThrow(/already exists/i);
  });
});
