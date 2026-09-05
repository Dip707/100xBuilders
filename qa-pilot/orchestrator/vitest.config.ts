import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // QA_PILOT_FIXTURES lets generated specs written to a temp dir import the runner fixtures by absolute path.
    // `.pathname` (not fileURLToPath) would leave this as a URL-encoded path with a leading "/"
    // on Windows (e.g. "/C:/Users/.../QA%20Pilot/..."), breaking the import in any repo path with
    // spaces - same class of bug as state.ts's outputDir() and run.ts's RUNNER_DIR.
    env: { QA_PILOT_HEADLESS: "1", QA_PILOT_FIXTURES: fileURLToPath(new URL("../runner/fixtures", import.meta.url)) },
  },
});
