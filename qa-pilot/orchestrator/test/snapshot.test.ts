import { describe, it, expect } from "vitest";
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
