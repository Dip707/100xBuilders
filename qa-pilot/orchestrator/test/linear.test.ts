import { describe, it, expect } from "vitest";
import { verifyLinear, createLinearIssue } from "../src/integrations/linear.js";
import { TrackerError } from "../src/integrations/errors.js";
import type { TicketBody } from "../src/integrations/ticket.js";

type Call = { url: string; init: RequestInit; body: { query: string; variables?: Record<string, unknown> } };

/** A fetch that records each GraphQL request and answers with the next canned body. */
function fakeFetch(answers: unknown[]) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    const answer = answers.shift();
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const teams = (nodes: { id: string; key: string; name: string }[]) => ({ data: { viewer: { id: "me", name: "Ada" }, teams: { nodes } } });

describe("verifyLinear", () => {
  it("resolves the only team without a key and sends the API key as the Authorization header", async () => {
    const { fetchFn, calls } = fakeFetch([teams([{ id: "t1", key: "ENG", name: "Engineering" }])]);
    const out = await verifyLinear({ apiKey: "lin_api_abc" }, fetchFn);
    expect(out.config).toEqual({ apiKey: "lin_api_abc", teamId: "t1", teamKey: "ENG", teamName: "Engineering" });
    expect(out.label).toBe("Linear · Engineering");
    expect(calls[0].url).toBe("https://api.linear.app/graphql");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("lin_api_abc");
  });

  it("asks for a team key when there are several", async () => {
    const { fetchFn } = fakeFetch([teams([{ id: "t1", key: "ENG", name: "Engineering" }, { id: "t2", key: "OPS", name: "Ops" }])]);
    await expect(verifyLinear({ apiKey: "k" }, fetchFn)).rejects.toThrow(/ENG, OPS/);
  });

  it("picks the team whose key matches, case-insensitively", async () => {
    const { fetchFn } = fakeFetch([teams([{ id: "t1", key: "ENG", name: "Engineering" }, { id: "t2", key: "OPS", name: "Ops" }])]);
    const out = await verifyLinear({ apiKey: "k", teamKey: "ops" }, fetchFn);
    expect(out.config.teamId).toBe("t2");
  });

  it("names an unknown team key", async () => {
    const { fetchFn } = fakeFetch([teams([{ id: "t1", key: "ENG", name: "Engineering" }])]);
    await expect(verifyLinear({ apiKey: "k", teamKey: "NOPE" }, fetchFn)).rejects.toThrow(/NOPE/);
  });

  it("surfaces a GraphQL error and a rejected key as TrackerError", async () => {
    const { fetchFn } = fakeFetch([{ errors: [{ message: "Authentication required" }] }]);
    await expect(verifyLinear({ apiKey: "bad" }, fetchFn)).rejects.toBeInstanceOf(TrackerError);
    const rejected = fakeFetch([new Response("nope", { status: 401 })]);
    await expect(verifyLinear({ apiKey: "bad" }, rejected.fetchFn)).rejects.toThrow(/rejected the API key/);
  });
});

describe("createLinearIssue", () => {
  const config = { apiKey: "lin_api_abc", teamId: "t1", teamKey: "ENG", teamName: "Engineering" };
  const body: TicketBody = { title: "[qa-pilot] Coupon 500", severity: "critical", sections: [{ heading: "Summary", lines: ["Target: x"] }, { heading: "Steps to reproduce", bullets: ["1. goto /"] }] };

  it("posts issueCreate with the team, title, markdown description and mapped priority", async () => {
    const { fetchFn, calls } = fakeFetch([{ data: { issueCreate: { success: true, issue: { identifier: "ENG-42", url: "https://linear.app/acme/issue/ENG-42" } } } }]);
    const out = await createLinearIssue(config, body, fetchFn);
    expect(out).toEqual({ key: "ENG-42", url: "https://linear.app/acme/issue/ENG-42" });
    expect(calls[0].body.query).toContain("issueCreate");
    const input = calls[0].body.variables!.input as Record<string, unknown>;
    expect(input.teamId).toBe("t1");
    expect(input.title).toBe("[qa-pilot] Coupon 500");
    expect(input.description).toContain("## Summary\nTarget: x");
    expect(input.priority).toBe(1);
  });

  it("maps every severity to a Linear priority", async () => {
    for (const [severity, priority] of [["high", 2], ["medium", 3], ["low", 4]] as const) {
      const { fetchFn, calls } = fakeFetch([{ data: { issueCreate: { success: true, issue: { identifier: "ENG-1", url: "u" } } } }]);
      await createLinearIssue(config, { ...body, severity }, fetchFn);
      expect((calls[0].body.variables!.input as Record<string, unknown>).priority).toBe(priority);
    }
  });

  it("throws a TrackerError when Linear reports failure", async () => {
    const { fetchFn } = fakeFetch([{ data: { issueCreate: { success: false } } }]);
    await expect(createLinearIssue(config, body, fetchFn)).rejects.toBeInstanceOf(TrackerError);
  });
});
