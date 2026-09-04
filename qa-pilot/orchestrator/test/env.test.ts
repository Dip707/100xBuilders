import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT, envFiles, loadEnv } from "../src/env.js";

describe("env loading", () => {
  it("points REPO_ROOT at the qa-pilot root (where README says .env lives)", () => {
    expect(existsSync(join(REPO_ROOT, ".env.example"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "orchestrator", "package.json"))).toBe(true);
  });

  it("always includes the root .env, even when cwd is a workspace dir like orchestrator/", () => {
    const files = envFiles(join(REPO_ROOT, "orchestrator"));
    expect(files).toContain(resolve(REPO_ROOT, ".env"));
  });

  it("does not list the same file twice when cwd is the root", () => {
    const files = envFiles(REPO_ROOT);
    expect(files).toEqual([resolve(REPO_ROOT, ".env")]);
  });

  it("loads variables from a .env in the given cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-pilot-env-"));
    writeFileSync(join(dir, ".env"), "QA_PILOT_ENV_TEST=from-cwd\n");
    delete process.env.QA_PILOT_ENV_TEST;
    loadEnv(dir);
    expect(process.env.QA_PILOT_ENV_TEST).toBe("from-cwd");
  });
});
