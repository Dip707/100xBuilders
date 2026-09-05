# Copilot design

Date: 2026-09-05.
Status: approved in brainstorming, awaiting implementation plan.

## Purpose

A chat that acts on finished runs.
Someone types a request such as "rerun the tests that failed last time, especially the checkout ones".
The copilot finds the run they mean, checks that the tests exist, reruns them without further input, and reports the outcome in the same chat.
It also answers read-only questions about a run from its stored results.

The copilot does not start new pipeline runs and does not heal.
Starting a run stays with the intake chat on the Start-a-run screen.

## Scope model

There is no project entity.
A copilot chat is scoped to a target URL, optionally narrowed to one run.

`scope: { url?: string; runId?: string }`

Resolution order for a turn:

1. A run id named in the message that the user owns.
2. The chat's `scope.runId`, when set.
3. The most recent run for `scope.url` owned by the user whose status is `done`, `partial`, `failed` or `interrupted`.
4. When the chat has no URL yet, the most recent such run the user owns, and the reply names it so the user can redirect.

A run that is `running` or `awaiting_review` is never selected for a rerun.

## Storage

Copilot chats reuse the `chats` collection with a discriminator.

```ts
type ChatKind = "intake" | "copilot";

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  at: string;
  data?: RerunPlanData | RerunResultData;
};

type RerunPlanData = { kind: "rerun_plan"; runId: string; testIds: string[]; blocked: { id: string; reason: string }[] };
type RerunResultData = { kind: "rerun_result"; runId: string; results: { id: string; title: string; status: string; error?: string; durationMs?: number }[] };

type ChatRecord = {
  id: string;
  userId: string;
  kind: ChatKind;            // absent on existing documents means "intake"
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  draft: RunDraft;           // intake only, {} for copilot
  scope?: { url?: string; runId?: string };  // copilot only
  pending?: { runId: string; testIds: string[] };  // a rerun decided but not yet executed
  runId?: string;            // intake only
};
```

`listChats` gains an optional `kind` filter so the copilot dropdown never shows intake chats and the intake dropdown never shows copilot chats.
Existing documents without `kind` are read as `intake`.
The message cap of 200 applies unchanged.

The title is the human-readable query.
On the first turn the model returns a three-to-five word title, the same way the intake chat does, and later turns never rename the chat.

Credentials are never stored on the chat, in `data`, or in any artifact.

## The turn

`POST /copilot/chats/:id/messages { text }`

1. Resolve the run as above.
   If none is found, the reply says so and asks for a URL or run id; nothing is executed.
2. Build the catalogue for that run from disk: `plan.json`, `results.json`, `defects.json`, `heal-log.json`, plus the classifications recorded in `decisions.jsonl`.
   One line per test: id, title, category, priority, preconditions, last status, error head, classifier verdict and confidence, heal outcome, defect id.
   Tests whose spec file is missing under `tests/` are marked `not generated` so the model does not pick them for a rerun.
3. One Claude call with the `copilot-turn` prompt at `effort: low`.
   Input: the catalogue, the run's id, URL, status and finish time, the last 12 messages, and a request for a title on the first turn.
   Output schema:

```ts
{
  reply: string;
  action: "rerun" | "answer" | "clarify";
  testIds: string[];      // rerun only
  title?: string;         // first turn only
}
```

4. Validate `testIds` against the catalogue.
   Ids that are not in the catalogue, or are marked `not generated`, are dropped.
   A rerun with no surviving ids is downgraded to `clarify`, and the reply is replaced by a server-written sentence that lists the run's actual failures so the model cannot claim a rerun it did not schedule.
5. Work out blockers per surviving id using the existing rerun blocker logic.
   A test that signs in is runnable when the run's login context is still in memory, or when the redacted login steps file exists and the request will carry credentials.
6. Store the user message and the assistant message in one write.
   For a rerun the assistant message carries `rerun_plan` data and the chat's `pending` is set.
7. Respond with `{ reply, action, plan?: RerunPlanData, needs: [] | ["credentials"], title? }`.

The model is told it never runs anything itself, never invents ids, and never repeats a credential.

## Execution

`POST /copilot/chats/:id/execute { credentials?: { username: string; password: string } }`

1. Refuse with 409 when the chat has no `pending`, when an execute for this chat is already in flight, or when the run is `running` or `awaiting_review`.
2. Build the login steps: the in-memory run context when present, otherwise the redacted `login-steps.json` with `{{username}}` and `{{password}}` substituted from the request.
   When the steps are needed and neither source is available, respond 409 with `needs: ["credentials"]`.
3. Call `rerunTests(runId, testIds, loginSteps)`, a generalisation of the existing single-test `rerunTest`, which runs one Playwright invocation for all selected specs, emits `test_start` and `test_result` on the run's bus, merges the fresh results into `results.json`, and updates the stored pass and fail counts.
4. Append an assistant message with `rerun_result` data and a plain-text summary of the form "3 of 4 passed. checkout-002 still fails: expected text 'Order placed' not found."
   Clear `pending`.
5. Respond with the same summary and data.

Credentials live in the request handler for the duration of the call and are not logged.

## Redacted login steps

At the end of every run, alongside `results.json`, the report node writes `login-steps.json`: the recorded login steps with the username value replaced by `{{username}}` and the password value replaced by `{{password}}`.
This is the same redaction the suite bundle already performs for `fixtures.ts`.
A run with no login writes an empty array.
The file contains field names and the login path, never a credential value.

## UI

A new screen at `/copilot`, with a Copilot entry in the sidebar under Setup and an "Ask copilot" action on the run header that opens `/copilot?run=<id>`.
Opening with `?run=` creates a chat scoped to that run's URL and id.

Layout follows the intake panel: chats dropdown, transcript, composer, and the masked credential inputs when a turn returns `needs: ["credentials"]`.
Suggestion chips on an empty chat: "Rerun everything that failed in the last run", "Why did the checkout tests fail?", "What is still blocked?".

A `rerun_plan` bubble lists the selected tests and any blocked ones with their reason.
While execute is in flight the screen subscribes to `/events/:runId` and moves each listed test from queued to running to passed or failed as `test_start` and `test_result` events arrive for those ids.
When execute returns, the stored `rerun_result` bubble renders a table: test, status, duration, error head, each row linking to `/runs/<id>/cases?test=<testId>`.
Reopening the chat renders the same table from the stored message.

Execute is called automatically the moment a rerun plan arrives with nothing needed, so the flow is one message in, results out.
When credentials are needed the inputs appear under the plan bubble and execute is called on submit.

## Guards

- Ownership: runs and chats resolve through the existing `ownedRun` and `ownedChat` helpers, so another user's ids read as not found.
- Busy run: `running` and `awaiting_review` runs are refused with 409 for reruns.
- Concurrency: one execute per chat at a time, and the existing per-test in-flight set prevents the same spec being run twice at once.
- Invented ids: dropped at the schema boundary before anything is scheduled.
- Credentials: excluded from the message schema, from the stored transcript and from the model's vocabulary, and only accepted on the execute call.

## Testing

- Unit: catalogue builder from a fixture output directory; id validation and the clarify downgrade; login-steps redaction and rehydration round trip.
- API with `FakeLlmClient`: rerun with valid ids, rerun with an invented id, answer turn, clarify turn, needs-credentials path, execute without pending, execute while in flight, foreign run id, busy run.
- Store: `kind` filter on `listChats`, legacy documents read as intake, `pending` set and cleared, message `data` round trip in both memory and Mongo stores.
- Runner: `rerunTests` merges several fresh results into `results.json` and updates counts, injected so the test does not spawn Playwright.
- Graph integration test: asserts `login-steps.json` exists and contains no credential value.
- UI: deriving the per-test live status list from a `rerun_plan` and a stream of events; the result table renders from stored data.

## Files

- `orchestrator/src/copilot/catalogue.ts`, `turn.ts`, `execute.ts`, `login-steps.ts`
- `orchestrator/src/llm/prompts/copilot-turn.md`
- `orchestrator/src/store/types.ts`, `memory.ts`, `mongo.ts`
- `orchestrator/src/api.ts` for the two routes
- `orchestrator/src/run.ts` for `rerunTests`
- `orchestrator/src/nodes/report.ts` for writing `login-steps.json`
- `ui/app/(app)/copilot/page.tsx`, `ui/components/copilot/*`, `ui/lib/api.ts`, `ui/components/shell/Sidebar.tsx`, `ui/components/run/RunHeader.tsx`
- `README.md` and `ARCHITECTURE.md` sections for the copilot

## Out of scope

Starting new runs from the copilot, healing from the copilot, a project entity, cross-user sharing of chats, and streaming the model's reply token by token.
