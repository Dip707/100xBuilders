import "./env.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { getBus } from "./events.js";
import { getScreencast, type Frame } from "./browser/screencast.js";
import { outputDir, RunInputSchema, type StartRunInput } from "./state.js";
import { startRun, newRunId, submitReview, awaitingReview, rerunTest, rerunBlocker, ReviewSubmissionSchema } from "./run.js";
import { defaultStore } from "./store/index.js";
import type { ChatRecord, RunRecord, Store } from "./store/types.js";
import { chatTurn, RunDraftSchema } from "./chat/turn.js";
import { makeLlmClient, type LlmClient } from "./llm/client.js";
import { authRoutes } from "./auth/routes.js";
import { requireUser, type AuthEnv } from "./auth/middleware.js";
import { artifactManifest } from "./runs/manifest.js";
import { readSuite } from "./suite/bundle.js";
import { zip } from "./suite/zip.js";

// userId is not part of RunInputSchema (Ruling 1), so there is nothing to omit for it here;
// the handler supplies it from the session when it builds the StartRunInput.
const BodySchema = RunInputSchema.omit({ runId: true, prdText: true }).extend({
  prd: z.string().optional(),
  /** The chat this run was configured in, so the conversation can link to what it produced. */
  chatId: z.string().optional(),
});

const ChatMessageSchema = z.object({
  text: z.string(),
  /**
   * The form exactly as it stands in the browser, which is the authority on what is filled
   * in: the person may have typed into a field the chat never touched, or cleared one it did.
   * Omitted entirely, the chat's stored draft is used instead.
   */
  snapshot: RunDraftSchema.optional(),
});

/** What a chat is called until the first turn names it. */
const UNTITLED_CHAT = "New chat";

const MIME: Record<string, string> = { html: "text/html", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webm: "video/webm", zip: "application/zip", json: "application/json", md: "text/markdown", ts: "text/plain", jsonl: "text/plain" };

/** How often a screencast connection flushes whatever frames have accumulated. */
const FRAME_TICK_MS = 120;

/** How long a screencast may go silent before it sends a comment to prove it is alive. */
const KEEPALIVE_MS = 15_000;

const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

function isValidRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId) && runId !== "." && runId !== "..";
}

export function createApi(opts: {
  start: (input: StartRunInput) => Promise<{ runId: string }> | { runId: string };
  store: Store;
  /** Injectable so the API tests do not spawn Playwright. */
  rerun?: (runId: string, testId: string, store: Store) => Promise<unknown | null>;
  rerunBlocker?: (runId: string, testId: string, store: Store) => Promise<string | null>;
  /** Injectable so the chat tests do not call Anthropic. */
  llm?: LlmClient;
}) {
  const app = new Hono<AuthEnv>();
  const { store } = opts;

  app.use("*", cors({
    // credentials must be allowed for the session cookie to travel on fetch and on
    // EventSource, and an explicit origin is mandatory once credentials are in play.
    origin: [process.env.QA_PILOT_UI_ORIGIN ?? "http://localhost:3000"],
    credentials: true,
  }));

  // Unauthenticated: a reachability probe, so Atlas can be checked before a demo.
  app.get("/health", async (c) => {
    try {
      await store.findUserById("__health_probe__");
      return c.json({ ok: true, mongo: "up" });
    } catch (err) {
      // Deliberately generic: /health is unauthenticated, and a driver error carries the
      // cluster hostname or IP in its message. The detail goes to the server log instead.
      console.error("[health] store probe failed:", err);
      return c.json({ ok: false, mongo: "down" }, 503);
    }
  });

  // Unauthenticated by design: signup and login are how a session is obtained. /auth/me
  // guards itself inside the route group.
  app.route("/auth", authRoutes(store));

  // Everything below requires a session.
  app.use("/run", requireUser(store));
  app.use("/runs", requireUser(store));
  app.use("/runs/*", requireUser(store));
  app.use("/events/*", requireUser(store));
  app.use("/screencast/*", requireUser(store));
  app.use("/report/*", requireUser(store));
  app.use("/chats", requireUser(store));
  app.use("/chats/*", requireUser(store));

  // Built on first use rather than at boot: the Anthropic constructor needs a key, and the
  // API has to come up for /health and /auth on a machine that has none configured.
  let llm = opts.llm;
  const getLlm = (): LlmClient => (llm ??= makeLlmClient());

  /**
   * Resolves a run the caller is allowed to see, or null. A run owned by somebody else is
   * indistinguishable from one that does not exist: both yield null and therefore 404,
   * so the API never confirms that another account's run id is real.
   */
  async function ownedRun(runId: string, userId: string): Promise<RunRecord | null> {
    if (!isValidRunId(runId)) return null;
    const rec = await store.getRun(runId);
    return rec && rec.userId === userId ? rec : null;
  }

  /**
   * The chat equivalent of `ownedRun`: somebody else's chat and a chat that never existed
   * both read as missing, so the API never confirms another account's chat id.
   */
  async function ownedChat(chatId: string, userId: string): Promise<ChatRecord | null> {
    const rec = await store.getChat(chatId);
    return rec && rec.userId === userId ? rec : null;
  }

  app.post("/run", async (c) => {
    const parsed = BodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const { prd, chatId, ...rest } = parsed.data;
    const userId = c.get("user").id;
    const { runId } = await opts.start({ ...rest, runId: newRunId(), prdText: prd, userId });
    // Best-effort link, never a reason to fail the start: the run is already going by now,
    // and an unknown or foreign chatId only means history will not cross-reference it.
    if (chatId && (await ownedChat(chatId, userId))) await store.appendChatTurn(chatId, [], { runId });
    return c.json({ runId });
  });

  app.post("/chats", async (c) => {
    const now = new Date().toISOString();
    const chat: ChatRecord = {
      id: randomUUID(), userId: c.get("user").id, title: UNTITLED_CHAT,
      createdAt: now, updatedAt: now, messages: [], draft: {},
    };
    await store.insertChat(chat);
    return c.json({ chat });
  });

  app.get("/chats", async (c) => {
    return c.json({ chats: await store.listChats(c.get("user").id) });
  });

  app.get("/chats/:chatId", async (c) => {
    const chat = await ownedChat(c.req.param("chatId"), c.get("user").id);
    return chat ? c.json({ chat }) : c.json({ error: "not found" }, 404);
  });

  app.delete("/chats/:chatId", async (c) => {
    const chatId = c.req.param("chatId");
    if (!(await ownedChat(chatId, c.get("user").id))) return c.json({ error: "not found" }, 404);
    await store.deleteChat(chatId);
    return c.body(null, 204);
  });

  app.post("/chats/:chatId/messages", async (c) => {
    const chatId = c.req.param("chatId");
    const chat = await ownedChat(chatId, c.get("user").id);
    if (!chat) return c.json({ error: "not found" }, 404);

    const parsed = ChatMessageSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const text = parsed.data.text.trim();
    if (!text) return c.json({ error: "a message cannot be empty" }, 400);

    const base = parsed.data.snapshot ?? chat.draft;
    const at = new Date().toISOString();
    const userMessage = { role: "user" as const, text, at };
    // Only an unnamed chat asks for a title, so a later turn cannot rename a conversation
    // the user has already learned to recognise in the list.
    const needsTitle = chat.title === UNTITLED_CHAT;

    let turn;
    try {
      turn = await chatTurn(getLlm(), { draft: base, messages: chat.messages.concat(userMessage), needsTitle });
    } catch (err) {
      // Nothing is stored on a failed turn: a half-written exchange would leave the
      // transcript claiming the assistant was asked something it never answered.
      console.error("[chat] turn failed:", err);
      return c.json({ error: "the assistant could not answer that - try again" }, 502);
    }

    const draft = { ...base, ...turn.patch };
    const title = needsTitle ? turn.title : undefined;
    await store.appendChatTurn(
      chatId,
      [userMessage, { role: "assistant", text: turn.reply, at: new Date().toISOString() }],
      title ? { draft, title } : { draft },
    );
    return c.json({ reply: turn.reply, patch: turn.patch, needs: turn.needs, draft, ...(title ? { title } : {}) });
  });

  app.get("/runs", async (c) => {
    return c.json({ runs: await store.listRuns(c.get("user").id) });
  });

  app.get("/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    const run = await ownedRun(runId, c.get("user").id);
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json({ run, manifest: artifactManifest(runId) });
  });

  /**
   * The reviewed plan for a run paused at the review gate. Whatever the reviewer kept -
   * possibly edited, possibly a subset - becomes the plan the generator sees.
   */
  app.post("/runs/:runId/review", async (c) => {
    const runId = c.req.param("runId");
    if (!(await ownedRun(runId, c.get("user").id))) return c.json({ error: "not found" }, 404);
    const parsed = ReviewSubmissionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    if (!awaitingReview(runId)) return c.json({ error: "this run is not waiting for review" }, 409);
    submitReview(runId, parsed.data.flows);
    return c.json({ ok: true, flows: parsed.data.flows.length });
  });

  /** Re-executes one generated test of a finished run and returns its fresh result. */
  app.post("/runs/:runId/tests/:testId/rerun", async (c) => {
    const runId = c.req.param("runId");
    const testId = c.req.param("testId");
    const run = await ownedRun(runId, c.get("user").id);
    if (!run || !isValidRunId(testId)) return c.json({ error: "not found" }, 404);
    if (run.status === "running" || run.status === "awaiting_review") return c.json({ error: "the run is still in progress" }, 409);
    const blocker = await (opts.rerunBlocker ?? rerunBlocker)(runId, testId, store);
    if (blocker === "test not found") return c.json({ error: blocker }, 404);
    if (blocker) return c.json({ error: blocker }, 409);
    const result = await (opts.rerun ?? rerunTest)(runId, testId, store);
    if (!result) return c.json({ error: "this test is already being re-run" }, 409);
    return c.json({ result });
  });

  app.get("/events/:runId", async (c) => {
    const runId = c.req.param("runId");
    if (!(await ownedRun(runId, c.get("user").id))) return c.json({ error: "not found" }, 404);
    const bus = getBus(runId);
    return streamSSE(c, async (stream) => {
      let id = 0;
      let finished = false;
      for (const e of bus.replay()) {
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: String(id++) });
        if (e.type === "done") finished = true;
      }
      if (finished) return;
      await new Promise<void>((resolveStream) => {
        const unsub = bus.subscribe((e) => {
          stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: String(id++) }).catch(() => { unsub(); resolveStream(); });
          if (e.type === "done") { unsub(); resolveStream(); }
        });
        stream.onAbort(() => { unsub(); resolveStream(); });
      });
    });
  });

  /**
   * Live viewports of the agents' browsers, as base64 JPEG frames.
   *
   * Separate from /events/:runId on purpose. That stream replays a run's whole history on
   * every connection; frames are worthless once stale and far too big to keep, so this one
   * replays nothing but the newest frame per live agent and then follows along.
   *
   * Backpressure is latest-wins: frames arriving while a write is in flight overwrite the
   * pending frame for that agent rather than queueing behind it, so a client on a slow link
   * sees a lower frame rate instead of an ever-growing backlog and an ever-growing heap.
   */
  app.get("/screencast/:runId", async (c) => {
    const runId = c.req.param("runId");
    if (!isValidRunId(runId)) return c.json({ error: "not found" }, 404);
    if (!(await ownedRun(runId, c.get("user").id))) return c.json({ error: "not found" }, 404);
    const hub = getScreencast(runId);
    return streamSSE(c, async (stream) => {
      const pending = new Map<string, Frame>();
      for (const f of hub.snapshot()) pending.set(f.agent, f);
      let alive = true;
      const stop = () => { alive = false; };
      const unsub = hub.subscribe((f) => { pending.set(f.agent, f); });
      stream.onAbort(() => { unsub(); stop(); });
      try {
        // A run is idle for long stretches - a planner waiting on the model casts nothing -
        // and a stream that sends no bytes at all never flushes its headers and eventually
        // gets dropped as dead. This comment opens the stream at once, and the same write
        // repeats whenever the agents fall quiet.
        let lastWrite = Date.now();
        await stream.write(": connected\n\n");
        while (alive) {
          for (const agent of [...pending.keys()]) {
            const frame = pending.get(agent)!;
            pending.delete(agent);
            await stream.writeSSE({ event: "frame", data: JSON.stringify(frame) });
            lastWrite = Date.now();
          }
          // The hub is ended and drained once the run finishes: close rather than poll forever.
          if (hub.ended && pending.size === 0) break;
          if (Date.now() - lastWrite >= KEEPALIVE_MS) {
            await stream.write(": ping\n\n");
            lastWrite = Date.now();
          }
          await stream.sleep(FRAME_TICK_MS);
        }
      } catch {
        // The client went away mid-write; the abort handler may not have fired yet.
      } finally {
        unsub();
      }
    });
  });

  /**
   * The run's generated tests as a standalone Playwright project: specs, fixtures, config and
   * setup instructions, ready to run anywhere. Built on request from what the report node left
   * on disk, so it always matches the specs as they finished - healed ones included.
   */
  app.get("/runs/:runId/suite.zip", async (c) => {
    const runId = c.req.param("runId");
    if (!(await ownedRun(runId, c.get("user").id))) return c.text("not found", 404);
    const entries = readSuite(runId);
    if (entries.length === 0) return c.text("the suite is not ready yet", 404);
    return c.body(new Uint8Array(zip(entries)), 200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${runId}-suite.zip"`,
      "cache-control": "no-store",
    });
  });

  app.get("/report/:runId", async (c) => {
    const runId = c.req.param("runId");
    if (!(await ownedRun(runId, c.get("user").id))) return c.text("not found", 404);
    const path = outputDir(runId) + "report.html";
    if (!existsSync(path)) return c.text("report not ready", 404);
    return c.html(readFileSync(path, "utf8"));
  });

  app.get("/runs/:runId/files/*", async (c) => {
    const runId = c.req.param("runId");
    if (!(await ownedRun(runId, c.get("user").id))) return c.text("not found", 404);
    const root = resolve(outputDir(runId));
    // c.req.param("*") is not populated for a trailing "*" segment in the installed Hono
    // version (4.13.5) - it comes back undefined, so the wildcard remainder is recovered
    // from the raw path instead. split("/files/")[1] truncates at the FIRST occurrence and
    // mis-parses a path containing a nested "/files/" segment; indexOf + slice split on the
    // first occurrence only, so everything after it (nested "/files/" included) is kept.
    const marker = "/files/";
    const markerIndex = c.req.path.indexOf(marker);
    const rel = markerIndex === -1 ? "" : c.req.path.slice(markerIndex + marker.length);
    const path = resolve(root, decodeURIComponent(rel));
    const relPath = relative(root, path);
    if (relPath === "" || relPath.startsWith("..") || isAbsolute(relPath) || !existsSync(path)) return c.text("not found", 404);
    const ext = path.split(".").pop() ?? "";
    // Recordings, traces and screenshots are written once and may be cached; everything
    // else - live frames, plan.json, results.json, generated specs - is rewritten while
    // the run progresses and a cached copy would show the UI a stale plan.
    const cache = relPath.startsWith("traces/") ? "private, max-age=3600" : "no-store";
    return c.body(new Uint8Array(readFileSync(path)), 200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": cache });
  });

  return app;
}

if (process.argv[1] && process.argv[1].endsWith("api.ts")) {
  const port = Number(process.env.QA_PILOT_API_PORT ?? 4000);
  const store = await defaultStore();
  const app = createApi({
    store,
    start: async (input) => {
      const { runId, done } = await startRun(input);
      done.catch(() => {});
      return { runId };
    },
  });
  serve({ fetch: app.fetch, port }, () => console.log(`qa-pilot api on http://localhost:${port}`));
}
