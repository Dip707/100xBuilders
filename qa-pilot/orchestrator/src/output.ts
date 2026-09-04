import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { outputDir } from "./state.js";

export function writeOutput(runId: string, name: string, content: string | object): string {
  const path = outputDir(runId) + name;
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return path;
}
export function readOutput(runId: string, name: string): string | null {
  const path = outputDir(runId) + name;
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
