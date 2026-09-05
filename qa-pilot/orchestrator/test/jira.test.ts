import { describe, it, expect } from "vitest";
import { verifyJira, createJiraIssue } from "../src/integrations/jira.js";
import { TrackerError } from "../src/integrations/errors.js";
import type { TicketBody } from "../src/integrations/ticket.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(answers: Response[]) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answers.shift() ?? new Response("{}", { status: 500 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const project = (issueTypes: { name: string; subtask: boolean }[]) => ({ key: "ACME", name: "Acme Shop", issueTypes });
const input = { baseUrl: "https://acme.atlassian.net/", email: "ada@acme.test", apiToken: "tok", projectKey: "ACME" };

describe("verifyJira", () => {
  it("fetches the project with basic auth, trims the trailing slash and prefers the Bug issue type", async () => {
    const { fetchFn, calls } = fakeFetch([json(project([{ name: "Task", subtask: false }, { name: "Bug", subtask: false }]))]);
    const out = await verifyJira(input, fetchFn);
    expect(out.config).toEqual({ baseUrl: "https://acme.atlassian.net", email: "ada@acme.test", apiToken: "tok", projectKey: "ACME", projectName: "Acme Shop", issueType: "Bug" });
    expect(out.label).toBe("Jira · Acme Shop on acme.atlassian.net");
    expect(calls[0].url).toBe("https://acme.atlassian.net/rest/api/3/project/ACME");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("ada@acme.test:tok").toString("base64")}`);
  });

  it("falls back to the first non-subtask issue type when there is no Bug", async () => {
    const { fetchFn } = fakeFetch([json(project([{ name: "Sub-task", subtask: true }, { name: "Story", subtask: false }]))]);
    expect((await verifyJira(input, fetchFn)).config.issueType).toBe("Story");
  });

  it("explains a rejected credential and an unknown project", async () => {
    await expect(verifyJira(input, fakeFetch([new Response("", { status: 401 })]).fetchFn)).rejects.toThrow(/email or API token/);
    await expect(verifyJira(input, fakeFetch([new Response("", { status: 404 })]).fetchFn)).rejects.toThrow(/ACME/);
    await expect(verifyJira({ ...input, baseUrl: "not a url" }, fakeFetch([]).fetchFn)).rejects.toBeInstanceOf(TrackerError);
  });
});

describe("createJiraIssue", () => {
  const config = { baseUrl: "https://acme.atlassian.net", email: "ada@acme.test", apiToken: "tok", projectKey: "ACME", projectName: "Acme Shop", issueType: "Bug" };
  const body: TicketBody = { title: "[qa-pilot] Coupon 500", severity: "high", sections: [{ heading: "Summary", lines: ["Target: x"] }, { heading: "Evidence", bullets: ["500"] }] };

  it("posts the issue with project, type, summary and an ADF description, and links to the browse page", async () => {
    const { fetchFn, calls } = fakeFetch([json({ id: "1", key: "ACME-7" }, 201)]);
    const out = await createJiraIssue(config, body, fetchFn);
    expect(out).toEqual({ key: "ACME-7", url: "https://acme.atlassian.net/browse/ACME-7" });
    expect(calls[0].url).toBe("https://acme.atlassian.net/rest/api/3/issue");
    const sent = JSON.parse(String(calls[0].init.body)) as { fields: Record<string, unknown> };
    expect(sent.fields.project).toEqual({ key: "ACME" });
    expect(sent.fields.issuetype).toEqual({ name: "Bug" });
    expect(sent.fields.summary).toBe("[qa-pilot] Coupon 500");
    expect((sent.fields.description as { type: string }).type).toBe("doc");
  });

  it("surfaces Jira's field errors as a TrackerError", async () => {
    const { fetchFn } = fakeFetch([json({ errorMessages: ["Field 'priority' cannot be set"], errors: { issuetype: "issue type is required" } }, 400)]);
    await expect(createJiraIssue(config, body, fetchFn)).rejects.toThrow(/cannot be set.*issue type is required/);
  });
});
