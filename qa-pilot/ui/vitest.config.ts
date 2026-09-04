import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  // Mirrors the "@/*" path alias in tsconfig.json so the tests import the same way the app does.
  resolve: { alias: { "@": resolve(import.meta.dirname, ".") } },
});
