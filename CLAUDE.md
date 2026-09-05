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
belong to that branch, not to `qa-pilot`.

**Watch out:** the primary checkout at the repo root may sit on a stale `main`
that predates `qa-pilot` entirely. Verify with `git log --oneline -1` before
concluding anything is missing.

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
| `npm run qa-pilot -- run <url> [--intent ...]` | CLI run, no UI |
| `./scripts/litellm-proxy.sh` | LiteLLM proxy on :4444, to run on a Gemini key |
| `./demo.sh rename\|coupon\|reset` | chaos toggles on mini-shop for the healer/classifier demo |

There is no lint step for the orchestrator; the UI has `eslint.config.mjs`.

## Configuration

`qa-pilot/.env` (gitignored; `.env.example` is the template). `ANTHROPIC_API_KEY`
is the only hard requirement — every other variable has a working default.
`QA_PILOT_MONGO_URL` is optional: without it the process warns and uses the
in-memory store. Setting `QA_PILOT_LLM_BASE_URL` points the client at an
Anthropic-compatible proxy and switches on compat mode, which stops sending
`thinking` and `output_config` (a proxy with `drop_params` discards them) and
renders the zod schema into the system prompt instead. Full table in
`qa-pilot/README.md`.

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
  flaky tests. Keep that stage boundary explicit — the evaluation criteria
  reward visible orchestration logic, not just working tests.
- The plan node is registered as `planFlows` because LangGraph rejects a node
  name that collides with a state channel, and `plan` is a channel. The
  `guarded("plan", ...)` label keeps events and decisions reading `plan`.
- **Never weaken the healer's guard.** `guardExpects` in `nodes/heal.ts` reduces
  every `await expect(` line to a signature and rejects any patch that alters
  one. A healer that can edit assertions is a bug-hider, and this is the single
  most load-bearing invariant in the project.
- Likewise, when the generator cannot validate an assertion live it emits the
  original unchanged so the runner fails and the classifier can call the defect.
  Do not "fix" that into passing.
- The `Store` interface has two implementations and `test/store.test.ts` runs the
  same contract against both. Add to the contract test when adding a method.
- Tests use `FakeLlmClient` with canned answers; `npm test` needs no API key and
  no database.
