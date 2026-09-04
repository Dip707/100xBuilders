import { describe, it, expect } from "vitest";
import { FakeLlmClient } from "../src/llm/client.js";
import { chatTurn, normalisePatch, turnInput, CONTEXT_MESSAGES } from "../src/chat/turn.js";
import type { ChatMessage, RunDraft } from "../src/store/types.js";

function msg(role: ChatMessage["role"], text: string): ChatMessage {
  return { role, text, at: "2026-09-05T00:00:00.000Z" };
}

describe("normalisePatch", () => {
  it("gives a bare host the https scheme the form's validator requires", () => {
    expect(normalisePatch({ url: "example.com" }).url).toBe("https://example.com");
  });

  it("leaves an explicit scheme alone, http included, so a localhost target still works", () => {
    expect(normalisePatch({ url: "http://localhost:3005" }).url).toBe("http://localhost:3005");
  });

  it("drops a url that cannot be parsed even with a scheme, rather than filling the field with junk", () => {
    expect(normalisePatch({ url: "not a url at all" })).not.toHaveProperty("url");
  });

  it("drops an empty or whitespace intent so a filled field is never blanked by a patch", () => {
    expect(normalisePatch({ intent: "   " })).not.toHaveProperty("intent");
    expect(normalisePatch({ intent: "checkout" }).intent).toBe("checkout");
  });

  it("floors a fractional flow count and drops one below one", () => {
    expect(normalisePatch({ maxFlows: 8.7 }).maxFlows).toBe(8);
    expect(normalisePatch({ maxFlows: 0 })).not.toHaveProperty("maxFlows");
    expect(normalisePatch({ maxFlows: -3 })).not.toHaveProperty("maxFlows");
  });

  it("keeps only the valid half of a budget", () => {
    expect(normalisePatch({ budget: { maxLlmCalls: 300, maxMinutes: 0 } }).budget).toEqual({ maxLlmCalls: 300 });
    expect(normalisePatch({ budget: { maxMinutes: 0, maxLlmCalls: 0 } })).not.toHaveProperty("budget");
  });

  it("keeps the booleans the form owns", () => {
    expect(normalisePatch({ requiresSignIn: true, reviewPlan: true })).toEqual({ requiresSignIn: true, reviewPlan: true });
  });

  it("drops anything outside the draft, credentials above all", () => {
    // The model is told never to emit these. If a jailbroken or confused turn does, the
    // patch must not carry them into form state or into the stored draft.
    const patch = normalisePatch({
      url: "https://a.test", password: "hunter2", username: "admin",
      credentials: { username: "admin", password: "hunter2" }, prdText: "leaked", runId: "run-1",
    });
    expect(patch).toEqual({ url: "https://a.test" });
  });

  it("ignores a non-object patch instead of throwing", () => {
    expect(normalisePatch(null)).toEqual({});
    expect(normalisePatch("url=x")).toEqual({});
  });
});

describe("turnInput", () => {
  const draft: RunDraft = { url: "http://localhost:3005", intent: "checkout", prdText: "x".repeat(5000), prdName: "prd.md" };

  it("reports the PRD by name and size and sends only its head, never the whole document", () => {
    const input = turnInput({ draft, messages: [] });
    expect(input).toContain("prd.md");
    expect(input).toContain("5000");
    expect(input.length).toBeLessThan(2500);
  });

  it("carries the draft's filled fields so the model does not re-ask for them", () => {
    const input = turnInput({ draft, messages: [] });
    expect(input).toContain("http://localhost:3005");
    expect(input).toContain("checkout");
  });

  it("sends only the last CONTEXT_MESSAGES turns, oldest of those first", () => {
    const messages = Array.from({ length: CONTEXT_MESSAGES + 6 }, (_, i) => msg(i % 2 ? "assistant" : "user", `m${i}`));
    const input = turnInput({ draft: {}, messages });
    expect(input).not.toContain("m0");
    expect(input).toContain(`m${CONTEXT_MESSAGES + 5}`);
    expect(input.indexOf("m6")).toBeLessThan(input.indexOf(`m${CONTEXT_MESSAGES + 5}`));
  });

  it("never carries a password, even if one somehow reached the draft", () => {
    const input = turnInput({ draft: { ...draft, password: "hunter2" } as RunDraft, messages: [] });
    expect(input).not.toContain("hunter2");
  });
});

describe("chatTurn", () => {
  it("returns the reply and a normalised patch", async () => {
    const llm = new FakeLlmClient({
      "chat-intake": { reply: "Testing the shop. Which flows matter?", patch: { url: "localhost:3005" }, needs: ["intent"] },
    });
    const turn = await chatTurn(llm, { draft: {}, messages: [msg("user", "test my shop on localhost:3005")] });
    expect(turn.reply).toContain("Which flows matter?");
    expect(turn.patch).toEqual({ url: "https://localhost:3005" });
    expect(turn.needs).toEqual(["intent"]);
  });

  it("defaults needs to empty when the model omits it", async () => {
    const llm = new FakeLlmClient({ "chat-intake": { reply: "All set.", patch: {} } });
    const turn = await chatTurn(llm, { draft: { url: "https://a.test" }, messages: [msg("user", "go")] });
    expect(turn.needs).toEqual([]);
  });

  it("asks for a title only when the chat has none yet", async () => {
    const llm = new FakeLlmClient({ "chat-intake": (input: string) => ({ reply: input.includes("NAME THIS CHAT") ? "named" : "unnamed", patch: {} }) });
    const first = await chatTurn(llm, { draft: {}, messages: [msg("user", "hi")], needsTitle: true });
    expect(first.reply).toBe("named");
    const later = await chatTurn(llm, { draft: {}, messages: [msg("user", "hi")], needsTitle: false });
    expect(later.reply).toBe("unnamed");
  });
});
