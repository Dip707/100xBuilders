import { describe, it, expect } from "vitest";
import { composioTrackerClient, extractDestinations, extractIssue, findFirst, publicShape, type ComposioSdk } from "../src/integrations/composio.js";
import { TrackerError } from "../src/integrations/errors.js";
import type { TicketBody } from "../src/integrations/ticket.js";

type Executed = { slug: string; body: { userId: string; connectedAccountId?: string; arguments: Record<string, unknown>; dangerouslySkipVersionCheck?: boolean } };

/** A fake SDK whose every call is recorded and whose answers are scripted per method. */
function fakeSdk(over: {
  configs?: { id: string; toolkit: { slug: string } }[];
  executeAnswers?: Record<string, ({ successful: boolean; data: Record<string, unknown>; error: string | null } | Error)[]>;
  waitStatus?: string | Error;
} = {}) {
  const calls = { created: [] as string[], linked: [] as unknown[], executed: [] as Executed[], deleted: [] as string[] };
  const sdk: ComposioSdk = {
    authConfigs: {
      list: async () => ({ items: over.configs ?? [] }),
      create: async (toolkit) => { calls.created.push(toolkit); return { id: `ac_new_${toolkit}` }; },
    },
    connectedAccounts: {
      link: async (userId, authConfigId, options) => { calls.linked.push({ userId, authConfigId, options }); return { id: "ca_123", redirectUrl: "https://backend.composio.dev/oauth/x" }; },
      waitForConnection: async () => {
        if (over.waitStatus instanceof Error) throw over.waitStatus;
        return { status: over.waitStatus ?? "ACTIVE" };
      },
      delete: async (id) => { calls.deleted.push(id); if (id === "ca_gone") { const e = new Error("not found"); (e as { status?: number }).status = 404; throw e; } },
    },
    tools: {
      execute: async (slug, body) => {
        calls.executed.push({ slug, body });
        const next = over.executeAnswers?.[slug]?.shift();
        if (!next) throw new Error(`no scripted answer for ${slug}`);
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
  return { sdk, calls };
}

const ok = (data: Record<string, unknown>) => ({ successful: true, data, error: null });
const body: TicketBody = { title: "[qa-pilot] Coupon 500", severity: "critical", sections: [{ heading: "Summary", lines: ["Target: x"] }] };

describe("authConfigId", () => {
  it("prefers the env override, then an existing config, then creates a managed one, and caches", async () => {
    const env = { COMPOSIO_LINEAR_AUTH_CONFIG_ID: "ac_env" } as NodeJS.ProcessEnv;
    const { sdk, calls } = fakeSdk({ configs: [{ id: "ac_jira_existing", toolkit: { slug: "jira" } }] });
    const client = composioTrackerClient(sdk, env);
    expect(await client.authConfigId("linear")).toBe("ac_env");
    expect(await client.authConfigId("jira")).toBe("ac_jira_existing");
    expect(calls.created).toEqual([]);

    const fresh = composioTrackerClient(fakeSdk().sdk, {} as NodeJS.ProcessEnv);
    expect(await fresh.authConfigId("linear")).toBe("ac_new_linear");
    expect(await fresh.authConfigId("linear")).toBe("ac_new_linear");
  });
});

describe("connections", () => {
  it("creates the OAuth link with the callback and returns the account id", async () => {
    const { sdk, calls } = fakeSdk();
    const client = composioTrackerClient(sdk, {} as NodeJS.ProcessEnv);
    const out = await client.startConnection("u1", "linear", "http://localhost:4000/integrations/callback");
    expect(out).toEqual({ connectedAccountId: "ca_123", redirectUrl: "https://backend.composio.dev/oauth/x" });
    expect(calls.linked[0]).toMatchObject({ userId: "u1", authConfigId: "ac_new_linear", options: { callbackUrl: "http://localhost:4000/integrations/callback" } });
  });

  it("reduces the wait to active, failed or timeout", async () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(await composioTrackerClient(fakeSdk().sdk, env).awaitConnection("ca", 1000)).toBe("active");
    expect(await composioTrackerClient(fakeSdk({ waitStatus: "FAILED" }).sdk, env).awaitConnection("ca", 1000)).toBe("failed");
    const timeout = new Error("timed out"); timeout.name = "ConnectionRequestTimeoutError";
    expect(await composioTrackerClient(fakeSdk({ waitStatus: timeout }).sdk, env).awaitConnection("ca", 1000)).toBe("timeout");
    const failed = new Error("failed"); failed.name = "ConnectionRequestFailedError";
    expect(await composioTrackerClient(fakeSdk({ waitStatus: failed }).sdk, env).awaitConnection("ca", 1000)).toBe("failed");
  });

  it("disconnects and treats a missing account as already gone", async () => {
    const { sdk, calls } = fakeSdk();
    const client = composioTrackerClient(sdk, {} as NodeJS.ProcessEnv);
    await client.disconnect("ca_1");
    await client.disconnect("ca_gone");
    expect(calls.deleted).toEqual(["ca_1", "ca_gone"]);
  });
});

describe("destinations", () => {
  it("reads Linear teams from a GraphQL-shaped payload", () => {
    const data = { teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }, { id: "t2", key: "OPS", name: "Ops" }], pageInfo: { hasNextPage: false } } };
    expect(extractDestinations("linear", data)).toEqual([{ id: "t1", label: "Engineering (ENG)" }, { id: "t2", label: "Ops (OPS)" }]);
  });

  it("reads Composio's real Linear team payload, which has no key and lists members with ids and names too", () => {
    const data = {
      items: [], page_info: { endCursor: "86df", hasNextPage: false },
      teams: [{ id: "86dfda91-1a5a-40e8-8137-8d184bf48087", members: [{ email: "a@x.test", id: "m1", name: "Ada" }, { email: "b@x.test", id: "m2", name: "Bob" }], name: "ConchAI", projects: [{ id: "p1" }] }],
    };
    expect(extractDestinations("linear", data)).toEqual([{ id: "86dfda91-1a5a-40e8-8137-8d184bf48087", label: "ConchAI" }]);
  });

  it("reads Jira projects from a paginated REST payload and a bare array", () => {
    const paged = { values: [{ id: "10000", key: "ACME", name: "Acme Shop", lead: { accountId: "x", displayName: "Ada" } }], total: 1 };
    expect(extractDestinations("jira", paged)).toEqual([{ id: "ACME", label: "Acme Shop (ACME)" }]);
    expect(extractDestinations("jira", { projects: [{ key: "OPS", name: "Ops" }] })).toEqual([{ id: "OPS", label: "Ops (OPS)" }]);
  });

  it("executes the listing tool for the connected account", async () => {
    const { sdk, calls } = fakeSdk({ executeAnswers: { LINEAR_LIST_LINEAR_TEAMS: [ok({ nodes: [{ id: "t1", key: "ENG", name: "Engineering" }] })] } });
    const out = await composioTrackerClient(sdk, {} as NodeJS.ProcessEnv).listDestinations("u1", "linear", "ca_1");
    expect(out).toEqual([{ id: "t1", label: "Engineering (ENG)" }]);
    expect(calls.executed[0].body).toMatchObject({ userId: "u1", connectedAccountId: "ca_1", dangerouslySkipVersionCheck: true });
  });
});

describe("createIssue", () => {
  it("files in Linear with the team, markdown description and mapped priority, reading identifier and url", async () => {
    const { sdk, calls } = fakeSdk({ executeAnswers: { LINEAR_CREATE_LINEAR_ISSUE: [ok({ issueCreate: { success: true, issue: { id: "uuid", identifier: "ENG-42", url: "https://linear.app/acme/issue/ENG-42" } } })] } });
    const out = await composioTrackerClient(sdk, {} as NodeJS.ProcessEnv).createIssue("u1", "linear", "ca_1", { id: "t1", label: "Engineering (ENG)" }, body);
    expect(out).toEqual({ key: "ENG-42", url: "https://linear.app/acme/issue/ENG-42" });
    expect(calls.executed[0].body.arguments).toEqual({ team_id: "t1", title: "[qa-pilot] Coupon 500", description: "## Summary\nTarget: x", priority: 1 });
  });

  it("files in Jira as a Bug, retries as a Task when the project has no Bug, and builds the browse url", async () => {
    const rejected = { successful: false, data: {}, error: "Field 'issuetype' has invalid value 'Bug'" };
    const created = ok({ id: "10042", key: "ACME-7", self: "https://acme.atlassian.net/rest/api/3/issue/10042" });
    const { sdk, calls } = fakeSdk({ executeAnswers: { JIRA_CREATE_ISSUE: [rejected, created] } });
    const out = await composioTrackerClient(sdk, {} as NodeJS.ProcessEnv).createIssue("u1", "jira", "ca_1", { id: "ACME", label: "Acme Shop (ACME)" }, body);
    expect(out).toEqual({ key: "ACME-7", url: "https://acme.atlassian.net/browse/ACME-7" });
    expect(calls.executed.map((e) => e.body.arguments.issue_type)).toEqual(["Bug", "Task"]);
    expect(calls.executed[0].body.arguments).toMatchObject({ project_key: "ACME", summary: "[qa-pilot] Coupon 500" });
  });

  it("reads Composio's real Linear create payload, taking the key from the ticket url", async () => {
    const { sdk } = fakeSdk({ executeAnswers: { LINEAR_CREATE_LINEAR_ISSUE: [ok({ id: "0a1b", ticket_url: "https://linear.app/conchai/issue/CON-17/qa-pilot-coupon-500", issue_title: "[qa-pilot] Coupon 500", issue_description: "..." })] } });
    const out = await composioTrackerClient(sdk, {} as NodeJS.ProcessEnv).createIssue("u1", "linear", "ca_1", { id: "t1", label: "ConchAI" }, body);
    expect(out).toEqual({ key: "CON-17", url: "https://linear.app/conchai/issue/CON-17/qa-pilot-coupon-500" });
  });

  it("reads Composio's real Jira create payload, preferring its browser url over the API self link", async () => {
    const { sdk } = fakeSdk({ executeAnswers: { JIRA_CREATE_ISSUE: [ok({ id: "12738", key: "TEST-101", self: "https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/issue/12738", browser_url: "https://acme.atlassian.net/browse/TEST-101" })] } });
    const out = await composioTrackerClient(sdk, {} as NodeJS.ProcessEnv).createIssue("u1", "jira", "ca_1", { id: "ACME", label: "Acme (ACME)" }, body);
    expect(out).toEqual({ key: "TEST-101", url: "https://acme.atlassian.net/browse/TEST-101" });
  });

  it("turns an unsuccessful execution into a TrackerError carrying Composio's words", async () => {
    const { sdk } = fakeSdk({ executeAnswers: { LINEAR_CREATE_LINEAR_ISSUE: [{ successful: false, data: {}, error: "Entity not found: Team" }] } });
    await expect(composioTrackerClient(sdk, {} as NodeJS.ProcessEnv).createIssue("u1", "linear", "ca_1", { id: "t9", label: "x" }, body)).rejects.toThrow(/Entity not found: Team/);
    await expect(composioTrackerClient(sdk, {} as NodeJS.ProcessEnv).createIssue("u1", "linear", "ca_1", { id: "t9", label: "x" }, body)).rejects.toBeInstanceOf(Error);
  });

  it("complains when the response carries no key", async () => {
    const { sdk } = fakeSdk({ executeAnswers: { LINEAR_CREATE_LINEAR_ISSUE: [ok({ success: true })] } });
    await expect(composioTrackerClient(sdk, {} as NodeJS.ProcessEnv).createIssue("u1", "linear", "ca_1", { id: "t1", label: "x" }, body)).rejects.toBeInstanceOf(TrackerError);
  });
});

describe("rejected project key", () => {
  it("names COMPOSIO_API_KEY when Composio answers 401, however deep the SDK wraps it", async () => {
    const inner = Object.assign(new Error('401 {"error":{"message":"Invalid API key: ak_**GuHM"}}'), { status: 401 });
    const wrapped = Object.assign(new Error("Unable to retrieve tool"), { cause: inner });
    const { sdk } = fakeSdk({ configs: [] });
    sdk.authConfigs.list = async () => { throw wrapped; };
    await expect(composioTrackerClient(sdk, {} as NodeJS.ProcessEnv).authConfigId("linear")).rejects.toThrow(/COMPOSIO_API_KEY/);
    const executing = fakeSdk();
    executing.sdk.tools.execute = async () => { throw inner; };
    await expect(composioTrackerClient(executing.sdk, {} as NodeJS.ProcessEnv).listDestinations("u", "jira", "ca")).rejects.toBeInstanceOf(TrackerError);
  });
});

describe("helpers", () => {
  it("findFirst walks arrays and objects depth-first", () => {
    expect(findFirst({ a: [{ b: 1 }, { c: { d: "hit", e: 2 } }] }, (o) => o.d === "hit")).toEqual({ d: "hit", e: 2 });
    expect(findFirst(null, () => true)).toBeUndefined();
  });

  it("extractIssue falls back to a Linear url from the identifier, and to the id when the url has no key", () => {
    expect(extractIssue("linear", { identifier: "ENG-1" })).toEqual({ key: "ENG-1", url: "https://linear.app/issue/ENG-1" });
    expect(extractIssue("linear", { id: "uuid-1", ticket_url: "https://linear.app/x" })).toEqual({ key: "uuid-1", url: "https://linear.app/x" });
  });

  it("publicShape names the destination in the label and never exposes the account id", () => {
    const rec = { userId: "u", provider: "linear" as const, connectedAccountId: "ca_secret", status: "active" as const, destination: { id: "t1", label: "Engineering (ENG)" }, connectedAt: "2026-09-05T10:00:00.000Z" };
    expect(publicShape(rec)).toEqual({ provider: "linear", status: "active", connectedAt: "2026-09-05T10:00:00.000Z", destination: { id: "t1", label: "Engineering (ENG)" }, label: "Linear · Engineering (ENG)" });
    expect(publicShape({ ...rec, destination: undefined, status: "pending" }).label).toBe("Linear");
    expect(JSON.stringify(publicShape(rec))).not.toContain("ca_secret");
  });
});
