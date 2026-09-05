# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

The submission lives in `qa-pilot/` — a TypeScript npm-workspace monorepo, fully
implemented and green. `README.md` at the repo root is the **original PRD** and
specifies a Python/FastAPI/LangGraph-Python stack that was never built; treat it
as a historical spec, not a description of the code. `qa-pilot/README.md` and
`qa-pilot/ARCHITECTURE.md` describe what actually exists.

A second, independent implementation of the same problem exists on the unmerged
branch `worktree-test-orchestration-agent` (Next.js + Claude Agent SDK, 4
sub-agents, no healer). It is archived, not maintained;
`docs/2026-09-04-test-orchestration-agent-session-summary.md` is its record.
Do not confuse the two — root-level `app/`, `lib/`, `components/`, `fixtures/`
belong to that branch, not to `qa-pilot`. Root-level `generated-tests/`,
`test-results/` and `scripts/` are gitignored leftovers of it too; the live
`scripts/` is `qa-pilot/scripts/`.

**Watch out:** the primary checkout at the repo root may sit on a stale `main`
that predates `qa-pilot` entirely. Verify with `git log --oneline -1` before
concluding anything is missing.

Longer-form design docs: `qa-pilot/ARCHITECTURE.md` (per-node table of which
LLM calls each node makes, the review gate, the copilot, ticket filing) and
`docs/orchestration-layer.md` (the pipeline explained for the judges).
`qa-pilot/ui/CLAUDE.md` imports the block `next dev` regenerates in
`ui/AGENTS.md`: read `node_modules/next/dist/docs/` before writing Next.js code,
the installed version differs from training data.

## Stack

Node 22+, TypeScript throughout. Workspaces: `orchestrator` (LangGraph JS +
Anthropic SDK + Playwright + Hono API), `runner` (Playwright Test config and
fixtures), `targets/mini-shop` (the local demo target with chaos toggles),
`ui` (Next.js). Run state is checkpointed in SQLite; runs and accounts persist
to MongoDB when configured, in memory otherwise.

## Commands

All from `qa-pilot/`:

| Command | What it does |
|---|---|
| `npm install` | install every workspace |
| `npx playwright install chromium` | browser the pipeline drives |
| `npm test` | full suite (orchestrator + mini-shop + ui), ~65s |
| `npm run typecheck` | `tsc --noEmit` across orchestrator, runner, mini-shop |
| `npm run shop` | demo target on :3005 |
| `npm run api` | orchestrator API on :4000 |
| `npm run ui` | live UI on :3000 |
| `npm run qa-pilot -- run <url> [--intent "..."] [--prd file.md] [--username u --password p] [--max-flows 12] [--headed]` | CLI run, no UI; attributed to the reserved `local@qa-pilot` account |
| `npm run lint -w ui` | eslint, UI only; the orchestrator has no lint step |
| `./scripts/litellm-proxy.sh` | LiteLLM proxy on :4444, to run on a Gemini key |
| `./demo.sh rename\|coupon\|cosmetic\|reset` | chaos toggles on mini-shop for the healer/classifier demo (`POST /__chaos`; same flags at boot via `CHAOS_RENAME_CHECKOUT=1` etc.) |

Single tests, from the workspace directory (vitest everywhere):

```bash
cd qa-pilot/orchestrator && npx vitest run test/heal.test.ts            # one file
cd qa-pilot/orchestrator && npx vitest run test/heal.test.ts -t "guard"  # one case
cd qa-pilot/ui && npx vitest run test/derive.test.ts
```

Most orchestrator tests are sub-second. These start a fixture target from
`test/helpers/` (mini-shop, kiosk, spa, root-login) and drive real Chromium, so
they are the slow ones: `explore*`, `plan`, `generate*`, `heal`, `run`, `graph`,
`recording`, `screencast-*`, `suite-e2e`, `toolkit`. `graph.test.ts` is the
full-pipeline integration test.

## Configuration

`qa-pilot/.env` (gitignored; `.env.example` is the template). `ANTHROPIC_API_KEY`
is the only hard requirement — every other variable has a working default.
`QA_PILOT_MONGO_URL` is optional: without it the process warns and uses the
in-memory store. Setting `QA_PILOT_LLM_BASE_URL` points the client at an
Anthropic-compatible proxy and switches on compat mode, which stops sending
`thinking` and `output_config` (a proxy with `drop_params` discards them) and
renders the zod schema into the system prompt instead. Full table in
`qa-pilot/README.md`.

`orchestrator/src/env.ts` loads `.env` from the process cwd *and* from the
qa-pilot root, in that order, never overriding an existing variable. That is why
`npm run api` (cwd `orchestrator/`) still finds the key at `qa-pilot/.env`; every
entry point imports it first. `QA_PILOT_FAKE_LLM=1` swaps in `FakeLlmClient`
with no canned answers, for a UI walkthrough with no key.

Per-run defaults live in `RunInputSchema` (`state.ts`): `maxFlows` 12, budget
200 LLM calls / 40 minutes, `reviewPlan` off. The UI reads the API origin from
`NEXT_PUBLIC_QA_PILOT_API` (default `http://localhost:4000`). Tracker filing
needs `COMPOSIO_API_KEY`; nothing else does.

The LLM client owns its own transport-retry policy (the SDK's `maxRetries` is set
to 0): jittered exponential backoff over ~30s, honouring `retry-after`, tuned by
`QA_PILOT_LLM_MAX_RETRIES` / `_RETRY_BASE_MS` / `_RETRY_CAP_MS`. Transport retries
are not charged to the LLM budget; validation retries are.

## What this repo is for

Shared repo for a hackathon submission to the **Bessemer Tech Catalyst**
(AI/ML track), organized by Aivar Innovations. Full spec:
`problem_explanation_9dm9yp4f98s.pdf`.

### The problem to solve: Autonomous Test Orchestration Agent

Build an agent that takes a web application URL and autonomously drives the
full testing lifecycle — planning, generation, execution, repair — with no
human intervention between stages, and no manually written test scripts.

**Required pipeline (a meta-agent coordinating three sub-agents):**
1. **Planner** — explores the target app, produces a structured, human-readable
   test plan covering meaningful user flows (not just happy paths).
2. **Meta-agent gap check** — evaluates the plan for coverage gaps (missing
   flows, edge cases, error states) before handing off to the Generator.
3. **Generator** — converts the plan into executable test files, with live
   selector/assertion validation against the running app.
4. **Execution + Healer** — runs the suite; on failures, the Healer replays and
   repairs broken locators/flows, and the system must distinguish a broken
   test script from a genuine application defect.
5. **Final report** — scenarios covered, pass/fail outcomes, healer actions
   taken, remaining coverage gaps, untested-flow risk.

**Good to have:** optional PRD input to steer Planner scope, natural-language
scoping (e.g. "focus on checkout and auth"), parallel test execution across
flows.

**Bonus:** PRD-vs-test-plan gap analysis; confident defect classification
(script bug vs. app bug).

**Explicitly out of scope:** production deployment/hosting at scale, CI/CD
integration, cross-browser matrix testing, complete coverage of a production
app, hand-written test scripts.

**Constraints to keep in mind while building:**
- Bring your own test target (self-hosted OSS app, an existing sample app, or
  any public demo app) rather than waiting on organiser-provided URLs.
- Each team must supply its own LLM API keys — none are provided by the
  organiser.
- Evaluation weighting: end-to-end functionality (30%), orchestration
  intelligence / handling of ambiguity & gaps (20%), code quality & healer
  depth (20%), demo/UX clarity (15%), business impact (10%), presentation (5%).
- Submission needs: working prototype, source repo with setup instructions,
  README covering architecture/pipeline design, an architecture diagram of
  the sub-agent orchestration flow, a 2–5 min demo video, and a slide deck.

## Working in this repo

- The pipeline is a LangGraph state machine in `orchestrator/src/graph.ts`:
  `explore → plan → evaluate_coverage → generate (fan-out) → run → classify →
  heal → report`, with a re-plan loop below coverage 0.75 and a rerun loop for
  flaky tests (`prepareRerun → run`; `MAX_HEAL_ATTEMPTS` and `MAX_RERUNS` are
  both 2, in `nodes/classify.ts`). Keep that stage boundary explicit — the
  evaluation criteria reward visible orchestration logic, not just working tests.
- Every node except `report` is wrapped by `guarded(name, fn)` in `graph.ts`. It
  skips the node once `state.partial` is set, sets `partial` when the budget is
  exhausted, and turns a thrown error into `partial` plus a decision event instead
  of a crash; every conditional edge then routes `partial` straight to `report`.
  A run therefore always ends with a report, and a node that throws is a
  *partial* run, not a failed one. Do not catch-and-swallow inside a node.
- A run with `reviewPlan: true` routes from the coverage gate to a `review` node
  the graph is compiled to `interruptBefore`. Its body never runs: `startRun`
  parks (status `awaiting_review`), and `POST /runs/:id/review` writes the edited
  plan into the checkpoint *as that node's output* before resuming into the
  generate fan-out. Runs without review never touch it.
- The plan node is registered as `planFlows` because LangGraph rejects a node
  name that collides with a state channel, and `plan` is a channel. The
  `guarded("plan", ...)` label keeps events and decisions reading `plan`.
- The gap loop stops on three conditions, not two: coverage >= 0.75, iterations
  exhausted, **or `replanStalled`** - an iteration that failed to move the score
  by more than `STALL_EPSILON`. A converged planner will reproduce the same gaps,
  so grinding to `MAX_PLAN_ITERATIONS` spends the pipeline's most expensive LLM
  call (`plan`, effort `high`) to learn nothing. The unclosed gaps go into the
  report instead. `afterCoverage` reads the score history from `coverage.json`,
  so any test touching it must set its own `QA_PILOT_OUTPUT`.
- `scoreCoverage` has six dimensions; `errors` (0.15) is separate from `mix` on
  purpose. A plan can satisfy the non-happy ratio with validation-error flows
  alone and never ask what the app does when a *request* fails - a validation
  error is the app working, a failed request is the app under duress, and only
  the second shows whether failure is surfaced or silently swallowed.
- Intent scoping matches against a flow's title, step targets/names **and**
  assertions, with a fuzzy fallback. Title-only substring matching scored a flow
  named "Place order" as zero coverage for the intent "focus on checkout" even
  though every step ran through /checkout.
- **Never weaken the healer's guard.** `guardExpects` in `nodes/heal.ts` reduces
  every `await expect(` line to a signature and rejects any patch that alters
  one. A healer that can edit assertions is a bug-hider, and this is the single
  most load-bearing invariant in the project.
- `guardExpects` strips the target's accessible *name* from the signature, so on
  its own it would accept `"Log In"` -> `"Sign Up"` on an assertion: same role,
  same matcher, live-visible, green suite on a broken login page.
  `MIN_ASSERTION_NAME_SIMILARITY` (0.8) in `nodes/heal.ts` closes that: a heal may
  re-target an assertion only across a cosmetic rename (`"Log In"` -> `"Log in"`,
  1.0), never a semantic one (`"Log In"` -> `"Sign Up"`, 0.0). Below the bar the
  test escalates as a defect. The two guards are complementary - structural
  (`guardExpects`) and semantic (`MIN_ASSERTION_NAME_SIMILARITY`) - and neither
  substitutes for the other.
- **Assertion healing makes no LLM call.** Because the similarity bar admits only
  same-role elements whose names are near-copies, there is no judgement left to
  delegate: `pickAssertionTarget` in `nodes/heal.ts` ranks candidates with
  `findNearTwins` and takes the top one, or escalates. `heal.md` is therefore a
  step-only prompt. The step path still calls the LLM, and may cross roles (a link
  replacing a button), because its patch is verified by acting live and re-running
  every assertion. `heal.test.ts` asserts `llm.calls === 0` on the assertion path;
  keep that assertion if you touch this.
- Likewise, when the generator cannot validate an assertion live it emits the
  original unchanged so the runner fails and the classifier can call the defect.
  Do not "fix" that into passing.
- **A plan repair contributes steps and nothing else.** `driftedFields` /
  `REPAIR_IMMUTABLE` in `nodes/plan.ts` carry id, title, category, priority,
  preconditions, expectations and source over from the original flow and log
  anything the repair tried to move. `dryWalk` only re-walks *steps*, so an
  unguarded repair could rewrite `expected` into an assertion the page never
  satisfies - the runner fails it and the report names an application defect that
  does not exist. A fabricated defect damages the product's core claim as much as
  a hidden one. `plan-repair.md` asked for this in prose long before anything
  enforced it; prose is not a guard.
- The `Store` interface has two implementations and `test/store.test.ts` runs the
  same contract against both. Add to the contract test when adding a method.
- `budgetSnapshot` in `browser/toolkit.ts` caps every accessibility snapshot at
  `QA_PILOT_MAX_SNAPSHOT_CHARS` (default 12000, 0 = uncapped). It is tunable and
  not fixed because the right answer is model-dependent: compaction helps
  small/mid-tier models and can hurt a frontier model with a large thinking
  budget. Truncation is on a line boundary and leaves a marker saying how many
  lines were dropped - a silently cut-off tree makes a model report a missing
  element as a defect.
- The crawler never clicks a control matching `BLOCKLIST` in `nodes/deps.ts`
  (delete, remove, log out, reset, cancel subscription...). The explore probe
  presses any button outside a form, so this regex is the only thing between an
  exploratory click and a control that throws the target's state away.
- Tests use `FakeLlmClient` (exported from `src/llm/client.ts`) with canned
  answers keyed by prompt name; an unkeyed prompt throws, so a test that reaches
  an unexpected LLM call fails loudly. `npm test` needs no API key and no
  database. `vitest.config.ts` sets `QA_PILOT_HEADLESS=1` and `QA_PILOT_FIXTURES`;
  any test that writes run artifacts sets `QA_PILOT_OUTPUT` to its own temp dir,
  because `afterCoverage` and the API read from there.

## Beyond the pipeline

Everything below sits around the graph and is where most recent change landed.

- **Auth** (`src/auth/`): cookie sessions (`qa_pilot_session`, 30 days, stored
  as a SHA-256 digest). Every run, chat, integration and ticket is owned by a
  user; the API's `ownedRun`/`ownedChat` helpers answer 404, not 403, for
  someone else's. `middleware.ts` caches session lookups for 30s because the live
  run view fetches one screenshot per step through an authenticated route; logout
  evicts. CLI runs belong to the reserved `local@qa-pilot` account, whose
  password hash can never verify. The UI's `middleware.ts` only checks the cookie
  *exists* and is a convenience, not a boundary; `app/(app)/layout.tsx` is the
  real gate.
- **Two chat kinds share the `chats` collection.** `kind: "intake"`
  (`src/chat/turn.ts`) fills in a run draft (url, intent, PRD, sign-in) and never
  sees credentials in either direction. `kind: "copilot"` (`src/copilot/`)
  answers questions about a finished run and re-runs tests: one structured call
  returns `rerun | answer | clarify` plus test ids, every id is checked against a
  catalogue built from the run's artifacts, and invented ids are dropped.
  Execute is a separate `POST .../execute`, one per chat at a time (409 otherwise).
  A rerun never re-classifies; it reuses the pipeline run's verdicts.
- **Runner ↔ orchestrator talk through files, not the bus.** The runner is a
  separate Playwright process: login steps arrive via `QA_PILOT_LOGIN_STEPS`,
  live progress is a per-test state file `runNode` polls every 250ms, and videos
  are copied to `traces/videos/` because Playwright wipes its output dir on every
  invocation and the pipeline invokes it many times per run.
- **Screencast frames deliberately bypass `EventBus`** (`browser/screencast.ts`).
  The bus appends everything to `events.jsonl` and replays it to late
  subscribers; a JPEG every 150ms from a dozen generator agents would OOM the
  replay. The hub keeps only the newest frame per agent and persists nothing.
- **Take-home suite** (`src/suite/bundle.ts`): `output/<run>/suite/` re-packages
  the specs as a standalone Playwright project. Recorded login steps are baked in
  with credential values swapped for `QA_USERNAME`/`QA_PASSWORD` env reads, so
  the bundle is safe to commit. `runs/manifest.ts` reports which artifacts really
  exist so the UI never offers a link that 404s.
- **Trackers** (`src/integrations/`): Linear and Jira via Composio OAuth.
  `TrackerClient` in `composio.ts` is the only file that knows the SDK; routes
  and tests use a fake of that interface. One ticket per (user, run, test): a
  second click returns the existing one. `ticket.ts` renders one provider-neutral
  body to markdown for both.
- **UI** (`ui/`): Next.js App Router, `(app)` route group behind the auth gate,
  `/login` and `/signup` public. `lib/api.ts` is the typed client for every API
  route; `lib/derive.ts`, `lib/stages.ts`, `lib/planner.ts` turn the event stream
  into screen state and are where the pure, unit-tested logic lives. Tests are
  vitest with a `@/` alias mirroring `tsconfig.json`.
