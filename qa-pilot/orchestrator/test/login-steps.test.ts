import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydrateLoginSteps, readRedactedLoginSteps, redactLoginSteps, writeRedactedLoginSteps, LOGIN_STEPS_FILE } from "../src/copilot/login-steps.js";
import type { Step } from "../src/state.js";

const creds = { username: "demo@shop.test", password: "demo1234" };
const recorded: Step[] = [
  { action: "goto", target: "/login", intent: "open login page" },
  { action: "fill", role: "textbox", name: "Email", value: "demo@shop.test", intent: "enter username" },
  { action: "fill", role: "textbox", name: "Password", value: "demo1234", intent: "enter password" },
  { action: "click", role: "button", name: "Sign in", intent: "submit login form" },
];

describe("login steps redaction", () => {
  beforeEach(() => { process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-login-")) + "/"; });

  it("replaces credential values with placeholders and nothing else", () => {
    const redacted = redactLoginSteps(recorded, creds);
    expect(redacted[1].value).toBe("{{username}}");
    expect(redacted[2].value).toBe("{{password}}");
    expect(redacted[0]).toEqual(recorded[0]);
    expect(redacted[3]).toEqual(recorded[3]);
    expect(JSON.stringify(redacted)).not.toContain("demo1234");
    expect(JSON.stringify(redacted)).not.toContain("demo@shop.test");
  });

  it("hydrates placeholders with fresh credentials", () => {
    const fresh = { username: "other@shop.test", password: "s3cret" };
    const steps = hydrateLoginSteps(redactLoginSteps(recorded, creds), fresh);
    expect(steps[1].value).toBe("other@shop.test");
    expect(steps[2].value).toBe("s3cret");
    expect(steps.map((s) => s.action)).toEqual(["goto", "fill", "fill", "click"]);
  });

  it("writes the file redacted and reads it back; a missing file reads as null", () => {
    expect(readRedactedLoginSteps("r1")).toBeNull();
    writeRedactedLoginSteps("r1", recorded, creds);
    const raw = readFileSync(process.env.QA_PILOT_OUTPUT + "r1/" + LOGIN_STEPS_FILE, "utf8");
    expect(raw).not.toContain("demo1234");
    expect(readRedactedLoginSteps("r1")).toEqual(redactLoginSteps(recorded, creds));
  });

  it("writes an empty array for a run with no login", () => {
    writeRedactedLoginSteps("r2", [], undefined);
    expect(readRedactedLoginSteps("r2")).toEqual([]);
  });
});
