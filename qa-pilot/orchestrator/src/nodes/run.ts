import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { outputDir, type RunResults, type RunState, type RunUpdate, type Step, type TestResult } from "../state.js";
import { writeOutput } from "../output.js";
import { now, type NodeDeps } from "./deps.js";

const RUNNER_DIR = resolve(new URL("../../../runner/", import.meta.url).pathname);

type JsonResult = { status: string; duration: number; error?: { message?: string }; errors?: { message?: string }[]; errorLocation?: { file: string; line: number }; attachments?: { name: string; path?: string }[]; annotations?: { type: string; description?: string }[] };
type JsonTest = { status: string; annotations?: { type: string; description?: string }[]; results: JsonResult[] };
type JsonSpec = { title: string; file: string; ok: boolean; tests: JsonTest[] };
type JsonSuite = { title: string; file: string; specs: JsonSpec[]; suites?: JsonSuite[] };
type JsonReport = { suites: JsonSuite[]; errors?: { message?: string }[] };

function flatSpecs(suites: JsonSuite[]): { spec: JsonSpec; file: string }[] {
  return suites.flatMap((s) => [...s.specs.map((spec) => ({ spec, file: s.file })), ...flatSpecs(s.suites ?? [])]);
}
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
/** Walks up from the failing line to the nearest `// step N` comment. Returns undefined when the failure is in an expect line. */
function stepAtLine(source: string, line: number): number | undefined {
  const lines = source.split("\n");
  const failing = lines[line - 1] ?? "";
  if (/^\s*await expect\(/.test(failing)) return undefined;
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const m = /^\s*\/\/ step (\d+)/.exec(lines[i]);
    if (m) return Number(m[1]);
  }
  return undefined;
}
function findTrace(dir: string, id: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory() && entry.includes(id)) {
      const trace = join(p, "trace.zip");
      if (existsSync(trace)) return trace;
    }
  }
  return undefined;
}
function parseAnnotation<T>(list: { type: string; description?: string }[] | undefined, type: string, fallback: T): T {
  const a = list?.find((x) => x.type === type);
  if (!a?.description) return fallback;
  try { return JSON.parse(a.description) as T; } catch { return fallback; }
}

/**
 * Playwright wipes its output directory on every invocation, and this pipeline invokes it
 * many times per run (once per generated flow, then for the suite, then for every heal or
 * rerun). A recording left where Playwright wrote it would vanish on the next call, so it
 * is copied to `traces/videos/<id>.webm`, which only this function ever writes.
 */
function keepVideo(runDir: string, id: string, videoPath: string | undefined): string | undefined {
  if (!videoPath || !existsSync(videoPath)) return undefined;
  const dir = join(runDir, "traces", "videos");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${id}.webm`);
  try {
    copyFileSync(videoPath, dest);
    return dest;
  } catch {
    return undefined;
  }
}

/** Where the runner streams live frames for this run; one subdirectory per test id. */
export function liveDir(runId: string): string {
  return outputDir(runId) + "live";
}

/**
 * Polls the live directory while Playwright runs and emits one `test_start` per test the
 * moment its state file says `running`. The runner is a separate process with no handle on
 * the event bus, so a file on disk is the channel; 250ms keeps the UI's "running" pill within
 * a blink of the truth without touching the bus with frame data. Only state files written
 * after the watcher started count, so a file left behind by an earlier invocation - one per
 * generated flow, then the suite, then every heal or rerun - is never announced twice.
 */
function watchLive(dir: string, bus: NodeDeps["bus"] | undefined, only?: Set<string>): () => void {
  if (!bus) return () => {};
  const since = Date.now();
  const announced = new Set<string>();
  const scan = () => {
    if (!existsSync(dir)) return;
    for (const id of readdirSync(dir)) {
      // Generation runs one invocation per flow, concurrently, each with its own watcher;
      // without this filter every watcher would announce every other flow's test too.
      if (announced.has(id) || (only && !only.has(id))) continue;
      const statePath = join(dir, id, "state.json");
      if (!existsSync(statePath) || statSync(statePath).mtimeMs < since) continue;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as { status?: string; title?: string };
        if (state.status !== "running") continue;
        announced.add(id);
        bus.emit({ type: "test_start", message: `${id} running`, data: { id, title: state.title ?? id } });
      } catch {
        /* half-written file: the next tick reads it whole */
      }
    }
  };
  const timer = setInterval(scan, 250);
  return () => { clearInterval(timer); scan(); };
}

export function parseJsonReport(report: unknown, testDir: string, traceDir: string): TestResult[] {
  const r = report as JsonReport;
  const out: TestResult[] = [];
  for (const { spec, file } of flatSpecs(r.suites ?? [])) {
    const id = file.replace(/\.spec\.ts$/, "").split("/").pop()!;
    const test = spec.tests[0];
    const last = test?.results[test.results.length - 1];
    const annotations = [...(test?.annotations ?? []), ...(last?.annotations ?? [])];
    const status = (last?.status ?? "skipped") as TestResult["status"];
    const errorRaw = last?.error?.message ?? last?.errors?.[0]?.message;
    const error = errorRaw ? stripAnsi(errorRaw).split("\n").slice(0, 6).join("\n") : undefined;
    const sourcePath = join(testDir, file);
    const source = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : "";
    const errorLine = last?.errorLocation?.line;
    out.push({
      id,
      file: sourcePath,
      title: spec.title,
      status,
      error,
      errorLine,
      failingStep: errorLine && source ? stepAtLine(source, errorLine) : undefined,
      network: parseAnnotation(annotations, "network", []),
      consoleErrors: parseAnnotation(annotations, "console", []),
      pageErrors: parseAnnotation(annotations, "pageerror", []),
      tracePath: last?.attachments?.find((a) => a.name === "trace")?.path ?? findTrace(traceDir, id),
      videoPath: last?.attachments?.find((a) => a.name === "video")?.path,
      durationMs: last?.duration ?? 0,
    });
  }
  return out;
}

export async function runPlaywright(opts: { runId: string; baseUrl: string; loginSteps: Step[]; files?: string[]; bus?: NodeDeps["bus"] }): Promise<RunResults> {
  const dir = outputDir(opts.runId);
  const testDir = dir + "tests";
  const traceDir = dir + "traces/playwright";
  const jsonReport = dir + "results.raw.json";
  const live = liveDir(opts.runId);
  const args = ["playwright", "test", "--config", join(RUNNER_DIR, "playwright.config.ts"), ...(opts.files ?? []).map((f) => resolve(f))];
  opts.bus?.log("runner", `npx ${args.join(" ")}`);
  const stopWatching = watchLive(live, opts.bus, opts.files ? new Set(opts.files.map((f) => f.split("/").pop()!.replace(/\.spec\.ts$/, ""))) : undefined);
  await new Promise<void>((resolveRun) => {
    const child = spawn("npx", args, {
      cwd: RUNNER_DIR,
      env: {
        ...process.env,
        QA_PILOT_TEST_DIR: testDir,
        QA_PILOT_RESULTS_DIR: traceDir,
        QA_PILOT_JSON_REPORT: jsonReport,
        QA_PILOT_BASE_URL: opts.baseUrl,
        QA_PILOT_LOGIN_STEPS: JSON.stringify(opts.loginSteps),
        QA_PILOT_LIVE_DIR: live,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => opts.bus?.log("runner", String(d).trim()));
    child.stderr.on("data", (d) => opts.bus?.log("runner", String(d).trim()));
    child.on("error", (err) => {
      opts.bus?.emit({ type: "error", node: "run", message: `playwright spawn failed: ${err.message}` });
      resolveRun();
    });
    child.on("close", () => resolveRun());
  });
  stopWatching();
  let report: JsonReport;
  if (existsSync(jsonReport)) {
    try {
      report = JSON.parse(readFileSync(jsonReport, "utf8"));
    } catch (err) {
      opts.bus?.emit({ type: "error", node: "run", message: `failed to parse playwright report: ${err instanceof Error ? err.message : String(err)}` });
      report = { suites: [] };
    }
  } else {
    report = { suites: [] };
  }
  const tests = parseJsonReport(report, testDir, traceDir).map((t) => ({ ...t, videoPath: keepVideo(dir, t.id, t.videoPath) }));
  for (const t of tests) opts.bus?.emit({ type: "test_result", message: `${t.id} ${t.status}`, data: t });
  return { tests, at: now() };
}

export async function runNode(state: RunState, deps: NodeDeps): Promise<RunUpdate> {
  deps.bus.emit({ type: "node_start", node: "run", data: { only: state.testsToRun } });
  const files = state.testsToRun?.map((id) => `${outputDir(state.runId)}tests/${id}.spec.ts`);
  const fresh = await runPlaywright({ runId: state.runId, baseUrl: state.url, loginSteps: state.siteMap?.loginSteps ?? [], files, bus: deps.bus });
  const merged = new Map((state.results?.tests ?? []).map((t) => [t.id, t]));
  for (const t of fresh.tests) merged.set(t.id, t);
  const results: RunResults = { tests: [...merged.values()], at: fresh.at };
  writeOutput(state.runId, "results.json", results);
  const passed = results.tests.filter((t) => t.status === "passed").length;
  deps.bus.emit({ type: "node_end", node: "run", data: { passed, total: results.tests.length } });
  return { results, testsToRun: undefined };
}
