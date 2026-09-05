// Not "dotenv/config": that only reads process.cwd(), and this script runs with
// orchestrator/ as cwd while .env lives at the qa-pilot root. env.ts loads both.
import "../src/env.js";
import { z } from "zod";
import { AnthropicLlmClient } from "../src/llm/client.js";
const c = new AnthropicLlmClient();
console.log(await c.complete({ prompt: "_smoke", input: "What is 6 times 7? Put it in answer.", schema: z.object({ answer: z.number() }), effort: "low" }));
