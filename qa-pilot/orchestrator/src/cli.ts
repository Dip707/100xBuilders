import "dotenv/config";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { startRun, newRunId } from "./run.js";
import { getBus } from "./events.js";
import { outputDir, type RunInput } from "./state.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    intent: { type: "string" },
    prd: { type: "string" },
    username: { type: "string" },
    password: { type: "string" },
    "max-flows": { type: "string" },
    headless: { type: "boolean", default: false },
    "run-id": { type: "string" },
  },
});

const [cmd, url] = positionals;
if (cmd !== "run" || !url) {
  console.error('usage: qa-pilot run <url> [--intent "..."] [--prd file.md] [--username u --password p] [--max-flows 12] [--headless]');
  process.exit(1);
}

const runId = values["run-id"] ?? newRunId();
const bus = getBus(runId);
bus.subscribe((e) => {
  if (e.type === "decision") console.log(`\x1b[36m[decision]\x1b[0m ${e.message}`);
  else if (e.type === "node_start") console.log(`\x1b[33m[node]\x1b[0m ${e.node} ${e.message ?? ""}`);
  else if (e.type === "test_result") console.log(`\x1b[32m[test]\x1b[0m ${e.message}`);
  else if (e.type === "error") console.error(`\x1b[31m[error]\x1b[0m ${e.message}`);
  else if (e.type === "agent_log" && e.agent !== "runner") console.log(`[${e.agent}] ${e.message}`);
});

const { done } = startRun(
  {
    runId,
    url,
    intent: values.intent,
    prdText: values.prd ? readFileSync(values.prd, "utf8") : undefined,
    credentials: values.username && values.password ? { username: values.username, password: values.password } : undefined,
    maxFlows: values["max-flows"] ? Number(values["max-flows"]) : 12,
    // RunInputSchema fills maxLlmCalls/maxMinutes defaults at parse time; the
    // static RunInput type resolves those as required, so cast the empty input.
    budget: {} as RunInput["budget"],
  },
  { headless: values.headless || process.env.QA_PILOT_HEADLESS === "1" },
);
const final = await done;
const passed = final.results?.tests.filter((t) => t.status === "passed").length ?? 0;
console.log(`\ndone. ${passed}/${final.results?.tests.length ?? 0} passed, ${final.defects.length} defects, ${final.healLog.filter((h) => h.accepted).length} heals.`);
console.log(`report: ${outputDir(runId)}report.html`);
process.exit(0);
