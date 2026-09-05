import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RerunResultTable } from "@/components/copilot/RerunResultTable";
import { RerunPlanCard } from "@/components/copilot/RerunPlanCard";
import type { RerunResultData } from "@/lib/api";

const NONE = { integration: null, tickets: {}, filing: null, onRaise: () => {} };
const LINEAR = { provider: "linear" as const, status: "active" as const, destination: { id: "t1", label: "Engineering (ENG)" }, label: "Linear · Engineering (ENG)", connectedAt: "2026-09-05T10:00:00.000Z" };
const defectRow = { id: "checkout-001", title: "Coupon", status: "failed", error: "Error: 500", durationMs: 4200, verdict: { class: "defect", confidence: 0.9 }, defectId: "DEF-1-checkout-001" };
const table = (rows: RerunResultData["results"], over: Partial<Parameters<typeof RerunResultTable>[0]> = {}) =>
  renderToStaticMarkup(<RerunResultTable result={{ kind: "rerun_result", runId: "r1", results: rows }} {...NONE} {...over} />);

describe("RerunResultTable", () => {
  it("renders one row per test with status, duration and error head, linking to the case", () => {
    const html = renderToStaticMarkup(
      <RerunResultTable {...NONE} result={{ kind: "rerun_result", runId: "r1", results: [
        { id: "checkout-001", title: "Coupon", status: "failed", error: "Error: expect(locator).toContainText(expected) failed\nLocator: x", durationMs: 4200 },
        { id: "checkout-002", title: "Order", status: "passed", durationMs: 1500 },
      ] }} />,
    );
    expect(html).toContain("checkout-001");
    expect(html).toContain("Coupon");
    expect(html).toContain("Failed");
    expect(html).toContain("Passed");
    expect(html).toContain("expect(locator).toContainText(expected) failed");
    expect(html).not.toContain("Locator: x");
    expect(html).toContain('href="/runs/r1/cases?test=checkout-001"');
    // formatDuration rounds to whole seconds.
    expect(html).toContain("4s");
  });

  it("shows nothing about tickets for a passed row or a row with no verdict", () => {
    const html = table([{ id: "a", title: "A", status: "passed", durationMs: 1, verdict: { class: "defect", confidence: 0.9 } }, { id: "b", title: "B", status: "failed", error: "x", durationMs: 1 }], { integration: LINEAR });
    expect(html).not.toContain("Classifier");
    expect(html).not.toContain("Raise in");
    expect(html).not.toContain("Connect Linear");
  });

  it("names a non-defect verdict and offers no ticket", () => {
    const html = table([{ id: "auth-001", title: "Login", status: "timedOut", error: "TimeoutError", durationMs: 1, verdict: { class: "env", confidence: 0.6 } }], { integration: LINEAR });
    expect(html).toContain("Classifier: environment error, not filed as a defect");
    expect(html).not.toContain("Raise in");
  });

  it("links to Settings when a defect row has no tracker connected", () => {
    const html = table([defectRow], { integration: null });
    expect(html).toContain("App defect");
    expect(html).toContain("Connect Linear or Jira");
    expect(html).toContain('href="/settings?return=%2Fcopilot"');
    expect(html).not.toContain("Raise in");
  });

  it("sends a pending or destination-less connection back to Settings to finish", () => {
    const pending = table([defectRow], { integration: { ...LINEAR, status: "pending", destination: undefined, label: "Linear" } });
    expect(pending).toContain("Finish connecting Linear");
    expect(pending).toContain('href="/settings?return=%2Fcopilot"');
    expect(pending).not.toContain("Raise in");
    const noDestination = table([defectRow], { integration: { ...LINEAR, destination: undefined, label: "Linear" } });
    expect(noDestination).toContain("Finish connecting Linear");
    expect(noDestination).not.toContain("Raise in");
  });

  it("offers to raise in the connected tracker", () => {
    const html = table([defectRow], { integration: LINEAR });
    expect(html).toContain("Raise in Linear");
    expect(html).toContain("<button");
    expect(table([defectRow], { integration: { ...LINEAR, provider: "jira" } })).toContain("Raise in Jira");
  });

  it("shows a spinner while that row is being filed", () => {
    const html = table([defectRow], { integration: LINEAR, filing: "checkout-001" });
    expect(html).toContain('aria-label="loading"');
    expect(html).toContain("Filing");
  });

  it("links to the issue once a ticket exists, whatever the connection state", () => {
    const ticket = { id: "t1", userId: "u", runId: "r1", testId: "checkout-001", provider: "linear" as const, key: "ENG-42", url: "https://linear.app/acme/issue/ENG-42", createdAt: "2026-09-05T10:00:00.000Z" };
    const html = table([defectRow], { integration: null, tickets: { "checkout-001": ticket } });
    expect(html).toContain("ENG-42");
    expect(html).toContain('href="https://linear.app/acme/issue/ENG-42"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("Connect Linear");
    expect(html).not.toContain("Raise in");
  });

  it("offers nothing while the connection state is still loading", () => {
    const html = table([defectRow], { integration: undefined });
    expect(html).toContain("App defect");
    expect(html).not.toContain("Connect Linear");
    expect(html).not.toContain("Raise in");
  });
});

describe("RerunPlanCard", () => {
  const plan = { kind: "rerun_plan" as const, runId: "r1", testIds: ["checkout-001", "checkout-002"], blocked: [{ id: "auth-009", reason: "test not found" }] };

  it("lists the selected tests and the blocked ones with their reason", () => {
    const html = renderToStaticMarkup(<RerunPlanCard plan={plan} statuses={null} live={false} />);
    expect(html).toContain("checkout-001");
    expect(html).toContain("auth-009");
    expect(html).toContain("test not found");
    expect(html).toContain("2 tests");
  });

  it("shows each test's live status while running", () => {
    const html = renderToStaticMarkup(<RerunPlanCard plan={plan} statuses={{ "checkout-001": "running", "checkout-002": "queued" }} live />);
    expect(html).toContain("Running");
    expect(html).toContain("Queued");
  });
});
