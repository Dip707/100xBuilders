# PRD — Autonomous Test Orchestration Agent

**Codename:** `qa-pilot` (rename freely)
**Event:** Bessemer Tech Catalyst — Aivar Innovations, AI/ML track
**Owner:** Pradeep
**Status:** Build spec, v1

---

## 1. One-line summary

A developer gives a web app URL. The agent explores the app, writes a test plan, checks the plan for gaps, generates Playwright tests, runs them, repairs broken tests, flags real bugs, and returns a test quality report — with no human step in between.

---

## 2. Problem

AI tools can plan tests, write tests, and heal tests. None of them decide *when* to do each, *whether the output is good enough*, or *whether a red test is a script problem or an app bug*. Engineers still do the coordination. This project builds that coordination layer.

---

## 3. Goals and non-goals

### Goals (must ship)
1. URL in → passing, meaningful test suite + report out, fully autonomous.
2. Orchestrator makes visible decisions: coverage good enough? re-plan? heal? escalate?
3. Failure classification with confidence and evidence: broken script vs real defect vs flaky.
4. Live UI that shows the agent thinking and the browser acting, in real time.

### Non-goals (do not build)
- CI/CD integration, hosting, cross-browser matrix.
- Fixing application source code or raising PRs against the app.
- 100% coverage of a production app.
- Any hand-written test scripts. All tests come from the pipeline.

---

## 4. Users and scenario

**User:** a full-stack developer or SDET with a running web app and no test suite.
**Scenario:** `qa-pilot run https://demo.example.com --intent "focus on auth and checkout" --prd ./prd.md`
Twelve minutes later they have `tests/*.spec.ts`, an HTML report, and a defect list.

---

## 5. Inputs and outputs

### Inputs
| Field | Required | Notes |
|---|---|---|
| `url` | yes | Base URL of the target app |
| `credentials` | no | `{username, password}` or login steps in plain text |
| `intent` | no | Natural language focus, e.g. "checkout and authentication" |
| `prd_path` | no | Markdown/PDF product requirements |
| `max_flows` | no | Cap on flows, default 12 |
| `budget` | no | Max LLM calls / minutes, default 40 min |

### Outputs
```
output/<run_id>/
  plan.md                # human-readable test plan
  plan.json              # structured plan (flows, steps, expected states)
  coverage.json          # evaluator verdicts per iteration
  tests/*.spec.ts        # generated Playwright tests
  results.json           # raw Playwright JSON report
  heal-log.json          # every heal: before/after, reason, confidence
  defects.json           # escalated bugs with evidence
  report.md + report.html
  decisions.jsonl        # orchestrator decision log (stream source)
  traces/                # Playwright trace.zip + screenshots
```

---

## 6. System components

```
Input → Orchestrator (LangGraph) → Planner → Coverage evaluator → Generator → Runner → Classifier → Healer → Report
                                       ↑____________ re-plan loop ____________|          |___ retry ___|
```

| Component | Role | Owns |
|---|---|---|
| Orchestrator | State machine; decides next step; enforces budget | LangGraph graph, state, checkpointer |
| Planner | Explores app, produces structured plan | LLM + Playwright MCP tools |
| Coverage evaluator | Scores plan, lists gaps, asks for re-plan | LLM + rules, no browser |
| Generator | Turns one flow into one `.spec.ts`, validates selectors live | LLM + Playwright MCP + file writer |
| Runner | Executes suite, parses JSON report, collects network/console | Playwright CLI, Node subprocess |
| Classifier | Labels each failure: script / defect / flaky / env | Rules + LLM + evidence |
| Healer | Repairs script failures by intent, never weakens assertions | LLM + Playwright MCP + Runner |
| Reporter | Builds report and defect tickets | Templates |
| UI | Live stream of decisions, browser view, final report | Next.js + SSE |

---

## 7. Orchestrator (LangGraph)

### State schema
```python
class RunState(TypedDict):
    run_id: str
    url: str
    credentials: dict | None
    intent: str | None
    prd_text: str | None
    site_map: dict            # routes, forms, nav links, auth-gated pages
    plan: list[Flow]          # see Flow below
    coverage: CoverageVerdict # score, gaps, missing_flows
    plan_iterations: int
    test_files: list[str]
    results: RunResults       # per test: status, error, step, network, console
    classifications: list[Classification]
    heal_attempts: dict[str, int]
    defects: list[Defect]
    decisions: list[Decision] # appended at every branch
    budget_used: dict         # llm_calls, minutes
```

### Nodes
`explore → plan → evaluate_coverage → generate → run → classify → heal → report`

### Conditional edges (the "intelligence")
| After node | Condition | Next |
|---|---|---|
| `evaluate_coverage` | score ≥ 0.75 or iterations ≥ 3 | `generate` |
| `evaluate_coverage` | score < 0.75 | `plan` (with gap list injected) |
| `classify` | any `script` class with heal_attempts < 2 | `heal` |
| `classify` | any `flaky` | `run` (rerun only those, max 2) |
| `classify` | all passed / all defects / attempts exhausted | `report` |
| `heal` | healed tests exist | `run` (only healed tests) |
| any | budget exceeded | `report` with `partial: true` |

Every branch writes a `Decision {node, reason, evidence, next}` to state and to `decisions.jsonl`. This is the demo feed.

### Parallelism (good-to-have)
- Generator: fan out one `generate_flow` node per flow using `Send()`; join.
- Runner: `npx playwright test --workers=4`.

---

## 8. Sub-agent specs

### 8.1 Planner
**Goal:** explore the app and produce a plan covering happy paths, negative paths, edge cases, error states, and auth boundaries.

**Tools (Playwright MCP):** `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_select_option`, `browser_press_key`, `browser_navigate_back`.

**Algorithm:**
1. Login if credentials given; record login steps as a reusable fixture.
2. BFS crawl within same origin, depth ≤ 3, max 30 pages. Per page record: URL, title, forms (fields + labels), buttons, links, auth-gated (302 to login?).
3. Build `site_map`.
4. Ask LLM to produce flows from site_map + intent + PRD.
5. For each flow, do a dry walk-through in the browser to confirm the steps are real (no hallucinated pages).

**Output — `Flow`:**
```json
{
  "id": "auth-002",
  "title": "Login with wrong password shows error",
  "category": "negative",           // happy | negative | edge | error_state | authz
  "priority": "P1",
  "preconditions": ["logged_out"],
  "steps": [
    {"action": "goto", "target": "/login"},
    {"action": "fill", "role": "textbox", "name": "Email", "value": "user@test.com"},
    {"action": "fill", "role": "textbox", "name": "Password", "value": "wrong"},
    {"action": "click", "role": "button", "name": "Sign in"}
  ],
  "expected": [
    {"type": "visible", "role": "alert", "text_contains": "Invalid"},
    {"type": "url_stays", "value": "/login"}
  ],
  "source": "explored | prd | intent"
}
```

**Prompt rules:** at least one negative and one edge flow per form; one authz flow per gated route; steps must reference elements seen in a snapshot.

### 8.2 Coverage evaluator
**Goal:** judge the plan before code is written.

**Inputs:** `site_map`, `plan`, `prd_text`, `intent`.
**Checks:**
- Every discovered form has happy + negative + empty-submit flows.
- Every gated route has an unauthenticated-access flow.
- Every PRD requirement (extracted as a list) maps to ≥ 1 flow (bonus: PRD gap analysis).
- Intent keywords appear in ≥ 1 flow title.
- Category mix: negative + edge + error_state ≥ 40% of flows.

**Output — `CoverageVerdict`:**
```json
{"score": 0.62, "gaps": [
  {"kind": "missing_negative", "target": "form:/checkout", "suggest": "submit with expired card"},
  {"kind": "prd_uncovered", "requirement": "R4 password reset email", "suggest": "reset flow"}
], "untested_risk": [{"flow": "payment", "reason": "external gateway", "risk": "high"}]}
```
Score = weighted average of check pass rates. Gaps are fed back into the Planner prompt on re-plan.

### 8.3 Generator
**Goal:** one `Flow` → one `.spec.ts` that passes on first run.

**Tools:** Playwright MCP (for live validation), `write_file`.

**Algorithm per flow:**
1. Open browser at flow start. Run preconditions (login fixture).
2. For each step: take snapshot, resolve `{role, name}` to a real element, prefer `getByRole` → `getByLabel` → `getByText` → `data-testid` → CSS (last resort). Execute it live. If the element is not found, mark the step `unresolved` and stop; return to orchestrator.
3. For each expected state: verify it live, then write the matching `expect()`.
4. Emit file with shared fixtures from `fixtures.ts` (login, base URL).
5. Run `npx playwright test <file>` once. If it fails, one self-repair attempt, then hand to orchestrator.

**Output template:**
```ts
import { test, expect } from './fixtures';
// flow: auth-002 | category: negative | source: explored
test('Login with wrong password shows error', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email' }).fill('user@test.com');
  await page.getByRole('textbox', { name: 'Password' }).fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid');
  await expect(page).toHaveURL(/\/login/);
});
```

### 8.4 Runner
- `npx playwright test --reporter=json --trace=retain-on-failure --workers=4`
- `fixtures.ts` attaches listeners: collect `response.status() >= 400`, `console.error`, `pageerror`, and attach to test annotations. Parse into `RunResults`.

### 8.5 Classifier
**Question:** did the app change, or did the app break?

**Classes:** `script` | `defect` | `flaky` | `env`

**Signals (each adds/removes weight):**
| Signal | Toward |
|---|---|
| Locator not found, but near-twin exists (same role, similar name, same container) | script +0.4 |
| Locator not found, no plausible alternative in snapshot | defect +0.3 |
| Network 4xx/5xx during the failing step | defect +0.4 |
| `pageerror` / uncaught exception during step | defect +0.3 |
| Assertion failed, actual text is a paraphrase of expected | script +0.3 |
| Happy-path test of same flow passes | script +0.2 |
| Happy-path test of same flow also fails | defect +0.3 |
| Many tests fail on the same locator | script +0.3 |
| Passes on rerun | flaky +0.6 |
| Timeout on `goto`, 0 responses, or login fails | env +0.6 |

**Output — `Classification`:**
```json
{"test": "auth-002", "class": "defect", "confidence": 0.91,
 "evidence": ["POST /api/login returned 500", "happy-path auth-001 also failing", "no alternative submit control found"],
 "action": "escalate"}
```
Thresholds: ≥ 0.8 → act; 0.5–0.8 → rerun + run control test, then act; < 0.5 → `needs_human`, explain why.

### 8.6 Healer
**Goal:** repair `script` failures without changing what the test proves.

**Algorithm:**
1. Read failing step + intent ("submit the login form").
2. Replay to the failing step in a live browser. Snapshot.
3. Ask LLM: which element accomplishes the intent? Try it. Verify the expected state still becomes true.
4. If yes → patch only the locator/step. Write diff to `heal-log.json`. Rerun.
5. If achieving the intent requires weakening or deleting an `expect()` → stop, reclassify as `defect`, escalate.
6. Max 2 attempts per test.

**Hard rule:** the Healer may change *how the test gets there*, never *what it asserts*.

### 8.7 Reporter
`report.md` sections: summary numbers · flows covered by category · pass/fail table · heals taken (with diffs) · defects (repro steps, expected/actual, evidence, screenshot, trace link) · coverage gaps remaining · untested flow risk · PRD gap matrix (if PRD given) · orchestrator decision timeline.

`defects.json` entries are paste-ready tickets: title, severity, repro steps, expected, actual, evidence, attachments.

---

## 9. UI (demo surface)

Single page, Next.js, connected via SSE to `decisions.jsonl` + agent event stream.

Panels:
1. **Pipeline strip** — nodes lit as the graph moves; loops visibly re-enter.
2. **Agent feed** — streaming thoughts/actions per sub-agent, colour-coded.
3. **Browser view** — headed Chromium window on screen during demo; plus latest screenshot thumbnail in UI.
4. **Decision log** — "Coverage 0.62 < 0.75 → re-planning; gaps: checkout negative, R4".
5. **Results** — live pass/fail counters; classification badges with confidence.
6. **Report** — rendered at the end with links to traces.

Backend: FastAPI (Python) running LangGraph; exposes `POST /run`, `GET /events/{run_id}` (SSE), `GET /report/{run_id}`.

---

## 10. Tech stack

| Layer | Choice |
|---|---|
| Orchestration | Python 3.11, LangGraph, SQLite checkpointer |
| LLM | Claude Sonnet 4.6 via Anthropic API (user-provided key); model configurable |
| Browser tools | `@playwright/mcp` over stdio via `langchain-mcp-adapters` |
| Test runner | Playwright Test (TypeScript), Node 20 |
| API | FastAPI + SSE |
| UI | Next.js 15, Tailwind |
| Storage | Filesystem under `output/<run_id>/` |

---

## 11. Repository layout

```
qa-pilot/
  orchestrator/          # python
    graph.py             # LangGraph build, edges
    state.py             # RunState, Flow, etc. (pydantic)
    nodes/
      explore.py planner.py coverage.py generator.py
      runner.py classifier.py healer.py reporter.py
    tools/mcp_client.py  # Playwright MCP wiring
    prompts/*.md
    api.py               # FastAPI
  runner/                # node
    playwright.config.ts
    fixtures.ts          # login, network/console capture
    tests/               # generated, gitignored except examples
  ui/                    # next.js
  targets/               # docker-compose for a sample app (e.g. Saleor demo, RealWorld)
  output/
  README.md  ARCHITECTURE.md
```

---

## 12. Milestones (hackathon clock)

| # | Deliverable | Done when |
|---|---|---|
| M1 | Explore + Planner | `plan.md` with ≥ 8 flows across ≥ 3 categories from a URL |
| M2 | Generator + Runner | ≥ 80% of generated tests pass first run on the sample app |
| M3 | Classifier + Healer | Injected button-rename is healed; injected 500 is escalated |
| M4 | Coverage loop | Score < 0.75 triggers re-plan and the second plan closes the gaps |
| M5 | UI + Report | Full run visible live; report opens in browser |
| M6 | Demo target | Bring-your-own app with 2 injected bugs + 1 cosmetic change |

Cut order if behind: parallelism → PRD gap matrix → UI polish. Never cut M3.

---

## 13. Demo script (5 min)

1. Paste URL + "focus on auth and checkout". Start.
2. Show Planner crawling in the headed browser; plan appears.
3. Coverage evaluator flags missing negative checkout flow → re-plan visibly.
4. Generator writes tests; runner goes green/red.
5. Renamed button → Healer patches locator, shows diff.
6. Broken coupon endpoint → Classifier says `defect 0.9`, shows network 500 + control test, escalates ticket.
7. Open report: coverage, heals, defects, untested risk, decision timeline.

---

## 14. Acceptance criteria

- [ ] Runs end to end from a single URL with zero prompts to the user.
- [ ] Plan includes non-happy paths; evaluator produces a numeric score and gap list.
- [ ] Generated tests use role/label locators; assertions verify outcomes, not just "no crash".
- [ ] Every failure gets a class, confidence, and evidence list.
- [ ] A heal never modifies or removes an `expect()`.
- [ ] Report contains all six required sections.
- [ ] README, architecture diagram, demo video, deck exist.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Target app slow/flaky on demo day | Local docker target; retries; `env` class stops false defects |
| Planner wanders off-site or into logout/delete actions | `--allowed-origins`; blocklist for destructive button names |
| LLM hallucinates elements | Generator validates every locator live before writing |
| Healer hides bugs | Hard rule 8.6.5 + heal log in report |
| Budget blowout | `budget` in state; report partial results |

## qa-pilot

Autonomous test orchestration agent for the Bessemer Tech Catalyst hackathon.
See [qa-pilot/README.md](qa-pilot/README.md).