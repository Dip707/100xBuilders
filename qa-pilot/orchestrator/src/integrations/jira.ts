import { TrackerError } from "./errors.js";
import { renderAdf, type TicketBody } from "./ticket.js";
import type { Fetch } from "./linear.js";

export type JiraConfig = { baseUrl: string; email: string; apiToken: string; projectKey: string; projectName: string; issueType: string };

/** Jira Cloud's basic auth: the account email and an API token from id.atlassian.com. */
const auth = (email: string, token: string) => `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

function normaliseBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TrackerError("Enter the Jira site URL, for example https://acme.atlassian.net");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TrackerError("The Jira site URL must start with https://");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Jira's error body carries a list of general messages and a map of per-field ones; both are worth reading. */
async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { errorMessages?: string[]; errors?: Record<string, string> } | null;
  const parts = [...(body?.errorMessages ?? []), ...Object.values(body?.errors ?? {})];
  return parts.length ? parts.join("; ") : `Jira answered ${res.status}`;
}

type Project = { key: string; name: string; issueTypes?: { name: string; subtask: boolean }[] };

/** Proves the credential and project, and settles which issue type a defect becomes. */
export async function verifyJira(
  input: { baseUrl: string; email: string; apiToken: string; projectKey: string },
  fetchFn: Fetch = fetch,
): Promise<{ config: JiraConfig; label: string }> {
  const baseUrl = normaliseBase(input.baseUrl);
  const projectKey = input.projectKey.trim().toUpperCase();
  const res = await fetchFn(`${baseUrl}/rest/api/3/project/${encodeURIComponent(projectKey)}`, {
    headers: { Accept: "application/json", Authorization: auth(input.email.trim(), input.apiToken) },
  });
  if (res.status === 401 || res.status === 403) throw new TrackerError("Jira rejected the email or API token");
  if (res.status === 404) throw new TrackerError(`Jira has no project ${projectKey} that this account can see`);
  if (!res.ok) throw new TrackerError(await errorText(res));
  const project = (await res.json()) as Project;
  const types = (project.issueTypes ?? []).filter((t) => !t.subtask);
  const issueType = types.find((t) => t.name.toLowerCase() === "bug")?.name ?? types[0]?.name;
  if (!issueType) throw new TrackerError(`Project ${projectKey} has no issue type a defect could be filed as`);
  return {
    config: { baseUrl, email: input.email.trim(), apiToken: input.apiToken, projectKey, projectName: project.name, issueType },
    label: `Jira · ${project.name} on ${new URL(baseUrl).host}`,
  };
}

export async function createJiraIssue(config: JiraConfig, body: TicketBody, fetchFn: Fetch = fetch): Promise<{ key: string; url: string }> {
  const fields = {
    project: { key: config.projectKey },
    issuetype: { name: config.issueType },
    summary: body.title,
    description: renderAdf(body),
  };
  const res = await fetchFn(`${config.baseUrl}/rest/api/3/issue`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json", Authorization: auth(config.email, config.apiToken) },
    body: JSON.stringify({ fields }),
  });
  if (res.status === 401 || res.status === 403) throw new TrackerError("Jira rejected the email or API token");
  if (!res.ok) throw new TrackerError(await errorText(res));
  const created = (await res.json()) as { key: string };
  return { key: created.key, url: `${config.baseUrl}/browse/${created.key}` };
}
