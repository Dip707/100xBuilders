import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.js";
import { getBus } from "../src/events.js";

describe("api", () => {
  it("validates POST /run and returns a runId", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api-")) + "/";
    const started: unknown[] = [];
    const app = createApi({ start: (input) => { started.push(input); return { runId: input.runId }; } });
    const bad = await app.request("/run", { method: "POST", body: JSON.stringify({ url: "nope" }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    const ok = await app.request("/run", { method: "POST", body: JSON.stringify({ url: "http://localhost:3005", intent: "auth" }), headers: { "content-type": "application/json" } });
    expect(ok.status).toBe(200);
    const { runId } = await ok.json();
    expect(runId).toMatch(/^run-/);
    expect(started).toHaveLength(1);
  });

  it("replays events over SSE and serves the report", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api2-")) + "/";
    const bus = getBus("api-r1");
    bus.log("planner", "hello");
    bus.emit({ type: "done", message: "complete" });
    mkdirSync(process.env.QA_PILOT_OUTPUT + "api-r1", { recursive: true });
    writeFileSync(process.env.QA_PILOT_OUTPUT + "api-r1/report.html", "<h1>ok</h1>");
    const app = createApi({ start: () => ({ runId: "x" }) });
    const res = await app.request("/events/api-r1");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: agent_log");
    expect(text).toContain("event: done");
    const report = await app.request("/report/api-r1");
    expect(report.status).toBe(200);
    expect(await report.text()).toContain("<h1>ok</h1>");
    expect((await app.request("/report/missing")).status).toBe(404);
  });

  it("serves run files and blocks path traversal", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-api3-")) + "/";
    mkdirSync(process.env.QA_PILOT_OUTPUT + "api-r2/screenshots", { recursive: true });
    writeFileSync(process.env.QA_PILOT_OUTPUT + "api-r2/screenshots/step1.png", "fake-png-bytes");
    writeFileSync(process.env.QA_PILOT_OUTPUT + "secret.txt", "top secret");
    const app = createApi({ start: () => ({ runId: "x" }) });

    const file = await app.request("/runs/api-r2/files/screenshots/step1.png");
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(await file.text()).toBe("fake-png-bytes");

    expect((await app.request("/runs/api-r2/files/nope.png")).status).toBe(404);
    expect((await app.request("/runs/api-r2/files/..%2Fsecret.txt")).status).toBe(404);
  });
});
