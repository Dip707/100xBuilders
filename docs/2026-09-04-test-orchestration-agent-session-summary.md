# Autonomous Test Orchestration Agent — parallel build summary

**Branch:** `worktree-test-orchestration-agent` (never merged/pushed — this doc
is the durable record of that work)
**Author of this branch's work:** Dip, with Claude Code (subagent-driven
development)
**Relationship to `qa-pilot`:** built independently and in parallel by a
different teammate for the same hackathon problem, merged to `main` via PR #2.
This document exists because two full implementations were built without
either side knowing about the other. Nothing here was merged into `qa-pilot`;
this is an archive of what was tried, what worked, and what's worth carrying
over.

---

## 1. What this is

A working MVP of the required pipeline: point it at a URL, it autonomously
explores the app, plans test flows (happy path + error/edge cases), checks
its own plan for coverage gaps and re-plans if thin, generates real
Playwright specs with live selector verification, executes them, and
produces a markdown report that distinguishes a broken test from a genuine
app defect — with **no human step in between** and a live UI showing the
whole pipeline as it runs.

## 2. Stack and architecture

TypeScript full-stack: **Next.js 16** (App Router) + **Claude Agent SDK** +
**Playwright**, in-memory store (SQLite/WebSocket were designed but
deliberately deferred — see §5), Server-Sent Events for the live UI.

**Pipeline as built — 4 sub-agents, not 7:**

```
meta-agent (tools: ["Task"] only — delegates, never touches the browser)
  │
  ├─▶ Planner    — explores the app live, records flows (happy/error/edge)
  │
  ├─▶ (gap-check happens IN the meta-agent's own reasoning,
  │    not a 5th sub-agent — it re-invokes Planner if coverage looks thin)
  │
  ├─▶ Generator  — converts flows into real .spec.ts files, verifying
  │                selectors against the live app before writing each one
  │
  ├─▶ Executor   — runs the specs via `npx playwright test`, records
  │                pass/fail + failure text
  │
  └─▶ Reporter   — writes the final markdown report: flows covered,
                    results, suspected app defects vs. test bugs, coverage
                    gaps / untested-flow risk
```

Every stage's activity streams to the UI live via SSE as it happens — the
live feed is deliberately the centerpiece, not an afterthought, because the
hackathon rubric weights "orchestration intelligence" and "demo/UX clarity"
at 20% + 15% combined.

**Known gap vs. the spec: no Healer.** The Executor runs specs and records
outcomes; nothing retries or repairs a broken locator. In practice this
never blocked a demo because every completed run so far has passed cleanly
— but it's the one required-pipeline piece not built. If `qa-pilot` has a
Healer, that's worth studying.

## 3. Key files (for reference / salvage)

```
lib/store.ts          in-memory Run/RunEvent store + SSE pub-sub
lib/tools.ts           Playwright tools + recording tools, via createSdkMcpServer
lib/orchestrator.ts    startRun(): the meta session + 4 sub-agent definitions
lib/redact.ts          strips TARGET_PASSWORD from every event before storage
app/                   Next.js routes + pages (run form, live run view)
components/            StageStrip + stagePipeline.ts (pipeline visualiser,
                        loop-back detection), CostMeter, TestViewer + highlight.tsx
                        (generated-spec viewer, hand-rolled syntax highlighting),
                        ActivityFeed (stage-filterable, reasoning vs. tool-call)
fixtures/app/          local login/checkout test target (no external dep needed)
scripts/e2e-run.mjs    drive a full run from the CLI, prints the live feed
scripts/probe-*.mjs    standalone diagnostics used to isolate real-app bugs
                        from pipeline bugs (see §4)
```

35/35 tests passing (`npm test`), `tsc --noEmit` clean, at the last commit
(`8377013`).

## 4. Bugs found and fixed along the way (the actually interesting part)

Several of these are non-obvious and may be worth checking against
`qa-pilot` even if the code isn't reused directly:

- **MCP tool-naming bug (caught before any code was written).** Tools
  registered via `createSdkMcpServer` are addressed by the model as
  `mcp__<serverName>__<toolName>`, not bare names. An early plan draft used
  bare names in every sub-agent's tool allowlist — every sub-agent would
  have silently had zero tools while appearing to run.
- **Vitest ⇄ Playwright test-collection collision, in both directions.**
  Vitest's default include glob was collecting generated Playwright specs
  (which import `@playwright/test` and crash vitest on load). Separately,
  Playwright's default `testDir` is the repo root, so with no
  `playwright.config.ts` it tried to load the project's own vitest tests as
  specs, crashed discovery, and reported "No tests found" for every
  generated spec — which reads as a broken generator, not a config gap.
  Fixed by scoping each tool to its own directory.
- **Next.js 16 breaking change:** dynamic route `params` is now a
  `Promise<{...}>` and must be awaited in both route handlers and pages.
- **Ambiguous-selector trap (root cause of the first real GradeOwl
  failures).** Playwright's `:has-text()` is a substring match. GradeOwl's
  login page has both "Sign In" and "Sign in with Google" buttons; the
  obvious selector clicked the SSO button and opened a dead-end OAuth popup,
  burning the whole turn budget on retries. Fixed at the tool layer:
  `browser_snapshot` now surfaces overlapping-text ambiguity, `browser_click`
  reports match-count warnings, and sub-agent prompts call out the trap
  explicitly and steer toward `:text-is()`.
- **Credential leak path.** Tool-call events log their raw arguments —
  a `browser_fill` on a password field would have put the literal password
  into the event log, the SSE stream, and the UI. Fixed with central
  redaction in the store's `appendEvent`, not at each call site.
- **Stage-attribution bug.** `RunEvent.stage` fell back to `"meta"` whenever
  a message lacked `subagent_type` (common), so the live feed showed
  sub-agent work as if the meta-agent were doing it directly. Fixed by
  tracking Task delegations and attributing subsequent events to the
  delegated sub-agent via `parent_tool_use_id`.
- **No login verification before planning.** Originally the agent would
  just start planning after attempting login, with no check that it
  actually worked. Added an explicit `verify_login` tool (checks the URL
  moved off the login page + an expected post-login element) that fails
  fast and legibly instead of grinding through retries.
- **Turn-budget cliff.** The original 40-turn cap was fine for the local
  fixture app but not for a real app; hitting it produced *no report at
  all*. Raised the caps and added a fallback-report path that synthesizes a
  partial report from whatever was recorded whenever a run ends without one
  — this fired for real during testing (both on a genuine cap-out and,
  separately, when the user's own Claude usage limit interrupted a run) and
  worked as designed both times.

## 5. Deliberate scope decisions

- **MVP-first pivot.** A full 27-task plan exists
  (`docs/superpowers/plans/`, `docs/superpowers/specs/`) with SQLite,
  WebSocket, and 7 sub-agents including a dedicated gap-checker and healer.
  Partway through, the decision was made to ship a thin, fully-working
  4-agent slice first rather than a half-built 7-agent architecture —
  in-memory store instead of SQLite, SSE instead of WebSocket, gap-check
  folded into the meta-agent's own reasoning instead of a dedicated agent.
- **Provider:** briefly explored routing through a LiteLLM proxy to use a
  Gemini key (no Anthropic key was available at the time); turned out
  unnecessary once it was confirmed the Agent SDK authenticates through the
  local Claude CLI's own OAuth session. The LiteLLM path is still present
  and working (`litellm.config.yaml`, `scripts/litellm-proxy.sh`) if ever
  needed, but tool-calling fidelity through a non-Anthropic backend was
  only verified at the transport level, not fully proven end-to-end.

## 6. Proof of full end-to-end success (the headline result)

After the above fixes landed, a completely clean run against the real,
unfamiliar **GradeOwl** production app (`gradeowl.neuraconcept.com`, an
AI-grading tool for teachers) completed in **520 seconds with no human
intervention**:

- Login succeeded, explicitly avoiding the "Sign in with Google" trap.
- The gap-check loop fired for real: an initial 3-flow plan (all
  exam-creation-adjacent) was judged too thin — no login-failure case, no
  coverage of the core grading workflow — and the meta-agent re-invoked the
  Planner, which added 2 more flows.
- All 5 flows became real Playwright specs, generated against the live app.
- **5/5 specs passed on execution.**
- The Reporter correctly separated a real finding from a script bug: one
  spec (`negative-total-marks-accepted.spec.ts`) **passed as written but
  documented a genuine app defect** — GradeOwl's exam-creation form accepts
  a negative `total_marks` value with no validation, persisting it and
  showing "-10 marks" in the UI.

This run (id `3b137c82-a7d1-4c43-8897-abf861e3c110`) is the strongest single
artifact from this branch of work — full pipeline, real unfamiliar target,
zero human steps, a genuine bug caught and correctly classified.

## 7. What's worth comparing against `qa-pilot`

Since both implementations exist, a quick pass worth doing before the
hackathon submission is finalized:

- Does `qa-pilot` have a Healer? If yes, that's the single biggest gap this
  branch has against the spec and worth adopting.
- `qa-pilot` appears to have real multi-user auth/session handling
  (signup/login/logout, session scoping per run, a login-timing
  side-channel fix) — this branch has none of that; it assumes a single
  local operator.
- This branch's UI has a live pipeline-stage visualiser with loop-back
  detection, a generated-spec source viewer with syntax highlighting, and a
  live cost/turn/elapsed meter — worth checking whether `qa-pilot`'s UI
  covers the same "show the orchestration, not just the result" goal, since
  that's directly rewarded by the rubric.
- This branch has one fully-proven real-world run (GradeOwl, §6) with a
  caught defect — a strong demo-video candidate regardless of which
  codebase ships.

**Addendum (as of this doc landing on `main`):** `qa-pilot` has continued to
grow past what's described above — it now also has a review gate,
single-test rerun, a PRD-input field on the start-a-run screen, an
overview dashboard with run history, and a unified run-detail screen for
both live and replayed runs. This document is a snapshot of one point in
time; check `qa-pilot`'s own docs/commit history for its current state
rather than treating this comparison as up to date.
