import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zip } from "../src/suite/zip.js";

/** Round-trips through the system unzip, so the archive is proven readable by a real tool. */
function unzipped(entries: { path: string; content: string }[]): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "qa-zip-")) + "/";
  const file = dir + "a.zip";
  writeFileSync(file, zip(entries));
  const listing = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).split("\n").filter(Boolean);
  return Object.fromEntries(listing.map((name) => [name, execFileSync("unzip", ["-p", file, name], { encoding: "utf8" })]));
}

describe("zip", () => {
  it("writes an archive the system unzip reads back byte for byte", () => {
    const entries = [
      { path: "README.md", content: "# Suite\n\nRun `npx playwright test`.\n" },
      { path: "tests/auth-001.spec.ts", content: "import { test } from './fixtures';\n" },
    ];
    expect(unzipped(entries)).toEqual({ "README.md": entries[0].content, "tests/auth-001.spec.ts": entries[1].content });
  });
  it("survives content that compresses badly and content that repeats", () => {
    const random = Array.from({ length: 2000 }, (_, i) => String.fromCharCode(33 + ((i * 7919) % 90))).join("");
    const repeated = "abc".repeat(5000);
    const out = unzipped([{ path: "r.txt", content: random }, { path: "s.txt", content: repeated }]);
    expect(out["r.txt"]).toBe(random);
    expect(out["s.txt"]).toBe(repeated);
  });
  it("keeps unicode file content intact", () => {
    const content = "// café — ünïcode ✓\n";
    expect(unzipped([{ path: "u.ts", content }])["u.ts"]).toBe(content);
  });
  it("reports an empty archive rather than writing a corrupt one", () => {
    expect(() => zip([])).toThrow(/empty/i);
  });
});
