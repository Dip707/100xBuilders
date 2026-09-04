import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.js";
import { memoryStore } from "../src/store/memory.js";
import { FakeLlmClient } from "../src/llm/client.js";
import type { Store } from "../src/store/types.js";
import { hashToken, mintToken, SESSION_COOKIE, SESSION_TTL_MS } from "../src/auth/session.js";
import { clearSessionCache } from "../src/auth/middleware.js";

const ORIGIN = "http://localhost:4000";

let store: Store;
let cookie: string;
let userId: string;
let headers: Record<string, string>;

async function signIn(email: string): Promise<{ userId: string; cookie: string }> {
  const user = await store.createUser(email, "unused");
  const token = mintToken();
  await store.createSession(hashToken(token), user.id, new Date(Date.now() + SESSION_TTL_MS));
  return { userId: user.id, cookie: `${SESSION_COOKIE}=${token}` };
}

/** A turn that answers whatever it is asked with a fixed reply and patch. */
function api(answer: unknown = { reply: "Which flows matter?", patch: { url: "localhost:3005" }, needs: ["intent"] }) {
  return createApi({
    store,
    start: (input) => ({ runId: input.runId }),
    llm: new FakeLlmClient({ "chat-intake": answer }),
  });
}

async function newChat(app: ReturnType<typeof api>): Promise<string> {
  const res = await app.request(`${ORIGIN}/chats`, { method: "POST", headers });
  const { chat } = await res.json();
  return chat.id;
}

beforeEach(async () => {
  clearSessionCache();
  store = memoryStore();
  const session = await signIn("chat@example.com");
  userId = session.userId;
  cookie = session.cookie;
  headers = { cookie, "content-type": "application/json" };
});

describe("chat routes", () => {
  it("requires a session", async () => {
    const app = api();
    for (const [method, path] of [["GET", "/chats"], ["POST", "/chats"], ["GET", "/chats/x"], ["DELETE", "/chats/x"], ["POST", "/chats/x/messages"]] as const) {
      const res = await app.request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("creates an empty chat owned by the caller", async () => {
    const app = api();
    const res = await app.request(`${ORIGIN}/chats`, { method: "POST", headers });
    expect(res.status).toBe(200);
    const { chat } = await res.json();
    expect(chat).toMatchObject({ userId, messages: [], draft: {} });
    expect(chat.id).toMatch(/./);
    expect(await store.getChat(chat.id)).not.toBeNull();
  });

  it("stores both messages of a turn and returns the reply, patch and needs", async () => {
    const app = api();
    const id = await newChat(app);

    const res = await app.request(`${ORIGIN}/chats/${id}/messages`, {
      method: "POST", headers, body: JSON.stringify({ text: "test my shop on localhost:3005", snapshot: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reply).toBe("Which flows matter?");
    expect(body.patch).toEqual({ url: "https://localhost:3005" });
    expect(body.needs).toEqual(["intent"]);

    const stored = (await store.getChat(id))!;
    expect(stored.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "test my shop on localhost:3005"],
      ["assistant", "Which flows matter?"],
    ]);
    expect(stored.draft).toEqual({ url: "https://localhost:3005" });
  });

  it("lays the patch on top of the client's snapshot, so a hand-typed field is never clobbered", async () => {
    const app = api();
    const id = await newChat(app);
    await app.request(`${ORIGIN}/chats/${id}/messages`, {
      method: "POST", headers,
      body: JSON.stringify({ text: "go", snapshot: { intent: "typed by hand", reviewPlan: true } }),
    });
    expect((await store.getChat(id))!.draft).toEqual({
      url: "https://localhost:3005", intent: "typed by hand", reviewPlan: true,
    });
  });

  it("keeps credentials out of the stored draft even when the client sends them in the snapshot", async () => {
    const app = api();
    const id = await newChat(app);
    await app.request(`${ORIGIN}/chats/${id}/messages`, {
      method: "POST", headers,
      body: JSON.stringify({ text: "part of it is behind a login", snapshot: { requiresSignIn: true, username: "admin", password: "hunter2" } }),
    });
    const stored = JSON.stringify(await store.getChat(id));
    expect(stored).not.toContain("hunter2");
    expect(stored).not.toContain("admin");
    expect((await store.getChat(id))!.draft.requiresSignIn).toBe(true);
  });

  it("names the chat from the first turn only", async () => {
    const app = api({ reply: "ok", patch: {}, needs: [], title: "Mini shop checkout" });
    const id = await newChat(app);
    const send = () => app.request(`${ORIGIN}/chats/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "hi", snapshot: {} }) });

    const first = await send();
    expect((await first.json()).title).toBe("Mini shop checkout");
    expect((await store.getChat(id))!.title).toBe("Mini shop checkout");

    // The model is asked for a title only while the chat is unnamed; a later turn that
    // returns one anyway must not rename a chat the user has already seen in the list.
    await send();
    expect((await store.getChat(id))!.title).toBe("Mini shop checkout");
  });

  it("rejects an empty message without spending an LLM call", async () => {
    const llm = new FakeLlmClient({ "chat-intake": { reply: "unused", patch: {} } });
    const app = createApi({ store, start: (i) => ({ runId: i.runId }), llm });
    const id = await newChat(app);
    const res = await app.request(`${ORIGIN}/chats/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "   " }) });
    expect(res.status).toBe(400);
    expect(llm.calls).toBe(0);
  });

  it("reads back a chat with its transcript, and lists it as a summary without one", async () => {
    const app = api();
    const id = await newChat(app);
    await app.request(`${ORIGIN}/chats/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "hi", snapshot: {} }) });

    const one = await app.request(`${ORIGIN}/chats/${id}`, { headers });
    expect((await one.json()).chat.messages).toHaveLength(2);

    const all = await app.request(`${ORIGIN}/chats`, { headers });
    const { chats } = await all.json();
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ id, url: "https://localhost:3005" });
    expect(chats[0].messages).toBeUndefined();
  });

  it("deletes a chat", async () => {
    const app = api();
    const id = await newChat(app);
    expect((await app.request(`${ORIGIN}/chats/${id}`, { method: "DELETE", headers })).status).toBe(204);
    expect(await store.getChat(id)).toBeNull();
  });

  it("treats another account's chat as missing, for reads, turns and deletes alike", async () => {
    const app = api();
    const mine = await newChat(app);
    const other = await signIn("someone@example.com");
    const otherHeaders = { cookie: other.cookie, "content-type": "application/json" };

    expect((await app.request(`${ORIGIN}/chats/${mine}`, { headers: otherHeaders })).status).toBe(404);
    expect((await app.request(`${ORIGIN}/chats/${mine}`, { method: "DELETE", headers: otherHeaders })).status).toBe(404);
    const turn = await app.request(`${ORIGIN}/chats/${mine}/messages`, { method: "POST", headers: otherHeaders, body: JSON.stringify({ text: "hi", snapshot: {} }) });
    expect(turn.status).toBe(404);

    // and the chat is untouched by the attempt
    expect((await store.getChat(mine))!.messages).toHaveLength(0);
    expect((await app.request(`${ORIGIN}/chats`, { headers: otherHeaders })).status).toBe(200);
    expect((await (await app.request(`${ORIGIN}/chats`, { headers: otherHeaders })).json()).chats).toHaveLength(0);
  });

  it("links the chat to the run it started", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-chat-")) + "/";
    const app = api();
    const id = await newChat(app);
    const res = await app.request(`${ORIGIN}/run`, {
      method: "POST", headers, body: JSON.stringify({ url: "http://localhost:3005", chatId: id }),
    });
    expect(res.status).toBe(200);
    const { runId } = await res.json();
    expect((await store.getChat(id))!.runId).toBe(runId);
  });

  it("starts the run even when the chatId is unknown or someone else's", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-chat-")) + "/";
    const app = api();
    const res = await app.request(`${ORIGIN}/run`, {
      method: "POST", headers, body: JSON.stringify({ url: "http://localhost:3005", chatId: "ghost" }),
    });
    expect(res.status).toBe(200);
  });
});
