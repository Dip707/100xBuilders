import "./env.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { getBus } from "./events.js";
import { getScreencast, type Frame } from "./browser/screencast.js";
import { outputDir, RunInputSchema, CredentialsSchema, type StartRunInput, type Step, type TestResult } from "./state.js";
import {
  startRun, newRunId, submitReview, awaitingReview, rerunTest, rerunBlocker, ReviewSubmissionSchema,
  contextLoginSteps as liveLoginSteps, needsLogin, rerunTests as runRerunTests, specPath,
} from "./run.js";
import { defaultStore, storeChoice } from "./store/index.js";
import type { ChatRecord, RerunPlanData, RunRecord, Store } from "./store/types.js";
import { chatTurn, RunDraftSchema } from "./chat/turn.js";
import { buildCatalogue } from "./copilot/catalogue.js";
import { resolveRun, FINISHED } from "./copilot/resolve.js";
import { copilotTurn, validateSelection, type CopilotDecision } from "./copilot/turn.js";
import { planRerun, resultData, summariseRerun } from "./copilot/execute.js";
import { hydrateLoginSteps, readRedactedLoginSteps } from "./copilot/login-steps.js";
import { makeLlmClient, type LlmClient } from "./llm/client.js";
import { authRoutes } from "./auth/routes.js";
import { requireUser, type AuthEnv } from "./auth/middleware.js";
import { artifactManifest } from "./runs/manifest.js";
import { readSuite } from "./suite/bundle.js";
import { liveTrackerClient, publicShape, TrackerError, type TrackerClient } from "./integrations/index.js";
import { buildTicket } from "./integrations/ticket.js";
import type { Defect, Flow, RunResults } from "./state.js";
import { readOutput } from "./output.js";
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

const CopilotScopeSchema = z.object({ url: z.string().optional(), runId: z.string().optional() });
const CopilotMessageSchema = z.object({ text: z.string() });
/** Repointing an existing chat: `null` clears the pin rather than naming a run. */
const CopilotChatScopeSchema = z.object({ runId: z.string().nullable().optional() });
const CopilotExecuteSchema = z.object({ credentials: CredentialsSchema.optional() });

/** Chats with an execute in flight. One rerun per chat at a time; a second request answers 409. */
const executing = new Set<string>();

/** Tickets being filed, keyed by run and test, so a double click cannot reach the tracker twice. */
const filing = new Set<string>();

/** Where the UI lives, for the link a ticket carries back to the case page and the OAuth return. */
const UI_ORIGIN = process.env.QA_PILOT_UI_ORIGIN ?? "http://localhost:3000";
/** Where this API is reachable from the browser, for the OAuth callback Composio sends it to. */
const API_ORIGIN = process.env.QA_PILOT_API_ORIGIN ?? `http://localhost:${process.env.QA_PILOT_API_PORT ?? 4000}`;
/** How long the callback waits for Composio to see the connection active. */
const CONNECT_WAIT_MS = 30_000;

const ConnectSchema = z.object({ provider: z.enum(["linear", "jira"]), return: z.string().optional() });
const DestinationSchema = z.object({ id: z.string().min(1) });

/** Only a path on the UI may be returned to after OAuth, never another origin. */
function safeReturn(raw: string | undefined | null): string | undefined {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : undefined;
}

function readJsonOutput<T>(runId: string, name: string, fallback: T): T {
  const raw = readOutput(runId, name);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** What a chat is called until the first turn names it. */
const UNTITLED_CHAT = "New chat";

const MIME: Record<string, string> = { html: "text/html", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webm: "video/webm", zip: "application/zip", json: "application/json", md: "text/markdown", ts: "text/plain", jsonl: "text/plain" };

/**
 * Parses a single byte range against a known file size, per RFC 9110.
 *
 * Returns the resolved [start, end] pair (both inclusive), `null` when the header is absent
 * or unparseable - which the spec says to ignore and answer in full - or "unsatisfiable"
 * when it asks for bytes past the end of the file.
 *
 * Only a single range is honoured. Multi-range replies need a multipart/byteranges body,
 * and no media element asks for one, so those fall back to the whole file.
 */
function parseRange(header: string | undefined, size: number): [number, number] | null | "unsatisfiable" {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  // "bytes=-N" is a suffix range: the last N bytes, not a range starting at zero.
  const [start, end] = rawStart === ""
    ? [Math.max(0, size - Number(rawEnd)), size - 1]
    : [Number(rawStart), rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1)];
  if (start > end || start >= size) return "unsatisfiable";
  return [start, end];
}

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
  /** Injectable so the copilot tests do not spawn Playwright. */
  rerunTests?: (runId: string, testIds: string[], loginSteps: Step[], store: Store) => Promise<TestResult[]>;
  /** Injectable so the copilot tests can pretend a run's login is, or is not, still in memory. */
  contextLoginSteps?: (runId: string) => Step[] | null;
  /** Injectable so the integration tests never reach Composio. */
  trackers?: TrackerClient;
}) {
  const app = new Hono<AuthEnv>();
  const { store } = opts;
  // Resolved per call: the live client needs COMPOSIO_API_KEY, and the API must boot without one.
  const trackers = (): TrackerClient => opts.trackers ?? liveTrackerClient();

  app.use("*", cors({
    // credentials must be allowed for the session cookie to travel on fetch and on
    // EventSource, and an explicit origin is mandatory once credentials are in play.
    origin: [process.env.QA_PILOT_UI_ORIGIN ?? "http://localhost:3000"],
    credentials: true,
  }));

  // Unauthenticated: a reachability probe, so Atlas can be checked before a demo.
  // `store` reports which backend actually answered, because the process falls back to the
  // in-memory store when no connection string is configured, and a probe that said "mongo:
  // up" either way would hide the fact that this run will not survive a restart.
  app.get("/health", async (c) => {
    const { kind } = storeChoice();
    try {
      await store.findUserById("__health_probe__");
      return c.json({ ok: true, store: kind, mongo: kind === "mongo" ? "up" : "n/a" });
    } catch (err) {
      // Deliberately generic: /health is unauthenticated, and a driver error carries the
      // cluster hostname or IP in its message. The detail goes to the server log instead.
      console.error("[health] store probe failed:", err);
      return c.json({ ok: false, store: kind, mongo: kind === "mongo" ? "down" : "n/a" }, 503);
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
  app.use("/copilot/*", requireUser(store));
  app.use("/integrations", requireUser(store));
  app.use("/integrations/*", requireUser(store));

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

  /** A copilot chat the caller owns. An intake chat is not served through the copilot routes. */
  async function ownedCopilotChat(chatId: string, userId: string): Promise<ChatRecord | null> {
    const chat = await ownedChat(chatId, userId);
    return chat && chat.kind === "copilot" ? chat : null;
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
      id: randomUUID(), userId: c.get("user").id, kind: "intake", title: UNTITLED_CHAT,
      createdAt: now, updatedAt: now, messages: [], draft: {},
    };
    await store.insertChat(chat);
    return c.json({ chat });
  });

  app.get("/chats", async (c) => {
    return c.json({ chats: await store.listChats(c.get("user").id, { kind: "intake" }) });
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

  // ---------- Copilot ----------
  //
  // A chat that acts on finished runs. A turn is two calls: the decision, which resolves the
  // run, catalogues its tests and asks the model what to do, and the execution, which runs
  // the pending selection. Splitting them lets the person see what is about to run, and
  // lets credentials travel only with the execute request when a rerun needs to sign in.

  app.post("/copilot/chats", async (c) => {
    const parsed = CopilotScopeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const userId = c.get("user").id;
    const scope: { url?: string; runId?: string } = {};
    if (parsed.data.runId) {
      // A scope naming a run the caller cannot see is refused up front, so the chat never
      // exists with a foreign run in it.
      const run = await ownedRun(parsed.data.runId, userId);
      if (!run) return c.json({ error: "not found" }, 404);
      scope.runId = run.id;
      scope.url = run.url;
    }
    if (parsed.data.url) scope.url = parsed.data.url;
    const now = new Date().toISOString();
    const chat: ChatRecord = {
      id: randomUUID(), userId, kind: "copilot", title: UNTITLED_CHAT,
      createdAt: now, updatedAt: now, messages: [], draft: {}, scope,
    };
    await store.insertChat(chat);
    return c.json({ chat });
  });

  app.get("/copilot/chats", async (c) => {
    return c.json({ chats: await store.listChats(c.get("user").id, { kind: "copilot" }) });
  });

  /**
   * Repoints a chat at a different run. A turn pins the chat to whatever it resolved, so this
   * is how a person moves the conversation onto the run they meant without starting a new one.
   * `runId: null` clears the pin and the chat falls back to the most recent finished run.
   */
  app.post("/copilot/chats/:chatId/scope", async (c) => {
    const chatId = c.req.param("chatId");
    const userId = c.get("user").id;
    const chat = await ownedCopilotChat(chatId, userId);
    if (!chat) return c.json({ error: "not found" }, 404);

    const parsed = CopilotChatScopeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

    const scope: { url?: string; runId?: string } = {};
    if (parsed.data.runId) {
      // As on creation, a run the caller cannot see is refused rather than silently ignored.
      const run = await ownedRun(parsed.data.runId, userId);
      if (!run) return c.json({ error: "not found" }, 404);
      scope.runId = run.id;
      scope.url = run.url;
    }
    // A rerun decided but never executed belongs to the run that was pinned when it was
    // decided, so moving the chat elsewhere drops it rather than leaving it to fire later.
    const stale = chat.pending !== undefined && chat.pending.runId !== scope.runId;
    await store.appendChatTurn(chatId, [], { scope, ...(stale ? { pending: null } : {}) });
    return c.json({ scope });
  });

  app.post("/copilot/chats/:chatId/messages", async (c) => {
    const chatId = c.req.param("chatId");
    const userId = c.get("user").id;
    const chat = await ownedCopilotChat(chatId, userId);
    if (!chat) return c.json({ error: "not found" }, 404);

    const parsed = CopilotMessageSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const text = parsed.data.text.trim();
    if (!text) return c.json({ error: "a message cannot be empty" }, 400);

    const at = new Date().toISOString();
    const userMessage = { role: "user" as const, text, at };
    const needsTitle = chat.title === UNTITLED_CHAT;

    const run = await resolveRun(store, userId, chat.scope ?? {}, text);
    if (!run) {
      // Written here rather than by the model: there is nothing to show the model yet.
      const reply = "There is no finished run to work from yet. Give me a run id, or the URL of the app you tested.";
      const title = needsTitle ? text.slice(0, 40) : undefined;
      await store.appendChatTurn(chatId, [userMessage, { role: "assistant", text: reply, at: new Date().toISOString() }], title ? { title } : {});
      return c.json({ reply, action: "clarify", needs: [], ...(title ? { title } : {}) });
    }

    const catalogue = buildCatalogue(run);
    let decision: CopilotDecision;
    try {
      decision = validateSelection(await copilotTurn(getLlm(), { catalogue, messages: chat.messages.concat(userMessage), needsTitle }), catalogue);
    } catch (err) {
      // Nothing is stored on a failed turn: a half-written exchange would leave the
      // transcript claiming the assistant was asked something it never answered.
      console.error("[copilot] turn failed:", err);
      return c.json({ error: "the copilot could not answer that - try again" }, 502);
    }

    const title = needsTitle ? decision.title : undefined;
    const scope = { url: run.url, runId: run.id };
    let plan: RerunPlanData | undefined;
    let needs: "credentials"[] = [];

    if (decision.action === "rerun") {
      const hasContext = (opts.contextLoginSteps ?? liveLoginSteps)(run.id) !== null;
      const hasLoginFile = readRedactedLoginSteps(run.id) !== null;
      const split = planRerun(decision.testIds, catalogue, { hasContext, hasLoginFile });
      if (split.runnable.length === 0) {
        decision = {
          ...decision, action: "clarify", testIds: [],
          reply: `None of those can run: ${split.blocked.map((b) => `${b.id} ${b.reason}`).join("; ")}.`,
        };
      } else {
        plan = { kind: "rerun_plan", runId: run.id, testIds: split.runnable, blocked: split.blocked };
        if (split.needsCredentials) needs = ["credentials"];
      }
    }

    const assistant = { role: "assistant" as const, text: decision.reply, at: new Date().toISOString(), ...(plan ? { data: plan } : {}) };
    await store.appendChatTurn(chatId, [userMessage, assistant], {
      scope,
      ...(title ? { title } : {}),
      ...(plan ? { pending: { runId: plan.runId, testIds: plan.testIds } } : {}),
    });
    return c.json({ reply: decision.reply, action: decision.action, runId: run.id, ...(plan ? { plan } : {}), needs, ...(title ? { title } : {}) });
  });

  app.post("/copilot/chats/:chatId/execute", async (c) => {
    const chatId = c.req.param("chatId");
    const userId = c.get("user").id;
    const chat = await ownedCopilotChat(chatId, userId);
    if (!chat) return c.json({ error: "not found" }, 404);
    const parsed = CopilotExecuteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    if (!chat.pending) return c.json({ error: "nothing to run - ask for a rerun first" }, 409);

    // The check and the claim happen with no await between them, so two requests that both
    // passed the ownership check cannot both proceed. Every path out of here releases the slot.
    if (executing.has(chatId)) return c.json({ error: "a rerun is already in progress for this chat" }, 409);
    executing.add(chatId);
    try {
      const { runId, testIds } = chat.pending;
      const run = await ownedRun(runId, userId);
      if (!run) return c.json({ error: "not found" }, 404);
      if (!FINISHED.has(run.status)) return c.json({ error: "the run is still in progress" }, 409);

      let loginSteps = (opts.contextLoginSteps ?? liveLoginSteps)(runId);
      if (loginSteps === null) {
        // A spec that vanished between the plan and now is skipped by the runner; it must not
        // throw here.
        const signsIn = testIds.some((id) => existsSync(specPath(runId, id)) && needsLogin(specPath(runId, id)));
        if (!signsIn) loginSteps = [];
        else {
          const redacted = readRedactedLoginSteps(runId);
          if (!redacted || !parsed.data.credentials) {
            return c.json({ error: "these tests sign in; enter the target app's username and password to run them", needs: ["credentials"] }, 409);
          }
          // The credentials live in this handler for the length of the call and nowhere else.
          loginSteps = hydrateLoginSteps(redacted, parsed.data.credentials);
        }
      }

      const results = await (opts.rerunTests ?? runRerunTests)(runId, testIds, loginSteps, store);
      // The catalogue is read after the rerun so its statuses are fresh; its verdicts are the
      // pipeline run's, which is what the chat repeats.
      const catalogue = buildCatalogue(run);
      const reply = summariseRerun(results, testIds, catalogue);
      const result = resultData(runId, results, catalogue);
      await store.appendChatTurn(chatId, [{ role: "assistant", text: reply, at: new Date().toISOString(), data: result }], { pending: null });
      return c.json({ reply, result });
    } finally {
      executing.delete(chatId);
    }
  });

  app.get("/runs", async (c) => {
    return c.json({ runs: await store.listRuns(c.get("user").id) });
  });

  // ---- Tracker integrations --------------------------------------------------------------
  //
  // One Linear or Jira connection per user, made through Composio's OAuth. qa-pilot keeps
  // only Composio's connected account id and the destination (team or project) issues go
  // to; the token never touches this process.

  /** The tracker client, or a 500 naming the missing key when it cannot be built. */
  function trackerOr500(c: { json: (body: unknown, status: 500) => Response }): TrackerClient | Response {
    try {
      return trackers();
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  }

  app.get("/integrations", async (c) => {
    const rec = await store.getIntegration(c.get("user").id);
    return c.json({ integration: rec ? publicShape(rec) : null });
  });

  app.post("/integrations/connect", async (c) => {
    const parsed = ConnectSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const client = trackerOr500(c);
    if (client instanceof Response) return client;
    const userId = c.get("user").id;
    const previous = await store.getIntegration(userId);
    if (previous) await client.disconnect(previous.connectedAccountId).catch((err) => console.error("[integrations] disconnect failed:", err));
    const returnTo = safeReturn(parsed.data.return);
    const callbackUrl = `${API_ORIGIN}/integrations/callback${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ""}`;
    let started: { connectedAccountId: string; redirectUrl: string };
    try {
      started = await client.startConnection(userId, parsed.data.provider, callbackUrl);
    } catch (err) {
      if (err instanceof TrackerError) return c.json({ error: err.message }, 502);
      console.error("[integrations] connect failed:", err);
      return c.json({ error: "could not reach Composio; try again" }, 502);
    }
    await store.saveIntegration({ userId, provider: parsed.data.provider, connectedAccountId: started.connectedAccountId, status: "pending", connectedAt: new Date().toISOString() });
    return c.json({ redirectUrl: started.redirectUrl });
  });

  /**
   * Where Composio sends the browser after OAuth. The session cookie names the user, so a
   * guessed URL from a stranger is a 401 and changes nothing. Always ends in a redirect to
   * Settings, carrying the return path and any failure reason.
   */
  app.get("/integrations/callback", async (c) => {
    const userId = c.get("user").id;
    const returnTo = safeReturn(c.req.query("return"));
    const settings = (error?: string) => {
      const q = new URLSearchParams();
      if (returnTo) q.set("return", returnTo);
      if (error) q.set("error", error);
      const qs = q.toString();
      return c.redirect(`${UI_ORIGIN}/settings${qs ? `?${qs}` : ""}`, 302);
    };
    const rec = await store.getIntegration(userId);
    if (!rec) return settings("no connection was in progress; start again");
    if (rec.status === "active") return settings();
    const client = trackerOr500(c);
    if (client instanceof Response) return client;
    if (c.req.query("status") === "failed") {
      await store.deleteIntegration(userId);
      await client.disconnect(rec.connectedAccountId).catch(() => {});
      return settings(`${rec.provider === "linear" ? "Linear" : "Jira"} did not authorise the connection`);
    }
    const outcome = await client.awaitConnection(rec.connectedAccountId, CONNECT_WAIT_MS);
    if (outcome !== "active") {
      await store.deleteIntegration(userId);
      return settings(outcome === "timeout" ? "the connection did not become active in time; try again" : "the connection failed; try again");
    }
    let destinations: { id: string; label: string }[] = [];
    try {
      destinations = await client.listDestinations(userId, rec.provider, rec.connectedAccountId);
    } catch (err) {
      console.error("[integrations] listing destinations failed:", err);
    }
    await store.saveIntegration({ ...rec, status: "active", ...(destinations.length === 1 ? { destination: destinations[0] } : {}), connectedAt: new Date().toISOString() });
    return settings();
  });

  app.get("/integrations/destinations", async (c) => {
    const userId = c.get("user").id;
    const rec = await store.getIntegration(userId);
    if (!rec || rec.status !== "active") return c.json({ error: "no active connection" }, 409);
    const client = trackerOr500(c);
    if (client instanceof Response) return client;
    try {
      return c.json({ destinations: await client.listDestinations(userId, rec.provider, rec.connectedAccountId) });
    } catch (err) {
      if (err instanceof TrackerError) return c.json({ error: err.message }, 502);
      console.error("[integrations] listing destinations failed:", err);
      return c.json({ error: "could not list destinations; try again" }, 502);
    }
  });

  app.put("/integrations/destination", async (c) => {
    const parsed = DestinationSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const userId = c.get("user").id;
    const rec = await store.getIntegration(userId);
    if (!rec || rec.status !== "active") return c.json({ error: "no active connection" }, 409);
    const client = trackerOr500(c);
    if (client instanceof Response) return client;
    const destination = (await client.listDestinations(userId, rec.provider, rec.connectedAccountId)).find((d) => d.id === parsed.data.id);
    if (!destination) return c.json({ error: "that team or project is not one this connection can file into" }, 400);
    const next = { ...rec, destination };
    await store.saveIntegration(next);
    return c.json({ integration: publicShape(next) });
  });

  app.delete("/integrations", async (c) => {
    const userId = c.get("user").id;
    const rec = await store.getIntegration(userId);
    if (rec) {
      await store.deleteIntegration(userId);
      try {
        trackers().disconnect(rec.connectedAccountId).catch((err) => console.error("[integrations] disconnect failed:", err));
      } catch {
        // No Composio key: the record is gone, which is what the person asked for.
      }
    }
    return c.body(null, 204);
  });

  app.get("/runs/:runId/tickets", async (c) => {
    const userId = c.get("user").id;
    const run = await ownedRun(c.req.param("runId"), userId);
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json({ tickets: await store.listTickets(userId, run.id) });
  });

  /**
   * Files one test of one run in the connected tracker. The body comes from the defect
   * record the pipeline escalated when there is one, otherwise from the plan flow and the
   * latest result; the UI only offers this on a `defect` verdict, but the route files
   * whatever it is asked to for a test in the plan, so the cases page can reuse it.
   */
  app.post("/runs/:runId/tests/:testId/ticket", async (c) => {
    const userId = c.get("user").id;
    const run = await ownedRun(c.req.param("runId"), userId);
    if (!run) return c.json({ error: "not found" }, 404);
    const testId = c.req.param("testId");
    const catalogue = buildCatalogue(run);
    const entry = catalogue.tests.find((t) => t.id === testId);
    const flow = readJsonOutput<Flow[]>(run.id, "plan.json", []).find((f) => f.id === testId);
    if (!entry || !flow) return c.json({ error: "not found" }, 404);

    const integration = await store.getIntegration(userId);
    if (!integration || integration.status !== "active" || !integration.destination) {
      return c.json({ error: "connect Linear or Jira in Settings, and pick where issues go, to file a ticket", needs: ["integration"] }, 412);
    }

    const existing = await store.findTicket(userId, run.id, testId);
    if (existing) return c.json({ ticket: existing });

    const slot = `${userId}/${run.id}/${testId}`;
    if (filing.has(slot)) return c.json({ error: "this ticket is already being filed" }, 409);
    filing.add(slot);
    try {
      const client = trackerOr500(c);
      if (client instanceof Response) return client;
      const defect = readJsonOutput<Defect[]>(run.id, "defects.json", []).find((d) => d.flow === testId);
      const latest = readJsonOutput<RunResults>(run.id, "results.json", { tests: [], at: "" });
      const latestResult = (Array.isArray(latest.tests) ? latest.tests : []).find((t) => t.id === testId);
      const body = buildTicket({
        runId: run.id, url: run.url, testId, flow, defect,
        verdict: entry.verdict ? { class: entry.verdict.class, confidence: entry.verdict.confidence } : undefined,
        latest: latestResult ? { error: latestResult.error, at: latest.at } : undefined,
        uiOrigin: UI_ORIGIN,
      });
      let created: { key: string; url: string };
      try {
        created = await client.createIssue(userId, integration.provider, integration.connectedAccountId, integration.destination, body);
      } catch (err) {
        if (err instanceof TrackerError) return c.json({ error: err.message }, 502);
        console.error("[tickets] create failed:", err);
        return c.json({ error: `could not reach ${integration.provider} through Composio; try again` }, 502);
      }
      const ticket = { id: randomUUID(), userId, runId: run.id, testId, provider: integration.provider, key: created.key, url: created.url, createdAt: new Date().toISOString() };
      try {
        await store.insertTicket(ticket);
      } catch (err) {
        // Two requests raced past the pre-check; the index kept one. Answer with the survivor.
        const survivor = await store.findTicket(userId, run.id, testId);
        if (survivor) return c.json({ ticket: survivor });
        throw err;
      }
      return c.json({ ticket });
    } finally {
      filing.delete(slot);
    }
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

  /**
   * The run's event stream: the whole history so far, then whatever follows. The stream
   * closes once the run is done, unless `?follow=1` asks it to stay open - a rerun of a
   * finished run's tests emits on the same bus after `done`, and the copilot watches those.
   */
  app.get("/events/:runId", async (c) => {
    const runId = c.req.param("runId");
    if (!(await ownedRun(runId, c.get("user").id))) return c.json({ error: "not found" }, 404);
    const follow = c.req.query("follow") === "1";
    const bus = getBus(runId);
    return streamSSE(c, async (stream) => {
      let id = 0;
      let finished = false;
      for (const e of bus.replay()) {
        await stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: String(id++) });
        if (e.type === "done") finished = true;
      }
      if (finished && !follow) return;
      await new Promise<void>((resolveStream) => {
        const unsub = bus.subscribe((e) => {
          stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: String(id++) }).catch(() => { unsub(); resolveStream(); });
          if (e.type === "done" && !follow) { unsub(); resolveStream(); }
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
    const html = readFileSync(path, "utf8");
    // Same file either way: the UI iframes and opens this inline by default; ?download=1 (the
    // UI's "Download report" button) adds content-disposition so the browser saves it instead -
    // the html anchor attribute alone can't force that, since the API is a different origin.
    if (c.req.query("download")) {
      return c.body(html, 200, { "content-type": "text/html; charset=utf-8", "content-disposition": `attachment; filename="${runId}-report.html"` });
    }
    return c.html(html);
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
    const headers = {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": cache,
      // A media element only treats a resource as seekable if the server advertises byte
      // ranges. Without this the recordings play from the start and cannot be scrubbed,
      // and the poster frame is pinned to frame zero.
      "accept-ranges": "bytes",
    };

    const size = statSync(path).size;
    const range = parseRange(c.req.header("range"), size);
    if (range === "unsatisfiable") {
      return c.body(null, 416, { ...headers, "content-range": `bytes */${size}` });
    }
    const body = readFileSync(path);
    if (!range) {
      return c.body(new Uint8Array(body), 200, { ...headers, "content-length": String(size) });
    }
    const [start, end] = range;
    return c.body(new Uint8Array(body.subarray(start, end + 1)), 206, {
      ...headers,
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(end - start + 1),
    });
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
