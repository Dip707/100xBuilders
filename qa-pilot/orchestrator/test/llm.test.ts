import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { AnthropicLlmClient, FakeLlmClient } from "../src/llm/client.js";
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

describe("zodOutputFormat", () => {
  it("builds a json_schema output format from a plain zod schema without throwing", () => {
    const format = zodOutputFormat(z.object({ answer: z.number() }));
    expect(format).toBeTypeOf("object");
    expect(format).toHaveProperty("type", "json_schema");
  });
});

describe("AnthropicLlmClient", () => {
  const schema = z.object({ answer: z.number() });

  it("throws immediately on refusal without retrying", async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: "refusal", content: [] });
    const client = new AnthropicLlmClient({ client: { messages: { create } } as any });
    await expect(client.complete({ prompt: "_smoke", input: "x", schema })).rejects.toThrow(/refused/);
    expect(client.calls).toBe(1);
  });

  it("retries once on invalid output, appending the validation error, then succeeds", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ answer: "nope" }) }] })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ answer: 42 }) }] });
    const client = new AnthropicLlmClient({ client: { messages: { create } } as any });
    const out = await client.complete({ prompt: "_smoke", input: "x", schema });
    expect(out.answer).toBe(42);
    expect(client.calls).toBe(2);
    const secondCallArgs = create.mock.calls[1]![0];
    expect(secondCallArgs.messages[0].content).toContain("failed validation");
  });

  it("throws after two failed validation attempts", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ answer: "nope" }) }] })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ answer: "still nope" }) }] });
    const client = new AnthropicLlmClient({ client: { messages: { create } } as any });
    await expect(client.complete({ prompt: "_smoke", input: "x", schema })).rejects.toThrow(/failed validation twice/);
    expect(client.calls).toBe(2);
  });
});
