import { describe, it, expect } from "vitest";
import { FakeLlmClient } from "../src/llm/client.js";
import { copilotTurn, turnInput, validateSelection } from "../src/copilot/turn.js";
import type { Catalogue } from "../src/copilot/catalogue.js";
import type { ChatMessage } from "../src/store/types.js";

const catalogue: Catalogue = {
  runId: "c1", url: "http://localhost:3005", status: "done", finishedAt: "2026-09-05T10:09:00.000Z",
  tests: [
    { id: "auth-001", title: "User logs in", category: "happy", priority: "P0", preconditions: ["logged_out"], status: "passed", generated: true, signsIn: false },
    { id: "checkout-001", title: "Shopper applies a coupon", category: "happy", priority: "P1", preconditions: ["logged_in"], status: "failed", generated: true, signsIn: true, error: "500" },
    { id: "checkout-002", title: "Shopper places an order", category: "happy", priority: "P0", preconditions: ["logged_in"], status: "timedOut", generated: true, signsIn: true },
    { id: "orders-001", title: "Order history", category: "happy", priority: "P2", preconditions: ["logged_in"], status: "not_run", generated: false, signsIn: false },
  ],
};
const msgs: ChatMessage[] = [{ role: "user", text: "rerun the checkout tests that failed", at: "t" }];

describe("turnInput", () => {
  it("carries the catalogue, the conversation and the title request", () => {
    const text = turnInput({ catalogue, messages: msgs, needsTitle: true });
    expect(text).toContain("RUN CATALOGUE");
    expect(text).toContain("checkout-001 | failed");
    expect(text).toContain("user: rerun the checkout tests that failed");
    expect(text).toContain("NAME THIS CHAT");
    expect(turnInput({ catalogue, messages: msgs })).not.toContain("NAME THIS CHAT");
  });
});

describe("copilotTurn", () => {
  it("returns the model's decision with defaults filled", async () => {
    const llm = new FakeLlmClient({ "copilot-turn": { reply: "Rerunning two checkout tests.", action: "rerun", testIds: ["checkout-001", "checkout-002"], title: "Rerun failed checkout tests" } });
    const d = await copilotTurn(llm, { catalogue, messages: msgs, needsTitle: true });
    expect(d).toEqual({ reply: "Rerunning two checkout tests.", action: "rerun", testIds: ["checkout-001", "checkout-002"], title: "Rerun failed checkout tests" });
  });

  it("tolerates a missing testIds on an answer", async () => {
    const llm = new FakeLlmClient({ "copilot-turn": { reply: "checkout-001 failed on a 500.", action: "answer" } });
    const d = await copilotTurn(llm, { catalogue, messages: msgs });
    expect(d.testIds).toEqual([]);
    expect(d.title).toBeUndefined();
  });
});

describe("validateSelection", () => {
  it("keeps ids that exist and are generated, in catalogue order, without duplicates", () => {
    const d = validateSelection({ reply: "ok", action: "rerun", testIds: ["checkout-002", "checkout-001", "checkout-002"] }, catalogue);
    expect(d.action).toBe("rerun");
    expect(d.testIds).toEqual(["checkout-001", "checkout-002"]);
    expect(d.reply).toBe("ok");
  });

  it("drops invented and ungenerated ids", () => {
    const d = validateSelection({ reply: "ok", action: "rerun", testIds: ["checkout-001", "payments-009", "orders-001"] }, catalogue);
    expect(d.testIds).toEqual(["checkout-001"]);
  });

  it("downgrades a rerun with nothing valid to clarify and lists the real failures", () => {
    const d = validateSelection({ reply: "Rerunning payments-009.", action: "rerun", testIds: ["payments-009"] }, catalogue);
    expect(d.action).toBe("clarify");
    expect(d.testIds).toEqual([]);
    expect(d.reply).toContain("payments-009");
    expect(d.reply).toContain("checkout-001");
    expect(d.reply).toContain("checkout-002");
    expect(d.reply).not.toContain("Rerunning payments-009.");
  });

  it("says so when nothing failed at all", () => {
    const green: Catalogue = { ...catalogue, tests: catalogue.tests.map((t) => ({ ...t, status: t.generated ? "passed" : "not_run" })) };
    const d = validateSelection({ reply: "x", action: "rerun", testIds: ["nope"] }, green);
    expect(d.action).toBe("clarify");
    expect(d.reply).toContain("every generated test passed");
  });

  it("empties testIds on answer and clarify", () => {
    expect(validateSelection({ reply: "x", action: "answer", testIds: ["checkout-001"] }, catalogue).testIds).toEqual([]);
  });
});
