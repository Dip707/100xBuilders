import { describe, it, expect } from "vitest";
import { renderSpec, actionCode, expectLines } from "../src/codegen/template.js";
import type { Flow } from "../src/state.js";

const flow: Flow = {
  id: "auth-002", title: "Login with wrong password shows error", category: "negative", priority: "P1",
  preconditions: ["logged_out"], source: "explored",
  steps: [{ action: "goto", target: "/login" }, { action: "fill", role: "textbox", name: "Email", value: "user@test.com" }, { action: "click", role: "button", name: "Sign in" }],
  expected: [{ type: "visible", role: "alert", text_contains: "Invalid" }],
};

describe("renderSpec", () => {
  it("matches the PRD output template", () => {
    const src = renderSpec(flow, ["await page.goto('/login');", "await page.getByRole('textbox', { name: 'Email' }).fill('user@test.com');", "await page.getByRole('button', { name: 'Sign in' }).click();"], ["await expect(page.getByRole('alert')).toContainText('Invalid');"]);
    expect(src).toContain("import { test, expect } from '../../../runner/fixtures';");
    expect(src).toContain("// flow: auth-002 | category: negative | source: explored");
    expect(src).toContain("test('Login with wrong password shows error', async ({ page }) => {");
    expect(src).toContain("  // step 1\n  await page.getByRole('textbox', { name: 'Email' }).fill('user@test.com');");
    expect(src).toContain("  await expect(page.getByRole('alert')).toContainText('Invalid');");
    expect(expectLines(src)).toHaveLength(1);
  });
  it("adds the login fixture for logged_in flows", () => {
    const src = renderSpec({ ...flow, preconditions: ["logged_in"] }, ["await page.goto('/orders');"], ["await expect(page).toHaveURL(/\\/orders/);"]);
    expect(src).toContain("async ({ page, login }) => {");
    expect(src).toContain("  await login();\n  // step 0");
  });
});

describe("actionCode", () => {
  it("renders each action", () => {
    const loc = "page.getByRole('button', { name: 'Go' })";
    expect(actionCode({ action: "click" }, loc)).toBe(`await ${loc}.click();`);
    expect(actionCode({ action: "fill", value: "a'b" }, loc)).toBe(`await ${loc}.fill('a\\'b');`);
    expect(actionCode({ action: "select", value: "x" }, loc)).toBe(`await ${loc}.selectOption('x');`);
    expect(actionCode({ action: "press", value: "Enter" }, loc)).toBe(`await ${loc}.press('Enter');`);
    expect(actionCode({ action: "check" }, loc)).toBe(`await ${loc}.check();`);
    expect(actionCode({ action: "goto", target: "/x" }, "")).toBe("await page.goto('/x', { waitUntil: 'domcontentloaded' });");
  });
});

describe("unique test data", () => {
  const loc = "page.getByRole('textbox', { name: 'Email' })";
  it("renders a {{unique}} placeholder as a runtime template literal", () => {
    expect(actionCode({ action: "fill", value: "user-{{unique}}@test.com" }, loc)).toBe("await " + loc + ".fill(`user-${unique}@test.com`);");
    expect(actionCode({ action: "fill", value: "it's `{{unique}}` ${x}" }, loc)).toBe("await " + loc + ".fill(`it's \\`${unique}\\` \\${x}`);");
  });
  it("declares the unique token once at the top of a test that uses it", () => {
    const src = renderSpec(flow, ["await page.goto('/register');", "await " + loc + ".fill(`user-${unique}@test.com`);"], ["await expect(page).toHaveURL(/\\/account/);"]);
    expect(src).toContain("async ({ page }) => {\n  const unique = Date.now().toString(36);\n  // step 0");
    expect(src.match(/const unique/g)).toHaveLength(1);
  });
  it("leaves a test without the placeholder untouched", () => {
    const src = renderSpec(flow, ["await page.goto('/login');"], ["await expect(page).toHaveURL(/\\/login/);"]);
    expect(src).not.toContain("const unique");
  });
});
