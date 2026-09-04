import type { Flow, Step } from "../state.js";
import { quote as q } from "../browser/locators.js";

export const DEFAULT_FIXTURES_IMPORT = "../../../runner/fixtures";

export function actionCode(step: Pick<Step, "action" | "target" | "value">, locatorCode: string): string {
  switch (step.action) {
    case "goto": return `await page.goto(${q(step.target ?? "/")});`;
    case "fill": return `await ${locatorCode}.fill(${q(step.value ?? "")});`;
    case "click": return `await ${locatorCode}.click();`;
    case "select": return `await ${locatorCode}.selectOption(${q(step.value ?? "")});`;
    case "press": return `await ${locatorCode}.press(${q(step.value ?? "Enter")});`;
    case "check": return `await ${locatorCode}.check();`;
  }
}

export function renderSpec(flow: Flow, stepCodes: string[], expectCodes: string[], fixturesImport = DEFAULT_FIXTURES_IMPORT): string {
  const needsLogin = flow.preconditions.includes("logged_in");
  const lines = [
    `import { test, expect } from ${q(fixturesImport)};`,
    `// flow: ${flow.id} | category: ${flow.category} | source: ${flow.source}`,
    `test(${q(flow.title)}, async ({ page${needsLogin ? ", login" : ""} }) => {`,
  ];
  if (needsLogin) lines.push("  await login();");
  stepCodes.forEach((code, i) => lines.push(`  // step ${i}`, `  ${code}`));
  for (const e of expectCodes) lines.push(`  ${e}`);
  lines.push("});", "");
  return lines.join("\n");
}

/** Lines that the healer and self-repair must never change. */
export function expectLines(source: string): string[] {
  return source.split("\n").filter((l) => /^\s*await expect\(/.test(l)).map((l) => l.trim());
}
