import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startShop } from "./helpers/shop.js";
import { generateFlowNode } from "../src/nodes/generate.js";
import { initialState, type Flow, type RunResults, type SiteMap } from "../src/state.js";
import { EventBus } from "../src/events.js";
import { FakeLlmClient } from "../src/llm/client.js";
import { runPlaywright } from "../src/nodes/run.js";

// Stub the Playwright runner so the self-repair branch is reachable deterministically.
// Live validation (act/checkExpectation against the running mini-shop) still runs for real.
vi.mock("../src/nodes/run.js", () => ({ runPlaywright: vi.fn() }));

const runPlaywrightMock = vi.mocked(runPlaywright);

let shop: Awaited<ReturnType<typeof startShop>>;
const siteMap: SiteMap = { origin: "", loginPath: "/login", loginSteps: [], pages: {} };

beforeAll(async () => {
  shop = await startShop();
  siteMap.origin = shop.base;
});
afterAll(async () => {
  await shop.stop();
});
beforeEach(() => {
  runPlaywrightMock.mockReset();
});

// logged_out flow with wrong credentials so the live "Invalid" alert expectation is true.
const flow: Flow = {
  id: "auth-repair-001",
  title: "Login with wrong password shows error",
  category: "negative",
  priority: "P1",
  preconditions: ["logged_out"],
  source: "explored",
  steps: [
    { action: "goto", target: "/login" },
    { action: "fill", role: "textbox", name: "Email", value: "user@test.com" },
    { action: "fill", role: "textbox", name: "Password", value: "wrong" },
    { action: "click", role: "button", name: "Sign in" },
  ],
  expected: [{ type: "visible", role: "alert", text_contains: "Invalid" }],
};

function failingResult(): RunResults {
  return {
    tests: [
      {
        id: flow.id,
        file: "x",
        title: flow.title,
        status: "failed",
        error: "Timeout waiting for getByRole('button', { name: 'Sign in' })",
        failingStep: 3,
        network: [],
        consoleErrors: [],
        pageErrors: [],
        durationMs: 1,
      },
    ],
    at: "",
  };
}
function passedResult(): RunResults {
  return {
    tests: [
      { id: flow.id, file: "x", title: flow.title, status: "passed", network: [], consoleErrors: [], pageErrors: [], durationMs: 1 },
    ],
    at: "",
  };
}

/** Pulls the generated spec source back out of the fake LLM's prompt input. */
function extractSource(input: string): string {
  const start = "SOURCE:\n";
  const end = "\n\nERROR:";
  return input.slice(input.indexOf(start) + start.length, input.indexOf(end));
}

function freshState(dirPrefix: string) {
  const outputDir = mkdtempSync(join(tmpdir(), dirPrefix)) + "/";
  process.env.QA_PILOT_OUTPUT = outputDir;
  const bus = new EventBus("r", outputDir + "r/");
  const state = { ...initialState({ runId: "r", url: shop.base }), siteMap, currentFlow: flow };
  return { bus, state };
}

describe("generateFlowNode self-repair", () => {
  it("accepts a self-repair that only changes action lines", async () => {
    const { bus, state } = freshState("qa-repair-a-");
    runPlaywrightMock.mockResolvedValueOnce(failingResult()).mockResolvedValueOnce(passedResult());

    const llm = new FakeLlmClient({
      "self-repair": (input: string) => {
        const src = extractSource(input);
        const repaired = src.replace(
          /(await page\.getByRole\('button', \{ name: 'Sign in' \}\)\.click\(\);)/,
          "$1\n  await page.waitForLoadState('networkidle');",
        );
        expect(repaired).not.toBe(src);
        return { source: repaired, reason: "wait for navigation to settle after sign in" };
      },
    });

    const update = await generateFlowNode(state, { bus, llm, headless: true });

    expect(update.testFiles).toHaveLength(1);
    const src = readFileSync((update.testFiles as string[])[0], "utf8");
    expect(src).toContain("await page.waitForLoadState('networkidle');");
    expect(runPlaywrightMock).toHaveBeenCalledTimes(2);
    expect(update.llmCalls).toBe(state.llmCalls + 1);
  }, 120_000);

  it("rejects a self-repair that alters an expect line, leaving the file untouched", async () => {
    // Baseline: run once with an immediate pass, so no repair is attempted, to capture
    // what generateFlowNode writes for this flow absent any repair.
    const baseline = freshState("qa-repair-baseline-");
    runPlaywrightMock.mockResolvedValueOnce(passedResult());
    const baselineUpdate = await generateFlowNode(baseline.state, { bus: baseline.bus, llm: new FakeLlmClient({}), headless: true });
    const baselineSrc = readFileSync((baselineUpdate.testFiles as string[])[0], "utf8");
    expect(runPlaywrightMock).toHaveBeenCalledTimes(1);
    runPlaywrightMock.mockReset();

    const { bus, state } = freshState("qa-repair-b-");
    runPlaywrightMock.mockResolvedValueOnce(failingResult());

    const llm = new FakeLlmClient({
      "self-repair": (input: string) => {
        const src = extractSource(input);
        const repaired = src.replace(/await expect\([^\n]*\);/, "await expect(page.getByRole('alert')).toContainText('Whatever');");
        expect(repaired).not.toBe(src);
        return { source: repaired, reason: "changed the expectation" };
      },
    });

    const update = await generateFlowNode(state, { bus, llm, headless: true });

    expect(update.testFiles).toHaveLength(1);
    const src = readFileSync((update.testFiles as string[])[0], "utf8");
    expect(src).toBe(baselineSrc);
    expect(runPlaywrightMock).toHaveBeenCalledTimes(1);
    const replay = bus.replay();
    expect(replay.some((e) => e.type === "agent_log" && typeof e.message === "string" && e.message.includes("rejected"))).toBe(true);
  }, 120_000);

  it("survives a self-repair call that throws", async () => {
    const { bus, state } = freshState("qa-repair-c-");
    runPlaywrightMock.mockResolvedValueOnce(failingResult());

    // FakeLlmClient throws when there's no canned answer for the requested prompt.
    const llm = new FakeLlmClient({});

    const update = await generateFlowNode(state, { bus, llm, headless: true });

    expect(update.testFiles).toHaveLength(1);
    expect(update.llmCalls).toBe(state.llmCalls);
    expect(runPlaywrightMock).toHaveBeenCalledTimes(1);
    const replay = bus.replay();
    const errorEvent = replay.find((e) => e.type === "error" && e.node === "generate");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toMatch(new RegExp(`self-repair failed for ${flow.id}`));
  }, 120_000);
});
