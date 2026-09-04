import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { getBus } from "./events.js";
import { outputDir, RunInputSchema, type RunInput } from "./state.js";
import { startRun, newRunId } from "./run.js";

const BodySchema = RunInputSchema.omit({ runId: true, prdText: true }).extend({ prd: z.string().optional() });

const MIME: Record<string, string> = { html: "text/html", png: "image/png", zip: "application/zip", json: "application/json", md: "text/markdown", ts: "text/plain", jsonl: "text/plain" };

export function createApi(opts: { start: (input: RunInput) => { runId: string } }) {
  const app = new Hono();
  app.use("*", cors({ origin: ["http://localhost:3000"] }));

  app.post("/run", async (c) => {
    const parsed = BodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const { prd, ...rest } = parsed.data;
    const { runId } = opts.start({ ...rest, runId: newRunId(), prdText: prd });
    return c.json({ runId });
  });

  app.get("/events/:runId", (c) => {
    const bus = getBus(c.req.param("runId"));
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
          void stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: String(id++) });
          if (e.type === "done") { unsub(); resolveStream(); }
        });
        stream.onAbort(() => { unsub(); resolveStream(); });
      });
    });
  });

  app.get("/report/:runId", (c) => {
    const path = outputDir(c.req.param("runId")) + "report.html";
    if (!existsSync(path)) return c.text("report not ready", 404);
    return c.html(readFileSync(path, "utf8"));
  });

  app.get("/runs/:runId/files/*", (c) => {
    const root = resolve(outputDir(c.req.param("runId")));
    const rel = c.req.path.split("/files/")[1] ?? "";
    const path = resolve(root, decodeURIComponent(rel));
    if (!path.startsWith(root) || !existsSync(path)) return c.text("not found", 404);
    const ext = path.split(".").pop() ?? "";
    return c.body(new Uint8Array(readFileSync(path)), 200, { "content-type": MIME[ext] ?? "application/octet-stream" });
  });

  return app;
}

if (process.argv[1] && process.argv[1].endsWith("api.ts")) {
  const port = Number(process.env.QA_PILOT_API_PORT ?? 4000);
  const app = createApi({
    start: (input) => {
      const { runId, done } = startRun(input);
      done.catch(() => {});
      return { runId };
    },
  });
  serve({ fetch: app.fetch, port }, () => console.log(`qa-pilot api on http://localhost:${port}`));
}
