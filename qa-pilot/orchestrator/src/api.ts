import "./env.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { existsSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { getBus } from "./events.js";
import { outputDir, RunInputSchema, type StartRunInput } from "./state.js";
import { startRun, newRunId } from "./run.js";
import { defaultStore } from "./store/index.js";
import type { RunRecord, Store } from "./store/types.js";
import { authRoutes } from "./auth/routes.js";
import { requireUser, type AuthEnv } from "./auth/middleware.js";
import { artifactManifest } from "./runs/manifest.js";

// userId is not part of RunInputSchema (Ruling 1), so there is nothing to omit for it here;
// the handler supplies it from the session when it builds the StartRunInput.
const BodySchema = RunInputSchema.omit({ runId: true, prdText: true }).extend({ prd: z.string().optional() });

const MIME: Record<string, string> = { html: "text/html", png: "image/png", zip: "application/zip", json: "application/json", md: "text/markdown", ts: "text/plain", jsonl: "text/plain" };

const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

function isValidRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId) && runId !== "." && runId !== "..";
}

export function createApi(opts: {
  start: (input: StartRunInput) => Promise<{ runId: string }> | { runId: string };
  store: Store;
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
  app.use("/report/*", requireUser(store));

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

  app.post("/run", async (c) => {
    const parsed = BodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const { prd, ...rest } = parsed.data;
    const { runId } = await opts.start({ ...rest, runId: newRunId(), prdText: prd, userId: c.get("user").id });
    return c.json({ runId });
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
    return c.body(new Uint8Array(readFileSync(path)), 200, { "content-type": MIME[ext] ?? "application/octet-stream" });
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
