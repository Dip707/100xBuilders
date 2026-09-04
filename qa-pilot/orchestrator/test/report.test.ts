import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReport, reportNode } from "../src/nodes/report.js";
import { initialState, type RunState } from "../src/state.js";
import { EventBus } from "../src/events.js";
import { FakeLlmClient } from "../src/llm/client.js";

function sample(): RunState {
  const s = initialState({ runId: "r", url: "http://x", prdText: "R1 login" });
  return {
    ...s,
    siteMap: { origin: "http://x", loginPath: "/login", loginSteps: [], pages: {} },
    plan: [
      { id: "auth-001", title: "Login works", category: "happy", priority: "P1", preconditions: ["logged_out"], source: "explored", steps: [{ action: "goto", target: "/login" }], expected: [{ type: "url_contains", value: "/products" }] },
      { id: "checkout-003", title: "Apply coupon", category: "happy", priority: "P1", preconditions: ["logged_in"], source: "intent", steps: [{ action: "goto", target: "/checkout" }], expected: [{ type: "visible", role: "status", text_contains: "applied" }] },
    ],
    coverage: { score: 0.81, gaps: [{ kind: "missing_negative", target: "form:/register", suggest: "bad email" }], untested_risk: [{ flow: "/payment", reason: "external gateway", risk: "high" }], checks: { forms: 0.8, mix: 1 }, prdRequirements: ["R1 login"], prdMatrix: { "R1 login": ["auth-001"] } },
    results: { at: "", tests: [
      { id: "auth-001", file: "a", title: "Login works", status: "passed", network: [], consoleErrors: [], pageErrors: [], durationMs: 10 },
      { id: "checkout-003", file: "b", title: "Apply coupon", status: "failed", error: "toContainText failed", network: [{ method: "POST", url: "http://x/api/coupon", status: 500, at: 1 }], consoleErrors: [], pageErrors: [], durationMs: 10, tracePath: "/tmp/trace.zip" },
    ] },
    classifications: [{ test: "checkout-003", class: "defect", confidence: 0.9, evidence: ["POST /api/coupon returned 500"], action: "escalate", rationale: "server error" }],
    healLog: [{ test: "auth-001", attempt: 1, step: 2, before: "old", after: "new", reason: "renamed", confidence: 0.9, accepted: true }],
    defects: [{ id: "DEF-1", title: "Coupon endpoint 500", severity: "high", flow: "checkout-003", repro_steps: ["1. goto /checkout"], expected: "status applied", actual: "500", evidence: ["POST /api/coupon returned 500"], attachments: ["/tmp/trace.zip"] }],
    decisions: [{ node: "classify", reason: "defect 0.9", evidence: [], next: "report", at: "2026-09-04T00:00:00Z" }],
  };
}

describe("renderReport", () => {
  it("contains the six required sections plus decision timeline and PRD matrix", () => {
    const md = renderReport(sample());
    for (const h of ["## Summary", "## Flows by category", "## Results", "## Heals", "## Defects", "## Coverage gaps remaining", "## Untested risk", "## PRD gap matrix", "## Decision timeline"]) expect(md).toContain(h);
    expect(md).toContain("| checkout-003 | Apply coupon | failed | defect (0.9) |");
    expect(md).toContain("R1 login");
  });

  it("escapes untrusted text so it cannot corrupt tables or inject HTML", () => {
    const s = sample();
    s.plan[1] = { ...s.plan[1], title: "Login | Logout <b>x</b>\nnext" };
    s.results!.tests[1] = { ...s.results!.tests[1], title: "Login | Logout <b>x</b>\nnext" };
    s.defects[0] = { ...s.defects[0], evidence: ["<script>alert(1)</script>"] };
    const md = renderReport(s);
    expect(md).toContain("| checkout-003 | Login \\| Logout &lt;b&gt;x&lt;/b&gt; next | failed | defect (0.9) |");
    expect(md).toContain("&lt;script&gt;");
    expect(md).not.toContain("<script>");
  });
});

describe("reportNode", () => {
  it("writes report.md, report.html and defects.json", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-report-")) + "/";
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    await reportNode(sample(), { bus, llm: new FakeLlmClient({}) });
    const dir = process.env.QA_PILOT_OUTPUT + "r/";
    expect(existsSync(dir + "report.md")).toBe(true);
    expect(readFileSync(dir + "report.html", "utf8")).toContain("<h2");
    expect(JSON.parse(readFileSync(dir + "defects.json", "utf8"))).toHaveLength(1);
    expect(bus.replay().some((e) => e.type === "done")).toBe(true);
  });

  it("does not let untrusted evidence text reach report.html as raw HTML", async () => {
    process.env.QA_PILOT_OUTPUT = mkdtempSync(join(tmpdir(), "qa-report-")) + "/";
    const bus = new EventBus("r", process.env.QA_PILOT_OUTPUT + "r/");
    const s = sample();
    s.defects[0] = { ...s.defects[0], evidence: ["<script>alert(1)</script>"] };
    await reportNode(s, { bus, llm: new FakeLlmClient({}) });
    const dir = process.env.QA_PILOT_OUTPUT + "r/";
    expect(readFileSync(dir + "report.html", "utf8")).not.toContain("<script>");
  });
});
