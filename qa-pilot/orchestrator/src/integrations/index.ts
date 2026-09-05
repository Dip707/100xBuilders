import { z } from "zod";
import type { IntegrationRecord, TrackerProvider } from "../store/types.js";
import { createJiraIssue, verifyJira, type JiraConfig } from "./jira.js";
import { createLinearIssue, verifyLinear, type LinearConfig } from "./linear.js";
import type { TicketBody } from "./ticket.js";

export { TrackerError } from "./errors.js";

/** What the client is ever told about a connection. Never a secret. */
export type IntegrationPublic = { provider: TrackerProvider; label: string; connectedAt: string };

/** The body of `PUT /integrations`: the provider decides which fields are required. */
export const ConnectSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("linear"), apiKey: z.string().min(1), teamKey: z.string().optional() }),
  z.object({ provider: z.literal("jira"), baseUrl: z.string().min(1), email: z.string().min(1), apiToken: z.string().min(1), projectKey: z.string().min(1) }),
]);
export type ConnectInput = z.infer<typeof ConnectSchema>;

/**
 * The seam between the routes and the trackers, so the API tests can file into a fake and
 * the two real clients stay ignorant of HTTP routing. `config` is the provider's own shape,
 * sealed by the route before it reaches the store and opened by the route before it comes
 * back here.
 */
export type Trackers = {
  verify(provider: TrackerProvider, input: ConnectInput): Promise<{ config: unknown; label: string }>;
  createIssue(provider: TrackerProvider, config: unknown, body: TicketBody): Promise<{ key: string; url: string }>;
};

export const liveTrackers: Trackers = {
  async verify(provider, input) {
    if (input.provider !== provider) throw new Error(`provider mismatch: ${provider} vs ${input.provider}`);
    return input.provider === "linear" ? verifyLinear(input) : verifyJira(input);
  },
  async createIssue(provider, config, body) {
    return provider === "linear" ? createLinearIssue(config as LinearConfig, body) : createJiraIssue(config as JiraConfig, body);
  },
};

export function publicShape(rec: IntegrationRecord): IntegrationPublic {
  return { provider: rec.provider, label: rec.label, connectedAt: rec.connectedAt };
}
