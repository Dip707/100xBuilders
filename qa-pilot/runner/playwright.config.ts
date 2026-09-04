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
    headless: true,
  },
});
