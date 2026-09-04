import { describe, it, expect } from "vitest";
import { applyPatch, changedFields, formReducer, isValidUrl, runInputFromDraft, snapshotOf, DEFAULT_DRAFT } from "@/lib/draft";
import type { RunDraft } from "@/lib/draft";

describe("isValidUrl", () => {
  it("accepts http and https and nothing else", () => {
    expect(isValidUrl("http://localhost:3005")).toBe(true);
    expect(isValidUrl("https://app.example.com")).toBe(true);
    expect(isValidUrl("ftp://files.example.com")).toBe(false);
    expect(isValidUrl("app.example.com")).toBe(false);
    expect(isValidUrl("")).toBe(false);
  });
});

describe("applyPatch", () => {
  it("writes only the fields the patch carries", () => {
    const draft: RunDraft = { ...DEFAULT_DRAFT, url: "https://a.test", intent: "checkout" };
    const next = applyPatch(draft, { intent: "auth and checkout" });
    expect(next.url).toBe("https://a.test");
    expect(next.intent).toBe("auth and checkout");
  });

  it("merges a partial budget over the current one rather than replacing it", () => {
    const draft: RunDraft = { ...DEFAULT_DRAFT, budget: { maxLlmCalls: 200, maxMinutes: 40 } };
    expect(applyPatch(draft, { budget: { maxMinutes: 15 } }).budget).toEqual({ maxLlmCalls: 200, maxMinutes: 15 });
  });

  it("clears the credentials when sign-in is turned back off, so they cannot be sent unseen", () => {
    const draft: RunDraft = { ...DEFAULT_DRAFT, requiresSignIn: true, username: "demo", password: "pw" };
    const next = applyPatch(draft, { requiresSignIn: false });
    expect(next).toMatchObject({ requiresSignIn: false, username: "", password: "" });
  });

  it("leaves the credentials alone while sign-in stays on", () => {
    const draft: RunDraft = { ...DEFAULT_DRAFT, requiresSignIn: true, username: "demo", password: "pw" };
    expect(applyPatch(draft, { intent: "auth" })).toMatchObject({ username: "demo", password: "pw" });
  });
});

describe("changedFields", () => {
  it("names the fields a patch actually moved, so only those flash", () => {
    const draft: RunDraft = { ...DEFAULT_DRAFT, url: "https://a.test", intent: "checkout" };
    expect(changedFields(draft, applyPatch(draft, { intent: "auth", url: "https://a.test" }))).toEqual(["intent"]);
  });

  it("reports a budget change once, under one name", () => {
    const draft: RunDraft = { ...DEFAULT_DRAFT };
    expect(changedFields(draft, applyPatch(draft, { budget: { maxMinutes: 15 } }))).toEqual(["budget"]);
  });

  it("is empty when a patch changes nothing", () => {
    const draft: RunDraft = { ...DEFAULT_DRAFT, url: "https://a.test" };
    expect(changedFields(draft, applyPatch(draft, { url: "https://a.test" }))).toEqual([]);
  });
});

describe("snapshotOf", () => {
  it("carries the form fields the assistant may reason about", () => {
    const draft: RunDraft = { ...DEFAULT_DRAFT, url: "https://a.test", intent: "checkout", requiresSignIn: true, prdName: "prd.md", prdText: "# PRD" };
    expect(snapshotOf(draft)).toMatchObject({ url: "https://a.test", intent: "checkout", requiresSignIn: true, prdName: "prd.md", prdText: "# PRD" });
  });

  it("never carries the target app's credentials", () => {
    const draft: RunDraft = { ...DEFAULT_DRAFT, requiresSignIn: true, username: "demo", password: "hunter2" };
    const snapshot = snapshotOf(draft) as Record<string, unknown>;
    expect(snapshot.username).toBeUndefined();
    expect(snapshot.password).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain("hunter2");
  });

  it("omits an empty intent rather than sending a blank string", () => {
    expect(snapshotOf({ ...DEFAULT_DRAFT, intent: "  " })).not.toHaveProperty("intent");
  });
});

describe("runInputFromDraft", () => {
  it("builds what POST /run expects", () => {
    const draft: RunDraft = {
      ...DEFAULT_DRAFT, url: "https://a.test", intent: "checkout", prdText: "# PRD",
      reviewPlan: true, maxFlows: 8, budget: { maxLlmCalls: 150, maxMinutes: 20 },
    };
    expect(runInputFromDraft(draft, "chat-1")).toEqual({
      url: "https://a.test", intent: "checkout", prd: "# PRD", reviewPlan: true,
      maxFlows: 8, budget: { maxLlmCalls: 150, maxMinutes: 20 }, chatId: "chat-1",
    });
  });

  it("sends the credentials only when sign-in is on and both halves are filled", () => {
    const on: RunDraft = { ...DEFAULT_DRAFT, url: "https://a.test", requiresSignIn: true, username: "demo", password: "pw" };
    expect(runInputFromDraft(on).credentials).toEqual({ username: "demo", password: "pw" });
    expect(runInputFromDraft({ ...on, password: "" }).credentials).toBeUndefined();
    expect(runInputFromDraft({ ...on, requiresSignIn: false }).credentials).toBeUndefined();
  });

  it("omits blank optional fields instead of sending empty strings", () => {
    const input = runInputFromDraft({ ...DEFAULT_DRAFT, url: "https://a.test", intent: "   ", prdText: "" });
    expect(input).not.toHaveProperty("intent");
    expect(input).not.toHaveProperty("prd");
    expect(input).not.toHaveProperty("chatId");
  });
});

describe("formReducer", () => {
  it("records which fields a chat patch moved, so the form can flash them", () => {
    const next = formReducer({ draft: DEFAULT_DRAFT, flash: [] }, { kind: "patch", patch: { url: "https://a.test", intent: "auth" } });
    expect(next.draft.url).toBe("https://a.test");
    expect(next.flash).toEqual(["url", "intent"]);
  });

  it("does not flash a hand edit - only the assistant's writes are announced", () => {
    const next = formReducer({ draft: DEFAULT_DRAFT, flash: ["url"] }, { kind: "edit", fields: { intent: "typed" } });
    expect(next.draft.intent).toBe("typed");
    expect(next.flash).toEqual([]);
  });

  it("clears the credentials when sign-in is unticked by hand, not only by patch", () => {
    const signedIn = { draft: { ...DEFAULT_DRAFT, requiresSignIn: true, username: "demo", password: "pw" }, flash: [] };
    const next = formReducer(signedIn, { kind: "edit", fields: { requiresSignIn: false } });
    expect(next.draft).toMatchObject({ requiresSignIn: false, username: "", password: "" });
  });

  it("loads a saved chat's draft over the whole form and flashes nothing", () => {
    const dirty = { draft: { ...DEFAULT_DRAFT, url: "https://old.test", intent: "old" }, flash: ["url" as const] };
    const next = formReducer(dirty, { kind: "load", patch: { url: "https://new.test" } });
    expect(next.draft.url).toBe("https://new.test");
    expect(next.draft.intent).toBe("");
    expect(next.flash).toEqual([]);
  });

  it("returns the same state object when there is no flash to clear", () => {
    const state = { draft: DEFAULT_DRAFT, flash: [] };
    expect(formReducer(state, { kind: "clearFlash" })).toBe(state);
    expect(formReducer({ draft: DEFAULT_DRAFT, flash: ["url"] }, { kind: "clearFlash" }).flash).toEqual([]);
  });

  it("keeps the credentials through a load, since they were never in the saved draft", () => {
    const typed = { draft: { ...DEFAULT_DRAFT, requiresSignIn: true, username: "demo", password: "pw" }, flash: [] };
    const next = formReducer(typed, { kind: "load", patch: { requiresSignIn: true, url: "https://a.test" } });
    expect(next.draft).toMatchObject({ username: "demo", password: "pw" });
  });
});
