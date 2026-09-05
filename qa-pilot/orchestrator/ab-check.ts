import { readFileSync } from "node:fs";
import { scoreCoverage as newScore } from "./src/nodes/coverage.js";
import { scoreCoverage as oldScore } from "./src/nodes/coverage-old.js";
import type { Flow, SiteMap } from "./src/state.js";

const map = JSON.parse(readFileSync("/tmp/claude-501/sitemap.json", "utf8")) as SiteMap;
const plan = JSON.parse(readFileSync(process.argv[2], "utf8")) as Flow[];
console.log(`plan: ${process.argv[2]} (${plan.length} flows)`);
for (const [label, fn] of [["OLD", oldScore], ["NEW", newScore]] as const) {
  const v = fn(map, plan, {});
  console.log(` ${label} score ${v.score.toFixed(3)}  gaps ${v.gaps.length}  ` + JSON.stringify(Object.fromEntries(Object.entries(v.checks).map(([k, x]) => [k, +x.toFixed(3)]))));
}
