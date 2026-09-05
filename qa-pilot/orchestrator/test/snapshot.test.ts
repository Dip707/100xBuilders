import { describe, it, expect } from "vitest";
import { budgetSnapshot } from "../src/browser/toolkit.js";
import { parseSnapshot, findNearTwins } from "../src/browser/snapshot.js";

const yaml = `- navigation:
  - link "Home"
  - link "Products"
- main:
  - heading "Checkout" [level=1]
  - textbox "Coupon code"
  - button "Apply coupon"
  - button "Complete purchase"`;

describe("parseSnapshot", () => {
  it("extracts role, name and depth", () => {
    const nodes = parseSnapshot(yaml);
    expect(nodes.find((n) => n.role === "button" && n.name === "Complete purchase")).toBeTruthy();
    expect(nodes.find((n) => n.role === "heading")!.depth).toBe(1);
    expect(nodes.filter((n) => n.role === "link")).toHaveLength(2);
  });
});

describe("findNearTwins", () => {
  it("ranks same-role elements by name similarity", () => {
    const nodes = parseSnapshot(yaml);
    const twins = findNearTwins(nodes, { role: "button", name: "Place order" });
    expect(twins[0].node.name).toBe("Complete purchase");
    expect(twins.every((t) => t.node.role === "button")).toBe(true);
  });
  it("returns high similarity for a near-identical name", () => {
    const nodes = parseSnapshot(`- button "Apply coupon code"`);
    const [t] = findNearTwins(nodes, { role: "button", name: "Apply coupon" });
    expect(t.similarity).toBeGreaterThanOrEqual(0.6);
  });
});

describe("budgetSnapshot", () => {
  const yaml = Array.from({ length: 200 }, (_, i) => `- button "Action ${i}"`).join("\n");

  it("leaves a snapshot that fits the budget exactly as it is", () => {
    expect(budgetSnapshot(yaml, yaml.length)).toBe(yaml);
    expect(budgetSnapshot("- button \"One\"", 1000)).toBe("- button \"One\"");
  });

  it("treats a budget of 0 as uncapped", () => {
    expect(budgetSnapshot(yaml, 0)).toBe(yaml);
  });

  it("truncates on a line boundary, never mid-element", () => {
    const out = budgetSnapshot(yaml, 300);
    for (const line of out.split("\n")) {
      if (line.startsWith("[snapshot truncated")) continue;
      expect(line).toMatch(/^- button "Action \d+"$/);
    }
  });

  it("says how much it dropped, so a partial tree is not mistaken for the whole page", () => {
    const out = budgetSnapshot(yaml, 300);
    expect(out).toContain("snapshot truncated to 300 characters");
    // the marker must account for every line that did not make it
    const kept = out.split("\n").filter((l) => l.startsWith("- button")).length;
    expect(out).toContain(`${200 - kept} more element line(s) not shown`);
  });
});
