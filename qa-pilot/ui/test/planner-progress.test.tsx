import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlannerProgress } from "@/components/coverage/PlannerProgress";
import type { PlannerProgress as Progress } from "@/lib/planner";

/*
 * The panel that fills the two minutes the planner takes. Like the Sources viewport it is
 * only ever on screen while a specific node is running, and its two faces are seconds
 * apart on a small local target, so both are pinned here rather than caught by hand.
 */

const base: Progress = {
  phase: "drafting", startedAt: "2026-09-05T12:00:00.000Z", iteration: 1, gaps: 0,
  pages: 5, forms: 2, maxFlows: 3, routes: ["/", "/cart"], flows: [], kept: 0, dropped: 0, action: null,
};
const render = (p: Partial<Progress> = {}, liveSrc: string | null = null) =>
  renderToStaticMarkup(<PlannerProgress progress={{ ...base, ...p }} liveSrc={liveSrc} />);

describe("PlannerProgress, while the model is drafting", () => {
  it("names what the planner is reading rather than showing an empty browser", () => {
    const html = render();
    expect(html).toContain("AEGIS is writing your test plan");
    expect(html).toContain("5 pages");
    expect(html).toContain("/cart");
    expect(html).not.toContain("Live view of the planner");
  });

  it("says a re-plan is closing gaps rather than reading the crawl again", () => {
    expect(render({ iteration: 2, gaps: 3 })).toContain("close 3 coverage gaps");
  });

  it("promises the flows rather than claiming there are none", () => {
    expect(render()).toContain("The flows appear here the moment the planner has written them.");
  });

  it("says how long the wait is for rather than sitting still", () => {
    // The panel is on screen for the length of one LLM call, so the wait has to move and
    // has to name the budget it is waiting on - a static list read as a hung screen.
    const html = render();
    expect(html).toContain("Writing up to 3 flows");
    expect(html).toContain("animate-sweep");
    expect(html).toContain("animate-shimmer");
  });

  it("holds one waiting row per flow the planner may write, so the list does not reflow", () => {
    expect(render({ maxFlows: 2 }).match(/animate-shimmer/g)!.length).toBe(2 * 3);
    expect(render({ maxFlows: 5 }).match(/animate-shimmer/g)!.length).toBe(5 * 3);
  });
});

describe("PlannerProgress, while the dry walk runs", () => {
  const walking: Partial<Progress> = {
    phase: "validating", action: "click button Login", kept: 1, dropped: 1,
    flows: [
      { id: "auth-001", title: "Signs in", category: "happy", status: "kept" },
      { id: "auth-002", title: "Rejects a bad password", category: "negative", status: "dropped" },
      { id: "cart-001", title: "Adds to cart", category: "happy", status: "walking" },
      { id: "cart-002", title: "Empties the cart", category: "happy", status: "pending" },
    ],
  };

  it("shows the planner's browser and the step it is on", () => {
    const html = render({ ...walking }, "data:image/jpeg;base64,AAAA");
    expect(html).toContain("Live view of the planner&#x27;s browser");
    expect(html).toContain("click button Login");
  });

  it("says so plainly when the planner has not opened a browser yet", () => {
    expect(render({ ...walking })).toContain("The planner has not opened a browser yet.");
  });

  it("reports how much of the walk is left, counting dropped flows as decided", () => {
    const html = render({ ...walking });
    expect(html).toContain("2 of 4 decided");
    expect(html).toContain("Flows validated 2/4");
    expect(html).toContain("1 dropped as unreachable");
  });

  it("gives every proposed flow its own verdict", () => {
    const html = render({ ...walking });
    for (const label of ["kept", "dropped", "walking", "queued"]) expect(html).toContain(label);
    expect(html).toContain("Rejects a bad password");
    expect(html).toContain("cart-002");
  });
});
