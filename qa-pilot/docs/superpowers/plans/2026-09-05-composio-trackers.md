# Composio Trackers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the API-key Linear and Jira clients with Composio OAuth connections, keeping the copilot's defect ticket flow intact.

**Architecture:** A `TrackerClient` adapter over `@composio/core` handles auth configs, OAuth links, destination listing and issue creation. The integration record stores Composio's connected account id and a chosen destination instead of a sealed credential. Settings drives connect, callback, destination pick and disconnect.

**Tech Stack:** `@composio/core` 0.18.1, Hono, zod, MongoDB driver, Next.js, vitest.

**Spec:** `docs/superpowers/specs/2026-09-05-composio-trackers-design.md`

## Global Constraints

- No em dashes; plain dashes only.
- Commit messages never add an agent co-author.
- No credential is ever stored or returned; the record holds only Composio's connected account id.
- Copy: "Connect Linear", "Connect Jira", "Back to the copilot", "Raise in Linear", "Raise in Jira".
- Run orchestrator tests with `npx vitest run <file>` from `qa-pilot/orchestrator`, UI tests from `qa-pilot/ui`.
- Stage files by name; another session may be editing the tree.

---

### Task 1: Store record

**Files:** `orchestrator/src/store/types.ts`, `memory.ts`, `mongo.ts`, `orchestrator/test/store.test.ts`

- [ ] Replace `IntegrationRecord` with `{ userId, provider, connectedAccountId, status: "pending" | "active", destination?: { id, label }, connectedAt }`.
- [ ] Update the contract test: save pending, replace with active plus destination, read back a record without a destination as `undefined` not `null`, delete.
- [ ] Run `npx vitest run test/store.test.ts`, `npx tsc --noEmit`; commit `qa-pilot: integration record holds the Composio account`.

### Task 2: Adapter

**Files:** create `orchestrator/src/integrations/composio.ts`, `orchestrator/test/composio.test.ts`; delete `crypto.ts`, `linear.ts`, `jira.ts` and their tests; modify `integrations/index.ts`, `ticket.ts`.

- [ ] Test the adapter against a fake SDK object `{ authConfigs: { list, create }, connectedAccounts: { link, waitForConnection, delete }, tools: { execute } }` for: env override; existing config reuse; managed config creation with `type: "use_composio_managed_auth"`; `startConnection` passing `callbackUrl`; `awaitConnection` mapping a thrown `ConnectionRequestFailedError`-like error to `failed` and a timeout error to `timeout`; destinations from `{ teams: { nodes: [{ id, key, name }] } }` and from `{ values: [{ key, name }] }`; Linear create arguments and `{ identifier, url }` extraction; Jira create arguments, `Bug` then `Task` retry, and `<site>/browse/<key>` from `self`; `successful: false` -> `TrackerError`.
- [ ] Implement with `findFirst(value, predicate)` walking objects and arrays depth-first.
- [ ] `index.ts` exports `TrackerClient`, `Destination`, `IntegrationPublic`, `publicShape(rec)` and `liveTrackerClient()` (lazy, throws naming `COMPOSIO_API_KEY`).
- [ ] Remove `renderAdf` and its test block.
- [ ] Run the integration tests and `npx tsc --noEmit`; commit `qa-pilot: Composio tracker adapter`.

### Task 3: Routes

**Files:** `orchestrator/src/api.ts`, `orchestrator/test/integrations-api.test.ts`, `orchestrator/test/ownership.test.ts`

- [ ] Rewrite the API test with a fake `TrackerClient` recording calls: connect (stores pending, returns url, disconnects a previous account first); callback success with one destination (active, destination set, 302 to `<ui>/settings?return=...`); callback success with two destinations (active, no destination); callback `status=failed` (record deleted, redirect carries `error`); callback without a session is 401; destinations list; destination PUT good and bad id; DELETE calls disconnect; ticket POST 412 while pending, 412 without destination, files when active and stores the ticket; provider failure 502.
- [ ] Implement; `createApi` takes `trackers?: TrackerClient`; add `app.use("/integrations/*", requireUser(store))`.
- [ ] Run the orchestrator suite; commit `qa-pilot: OAuth connect, callback and destination routes`.

### Task 4: UI

**Files:** `ui/lib/api.ts`, `ui/components/settings/IntegrationsCard.tsx`, `ui/app/(app)/settings/page.tsx`, `ui/test/integrations-card.test.tsx`

- [ ] Client: `IntegrationPublic` gains `status` and `destination`; add `startConnect(provider, return?)`, `listDestinations()`, `setDestination(id)`; drop `connectIntegration`.
- [ ] Card tests: disconnected shows both Connect buttons; pending shows the unfinished note; active without destination shows a select and Save; active with destination shows label, destination, Disconnect and, with `returnTo`, "Back to the copilot"; `error` prop renders in the error line.
- [ ] Implement; the page reads `?return=` and `?error=`, calls `startConnect` and assigns `window.location.href`.
- [ ] `npx tsc --noEmit -p .`, `npx eslint`, `npx vitest run`; commit `qa-pilot: settings connect through Composio`.

### Task 5: Docs and verification

- [ ] `.env.example`: replace `QA_PILOT_SECRET` with `COMPOSIO_API_KEY`, optional `COMPOSIO_LINEAR_AUTH_CONFIG_ID`, `COMPOSIO_JIRA_AUTH_CONFIG_ID`, `QA_PILOT_API_ORIGIN`.
- [ ] README and ARCHITECTURE: describe the OAuth flow and the adapter.
- [ ] Restart the API; in the browser confirm Settings shows the two Connect buttons and the copilot row still shows "Connect Linear or Jira"; with a valid Composio key, click Connect Linear and confirm the redirect leaves for Composio.
- [ ] Commit `qa-pilot: document Composio trackers`.
