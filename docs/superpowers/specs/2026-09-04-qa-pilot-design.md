# qa-pilot design

Date: 2026-09-04
Status: approved design, pre-implementation
Source: PRD "Autonomous Test Orchestration Agent" (Bessemer Tech Catalyst, AI/ML track)

## 1. Summary

qa-pilot takes a web app URL and, with no human step in between, explores the app, writes a test plan, scores the plan for coverage gaps, generates Playwright tests, runs them, repairs broken scripts, flags real defects, and produces a report.
The orchestrator is a LangGraph.js state machine whose branch decisions are streamed live to a UI.

## 2. Decisions taken during brainstorming

| Topic             | Decision                                                      | Reason                                                                                                                                    |
| ----------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| PlStack           | TypeScript end to end                                         | Removes the Python to MCP to Node boundary from the hot browser loop; one language, one repo                                              |
| Code vs LLM split | Hybrid                                                        | Deterministic crawler and templated codegen; LLM only for planning, coverage judgement, classification rationale, and heal element choice |
| Default model     | `claude-opus-5`, configurable via `QA_PILOT_MODEL`            | Best first-run pass rate on generated tests                                                                                               |
| API key           | `.env` file, gitignored, with `.env.example` shipped          |                                                                                                                                           |
| Location          | `qa-pilot/` subfolder of the shared repo                      | Keeps the shared repo root clean                                                                                                          |
| Demo target       | Purpose-built mini shop in `targets/mini-shop`                | Deterministic, boots in one second, bugs toggled on cue                                                                                   |
| Browser view      | Headed Chromium on screen plus screenshot thumbnails over SSE | Matches PRD 9.3                                                                                                                           |

Non-goals are unchanged from the PRD: no CI integration, no fixing of application source, no hand-written tests, no cross-browser matrix.

## 3. Repository layout

```
qa-pilot/
  package.json            npm workspaces root; scripts: dev, test, demo
  .env.example
  orchestrator/           package @qa-pilot/orchestrator
    src/
      state.ts            zod schemas and LangGraph annotation for RunState
      graph.ts            nodes wired with conditional edges, SQLite checkpointer
      nodes/
        explore.ts plan.ts coverage.ts generate.ts run.ts classify.ts heal.ts report.ts
      browser/
        toolkit.ts        Playwright wrapper: snapshot, resolve, act, screenshot
        locators.ts       role/name resolution and preference chain
      llm/
        client.ts         Anthropic SDK wrapper with structured output and retry
        prompts/*.md      one prompt file per LLM call
      events.ts           typed event bus: disk + SSE fan-out
      budget.ts           LLM call and wall-clock budget
      api.ts              Hono server: POST /run, GET /events/:id, GET /report/:id
      cli.ts              qa-pilot run <url> [--intent] [--prd] [--credentials]
    test/                 vitest unit and integration tests
  runner/                 package @qa-pilot/runner
    playwright.config.ts  testDir from QA_PILOT_TEST_DIR, baseURL from QA_PILOT_BASE_URL
    fixtures.ts           login fixture, network/console/pageerror capture
  ui/                     Next.js 15 + Tailwind, single page
  targets/mini-shop/      Express demo app with chaos toggles
  output/<run_id>/        run artifacts, gitignored
  README.md ARCHITECTURE.md
```

## 4. State schema

All state types are zod schemas in `state.ts`.
The LangGraph annotation uses the same schemas.

```ts
RunState {
  runId, url, credentials?, intent?, prdText?, maxFlows (12), budget {maxLlmCalls (200), maxMinutes (40)}
  siteMap: SiteMap
  plan: Flow[]
  coverage: CoverageVerdict
  planIterations: number
  testFiles: string[]
  results: RunResults
  classifications: Classification[]
  healAttempts: Record<testId, number>
  rerunAttempts: Record<testId, number>
  defects: Defect[]
  decisions: Decision[]
  budgetUsed: {llmCalls, minutes}
  partial: boolean
}
```

`SiteMap` holds pages keyed by path.
Each page records title, forms (fields with role, label, name, type), buttons (role, name), links (href, text), and `gated: boolean`.
It also records the login fixture steps when credentials were supplied.

`Flow`, `CoverageVerdict`, `Classification`, and `Defect` follow the JSON shapes in PRD sections 8.1, 8.2, 8.5, and 8.7 exactly.
`Decision` is `{node, reason, evidence: string[], next, at}`

## 5. Graph

Nodes: `explore -> plan -> evaluate_coverage -> generate -> run -> classify -> heal -> report`.

Conditional edges match PRD section 7 verbatim:

| After             | Condition                            | Next                       |
| ----------------- | ------------------------------------ | -------------------------- |
| evaluate_coverage | score >= 0.75 or planIterations >= 3 | generate                   |
| evaluate_coverage | score < 0.75                         | plan, with gaps injected   |
| classify          | any `script` with healAttempts < 2   | heal                       |
| classify          | any `flaky` with rerunAttempts < 2   | run, only those tests      |
| classify          | otherwise                            | report                     |
| heal              | healed tests exist                   | run, only healed tests     |
| any               | budget exceeded                      | report with partial = true |

Every edge function appends a `Decision` to state and emits it on the event bus.
`generate` fans out one `generateFlow` invocation per flow using `Send()` and joins on `testFiles`.
The checkpointer is `@langchain/langgraph-checkpoint-sqlite` at `output/<run_id>/checkpoint.db`.

## 6. Node specifications

### 6.1 explore (no LLM)

1. Open a headed Chromium context (headless when `QA_PILOT_HEADLESS=1`).
2. If credentials are given, attempt login using heuristics: find the first form containing a password field, fill username and password by label, submit, and record the exact steps as the login fixture.
3. BFS within the same origin, depth 3, max 30 pages, from the base URL.
4. Per page, take an aria snapshot and record forms, buttons, and links.
5. Never click buttons whose accessible name matches the blocklist: delete, remove, logout, log out, sign out, destroy, clear.
6. Gating: revisit every discovered path in a fresh unauthenticated context; a page is `gated` when the final URL differs and matches the login page path.
7. Emit `siteMap` and a screenshot per page.

### 6.2 plan (one structured LLM call plus dry walk)

Input: site map, intent, PRD text, max flows, and gaps from the previous coverage verdict.
Output: `Flow[]` validated by zod.
Prompt rules: at least one negative and one edge flow per form; one authz flow per gated route; steps reference only elements present in the site map; every flow has at least one expectation.
Dry walk: each flow is executed through the toolkit.
A step that cannot be resolved marks the flow unresolved.
Unresolved flows get one repair LLM call with the failing step and the live snapshot.
Still-unresolved flows are dropped and recorded as a decision.

### 6.3 evaluate_coverage (rules plus one LLM call)

Checks and weights:

| Check                                                  | Weight                                     |
| ------------------------------------------------------ | ------------------------------------------ |
| Every form has happy, negative, and empty-submit flows | 0.30                                       |
| Every gated route has an unauthenticated-access flow   | 0.20                                       |
| Every PRD requirement maps to at least one flow        | 0.20 (skipped and re-weighted when no PRD) |
| Intent keywords appear in at least one flow title      | 0.10 (skipped when no intent)              |
| negative + edge + error_state flows >= 40% of flows    | 0.20                                       |

Score is the weighted average of per-check pass rates.
PRD requirements are extracted once by an LLM structured-output call and cached in state.
Requirement-to-flow mapping is a second LLM call that returns a matrix.
Gaps are emitted in the PRD 8.2 shape and injected into the next plan prompt.

### 6.4 generate (templated, LLM only for self-repair)

Per flow:

1. Open the browser at the base URL and run preconditions via the login fixture when `logged_in` is required.
2. For each step, resolve `{role, name}` to a live locator using the chain getByRole, getByLabel, getByText, data-testid, CSS.
   Execute the step live.
   An unresolvable step aborts the flow and returns it to the orchestrator as unresolved.
3. For each expectation, verify it live, then emit the matching `expect()`.
4. Render the spec file from a template with a header comment `// flow: <id> | category: <c> | source: <s>`.
5. Run `npx playwright test <file>` once.
   On failure, one LLM self-repair call receives the file, error, and snapshot, and may change step lines only.
6. Write the file to `output/<run_id>/tests/<flow-id>.spec.ts`.

Emitted code uses only role and label locators unless the chain fell through, and every flow has at least one outcome assertion.

### 6.5 run (subprocess)

Command: `npx playwright test --config runner/playwright.config.ts --reporter=json --trace=retain-on-failure --workers=4 [files]`.
`fixtures.ts` extends `test` with a `page` fixture that attaches `response.status() >= 400`, `console.error`, and `pageerror` entries as annotations, and exposes a `login` fixture built from the recorded login steps.
The JSON report plus annotations is parsed into `RunResults` with per-test status, error message, failing step index, network entries, console entries, and trace path.

### 6.6 classify (rules plus LLM rationale)

For each failed test, evidence is gathered: parsed error, a snapshot taken by replaying to the failing step, network and console entries from the failing step window, and the status of the happy-path test for the same flow (the control test).
Signal weights are applied exactly as PRD 8.5.
Class is the highest-weighted label; confidence is that label's total clamped to 1.
Thresholds: >= 0.8 act; 0.5 to 0.8 rerun and run the control test, then act; < 0.5 label `needs_human` with an explanation.
An LLM call writes the rationale and evidence list.
It may not change the class and may adjust confidence by at most 0.1.

### 6.7 heal (LLM chooses element, code enforces the rule)

1. Read the failing step and its intent from the flow.
2. Replay to that step live and snapshot.
3. Ask the LLM, with structured output, for a replacement locator that accomplishes the intent.
4. Execute it live and verify the flow's expectations still hold.
5. Patch only the failing step line.
6. Guard: every line containing `expect(` must be byte-identical before and after the patch.
   If not, the heal is rejected, the test is reclassified as `defect`, and a decision is recorded.
7. Append `{test, before, after, reason, confidence}` to `heal-log.json`.
8. Max 2 attempts per test.

### 6.8 report

`report.md` contains: summary numbers, flows by category, pass/fail table, heals with diffs, defects with repro steps and evidence and trace links, coverage gaps remaining, untested risk, PRD gap matrix when a PRD was given, and the decision timeline.
`report.html` is rendered from the markdown with a small inline stylesheet.
`defects.json` entries carry title, severity, repro steps, expected, actual, evidence, and attachments.

## 7. LLM client

`llm/client.ts` wraps `@anthropic-ai/sdk`.
Every call uses `claude-opus-5` by default, adaptive thinking, streaming with `finalMessage()`, structured outputs via `output_config.format` from a zod schema, and server-side fallbacks enabled.
Schema validation failure retries once with the validation error appended.
Each call increments `budgetUsed.llmCalls` and logs a summary to the event bus.
The client is behind an interface so tests can substitute a fake that returns canned responses keyed by prompt name.

## 8. Events and API

`events.ts` defines the union `RunEvent = node_start | node_end | decision | agent_log | screenshot | test_result | error | done`.
The bus appends every event to `output/<run_id>/events.jsonl` and decisions additionally to `decisions.jsonl`, and forwards to every SSE subscriber.
Screenshots are throttled to one per 500 ms per run and stored under `traces/`.

`api.ts` (Hono):

| Route                      | Behaviour                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `POST /run`                | body `{url, credentials?, intent?, prd?, maxFlows?, budget?}`; starts the graph; returns `{runId}` |
| `GET /events/:runId`       | SSE; replays `events.jsonl` then streams live                                                      |
| `GET /report/:runId`       | serves `report.html`                                                                               |
| `GET /runs/:runId/files/*` | serves output files including traces                                                               |

## 9. UI

Single Next.js page with six panels driven only by the SSE stream: pipeline strip, agent feed, browser thumbnail, decision log, results counters with classification badges, and the final report iframe.
A form at the top takes the same inputs as `POST /run`.
No server state beyond proxying to the orchestrator API.

## 10. Demo target: mini-shop

Express with server-rendered HTML and a seeded in-memory store.
Routes: `/login`, `/register`, `/products`, `/products/:id`, `/cart`, `/checkout` with a coupon field, `/orders` and `/account` gated behind login.
Seeded user `demo@shop.test` / `demo1234`.
Chaos toggles via env vars and `POST /__chaos` body `{renameCheckoutButton, breakCoupon, cosmeticChange}`:

| Toggle               | Effect                                    | Expected qa-pilot behaviour                             |
| -------------------- | ----------------------------------------- | ------------------------------------------------------- |
| renameCheckoutButton | "Place order" becomes "Complete purchase" | classifier says script, healer patches locator          |
| breakCoupon          | `POST /api/coupon` returns 500            | classifier says defect with network evidence, escalates |
| cosmeticChange       | button colour changes                     | no failure                                              |

## 11. Error handling

Budget is checked at the start of every node; exceeding it routes to report with `partial: true`.
`env` classifications route straight to report and are listed as environment problems, not defects.
Browser and subprocess errors inside a node are caught, emitted as `error` events, and converted into a decision that skips the affected item rather than failing the run.
The checkpointer allows `qa-pilot resume <run_id>`.

## 12. Testing strategy

Unit tests with vitest cover: coverage scoring, classifier signal weighting, codegen templating, the healer expect-guard, event bus fan-out, and locator preference resolution.
Integration test: the full graph against mini-shop with the fake LLM client returning canned flows, asserting the output directory contains every file in PRD section 5.
Milestone verification (M1 to M6) is performed as real runs against mini-shop with the live model and documented in `README.md`.

## 13. Milestones

Unchanged from the PRD.
Cut order if behind: parallelism, PRD gap matrix, UI polish.
M3 (classifier and healer) is never cut.
