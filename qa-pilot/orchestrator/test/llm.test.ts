import { describe, it, expect } from "vitest";
import { z } from "zod";
import { FakeLlmClient } from "../src/llm/client.js";
import { loadPrompt } from "../src/llm/prompts.js";

describe("FakeLlmClient", () => {
  it("returns canned, schema-validated output and counts calls", async () => {
    const fake = new FakeLlmClient({ _smoke: { answer: 42 } });
    const out = await fake.complete({ prompt: "_smoke", input: "x", schema: z.object({ answer: z.number() }) });
    expect(out.answer).toBe(42);
    expect(fake.calls).toBe(1);
  });
  it("supports function answers keyed by input", async () => {
    const fake = new FakeLlmClient({ _smoke: (input: string) => ({ answer: input.length }) });
    const out = await fake.complete({ prompt: "_smoke", input: "abc", schema: z.object({ answer: z.number() }) });
    expect(out.answer).toBe(3);
  });
  it("throws on unknown prompt", async () => {
    const fake = new FakeLlmClient({});
    await expect(fake.complete({ prompt: "nope", input: "", schema: z.any() })).rejects.toThrow(/no canned/);
  });
});

describe("loadPrompt", () => {
  it("loads a prompt file", () => {
    expect(loadPrompt("_smoke")).toContain("smoke");
  });
});
