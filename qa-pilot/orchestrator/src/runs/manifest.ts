import { existsSync, readdirSync } from "node:fs";
import { outputDir } from "../state.js";

/** The artifacts a run may produce, in the order the UI presents them. */
const KNOWN = [
  "plan.md", "plan.json", "coverage.json", "results.json",
  "heal-log.json", "defects.json", "report.md", "report.html",
  "decisions.jsonl", "events.jsonl",
] as const;

export type ArtifactManifest = { files: string[]; traces: string[]; hasReport: boolean; hasSuite: boolean };

/**
 * Which artifacts actually exist on disk for a run. The UI uses this to enable or disable
 * "Open report", "Download traces" and "Download suite" honestly, instead of offering links
 * that 404 - a partial or failed run legitimately has no report and no suite.
 */
export function artifactManifest(runId: string): ArtifactManifest {
  const dir = outputDir(runId);
  if (!existsSync(dir)) return { files: [], traces: [], hasReport: false, hasSuite: false };
  const files = KNOWN.filter((name) => existsSync(dir + name));
  const traceDir = dir + "traces";
  const traces = existsSync(traceDir) ? readdirSync(traceDir).filter((f) => f.endsWith(".zip")) : [];
  return { files: [...files], traces, hasReport: files.includes("report.html"), hasSuite: existsSync(dir + "suite/package.json") };
}
