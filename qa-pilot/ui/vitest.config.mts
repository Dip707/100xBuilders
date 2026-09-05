import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  // .tsx is included for the handful of component tests that render to static markup.
  // The transform needs no JSX option: oxc, which Vite now uses, defaults to the automatic
  // runtime for .tsx, and setting the esbuild equivalent only earns an "ignored" warning.
  test: { include: ["test/**/*.test.ts", "test/**/*.test.tsx"] },
  // Mirrors the "@/*" path alias in tsconfig.json so the tests import the same way the app does.
  resolve: { alias: { "@": resolve(import.meta.dirname, ".") } },
});
