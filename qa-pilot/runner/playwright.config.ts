import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: process.env.QA_PILOT_TEST_DIR ?? "./tests",
  outputDir: process.env.QA_PILOT_RESULTS_DIR ?? "./test-results",
  fullyParallel: true,
  workers: Number(process.env.QA_PILOT_WORKERS ?? 4),
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["json", { outputFile: process.env.QA_PILOT_JSON_REPORT ?? "./results.json" }]],
  use: {
    baseURL: process.env.QA_PILOT_BASE_URL ?? "http://localhost:3005",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Every test is recorded so the UI can replay it; the run node copies the file out
    // before Playwright's next invocation wipes this output directory.
    video: { mode: "on", size: { width: 1280, height: 800 } },
    viewport: { width: 1280, height: 800 },
    headless: true,
  },
});
