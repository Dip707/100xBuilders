import { TrackerError } from "./errors.js";
import { renderMarkdown, type TicketBody } from "./ticket.js";

export type LinearConfig = { apiKey: string; teamId: string; teamKey: string; teamName: string };
export type Fetch = typeof fetch;

const ENDPOINT = "https://api.linear.app/graphql";

/** Linear's priority scale: 1 urgent, 2 high, 3 medium, 4 low. */
const PRIORITY: Record<TicketBody["severity"], number> = { critical: 1, high: 2, medium: 3, low: 4 };

const TEAMS_QUERY = `query { viewer { id name } teams { nodes { id key name } } }`;
const CREATE_MUTATION = `mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { identifier url } }
}`;

async function graphql<T>(apiKey: string, query: string, variables: Record<string, unknown> | undefined, fetchFn: Fetch): Promise<T> {
  const res = await fetchFn(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: apiKey },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  if (res.status === 401 || res.status === 403) throw new TrackerError("Linear rejected the API key");
  if (!res.ok) throw new TrackerError(`Linear answered ${res.status}`);
  const out = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (out.errors?.length) throw new TrackerError(`Linear: ${out.errors.map((e) => e.message).join("; ")}`);
  if (!out.data) throw new TrackerError("Linear returned no data");
  return out.data;
}

type Team = { id: string; key: string; name: string };

/**
 * Proves the key works and settles which team issues go to. With one team there is nothing
 * to choose; with several the person names one by key, and the error lists the keys so the
 * second attempt can succeed.
 */
export async function verifyLinear(input: { apiKey: string; teamKey?: string }, fetchFn: Fetch = fetch): Promise<{ config: LinearConfig; label: string }> {
  const data = await graphql<{ viewer: { id: string }; teams: { nodes: Team[] } }>(input.apiKey, TEAMS_QUERY, undefined, fetchFn);
  const teams = data.teams.nodes;
  if (teams.length === 0) throw new TrackerError("This Linear account has no teams to file issues in");
  const wanted = input.teamKey?.trim().toUpperCase();
  let team: Team | undefined;
  if (wanted) {
    team = teams.find((t) => t.key.toUpperCase() === wanted);
    if (!team) throw new TrackerError(`No Linear team has the key ${wanted}. Teams: ${teams.map((t) => t.key).join(", ")}`);
  } else if (teams.length === 1) {
    team = teams[0];
  } else {
    throw new TrackerError(`This account has several teams; enter a team key. Teams: ${teams.map((t) => t.key).join(", ")}`);
  }
  return {
    config: { apiKey: input.apiKey, teamId: team.id, teamKey: team.key, teamName: team.name },
    label: `Linear · ${team.name}`,
  };
}

export async function createLinearIssue(config: LinearConfig, body: TicketBody, fetchFn: Fetch = fetch): Promise<{ key: string; url: string }> {
  const input = { teamId: config.teamId, title: body.title, description: renderMarkdown(body), priority: PRIORITY[body.severity] };
  const data = await graphql<{ issueCreate: { success: boolean; issue?: { identifier: string; url: string } } }>(config.apiKey, CREATE_MUTATION, { input }, fetchFn);
  if (!data.issueCreate.success || !data.issueCreate.issue) throw new TrackerError("Linear did not create the issue");
  return { key: data.issueCreate.issue.identifier, url: data.issueCreate.issue.url };
}
