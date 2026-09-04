import "dotenv/config";
import { z } from "zod";
import { AnthropicLlmClient } from "../src/llm/client.js";
const c = new AnthropicLlmClient();
console.log(await c.complete({ prompt: "_smoke", input: "What is 6 times 7? Put it in answer.", schema: z.object({ answer: z.number() }), effort: "low" }));
