import { Composio } from "@composio/core";
import type { IntegrationRecord, TrackerDestination, TrackerProvider } from "../store/types.js";
import { TrackerError } from "./errors.js";
import { renderMarkdown, type TicketBody } from "./ticket.js";

export type Destination = TrackerDestination;

/**
 * The seam between the routes and Composio. Tests hand the routes a fake of this; the live
 * implementation below wraps @composio/core. Every method speaks in qa-pilot's words
 * (provider, destination, ticket body) and never leaks an SDK type outward.
 */
export interface TrackerClient {
  /** The auth config for a provider's toolkit: the env override, else an existing config, else a new Composio-managed one. */
  authConfigId(provider: TrackerProvider): Promise<string>;
  /** Creates the OAuth link the browser must visit; the connection is `pending` until the callback. */
  startConnection(userId: string, provider: TrackerProvider, callbackUrl: string): Promise<{ connectedAccountId: string; redirectUrl: string }>;
  /** Polls the connection until it is usable, failed, or the wait runs out. */
  awaitConnection(connectedAccountId: string, timeoutMs: number): Promise<"active" | "failed" | "timeout">;
  /** Linear teams or Jira projects the connected account can file into. */
  listDestinations(userId: string, provider: TrackerProvider, connectedAccountId: string): Promise<Destination[]>;
  createIssue(userId: string, provider: TrackerProvider, connectedAccountId: string, destination: Destination, body: TicketBody): Promise<{ key: string; url: string }>;
  /** Removes the connected account from Composio. A missing account is not an error. */
  disconnect(connectedAccountId: string): Promise<void>;
}

/** The slice of the SDK the adapter touches, so a test can fake it without the SDK's own types. */
export type ComposioSdk = {
  authConfigs: {
    list(query: { toolkit?: string }): Promise<{ items: { id: string; toolkit: { slug: string } }[] }>;
    create(toolkit: string, options: { type: "use_composio_managed_auth"; name?: string }): Promise<{ id: string }>;
  };
  connectedAccounts: {
    link(userId: string, authConfigId: string, options: { callbackUrl?: string; allowMultiple?: boolean }): Promise<{ id: string; redirectUrl?: string | null }>;
    waitForConnection(connectedAccountId: string, timeout?: number): Promise<{ status: string }>;
    delete(connectedAccountId: string): Promise<unknown>;
  };
  tools: {
    execute(slug: string, body: { userId: string; connectedAccountId?: string; arguments: Record<string, unknown>; dangerouslySkipVersionCheck?: boolean }): Promise<{ successful: boolean; data: Record<string, unknown>; error: string | null }>;
  };
};

export const MISSING_COMPOSIO_KEY = "COMPOSIO_API_KEY is not set. Put your Composio API key in qa-pilot/.env to connect Linear or Jira";

const TOOLKIT: Record<TrackerProvider, string> = { linear: "linear", jira: "jira" };
const PROVIDER_NAME: Record<TrackerProvider, string> = { linear: "Linear", jira: "Jira" };
/** Linear's priority scale: 1 urgent, 2 high, 3 medium, 4 low. */
const LINEAR_PRIORITY: Record<TicketBody["severity"], number> = { critical: 1, high: 2, medium: 3, low: 4 };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Composio hands back the tracker's own payload, whose nesting the SDK does not pin down:
 * Linear answers in GraphQL shapes (`teams.nodes`, `issueCreate.issue`), Jira in REST ones
 * (`values`, a bare issue). Rather than guess one, the adapter walks the payload depth-first
 * for the first object that has the fields it needs.
 */
export function findFirst(value: unknown, matches: (o: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findFirst(item, matches);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (matches(value)) return value;
  for (const child of Object.values(value)) {
    const hit = findFirst(child, matches);
    if (hit) return hit;
  }
  return undefined;
}

/** Every object in the payload that matches, in document order; used for lists of teams or projects. */
export function findAll(value: unknown, matches: (o: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isRecord(v)) {
      if (matches(v)) out.push(v);
      else Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return out;
}

const str = (o: Record<string, unknown>, k: string): string | undefined => (typeof o[k] === "string" && (o[k] as string).length > 0 ? (o[k] as string) : undefined);
const isTeam = (o: Record<string, unknown>) => str(o, "id") !== undefined && str(o, "name") !== undefined && str(o, "key") !== undefined;
const isProject = (o: Record<string, unknown>) => str(o, "key") !== undefined && str(o, "name") !== undefined && !("id" in o && "email" in o);

export function extractDestinations(provider: TrackerProvider, data: unknown): Destination[] {
  if (provider === "linear") {
    return findAll(data, isTeam).map((t) => ({ id: str(t, "id")!, label: `${str(t, "name")} (${str(t, "key")})` }));
  }
  return findAll(data, isProject).map((p) => ({ id: str(p, "key")!, label: `${str(p, "name")} (${str(p, "key")})` }));
}

export function extractIssue(provider: TrackerProvider, data: unknown): { key: string; url: string } | undefined {
  if (provider === "linear") {
    const issue = findFirst(data, (o) => str(o, "identifier") !== undefined);
    if (!issue) return undefined;
    const key = str(issue, "identifier")!;
    return { key, url: str(issue, "url") ?? `https://linear.app/issue/${encodeURIComponent(key)}` };
  }
  const issue = findFirst(data, (o) => str(o, "key") !== undefined && (str(o, "self") !== undefined || str(o, "id") !== undefined));
  if (!issue) return undefined;
  const key = str(issue, "key")!;
  const self = str(issue, "self");
  let url = self ?? "";
  if (self) {
    try {
      url = `${new URL(self).origin}/browse/${encodeURIComponent(key)}`;
    } catch {
      url = self;
    }
  }
  return { key, url };
}

/** Maps the SDK's wait outcome to a word: the SDK throws typed errors for failure and timeout. */
function waitOutcome(err: unknown): "failed" | "timeout" {
  const name = (err as { name?: string } | null)?.name ?? "";
  return /timeout/i.test(name) ? "timeout" : "failed";
}

export function composioTrackerClient(sdk: ComposioSdk, env: NodeJS.ProcessEnv = process.env): TrackerClient {
  const configIds = new Map<TrackerProvider, string>();

  async function execute(slug: string, userId: string, connectedAccountId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await sdk.tools.execute(slug, { userId, connectedAccountId, arguments: args, dangerouslySkipVersionCheck: true });
    if (!res.successful) throw new TrackerError(res.error ? `${slug}: ${res.error}` : `${slug} did not succeed`);
    return res.data;
  }

  return {
    async authConfigId(provider) {
      const cached = configIds.get(provider);
      if (cached) return cached;
      const fromEnv = env[`COMPOSIO_${provider.toUpperCase()}_AUTH_CONFIG_ID`];
      let id = fromEnv && fromEnv.trim();
      if (!id) {
        const existing = await sdk.authConfigs.list({ toolkit: TOOLKIT[provider] });
        id = existing.items.find((c) => c.toolkit.slug.toLowerCase() === TOOLKIT[provider])?.id;
      }
      if (!id) id = (await sdk.authConfigs.create(TOOLKIT[provider], { type: "use_composio_managed_auth", name: `qa-pilot ${PROVIDER_NAME[provider]}` })).id;
      configIds.set(provider, id);
      return id;
    },

    async startConnection(userId, provider, callbackUrl) {
      const authConfigId = await this.authConfigId(provider);
      const req = await sdk.connectedAccounts.link(userId, authConfigId, { callbackUrl, allowMultiple: true });
      if (!req.redirectUrl) throw new TrackerError(`Composio returned no authorisation link for ${PROVIDER_NAME[provider]}`);
      return { connectedAccountId: req.id, redirectUrl: req.redirectUrl };
    },

    async awaitConnection(connectedAccountId, timeoutMs) {
      try {
        const account = await sdk.connectedAccounts.waitForConnection(connectedAccountId, timeoutMs);
        return account.status === "ACTIVE" ? "active" : "failed";
      } catch (err) {
        return waitOutcome(err);
      }
    },

    async listDestinations(userId, provider, connectedAccountId) {
      const slug = provider === "linear" ? "LINEAR_LIST_LINEAR_TEAMS" : "JIRA_GET_ALL_PROJECTS";
      const data = await execute(slug, userId, connectedAccountId, provider === "linear" ? { first: 100 } : { maxResults: 100 });
      return extractDestinations(provider, data);
    },

    async createIssue(userId, provider, connectedAccountId, destination, body) {
      const description = renderMarkdown(body);
      let data: Record<string, unknown>;
      if (provider === "linear") {
        data = await execute("LINEAR_CREATE_LINEAR_ISSUE", userId, connectedAccountId, {
          team_id: destination.id, title: body.title, description, priority: LINEAR_PRIORITY[body.severity],
        });
      } else {
        const args = { project_key: destination.id, summary: body.title, description };
        try {
          data = await execute("JIRA_CREATE_ISSUE", userId, connectedAccountId, { ...args, issue_type: "Bug" });
        } catch (err) {
          // A project with no Bug type rejects the create; Task exists in every default scheme.
          if (!(err instanceof TrackerError) || !/issue ?type|issuetype/i.test(err.message)) throw err;
          data = await execute("JIRA_CREATE_ISSUE", userId, connectedAccountId, { ...args, issue_type: "Task" });
        }
      }
      const issue = extractIssue(provider, data);
      if (!issue) throw new TrackerError(`${PROVIDER_NAME[provider]} created the issue but returned no key`);
      return issue;
    },

    async disconnect(connectedAccountId) {
      try {
        await sdk.connectedAccounts.delete(connectedAccountId);
      } catch (err) {
        if ((err as { status?: number } | null)?.status === 404 || /not found/i.test((err as Error)?.message ?? "")) return;
        throw err;
      }
    },
  };
}

let live: TrackerClient | undefined;

/** Built on first use: the API must come up without a Composio key for everything that is not a tracker. */
export function liveTrackerClient(): TrackerClient {
  if (live) return live;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new TrackerError(MISSING_COMPOSIO_KEY);
  const sdk = new Composio({ apiKey, allowTracking: false, toolkitVersions: "latest" });
  live = composioTrackerClient(sdk as unknown as ComposioSdk);
  return live;
}

export type IntegrationPublic = {
  provider: TrackerProvider;
  status: IntegrationRecord["status"];
  connectedAt: string;
  destination?: Destination;
  /** "Linear · Engineering (ENG)" once a destination is chosen, "Linear" before. */
  label: string;
};

export function publicShape(rec: IntegrationRecord): IntegrationPublic {
  const name = PROVIDER_NAME[rec.provider];
  return {
    provider: rec.provider,
    status: rec.status,
    connectedAt: rec.connectedAt,
    ...(rec.destination ? { destination: rec.destination } : {}),
    label: rec.destination ? `${name} · ${rec.destination.label}` : name,
  };
}
