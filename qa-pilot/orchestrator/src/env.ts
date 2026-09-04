// Loads .env for every orchestrator entry point (api, cli, run).
//
// `import "dotenv/config"` only looks in process.cwd(). The npm workspace scripts
// (`npm run api` -> `npm run api -w orchestrator`) run with orchestrator/ as cwd,
// while README puts .env at the qa-pilot root, so the key was never loaded and
// the first LLM call failed with "Could not resolve authentication method".
import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The qa-pilot root (two levels above src/): where .env.example and .env live. */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** .env files to load, in priority order: the process cwd first, then the qa-pilot root. */
export function envFiles(cwd: string = process.cwd()): string[] {
  return [...new Set([resolve(cwd, ".env"), resolve(REPO_ROOT, ".env")])];
}

/** Loads every file from envFiles(). Existing process.env values are never overridden. */
export function loadEnv(cwd: string = process.cwd()): void {
  config({ path: envFiles(cwd), quiet: true });
}

loadEnv();
