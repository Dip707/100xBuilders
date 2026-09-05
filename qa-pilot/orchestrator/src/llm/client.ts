import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { loadPrompt } from "./prompts.js";
import type { EventBus } from "../events.js";

/**
 * Whether to talk to the backend in the portable subset of the Messages API.
 *
 * The native path sends two parameters only the Anthropic API implements: `thinking`
 * and `output_config` (structured outputs, which is what guarantees the reply parses).
 * A LiteLLM proxy in front of Gemini is configured with `drop_params: true`, so it
 * accepts those keys and throws them away - the call succeeds and the model returns
 * prose, because nothing ever told it the shape to emit. Compat mode drops both and
 * puts the JSON Schema in the system prompt instead.
 *
 * Auto-detected from a base URL override, since pointing the SDK somewhere other than
 * api.anthropic.com is precisely when the native parameters stop being safe.
 * `QA_PILOT_LLM_COMPAT=0` or `=1` overrides the detection either way.
 */
export function compatMode(): boolean {
  const forced = process.env.QA_PILOT_LLM_COMPAT;
  if (forced === "1") return true;
  if (forced === "0") return false;
  return Boolean(baseUrl());
}

/** The base URL override, if any. `ANTHROPIC_BASE_URL` is the SDK's own name for it. */
export function baseUrl(): string | undefined {
  return process.env.QA_PILOT_LLM_BASE_URL || process.env.ANTHROPIC_BASE_URL || undefined;
}

/**
 * The schema, rendered into the system prompt for compat mode.
 *
 * `io: "output"` matters: it resolves defaults and transforms to what the model is
 * expected to *produce*, not what the parser will accept. A schema that cannot be
 * represented (a transform, a custom refinement) throws, and the call still goes out -
 * the reply then has to survive zod validation on its own, which the retry loop handles.
 */
export function schemaInstruction(schema: z.ZodType<unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(z.toJSONSchema(schema, { io: "output" }), null, 2);
  } catch {
    return "\n\n## Response format\n\nReply with a single JSON value and nothing else: no prose, no markdown code fence.";
  }
  return [
    "",
    "",
    "## Response format",
    "",
    "Reply with a single JSON value conforming to this JSON Schema.",
    "Emit nothing else: no explanation before or after, no markdown code fence.",
    "",
    json,
  ].join("\n");
}

/**
 * Pulls the JSON value out of a compat-mode reply, which is not guaranteed to be clean.
 *
 * The native path never needs this: `output_config` makes the API return the JSON value
 * and nothing else. With that parameter dropped, a backend answers however it likes -
 * Gemini in particular tends to wrap the object in a ```json fence, and sometimes writes
 * a sentence before it.
 *
 * So: strip the fence, then take the first balanced object or array. The scan deliberately
 * *throws* on a reply that ends mid-value rather than returning the prefix it managed to
 * read. A prefix is the dangerous case - `{"score": 0.9, "gaps": [` truncated to
 * `{"score": 0.9}` still parses, and several schemas here have optional or defaulted
 * fields, so a truncated plan could pass validation and silently become a smaller test
 * suite. Throwing routes it into the retry loop, which re-asks with the error attached.
 */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[{[]/);
  if (start < 0) throw new Error(`no JSON object or array in the reply: ${body.slice(0, 120)}`);
  return scanBalanced(body, start);
}

/**
 * The substring from `start` to the bracket that closes it.
 *
 * Counts only the opening bracket's own kind, which is sound because anything nested in
 * the other kind is spanned by it anyway, and skips over string literals so a brace or a
 * bracket inside a value - a selector like `div[role="alert"]`, which this pipeline
 * produces constantly - is not mistaken for structure. Backslash escapes are honoured so
 * an escaped quote does not end the string early.
 */
function scanBalanced(body: string, start: number): string {
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return body.slice(start, i + 1);
  }
  throw new Error(`reply ended mid-JSON: unterminated ${open} at offset ${start}`);
}

/**
 * Statuses worth trying again. Mirrors the Anthropic SDK's own policy (408 request
 * timeout, 409 lock timeout, 429 rate limit, every 5xx) with 425 added, and is applied to
 * whatever the backend in front of us returns - a LiteLLM proxy forwards Gemini's 503
 * ("this model is currently experiencing high demand") with the status intact.
 */
export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Errors the SDK raises when the request never reached a server. */
const CONNECTION_ERRORS = new Set(["APIConnectionError", "APIConnectionTimeoutError", "APIUserAbortError"]);

/** Whether another attempt could plausibly succeed. A 400 or a 401 never can. */
export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return RETRYABLE_STATUS.has(status);
  const name = (err as { name?: unknown } | null)?.name;
  // A user abort is deliberately excluded: the caller asked to stop.
  return typeof name === "string" && CONNECTION_ERRORS.has(name) && name !== "APIUserAbortError";
}

/** Reads a server-supplied wait, in ms, from `retry-after-ms` or `retry-after`. */
export function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: { get?: (k: string) => string | null } } | null)?.headers;
  if (!headers || typeof headers.get !== "function") return undefined;
  const ms = headers.get("retry-after-ms");
  if (ms) {
    const parsed = Number.parseFloat(ms);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const after = headers.get("retry-after");
  if (!after) return undefined;
  const seconds = Number.parseFloat(after);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  // The header may instead be an HTTP date.
  const at = Date.parse(after);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** Retry knobs, so a slow provider outage can be ridden out without a code change. */
export function retryConfig(): { attempts: number; baseMs: number; capMs: number } {
  const num = (name: string, fallback: number) => {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  // Five attempts at 1s base backs off 1-2s, 2-4s, 4-8s, 8-16s: about 30s of patience
  // before giving up, against the SDK's own ~1.5s. A model that just went GA can be
  // saturated for longer than a second and a half.
  return { attempts: num("QA_PILOT_LLM_MAX_RETRIES", 5), baseMs: num("QA_PILOT_LLM_RETRY_BASE_MS", 1000), capMs: num("QA_PILOT_LLM_RETRY_CAP_MS", 30000) };
}

/**
 * How long to wait before attempt `attempt` (0-based index of the attempt just failed).
 *
 * A server-supplied `retry-after` wins outright - it knows more than we do - but is still
 * capped, so a provider asking for ten minutes does not silently hang a run. Otherwise
 * exponential backoff with jitter over the lower half of the window, because every
 * generator in a fan-out fails at the same instant and un-jittered retries would
 * reconverge into the same thundering herd that caused the overload.
 */
export function backoffMs(attempt: number, err: unknown, cfg = retryConfig(), rand = Math.random): number {
  const server = retryAfterMs(err);
  if (server !== undefined) return Math.min(server, cfg.capMs);
  const window = Math.min(cfg.baseMs * 2 ** attempt, cfg.capMs);
  return Math.round(window / 2 + rand() * (window / 2));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A one-line, bounded rendering of an error, for the event log. */
function errorLine(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  const msg = err instanceof Error ? err.message : String(err);
  return `${typeof status === "number" ? `${status} ` : ""}${msg.split("\n")[0]}`.slice(0, 300);
}

export type Effort = "low" | "medium" | "high" | "xhigh";
export type LlmRequest<T> = {
  prompt: string;
  input: string;
  schema: z.ZodType<T>;
  effort?: Effort;
  maxTokens?: number;
};

export interface LlmClient {
  complete<T>(req: LlmRequest<T>): Promise<T>;
  calls: number;
}

type MinimalAnthropicClient = { messages: { create: Anthropic["messages"]["create"] } };

type CreateFn = MinimalAnthropicClient["messages"]["create"];
type CreateParams = Parameters<CreateFn>[0];
/**
 * The completed message rather than a stream of events. `create` is typed as one function
 * over a union of streaming and non-streaming calls, so its return is the matching union;
 * this pipeline never sets `stream`, so the response is always this branch.
 */
type MessageResponse = Extract<Awaited<ReturnType<CreateFn>>, { content: unknown }>;

export class AnthropicLlmClient implements LlmClient {
  calls = 0;
  private client: MinimalAnthropicClient;
  private model: string;
  private compat: boolean;
  private sleeper: (ms: number) => Promise<void>;
  constructor(
    private opts: {
      model?: string;
      bus?: EventBus;
      client?: MinimalAnthropicClient;
      compat?: boolean;
      /** Overrides the env-derived retry knobs. Tests pass tiny values. */
      retry?: { attempts: number; baseMs: number; capMs: number };
      /** Injected so tests do not actually wait out a backoff. */
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.model = opts.model ?? process.env.QA_PILOT_MODEL ?? "claude-opus-5";
    this.compat = opts.compat ?? compatMode();
    this.sleeper = opts.sleep ?? sleep;
    // maxRetries: 0 hands the whole retry policy to `send()` below. The SDK's own default
    // is 2 attempts over roughly 1.5s, which is both too short for a saturated model and
    // invisible - it retries inside the call, so nothing reaches the event bus and the
    // decision log shows a single unexplained failure.
    this.client = opts.client ?? new Anthropic({ baseURL: baseUrl(), maxRetries: 0 });
  }

  /**
   * One request, retried on transport failures.
   *
   * Deliberately separate from the validation loop in `complete()`: a 503 means the model
   * never answered, so there is nothing to feed back to it and no tokens were spent, while
   * a schema violation means it answered badly and must be told so. Conflating them would
   * either re-prompt a server that is down or silently burn budget on outages.
   */
  private async send(params: CreateParams, label: string): Promise<MessageResponse> {
    const cfg = this.opts.retry ?? retryConfig();
    let last: unknown;
    for (let attempt = 0; attempt < cfg.attempts; attempt++) {
      try {
        return (await this.client.messages.create(params)) as MessageResponse;
      } catch (err) {
        last = err;
        const final = attempt === cfg.attempts - 1;
        if (!isRetryable(err) || final) {
          if (isRetryable(err)) {
            this.opts.bus?.log("llm", `${label}: giving up after ${cfg.attempts} attempts`, { error: errorLine(err) });
          }
          throw err;
        }
        const wait = backoffMs(attempt, err, cfg);
        this.opts.bus?.log("llm", `${label}: retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 2}/${cfg.attempts})`, {
          error: errorLine(err),
        });
        await this.sleeper(wait);
      }
    }
    throw last;
  }
  async complete<T>(req: LlmRequest<T>): Promise<T> {
    // In compat mode the schema rides in the system prompt, because output_config - the
    // parameter that would otherwise guarantee the shape - is dropped before the backend.
    const system = loadPrompt(req.prompt) + (this.compat ? schemaInstruction(req.schema) : "");
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      this.calls++;
      const input = lastError ? `${req.input}\n\nYour previous answer failed validation: ${lastError}. Fix it.` : req.input;
      this.opts.bus?.log("llm", `call ${req.prompt} (attempt ${attempt + 1})`, { chars: input.length });
      const native = {
        thinking: { type: "adaptive" as const },
        output_config: { effort: req.effort ?? "high", format: zodOutputFormat(req.schema) },
      };
      const response = await this.send(
        {
          model: this.model,
          max_tokens: req.maxTokens ?? 16000,
          system,
          ...(this.compat ? {} : native),
          messages: [{ role: "user", content: input }],
        },
        req.prompt,
      );
      if (response.stop_reason === "refusal") throw new Error(`LLM refused prompt ${req.prompt}`);

      const textBlocks = response.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
      const text = textBlocks.map((b) => b.text).join("");
      if (!text) {
        lastError = "no text content in response";
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(this.compat ? extractJson(text) : text);
      } catch (error) {
        lastError = `invalid JSON: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`;
        continue;
      }
      const result = req.schema.safeParse(parsed);
      if (result.success) return result.data;
      lastError = result.error.issues
        .slice(0, 1)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")
        .slice(0, 300);
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
