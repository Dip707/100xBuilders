# Defect tickets from the copilot

Date: 2026-09-05.
Status: approved in brainstorming, implementation plan follows.

## Purpose

When a rerun in the copilot still fails and the pipeline's classifier called that failure an application defect, the chat should let the person do the next thing: file it.
Today the rerun result bubble shows the error and stops.
This adds a call to action on that row: "Connect Linear or Jira" when nothing is connected, "Raise a ticket" when a tracker is, and a link to the issue once it exists.

Filing goes to a real tracker.
Linear and Jira Cloud are both supported; a user connects one of them on a new Settings page.

## Where the verdict comes from

The copilot's rerun never classifies a failure; only the original pipeline run does, in the classify node.
The rerun result therefore carries the original run's verdict for each test, read from the catalogue at execute time, and the call to action is gated on it:

- A row that still fails and whose test the original run classified `defect`, or that already has a record in `defects.json`, shows the ticket call to action.
- A row that still fails with a `script`, `env`, `flaky` or `needs_human` verdict shows the verdict in words and no ticket action, for instance "Classifier: environment error, not filed as a defect".
  A `page.goto` timeout is an environment error by the classifier's own rules, and the product stands behind that reading rather than inviting a ticket for an unreachable target.
- A row with no verdict at all (the test never ran in the pipeline, or the events file is gone) shows no verdict line and no ticket action.
- A row that passed shows nothing extra.

The rerun summary sentence names the verdict too: "checkout-001 still fails and the classifier calls it an app defect: POST /api/coupon returned 500".

## Storage

Two new collections, both behind the `Store` interface with memory and Mongo implementations and the shared contract test.

```ts
type TrackerProvider = "linear" | "jira";

/** What the client is ever told about a connection. Never a secret. */
type IntegrationPublic = { provider: TrackerProvider; label: string; connectedAt: string };

type LinearConfig = { apiKey: string; teamId: string; teamKey: string; teamName: string };
type JiraConfig = { baseUrl: string; email: string; apiToken: string; projectKey: string; projectName: string; issueType: string };

/** One connection per user. `secret` is the AES-256-GCM ciphertext of the JSON config. */
type IntegrationRecord = { userId: string; provider: TrackerProvider; label: string; secret: string; connectedAt: string };

type TicketRecord = {
  id: string; userId: string; runId: string; testId: string;
  provider: TrackerProvider; key: string; url: string; createdAt: string;
};
```

Store methods: `saveIntegration`, `getIntegration(userId)`, `deleteIntegration(userId)`, `insertTicket`, `findTicket(userId, runId, testId)`, `listTickets(userId, runId)`.
Mongo indexes: `integrations` keyed by `_id = userId`; `tickets` unique on `(userId, runId, testId)`.

Config encryption lives in `orchestrator/src/integrations/crypto.ts`: AES-256-GCM with a key derived by SHA-256 from `QA_PILOT_SECRET`.
Saving or reading an integration without `QA_PILOT_SECRET` set fails with a message naming the variable; the variable is added to `.env.example`.
The store never sees plaintext credentials and the API never returns them.

## Providers

`orchestrator/src/integrations/linear.ts` and `jira.ts` each export two functions over an injectable `fetch`:

- `verify(input) -> config + label`. Linear: the `viewer` and `teams` query with the API key; the team is the one whose key matches `teamKey`, or the only team when there is exactly one, otherwise a 400 listing the team keys. Jira: `GET /rest/api/3/project/{projectKey}` with basic auth from email and token; the issue type is `Bug` when the project has one, otherwise the first non-subtask type.
- `createIssue(config, ticket) -> { key, url }`. Linear: `issueCreate` with team, title, markdown description and priority mapped from severity (critical 1, high 2, medium 3, low 4). Jira: `POST /rest/api/3/issue` with project, issue type, summary and an Atlassian Document Format description.

The ticket body is built once, provider-agnostic, in `orchestrator/src/integrations/ticket.ts`:

```ts
type TicketBody = { title: string; severity: Defect["severity"]; sections: { heading: string; lines?: string[]; bullets?: string[] }[] };
```

Sections: Summary (target URL, run id, test id, severity, classifier verdict and confidence), Steps to reproduce, Expected, Actual, Evidence, Latest rerun (error head and time), and a link to the case page in the UI built from `QA_PILOT_UI_ORIGIN`.
When the test has a defect record the body comes from it; otherwise from the plan flow and the latest result.
`renderMarkdown(body)` feeds Linear; `renderAdf(body)` feeds Jira.

## API

- `GET /integrations` -> `{ integration: IntegrationPublic | null }`.
- `PUT /integrations` with `{ provider: "linear", apiKey, teamKey? }` or `{ provider: "jira", baseUrl, email, apiToken, projectKey }`. Verifies against the provider, encrypts, saves, returns the public shape. A provider rejection is a 400 carrying the provider's message.
- `DELETE /integrations` -> 204.
- `GET /runs/:runId/tickets` -> `{ tickets: TicketRecord[] }` for an owned run.
- `POST /runs/:runId/tests/:testId/ticket` -> `{ ticket }`. 404 for a run the user does not own or a test not in the plan; 412 with `needs: ["integration"]` when nothing is connected; the existing ticket with 200 when one was already filed for this run and test, so a second click never duplicates; 502 with the provider's message when creation fails. An in-flight set keyed by run and test guards a double click.

The rerun result stored on the chat message gains per row `verdict?: { class: string; confidence: number }` and `defectId?: string`, populated from the catalogue in `resultData`.

## UI

**Settings page** at `/settings`, reached from a new "Settings" item in the user menu.
One section, Integrations.
Disconnected: a segmented control choosing Linear or Jira, the provider's fields, a Connect button that verifies and saves, and a row of what will be sent.
Connected: a card with the provider, its label ("Linear · Engineering", "Jira · ACME on acme.atlassian.net"), the connection date, and a Disconnect button.
Opened with `?return=<path>` the page goes back to that path after a successful connect, so the chat flow resumes where it left off.

**Copilot result table.**
Each still-failing row with a `defect` verdict shows a verdict chip and, on the right of the status column, one of:

- a link "Connect Linear or Jira" to `/settings?return=/copilot` when no integration exists;
- a button "Raise in Linear" or "Raise in Jira" that posts to the ticket route, shows a spinner while it runs, and turns into the issue link on success;
- the issue link ("ENG-142", external-link icon) when a ticket exists.

Rows with another verdict show the verdict sentence in muted text.
The page loads the integration once and the run's tickets whenever a result bubble's run changes, and passes both down so a reopened chat shows the same links.
Errors from filing appear in the page's existing alert strip.

## Guards

- Ownership: runs resolve through `ownedRun`; tickets and integrations are read and written under the session user only.
- Secrets: encrypted at rest, decrypted only inside the ticket and verify handlers, never logged, never in a response, never on a chat message.
- Duplicates: the unique ticket index, the pre-check, and the in-flight set.
- Verdict honesty: the server files whatever it is asked to for a test in the plan, but the UI only offers filing on a `defect` verdict, and the summary sentence names the verdict.

## Testing

- Unit: crypto round trip and the missing-secret error; ticket body from a defect record and from a bare result; markdown and ADF rendering; Linear and Jira `verify` and `createIssue` against a fake fetch, including the multiple-teams 400 and the Bug fallback; `resultData` carrying verdicts; `summariseRerun` naming the verdict.
- Store contract (memory and Mongo): integration save, read, replace and delete; ticket insert, find, list, and the duplicate rejection.
- API: integration PUT with a fake verifier, GET never returns the secret, DELETE; ticket POST for an unconnected user, a foreign run, an unknown test, a first filing, a repeat filing, and a provider failure.
- UI: the result table's four states (no verdict, non-defect verdict, defect without integration, defect with integration, defect with ticket).

## Files

- `orchestrator/src/integrations/crypto.ts`, `ticket.ts`, `linear.ts`, `jira.ts`, `index.ts`
- `orchestrator/src/store/types.ts`, `memory.ts`, `mongo.ts`
- `orchestrator/src/copilot/execute.ts` for verdicts on results and in the summary
- `orchestrator/src/api.ts` for the five routes
- `ui/app/(app)/settings/page.tsx`, `ui/components/settings/IntegrationsCard.tsx`
- `ui/components/copilot/RerunResultTable.tsx`, `ui/app/(app)/copilot/page.tsx`, `ui/lib/api.ts`, `ui/components/shell/UserMenu.tsx`
- `.env.example`, `README.md`, `ARCHITECTURE.md`

## Out of scope

Filing from the run's cases page (the endpoint is generic so it can be added later), GitHub Issues, per-team or per-project sharing of a connection, OAuth flows, syncing ticket status back from the tracker, and attaching traces or videos to the issue.
