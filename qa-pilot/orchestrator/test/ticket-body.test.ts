import { describe, it, expect } from "vitest";
import { buildTicket, renderAdf, renderMarkdown } from "../src/integrations/ticket.js";
import type { Defect, Flow } from "../src/state.js";

const flow: Flow = {
  id: "checkout-001", title: "Apply a coupon at checkout", category: "happy", priority: "P0", preconditions: ["logged_in"],
  steps: [{ action: "goto", target: "/checkout" }, { action: "fill", role: "textbox", name: "Coupon", value: "SAVE10" }, { action: "click", role: "button", name: "Apply" }],
  expected: [{ type: "text_contains", role: "status", name: "Total", text_contains: "-10" }],
  source: "explored",
};

const defect: Defect = {
  id: "DEF-1-checkout-001", title: "Apply a coupon at checkout: POST /api/coupon returned 500", severity: "critical", flow: "checkout-001",
  repro_steps: ["Log in with the test credentials", "1. goto /checkout", "2. fill textbox \"Coupon\" with \"SAVE10\"", "3. click button \"Apply\""],
  expected: "text_contains status Total -10", actual: "Error: expect(locator).toContainText(expected) failed",
  evidence: ["POST /api/coupon returned 500", "still failing after rerun"], attachments: ["traces/checkout-001.zip"],
};

const base = { runId: "run-1", url: "http://localhost:3005", testId: "checkout-001", flow, uiOrigin: "http://localhost:3000" };

describe("buildTicket", () => {
  it("builds from the defect record, naming the verdict, the rerun error and the case page", () => {
    const body = buildTicket({ ...base, defect, verdict: { class: "defect", confidence: 0.9 }, latest: { error: "Error: still 500\n  at foo", at: "2026-09-05T12:00:00.000Z" } });
    expect(body.title).toBe("[qa-pilot] Apply a coupon at checkout: POST /api/coupon returned 500");
    expect(body.severity).toBe("critical");
    const headings = body.sections.map((s) => s.heading);
    expect(headings).toEqual(["Summary", "Steps to reproduce", "Expected", "Actual", "Evidence", "Latest rerun", "Links"]);
    const summary = body.sections[0].lines!.join("\n");
    expect(summary).toContain("Target: http://localhost:3005");
    expect(summary).toContain("Run: run-1");
    expect(summary).toContain("Test: checkout-001");
    expect(summary).toContain("Severity: critical");
    expect(summary).toContain("Classifier verdict: defect (0.90)");
    expect(body.sections[1].bullets).toEqual(defect.repro_steps);
    expect(body.sections[4].bullets).toEqual(defect.evidence);
    expect(body.sections[5].lines!.join("\n")).toContain("Error: still 500");
    expect(body.sections[5].lines!.join("\n")).not.toContain("at foo");
    expect(body.sections[6].lines![0]).toBe("http://localhost:3000/runs/run-1/cases?test=checkout-001");
  });

  it("builds from the flow alone when there is no defect record, with severity from priority", () => {
    const body = buildTicket({ ...base, flow: { ...flow, priority: "P2" }, latest: { error: "TimeoutError: page.goto", at: "2026-09-05T12:00:00.000Z" } });
    expect(body.title).toBe("[qa-pilot] Apply a coupon at checkout still fails");
    expect(body.severity).toBe("medium");
    expect(body.sections[1].bullets).toEqual(["Log in with the test credentials", "1. goto /checkout", "2. fill textbox \"Coupon\" with \"SAVE10\"", "3. click button \"Apply\""]);
    expect(body.sections[2].lines).toEqual(["text_contains status Total -10"]);
    expect(body.sections[3].lines).toEqual(["TimeoutError: page.goto"]);
    expect(body.sections[0].lines!.join("\n")).toContain("Classifier verdict: none");
  });

  it("clips a long error and encodes the ids in the case link", () => {
    const body = buildTicket({ ...base, testId: "a b", latest: { error: "x".repeat(500), at: "2026-09-05T12:00:00.000Z" } });
    expect(body.sections[5].lines![0].length).toBeLessThanOrEqual(300);
    expect(body.sections[6].lines![0]).toContain("cases?test=a%20b");
  });
});

describe("renderers", () => {
  const body = buildTicket({ ...base, defect, verdict: { class: "defect", confidence: 0.9 }, latest: { error: "Error: still 500", at: "2026-09-05T12:00:00.000Z" } });

  it("renders markdown with headings and bullets", () => {
    const md = renderMarkdown(body);
    expect(md).toContain("## Summary");
    expect(md).toContain("Target: http://localhost:3005");
    expect(md).toContain("## Steps to reproduce\n- Log in with the test credentials\n- 1. goto /checkout");
    expect(md).toContain("## Links\nhttp://localhost:3000/runs/run-1/cases?test=checkout-001");
  });

  it("renders an ADF document with heading, paragraph and bulletList nodes and no empty text", () => {
    const doc = renderAdf(body);
    expect(doc.type).toBe("doc");
    expect(doc.version).toBe(1);
    const types = doc.content.map((n) => n.type);
    expect(types[0]).toBe("heading");
    expect(types).toContain("paragraph");
    expect(types).toContain("bulletList");
    const texts: string[] = [];
    const walk = (n: { type: string; text?: string; content?: unknown[] }) => {
      if (n.type === "text") texts.push(n.text ?? "");
      for (const c of n.content ?? []) walk(c as { type: string });
    };
    walk(doc);
    expect(texts.every((t) => t.length > 0)).toBe(true);
    expect(texts).toContain("POST /api/coupon returned 500");
  });
});
