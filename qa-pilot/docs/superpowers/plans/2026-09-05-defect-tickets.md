# Defect Tickets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A still-failing rerun row that the classifier called an app defect gets a call to action that files a Linear or Jira issue, with the tracker connected on a new Settings page.

**Architecture:** The store gains `integrations` (one encrypted tracker config per user) and `tickets` (one per run and test). A provider-agnostic ticket body is built from the run's defect record and rendered to markdown for Linear or ADF for Jira. The rerun result stored on the chat carries each test's original verdict so the transcript can gate the CTA from stored data.

**Tech Stack:** Hono, zod, MongoDB driver, Node `crypto`, global `fetch`, Next.js app router, vitest.

**Spec:** `docs/superpowers/specs/2026-09-05-defect-tickets-design.md`

## Global Constraints

- No em dashes anywhere in code, copy or docs; use a plain dash.
- Commit messages never add an agent co-author.
- Secrets never appear in responses, chat messages, logs or tests' fixtures beyond obvious fakes.
- `QA_PILOT_SECRET` is required to save or read an integration; the error names the variable.
- Every store method is implemented in both `memory.ts` and `mongo.ts` and covered by `store.test.ts`.
- Copy: "Connect Linear or Jira", "Raise in Linear", "Raise in Jira", "Classifier: <verdict>, not filed as a defect".
- Run tests from `qa-pilot/orchestrator` with `npx vitest run <file>` and from `qa-pilot/ui` with `npx vitest run <file>`.
- Check `git status` before each commit and stage files by name; another session may be editing this tree.

---

### Task 1: Store records and methods

**Files:**
- Modify: `orchestrator/src/store/types.ts`
- Modify: `orchestrator/src/store/memory.ts`
- Modify: `orchestrator/src/store/mongo.ts`
- Test: `orchestrator/test/store.test.ts`

**Interfaces:**
- Produces: `TrackerProvider`, `IntegrationRecord`, `TicketRecord`, `TicketTakenError`, and `Store.saveIntegration / getIntegration / deleteIntegration / insertTicket / findTicket / listTickets`.

- [ ] **Step 1: Add the failing contract tests** to the `describe.each` block in `orchestrator/test/store.test.ts`:

```ts
  it("saves one integration per user, replaces it, never leaks it to another user, and deletes it", async () => {
    await store.saveIntegration({ userId: "u1", provider: "linear", label: "Linear · Eng", secret: "c1", connectedAt: "2026-09-05T10:00:00.000Z" });
    expect(await store.getIntegration("u1")).toMatchObject({ provider: "linear", secret: "c1" });
    expect(await store.getIntegration("u2")).toBeNull();
    await store.saveIntegration({ userId: "u1", provider: "jira", label: "Jira · ACME", secret: "c2", connectedAt: "2026-09-05T11:00:00.000Z" });
    expect(await store.getIntegration("u1")).toMatchObject({ provider: "jira", secret: "c2" });
    await store.deleteIntegration("u1");
    expect(await store.getIntegration("u1")).toBeNull();
  });

  it("stores one ticket per run and test, lists a run's tickets, and rejects a duplicate", async () => {
    const t = { id: "t1", userId: "u1", runId: "run-1", testId: "checkout-001", provider: "linear" as const, key: "ENG-1", url: "https://linear.app/x/ENG-1", createdAt: "2026-09-05T10:00:00.000Z" };
    await store.insertTicket(t);
    expect(await store.findTicket("u1", "run-1", "checkout-001")).toEqual(t);
    expect(await store.findTicket("u2", "run-1", "checkout-001")).toBeNull();
    await store.insertTicket({ ...t, id: "t2", testId: "checkout-002", key: "ENG-2" });
    expect((await store.listTickets("u1", "run-1")).map((x) => x.key)).toEqual(["ENG-1", "ENG-2"]);
    await expect(store.insertTicket({ ...t, id: "t3" })).rejects.toBeInstanceOf(TicketTakenError);
  });
```

Add `TicketTakenError` to the import from `../src/store/types.js`.

- [ ] **Step 2: Run** `npx vitest run test/store.test.ts` and confirm both fail on missing methods.

- [ ] **Step 3: Add the types** to `orchestrator/src/store/types.ts` (after `RunRecord`):

```ts
export type TrackerProvider = "linear" | "jira";

/** One tracker connection per user. `secret` is the AES-256-GCM ciphertext of the provider config; the store never sees plaintext. */
export type IntegrationRecord = { userId: string; provider: TrackerProvider; label: string; secret: string; connectedAt: string };

/** An issue filed in a tracker for one test of one run. */
export type TicketRecord = {
  id: string; userId: string; runId: string; testId: string;
  provider: TrackerProvider; key: string; url: string; createdAt: string;
};

/** Thrown by `insertTicket` when this run and test already have a ticket for this user. */
export class TicketTakenError extends Error {
  constructor(runId: string, testId: string) {
    super(`a ticket already exists for ${testId} in run ${runId}`);
    this.name = "TicketTakenError";
  }
}
```

And to the `Store` interface before `close()`:

```ts
  saveIntegration(rec: IntegrationRecord): Promise<void>;
  getIntegration(userId: string): Promise<IntegrationRecord | null>;
  deleteIntegration(userId: string): Promise<void>;

  insertTicket(rec: TicketRecord): Promise<void>;
  findTicket(userId: string, runId: string, testId: string): Promise<TicketRecord | null>;
  listTickets(userId: string, runId: string): Promise<TicketRecord[]>;
```

- [ ] **Step 4: Memory implementation** in `memory.ts`: two Maps, `integrations` keyed by userId and `tickets` keyed by `${userId}/${runId}/${testId}`; `listTickets` sorts by `createdAt`.

- [ ] **Step 5: Mongo implementation** in `mongo.ts`: `IntegrationDoc = Omit<IntegrationRecord, "userId"> & { _id: string }` in collection `integrations`; `TicketDoc = Omit<TicketRecord, "id"> & { _id: string }` in `tickets` with index `{ userId: 1, runId: 1, testId: 1 }` unique named `ticket_per_test`; duplicate key becomes `TicketTakenError`.

- [ ] **Step 6: Run** `npx vitest run test/store.test.ts` and `npx tsc --noEmit`. Expect pass.

- [ ] **Step 7: Commit** `qa-pilot: store integrations and tickets`.

---

### Task 2: Config encryption

**Files:**
- Create: `orchestrator/src/integrations/crypto.ts`
- Test: `orchestrator/test/integrations-crypto.test.ts`

**Interfaces:**
- Produces: `seal(obj: unknown, secret?: string): string`, `open<T>(ciphertext: string, secret?: string): T`, `MISSING_SECRET` message. `secret` defaults to `process.env.QA_PILOT_SECRET`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { seal, open } from "../src/integrations/crypto.js";

describe("integration crypto", () => {
  it("round-trips a config and never stores it in the clear", () => {
    const sealed = seal({ apiKey: "lin_api_secret", teamId: "t1" }, "passphrase");
    expect(sealed).not.toContain("lin_api_secret");
    expect(open(sealed, "passphrase")).toEqual({ apiKey: "lin_api_secret", teamId: "t1" });
  });
  it("produces a different ciphertext each time and rejects the wrong key", () => {
    expect(seal({ a: 1 }, "k")).not.toBe(seal({ a: 1 }, "k"));
    expect(() => open(seal({ a: 1 }, "k"), "other")).toThrow();
  });
  it("names QA_PILOT_SECRET when no secret is configured", () => {
    const prev = process.env.QA_PILOT_SECRET;
    delete process.env.QA_PILOT_SECRET;
    try { expect(() => seal({ a: 1 })).toThrow(/QA_PILOT_SECRET/); } finally { if (prev !== undefined) process.env.QA_PILOT_SECRET = prev; }
  });
});
```

- [ ] **Step 2: Implement** with `createCipheriv("aes-256-gcm")`, key `sha256(secret)`, 12-byte random IV, output `base64(iv | tag | ciphertext)` prefixed `v1.`.

- [ ] **Step 3: Run test, then commit** `qa-pilot: encrypt tracker configs at rest`.

---

### Task 3: Ticket body and renderers

**Files:**
- Create: `orchestrator/src/integrations/ticket.ts`
- Test: `orchestrator/test/ticket-body.test.ts`

**Interfaces:**
- Produces:

```ts
export type TicketSection = { heading: string; lines?: string[]; bullets?: string[] };
export type TicketBody = { title: string; severity: Defect["severity"]; sections: TicketSection[] };
export function buildTicket(args: { run: RunRecord; testId: string; catalogue: Catalogue; defect?: Defect; flow?: Flow; latest?: { error?: string; at: string }; uiOrigin: string }): TicketBody;
export function renderMarkdown(body: TicketBody): string;
export function renderAdf(body: TicketBody): AdfDoc;
```

- [ ] **Step 1: Failing tests**: from a defect record the title is `[qa-pilot] <defect title>`, sections include repro steps, expected, actual, evidence, the verdict line "Classifier verdict: defect (0.90)", the case link `<uiOrigin>/runs/<runId>/cases?test=<testId>`, and the latest rerun error; from a bare flow and result (no defect) the title is `[qa-pilot] <flow title> still fails` with severity from priority; `renderMarkdown` produces `## ` headings and `- ` bullets; `renderAdf` produces `{ type: "doc", version: 1, content: [...] }` with `heading`, `paragraph` and `bulletList` nodes and no empty text nodes.

- [ ] **Step 2: Implement.** Severity from priority: P0 critical, P1 high, otherwise medium. Sections in order: Summary (target, run, test, severity, verdict), Steps to reproduce (bullets), Expected, Actual, Evidence (bullets), Latest rerun (error head 300 chars and time), Links (case page URL).

- [ ] **Step 3: Run tests, commit** `qa-pilot: build tracker ticket bodies`.

---

### Task 4: Linear client

**Files:**
- Create: `orchestrator/src/integrations/linear.ts`
- Test: `orchestrator/test/linear.test.ts`

**Interfaces:**
- Produces:

```ts
export type LinearConfig = { apiKey: string; teamId: string; teamKey: string; teamName: string };
export type Fetch = typeof fetch;
export class TrackerError extends Error { constructor(message: string, public status = 400) }
export async function verifyLinear(input: { apiKey: string; teamKey?: string }, fetchFn?: Fetch): Promise<{ config: LinearConfig; label: string }>;
export async function createLinearIssue(config: LinearConfig, body: TicketBody, fetchFn?: Fetch): Promise<{ key: string; url: string }>;
```

`TrackerError` lives in `orchestrator/src/integrations/errors.ts` (created here) so Jira reuses it.

- [ ] **Step 1: Failing tests** with a fake fetch that records the request and answers canned GraphQL JSON: single team resolves without `teamKey`; two teams and no key throws `TrackerError` listing "ENG, OPS"; a matching key picks that team; an `errors` array throws with its message; `createLinearIssue` posts `issueCreate` with `teamId`, title, markdown description, priority 1 for critical, and returns `{ key: "ENG-42", url }`; the request carries `Authorization: <apiKey>`.

- [ ] **Step 2: Implement** against `https://api.linear.app/graphql`.

- [ ] **Step 3: Run tests, commit** `qa-pilot: Linear tracker client`.

---

### Task 5: Jira client

**Files:**
- Create: `orchestrator/src/integrations/jira.ts`
- Test: `orchestrator/test/jira.test.ts`

**Interfaces:**
- Produces:

```ts
export type JiraConfig = { baseUrl: string; email: string; apiToken: string; projectKey: string; projectName: string; issueType: string };
export async function verifyJira(input: { baseUrl: string; email: string; apiToken: string; projectKey: string }, fetchFn?: Fetch): Promise<{ config: JiraConfig; label: string }>;
export async function createJiraIssue(config: JiraConfig, body: TicketBody, fetchFn?: Fetch): Promise<{ key: string; url: string }>;
```

- [ ] **Step 1: Failing tests**: verify normalises a trailing slash off `baseUrl`, sends basic auth of `email:apiToken`, picks `Bug` when present else the first non-subtask type, throws `TrackerError` on 401 ("Jira rejected the email or API token") and on 404 ("project X not found"); create posts to `/rest/api/3/issue` with `fields.project.key`, `fields.issuetype.name`, `summary`, ADF `description`, returns `{ key: "ACME-7", url: "<base>/browse/ACME-7" }`, and surfaces `errorMessages` and `errors` values on a 400.

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Run tests, commit** `qa-pilot: Jira tracker client`.

---

### Task 6: Verdicts on rerun results

**Files:**
- Modify: `orchestrator/src/store/types.ts` (`RerunResultData.results[]` gains `verdict?: { class: string; confidence: number }` and `defectId?: string`)
- Modify: `orchestrator/src/copilot/execute.ts` (`resultData(runId, results, catalogue)`, `summariseRerun(results, requested, catalogue)`)
- Modify: `orchestrator/src/api.ts` execute route (build the catalogue and pass it)
- Modify: `ui/lib/api.ts` (same type)
- Test: `orchestrator/test/copilot-execute.test.ts`

- [ ] **Step 1: Failing tests**: `resultData` copies `verdict` and `defectId` from the catalogue entry for each result; `summariseRerun` writes "checkout-001 still fails and the classifier calls it an app defect: Error: still 500" for a `defect` verdict and the plain form otherwise.

- [ ] **Step 2: Implement, run** `npx vitest run test/copilot-execute.test.ts test/copilot-api.test.ts`, commit `qa-pilot: carry the classifier verdict on rerun results`.

---

### Task 7: API routes

**Files:**
- Create: `orchestrator/src/integrations/index.ts` (`Trackers` facade: `verify(provider, input)`, `createIssue(integration, body)`, `publicShape(rec)`)
- Modify: `orchestrator/src/api.ts`
- Test: `orchestrator/test/integrations-api.test.ts`

**Interfaces:**
- `createApi` gains `trackers?: Trackers` for injection.
- Routes: `GET /integrations`, `PUT /integrations`, `DELETE /integrations`, `GET /runs/:runId/tickets`, `POST /runs/:runId/tests/:testId/ticket`.

- [ ] **Step 1: Failing tests** (pattern from `copilot-api.test.ts`, `QA_PILOT_SECRET` set in `beforeEach`, seeded run with `plan.json`, `results.json`, `defects.json` and an `events.jsonl` defect classification for `checkout-001`):
  - GET with nothing connected returns `{ integration: null }`.
  - PUT linear with a fake `verify` stores and returns `{ provider, label, connectedAt }` and never `apiKey`; GET afterwards shows the same and the stored `secret` does not contain the key.
  - PUT with a failing verifier answers 400 with its message.
  - DELETE answers 204 and GET is null again.
  - POST ticket with nothing connected answers 412 with `needs: ["integration"]`.
  - POST ticket on another user's run answers 404; on an unknown test 404.
  - POST ticket creates once (fake `createIssue` returns `ENG-9`), the response `ticket.key` is `ENG-9`, and a second POST returns 200 with the same ticket and `createIssue` called once.
  - Provider failure on create answers 502 with the message and stores nothing.
  - GET tickets lists the run's tickets.

- [ ] **Step 2: Implement** the facade and routes. The ticket route: `ownedRun`, catalogue, flow lookup (404), integration (412), existing ticket (200), in-flight set `filing`, `open` config, `buildTicket`, `createIssue`, `insertTicket`, respond `{ ticket }`.

- [ ] **Step 3: Run** the new test and the whole orchestrator suite, `npx tsc --noEmit`, commit `qa-pilot: tracker integration and ticket routes`.

---

### Task 8: UI client and result table CTA

**Files:**
- Modify: `ui/lib/api.ts` (`IntegrationPublic`, `TicketRecord`, `getIntegration`, `connectIntegration`, `disconnectIntegration`, `listTickets`, `raiseTicket`)
- Modify: `ui/components/copilot/RerunResultTable.tsx`
- Test: `ui/test/copilot-result.test.tsx`

**Interfaces:**
- `RerunResultTable({ result, integration, tickets, onRaise, filing })` where `integration: IntegrationPublic | null | undefined` (undefined while loading), `tickets: Record<string, TicketRecord>`, `onRaise(testId) => void`, `filing: string | null`.

- [ ] **Step 1: Failing tests** for the states: passed row shows nothing extra; failed row with `env` verdict shows "Classifier: environment error, not filed as a defect" and no button; failed `defect` row with `integration === null` shows a link "Connect Linear or Jira" to `/settings?return=%2Fcopilot`; with a Linear integration shows a button "Raise in Linear"; with a ticket shows a link with the key and `target="_blank"`; while `filing === testId` shows the spinner.

- [ ] **Step 2: Implement.** Verdict words: defect "app defect", env "environment error", script "script bug", flaky "flaky test", needs_human "needs a human". Keep the existing columns; the CTA renders in a fourth cell.

- [ ] **Step 3: Run** `npx vitest run test/copilot-result.test.tsx`, commit `qa-pilot: ticket call to action on rerun results`.

---

### Task 9: Copilot page wiring

**Files:**
- Modify: `ui/app/(app)/copilot/page.tsx`
- Modify: `ui/components/copilot/CopilotTranscript.tsx`

- [ ] **Step 1:** Load the integration once on mount. Track `tickets` per run: whenever the messages contain a `rerun_result` whose `runId` is not yet loaded, fetch `listTickets(runId)`. `raise(runId, testId)` sets `filing`, calls `raiseTicket`, merges the ticket, clears `filing`, surfaces errors in the alert strip.

- [ ] **Step 2:** Thread `integration`, `tickets`, `filing` and `onRaise` through `CopilotTranscript` to the table.

- [ ] **Step 3:** `npx tsc --noEmit -p ui` (or `npx next lint`), commit `qa-pilot: file tickets from the copilot`.

---

### Task 10: Settings page

**Files:**
- Create: `ui/app/(app)/settings/page.tsx`
- Create: `ui/components/settings/IntegrationsCard.tsx`
- Modify: `ui/components/shell/UserMenu.tsx` (a "Settings" item above Log out)
- Test: `ui/test/integrations-card.test.tsx`

- [ ] **Step 1: Failing tests:** disconnected renders the Linear fields (API key, team key) by default and Jira's (site URL, email, API token, project key) when switched; connected renders the label, the date and a Disconnect button.

- [ ] **Step 2: Implement.** `PageHeader` with crumbs Runs > Settings. Card "Integrations". On connect: `connectIntegration(...)`, then `router.push(return)` when `?return=` is a same-origin path starting with `/`.

- [ ] **Step 3: Run the test, commit** `qa-pilot: settings page with tracker connection`.

---

### Task 11: Docs and end-to-end check

**Files:**
- Modify: `.env.example` (`QA_PILOT_SECRET=change-me`), `README.md`, `ARCHITECTURE.md`

- [ ] **Step 1:** Document the variable, the Settings page, the copilot CTA and the verdict gating.
- [ ] **Step 2:** Start the API and UI, open the copilot with a run whose failing test is classified `defect`, confirm the CTA states in the browser pane, connect a tracker with a fake or real key, file, and see the link.
- [ ] **Step 3:** Run the whole suite, commit `qa-pilot: document tracker integrations`.
