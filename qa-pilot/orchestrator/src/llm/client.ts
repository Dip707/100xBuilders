import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { loadPrompt } from "./prompts.js";
import type { EventBus } from "../events.js";

export type Effort = "low" | "medium" | "high" | "xhigh";
export type LlmRequest<T> = {
  prompt: string;
  input: string;
  schema: z.ZodType<T, any, any>;
  effort?: Effort;
  maxTokens?: number;
};

export interface LlmClient {
  complete<T>(req: LlmRequest<T>): Promise<T>;
  calls: number;
}

export class AnthropicLlmClient implements LlmClient {
  calls = 0;
  private client = new Anthropic();
  private model: string;
  constructor(private opts: { model?: string; bus?: EventBus } = {}) {
    this.model = opts.model ?? process.env.QA_PILOT_MODEL ?? "claude-opus-5";
  }
  async complete<T>(req: LlmRequest<T>): Promise<T> {
    const system = loadPrompt(req.prompt);
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      this.calls++;
      const input = lastError ? `${req.input}\n\nYour previous answer failed validation: ${lastError}. Fix it.` : req.input;
      this.opts.bus?.log("llm", `call ${req.prompt} (attempt ${attempt + 1})`, { chars: input.length });
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens ?? 16000,
        system,
        thinking: { type: "adaptive" },
        output_config: { effort: req.effort ?? "high", format: zodOutputFormat(req.schema as unknown as Parameters<typeof zodOutputFormat>[0]) },
        messages: [{ role: "user", content: input }],
      });
      if (response.stop_reason === "refusal") throw new Error(`LLM refused prompt ${req.prompt}`);
      if (response.parsed_output != null) return response.parsed_output as T;
      const text = response.content.find((b) => b.type === "text");
      lastError = `unparseable output: ${text && "text" in text ? text.text.slice(0, 300) : "no text"}`;
    }
    throw new Error(`LLM output for ${req.prompt} failed validation twice: ${lastError}`);
  }
}

type Canned = unknown | ((input: string) => unknown);
export class FakeLlmClient implements LlmClient {
  calls = 0;
  constructor(private answers: Record<string, Canned>) {}
  async complete<T>(req: LlmRequest<T>): Promise<T> {
    this.calls++;
    if (!(req.prompt in this.answers)) throw new Error(`FakeLlmClient: no canned answer for prompt "${req.prompt}"`);
    const a = this.answers[req.prompt];
    const value = typeof a === "function" ? (a as (i: string) => unknown)(req.input) : a;
    return req.schema.parse(value);
  }
}

export function makeLlmClient(bus?: EventBus, fake?: FakeLlmClient): LlmClient {
  if (fake) return fake;
  if (process.env.QA_PILOT_FAKE_LLM === "1") return new FakeLlmClient({});
  return new AnthropicLlmClient({ bus });
}
