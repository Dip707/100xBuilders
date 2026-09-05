# Trackers through Composio

Date: 2026-09-05.
Status: approved in brainstorming, implementation plan follows.
Supersedes the connection half of `2026-09-05-defect-tickets-design.md`; the verdict gating, ticket body, ticket records and the copilot call to action stay as designed there.

## Purpose

Connecting Linear or Jira should be a click through OAuth, not an API key pasted into a form.
Composio holds the OAuth tokens and exposes both trackers as tools, so qa-pilot stores no credential, drops its own encryption, and can add another tracker later by naming a toolkit.

## What changes and what stays

Removed: `integrations/crypto.ts`, `integrations/linear.ts`, `integrations/jira.ts`, `QA_PILOT_SECRET`, the API key and token fields on Settings, and the `secret` field on the integration record.

Kept: the `defect` verdict gate, `integrations/ticket.ts` (the body and its markdown rendering), the `tickets` collection and its unique index, the ticket route's duplicate handling, and the result table's three states.

Added: a Composio adapter, an OAuth connect and callback flow, and a destination picker (Linear team or Jira project) on Settings.

## Storage

```ts
type TrackerProvider = "linear" | "jira";

type IntegrationRecord = {
  userId: string;
  provider: TrackerProvider;
  /** Composio's connected account id; the token lives with Composio, never here. */
  connectedAccountId: string;
  /** "pending" from the moment the OAuth link is created until the callback sees it ACTIVE. */
  status: "pending" | "active";
  /** Where issues go: a Linear team id or a Jira project key, with the name shown to the person. */
  destination?: { id: string; label: string };
  connectedAt: string;
};
```

`saveIntegration` replaces the record; `getIntegration` and `deleteIntegration` are unchanged.
The public shape the client sees is `{ provider, status, connectedAt, destination?, label }` where `label` is "Linear · Engineering" once a destination is set and "Linear" before.

## The adapter

`orchestrator/src/integrations/composio.ts` wraps `@composio/core` behind one interface the routes and tests use:

```ts
type Destination = { id: string; label: string };

interface TrackerClient {
  /** The auth config for a toolkit: COMPOSIO_<PROVIDER>_AUTH_CONFIG_ID when set, else the existing config for that toolkit, else a new Composio-managed one. Cached per process. */
  authConfigId(provider: TrackerProvider): Promise<string>;
  /** connectedAccounts.link(userId, authConfigId, { callbackUrl }) */
  startConnection(userId: string, provider: TrackerProvider, callbackUrl: string): Promise<{ connectedAccountId: string; redirectUrl: string }>;
  /** connectedAccounts.waitForConnection(id, timeoutMs), reduced to a status word. */
  awaitConnection(connectedAccountId: string, timeoutMs: number): Promise<"active" | "failed" | "timeout">;
  /** LINEAR_LIST_LINEAR_TEAMS or JIRA_GET_ALL_PROJECTS. */
  listDestinations(userId: string, provider: TrackerProvider, connectedAccountId: string): Promise<Destination[]>;
  /** LINEAR_CREATE_LINEAR_ISSUE or JIRA_CREATE_ISSUE. */
  createIssue(userId: string, provider: TrackerProvider, connectedAccountId: string, destination: Destination, body: TicketBody): Promise<{ key: string; url: string }>;
  /** connectedAccounts.delete(id); a missing account is not an error. */
  disconnect(connectedAccountId: string): Promise<void>;
}
```

Tool arguments:

- Linear create: `{ team_id: destination.id, title: body.title, description: renderMarkdown(body), priority }` with priority mapped from severity (critical 1, high 2, medium 3, low 4).
- Jira create: `{ project_key: destination.id, issue_type: "Bug", summary: body.title, description: renderMarkdown(body) }`. Composio converts markdown to Atlassian Document Format itself. When Jira rejects `Bug` the adapter retries once with `Task`.

Tool responses are read tolerantly, because Composio returns the tracker's own payload and its shape is not pinned by the SDK types.
The adapter searches the response for the first object carrying the fields it needs: teams are objects with a string `id` and `name` (key added to the label when present), projects are objects with a string `key` and `name`, a created Linear issue is the object with `identifier` (and `url` when present, otherwise `https://linear.app/issue/<identifier>`), a created Jira issue is the object with `key` (url `<site>/browse/<key>` when the response carries a `self` URL, otherwise the `self` URL itself).
A response with `successful: false` becomes a `TrackerError` carrying Composio's `error` text.

The SDK is constructed once with `COMPOSIO_API_KEY`, `allowTracking: false` and `toolkitVersions: "latest"`; every execute passes `dangerouslySkipVersionCheck: true` as the SDK requires for `latest`.
A missing `COMPOSIO_API_KEY` fails the connect route with a message naming the variable.

## Routes

- `GET /integrations` -> `{ integration: IntegrationPublic | null }`.
- `POST /integrations/connect { provider, return? }` -> `{ redirectUrl }`. Resolves the auth config, calls `startConnection` with the callback `${QA_PILOT_API_ORIGIN}/integrations/callback?return=<path>`, saves a `pending` record (replacing any previous connection after disconnecting it in Composio), and returns the OAuth URL for the browser to visit.
- `GET /integrations/callback?status=success|failed&return=<path>`. Composio sends the browser here after OAuth; the session cookie identifies the user. On `success` the route awaits the connection for up to 30 seconds, marks the record `active`, lists destinations, and stores the destination when there is exactly one. It then redirects to `${QA_PILOT_UI_ORIGIN}/settings` with `return` carried through, adding `error=<reason>` when Composio reported failure or the wait timed out; a failed connection's record is deleted.
- `GET /integrations/destinations` -> `{ destinations }` for an active connection, so Settings can offer a picker.
- `PUT /integrations/destination { id }` -> stores the destination whose id is in the current list; 400 otherwise.
- `DELETE /integrations` -> disconnects in Composio and deletes the record; 204.
- `GET /runs/:id/tickets` unchanged.
- `POST /runs/:id/tests/:test/ticket`: 412 with `needs: ["integration"]` unless the record is `active` with a destination; otherwise as before, with `createIssue` going through the adapter.

`QA_PILOT_API_ORIGIN` defaults to `http://localhost:4000`.
`return` is accepted only as a path starting with a single `/`.

## UI

**Settings, Integrations card.**
No connection: two buttons, "Connect Linear" and "Connect Jira", and a sentence saying the browser will go to the tracker to authorise and come back. Clicking one posts to connect and sets `window.location` to the returned URL.
Pending: the same buttons with a note that the last attempt did not finish.
Active without a destination: the provider name, a select of destinations ("Engineering (ENG)" or "Acme Shop (ACME)"), and a Save button.
Active with a destination: the label, the connection date, the destination, a Disconnect button, and when `?return=` is present a primary "Back to the copilot" link.
An `?error=` from the callback shows in the card's error line.

**Copilot result table.** Unchanged. The Connect link still goes to `/settings?return=<chat>`; "Raise in Linear" appears only for an active connection with a destination, which is what `GET /integrations` reports.

## Guards

- No credential ever reaches qa-pilot; the record holds an opaque Composio id.
- The callback route requires the session, so a stranger hitting it with a guessed URL sees a 401 and nothing changes.
- One connected account per user: connecting again deletes the previous one in Composio first.
- Tickets stay unique per user, run and test.
- A destination id is only accepted from the list the adapter returned.

## Testing

- Adapter with a fake `@composio/core` surface: auth config resolution (env, existing, created), link and callback status mapping, destination extraction from both a Linear-shaped and a Jira-shaped payload, issue creation arguments and key/url extraction for both providers, the `Task` retry, and `successful: false` becoming a `TrackerError`.
- Store contract: the new record shape round-trips including a missing destination.
- API with a fake `TrackerClient`: connect returns the URL and stores `pending`; callback with success activates and auto-picks a single destination; callback with two destinations leaves it unset; callback with `status=failed` deletes the record and redirects with an error; destinations and destination PUT including a bad id; DELETE calls disconnect; ticket POST is 412 while pending or without a destination and files through the adapter when active.
- UI: the card's four states and the error line.

## Files

- Create: `orchestrator/src/integrations/composio.ts`, `orchestrator/test/composio.test.ts`
- Delete: `orchestrator/src/integrations/crypto.ts`, `linear.ts`, `jira.ts` and their tests
- Modify: `orchestrator/src/integrations/index.ts`, `ticket.ts` (drop `renderAdf`), `orchestrator/src/store/types.ts`, `memory.ts`, `mongo.ts`, `orchestrator/src/api.ts`, `orchestrator/test/store.test.ts`, `integrations-api.test.ts`, `ownership.test.ts`
- Modify: `ui/lib/api.ts`, `ui/components/settings/IntegrationsCard.tsx`, `ui/app/(app)/settings/page.tsx`, `ui/test/integrations-card.test.tsx`
- Modify: `.env.example`, `README.md`, `ARCHITECTURE.md`

## Out of scope

Composio triggers or webhooks, syncing issue status back, more than one connection per user, and a custom OAuth app per tracker (Composio's managed apps are used).
