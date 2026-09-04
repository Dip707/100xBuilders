import type { Flow, Step } from "../state.js";
import { quote as q } from "../browser/locators.js";

export const DEFAULT_FIXTURES_IMPORT = "../../../runner/fixtures";

/**
 * The placeholder the planner puts in values that must differ on every run (a new account's
 * email, a record's name). Live, the toolkit swaps in its own token; in generated code it
 * becomes a template literal over a token minted when the test starts, so the spec stays
 * re-runnable without colliding with data an earlier run created.
 */
export const UNIQUE_PLACEHOLDER = "{{unique}}";
const UNIQUE_DECLARATION = "const unique = Date.now().toString(36);";

/** A string literal for generated code: a plain quoted string, or a template literal when it carries the unique placeholder. */
export function valueCode(s: string): string {
  if (!s.includes(UNIQUE_PLACEHOLDER)) return q(s);
  const escaped = s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return `\`${escaped.split(UNIQUE_PLACEHOLDER).join("${unique}")}\``;
}

export function actionCode(step: Pick<Step, "action" | "target" | "value">, locatorCode: string): string {
  switch (step.action) {
    case "goto": return `await page.goto(${q(step.target ?? "/")});`;
    case "fill": return `await ${locatorCode}.fill(${valueCode(step.value ?? "")});`;
    case "click": return `await ${locatorCode}.click();`;
    case "select": return `await ${locatorCode}.selectOption(${valueCode(step.value ?? "")});`;
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
  if ([...stepCodes, ...expectCodes].some((c) => c.includes("${unique}"))) lines.push(`  ${UNIQUE_DECLARATION}`);
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
