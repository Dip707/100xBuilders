import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: process.env.QA_PILOT_TEST_DIR ?? "./tests",
  outputDir: process.env.QA_PILOT_RESULTS_DIR ?? "./test-results",
  fullyParallel: true,
  workers: Number(process.env.QA_PILOT_WORKERS ?? 4),
  retries: 0,
  // Budgets are env-tunable because the same suite runs against a target on localhost and
  // against a real site over the internet. The defaults assume the latter: one navigation
  // may take up to QA_PILOT_NAV_TIMEOUT_MS, and a four-step flow makes several, so the
  // per-test cap has to leave room for more than one of them.
  timeout: Number(process.env.QA_PILOT_TEST_TIMEOUT_MS ?? 60_000),
  expect: { timeout: Number(process.env.QA_PILOT_EXPECT_TIMEOUT_MS ?? 5_000) },
  reporter: [["json", { outputFile: process.env.QA_PILOT_JSON_REPORT ?? "./results.json" }]],
  use: {
    baseURL: process.env.QA_PILOT_BASE_URL ?? "http://localhost:3005",
    // Without these a click on a missing element waits out the whole test timeout and is
    // reported as timedOut with no error location: no failing step for the classifier, no
    // locator for the healer. A bounded action timeout turns it into a locator error instead.
    actionTimeout: Number(process.env.QA_PILOT_ACTION_TIMEOUT_MS ?? 10_000),
    // 30s, matching the explorer's own navigation budget: saucedemo.com answers in 4-6s,
    // and a site having a slow moment is not the same thing as a broken test.
    navigationTimeout: Number(process.env.QA_PILOT_NAV_TIMEOUT_MS ?? 30_000),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Every test is recorded so the UI can replay it; the run node copies the file out
    // before Playwright's next invocation wipes this output directory.
    video: { mode: "on", size: { width: 1280, height: 800 } },
    viewport: { width: 1280, height: 800 },
    headless: true,
  },
});
