import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RerunResultTable } from "@/components/copilot/RerunResultTable";
import { RerunPlanCard } from "@/components/copilot/RerunPlanCard";

describe("RerunResultTable", () => {
  it("renders one row per test with status, duration and error head, linking to the case", () => {
    const html = renderToStaticMarkup(
      <RerunResultTable result={{ kind: "rerun_result", runId: "r1", results: [
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
