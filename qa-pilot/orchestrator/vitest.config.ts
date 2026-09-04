import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // QA_PILOT_FIXTURES lets generated specs written to a temp dir import the runner fixtures by absolute path.
    env: { QA_PILOT_HEADLESS: "1", QA_PILOT_FIXTURES: new URL("../runner/fixtures", import.meta.url).pathname },
  },
});
