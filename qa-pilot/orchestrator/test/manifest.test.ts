import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactManifest } from "../src/runs/manifest.js";

describe("artifactManifest", () => {
  beforeEach(() => { process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-man-")) + "/"; });

  it("reports only the artifacts that exist", () => {
    const dir = process.env.QA_PILOT_OUTPUT + "m1/";
    mkdirSync(dir + "traces", { recursive: true });
    writeFileSync(dir + "plan.md", "# plan");
    writeFileSync(dir + "report.html", "<h1>r</h1>");
    writeFileSync(dir + "traces/checkout-001.zip", "zip");

    const m = artifactManifest("m1");
    expect(m.files).toEqual(expect.arrayContaining(["plan.md", "report.html"]));
    expect(m.files).not.toContain("results.json");
    expect(m.traces).toEqual(["checkout-001.zip"]);
    expect(m.hasReport).toBe(true);
  });

  it("returns an empty manifest for a run with no directory", () => {
    expect(artifactManifest("never-ran")).toEqual({ files: [], traces: [], hasReport: false, hasSuite: false });
  });
});
