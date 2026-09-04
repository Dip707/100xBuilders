import { test as base, expect, type Page } from "@playwright/test";

type Step = { action: "goto" | "fill" | "click" | "select" | "press" | "check"; target?: string; role?: string; name?: string; value?: string };

const loginSteps: Step[] = JSON.parse(process.env.QA_PILOT_LOGIN_STEPS ?? "[]");

async function runStep(page: Page, s: Step): Promise<void> {
  if (s.action === "goto") {
    await page.goto(s.target ?? "/");
    return;
  }
  const loc = page.getByRole(s.role as never, { name: s.name });
  switch (s.action) {
    case "fill": await loc.fill(s.value ?? ""); break;
    case "click": await loc.click(); break;
    case "select": await loc.selectOption(s.value ?? ""); break;
    case "press": await loc.press(s.value ?? "Enter"); break;
    case "check": await loc.check(); break;
  }
}

export const test = base.extend<{ login: () => Promise<void> }>({
  page: async ({ page }, use, testInfo) => {
    const network: { method: string; url: string; status: number; at: number }[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("response", (r) => {
      if (r.status() >= 400) network.push({ method: r.request().method(), url: r.url(), status: r.status(), at: Date.now() });
    });
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await use(page);
    testInfo.annotations.push({ type: "network", description: JSON.stringify(network) });
    testInfo.annotations.push({ type: "console", description: JSON.stringify(consoleErrors) });
    testInfo.annotations.push({ type: "pageerror", description: JSON.stringify(pageErrors) });
  },
  login: async ({ page }, use) => {
    await use(async () => {
      for (const s of loginSteps) await runStep(page, s);
      await page.waitForLoadState("networkidle").catch(() => {});
    });
  },
});
export { expect };
