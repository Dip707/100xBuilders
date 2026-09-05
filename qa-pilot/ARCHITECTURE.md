# Architecture

```mermaid
flowchart TD
  classDef llm fill:#e6f0ff,stroke:#3366cc,color:#1a2b4c;
  classDef det fill:#eafaf1,stroke:#2e8b57,color:#173a26;
  classDef guard fill:#fff3cd,stroke:#c99a2e,color:#4a3800;

  START([run: url + intent / PRD]) --> EXPLORE["explore<br/>Explorer (crawl + gating)"]:::det
  EXPLORE --> PLAN["planFlows<br/>Planner (LLM)"]:::llm
  PLAN --> COVERAGE{"evaluate_coverage<br/>Meta-agent gap check<br/>(deterministic score)"}:::det
  COVERAGE -- "score < 0.75 & iterations < 3<br/>(repair guarded by REPAIR_IMMUTABLE)" --> PLAN
  COVERAGE -- "score >= 0.75 or<br/>3 iterations reached" --> REVIEWQ{reviewPlan?}
  REVIEWQ -- yes --> GATE[["review<br/>human approves / edits plan"]]
  REVIEWQ -- no --> GENERATE
  GATE --> GENERATE
  GENERATE["generateFlow (fan-out)<br/>Generator (LLM), one agent per flow<br/>live selector/assertion validation"]:::llm --> RUN["run<br/>Runner (Playwright)"]:::det
  RUN --> CLASSIFY{"classify<br/>rule-based signals +<br/>bounded LLM confidence nudge"}:::llm
  CLASSIFY -- "class = env" --> STOP["stop<br/>avoid false defects"]
  CLASSIFY -- "action = heal" --> HEAL["heal<br/>assertion: deterministic re-target<br/>step: LLM suggestion"]:::det
  HEAL -- "healed" --> RUN
  HEAL -- "guard rejects re-target" --> ESCALATE["escalated as defect"]:::guard
  CLASSIFY -- "confidence 0.5-0.8" --> RERUN["prepareRerun"] --> RUN
  CLASSIFY -- "escalate / needs_human / healed" --> REPORT
  ESCALATE --> REPORT
  STOP --> REPORT["report<br/>final report"]:::det
```

The diagram labels the planning step `plan` because that is what every event and decision calls it.
In the LangGraph build (`orchestrator/src/graph.ts`) the node is actually registered as `planFlows`, because LangGraph rejects a node name that collides with a state channel name and the run state has a `plan` channel (the flow list).
The `guarded("plan", ...)` wrapper keeps the logged node name as `plan` for events and decisions, so the graph wiring and the observable behavior stay consistent even though the internal node id differs.

Every guarded node (`explore`, `planFlows`, `evaluate_coverage`, `generateFlow`, `run`, `classify`, `heal`) also has an implicit edge to `report` the moment the run's LLM-call or time budget runs out (the `guarded` wrapper in `graph.ts`), which finishes the run with `partial: true` and a reason instead of hanging or throwing. That edge is omitted from the diagram above to keep it readable.

## LLM calls vs. deterministic code

Precise per-node breakdown, verified against `orchestrator/src/nodes/*.ts`:

| Node | Calls an LLM for | Deterministic |
|---|---|---|
| `explore` | never | crawling, gating detection, form/button/link extraction (`nodes/explore.ts`) |
| `planFlows` | `plan` (effort `high`) turns the site map into a flow list; `plan-repair` (`medium`) only when a step doesn't resolve live | dry-walking every flow against the live app (`dryWalk`); the `REPAIR_IMMUTABLE` guard on any repair |
| `evaluate_coverage` | `prd-requirements` / `prd-matrix` (`medium`), only when a PRD was supplied, and only computed once | `scoreCoverage` is a fixed weighted-checks formula — forms, authz routes, PRD matrix, intent keywords, category mix — with no LLM involved even when a PRD is present |
| `generateFlow` | `expect-repair` (`medium`), only when a live-validated expectation is false; `self-repair` (`medium`), only when a step still fails after initial generation | codegen (`codegen/template.ts`); every LLM suggestion is accepted only after it is re-verified live |
| `run` | never | Playwright execution, network/console/error capture |
| `classify` | `classify-rationale` (`low`) writes the narrative and may nudge confidence by at most ±0.1, and only runs for genuine failures | `scoreSignals` — the rule engine that decides class and base confidence — is pure code |
| `heal` | `heal` (`medium`), only for a **step** failure | `pickAssertionTarget` re-targets an **assertion** failure by role + name-similarity ranking; no LLM call, and the untrusted page snapshot never reaches a model on this path |
| `report` | never | markdown/HTML rendering, suite bundling |

## Anti-bug-hiding guards

qa-pilot's central design constraint: no stage — LLM-driven or not — may make a failing test pass by weakening what it proves. A test that goes green because an assertion was quietly changed is worse than a test that stays red, because it hides the defect instead of reporting it. That constraint is enforced by guards at several different layers of the pipeline, and they do not substitute for one another — removing any one of them reopens a different way to fake a pass:

- **Structural** (`guardExpects`, `expectSignature` in `nodes/heal.ts`): every `await expect(...)` line is reduced to a signature — the target's role (or `page`/`body`), the matcher, its negation, and its arguments, with the accessible *name* stripped out. A patch is accepted only when the before/after signature lists match exactly, so an assertion may be re-targeted to another element but nothing may add, remove, negate, or change what a matcher checks. The generator's self-repair path (`nodes/generate.ts`) enforces a stricter version of the same idea: because self-repair is only ever supposed to touch step code, it requires the expect lines to come back byte-for-byte identical, not merely signature-equal.
- **Semantic** (`MIN_ASSERTION_NAME_SIMILARITY = 0.8` in `nodes/heal.ts`): `guardExpects` strips the target's name, which is correct for a *step* (a renamed button is a locator problem) but wrong for an *assertion*, where the name is often the thing being proven. An app that loses its "Log In" button while keeping a "Sign Up" button still satisfies `expect(getByRole('button')).toBeVisible()` under an identical signature — a healer free to rename the target could turn a broken login page green, which is the precise failure this project exists to catch. `pickAssertionTarget` only re-targets to an element whose accessible name has at least 0.8 bigram similarity to the one the plan named; below that bar the failure escalates as a defect instead of healing.
- **Role** (`findNearTwins` in `browser/snapshot.ts`): candidates are filtered to the same accessible role before they are ranked by name similarity, so an assertion can never be re-targeted from, say, a `heading` to a `button`, however similar the text.
- **Plan-stage** (`driftedFields` / `REPAIR_IMMUTABLE` in `nodes/plan.ts`): when a planned flow's step can't be resolved live, `plan-repair` is asked to fix it, but only its `steps` are kept — `id`, `title`, `category`, `priority`, `preconditions`, `expected`, and `source` are immutable, and any field the model drifted is discarded and logged as a decision. A repair that rewrote `expected` could manufacture an assertion nothing on the page satisfies, which the runner would fail and the classifier would then report as an application defect that was never real.
- **Deterministic-by-default**: the paths that decide pass/fail make no LLM call at all. Coverage scoring (`scoreCoverage`) is a fixed formula. Assertion healing (`pickAssertionTarget`) is a ranking function. Classification (`scoreSignals`) is rule-based; the one LLM call in `classify` only writes the rationale text and may nudge a mid-band (0.5–0.8) confidence by at most ±0.1 (`adjustConfidence`) — a confident or weak verdict is never moved by the model at all. Everywhere an LLM does decide something load-bearing (an assertion is false live, a step won't resolve, a rename plausibly explains a failure), its answer is never trusted on its own: it is re-verified against the live page or the actual test result before being accepted.

## Exploring single-page apps

The crawler waits for the network to go idle before reading a page, so links rendered by JavaScript are seen.
Routes are keyed by pathname plus the fragment when the app routes on hashes (`/#/faq`), and `goto` accepts those keys as they are.
Navigation controls that are not anchors (buttons inside `nav`, `header` or `[role=navigation]`, `[role=link]` without an href, `data-href` and `routerlink` attributes) are probed once each: the crawler clicks the control, records the route it lands on when it stays on the origin, and reloads the page before the next probe.
Submit buttons are never probed, blocklisted labels (delete, remove, log out, clear, ...) are never pressed, and a label is probed once per crawl.

## Plan repair

Before a planned flow reaches generation, `planNode` dry-walks it against the live app (`dryWalk`): every step is executed for real, with no spec file written yet. A step that can't be resolved sends the flow to one `plan-repair` LLM call with the failing step and a live snapshot, asking only for new steps that reach it.

Only the repair's `steps` are kept. `driftedFields` diffs the immutable fields (`id`, `title`, `category`, `priority`, `preconditions`, `expected`, `source`) between the original flow and the repaired one; any field the model tried to move is discarded and logged as a decision, and only `{ ...flow, steps: repaired.steps }` is dry-walked again. A flow that still can't be resolved after repair is dropped from the plan and recorded under `unresolvedFlows`.

This guard exists for the same reason `guardExpects` does: `plan-repair.md` already asks the model not to change `expected`, but a prompt is a request, not a guarantee, and a repair that rewrote an expectation would manufacture a defect that was never on the app.

## Live assertion validation

The generator verifies every expectation on the page the flow just produced before writing it.
An expectation that is false live gets one `expect-repair` call, and its answer is kept only when it verifies live.
An element expectation may move to another element of the same role, or to an element of any role when the expectation carries text, since the text is then what is asserted.
A URL expectation may take the route the app really reached, provided it is a real path and not the bare root every URL contains.
When nothing fits, the original expectation is emitted unchanged, so the runner fails on it and the classifier gets to call the defect; hiding the failure at generation time would hide the bug.
A re-targeted expectation is recorded in run state under the flow's id (`expectations`); the plan keeps what the planner wrote, and the healer and the defect ticket verify against what the spec asserts, so a heal is never rejected for failing an expectation the generator had already replaced.
Two rules at the schema boundary keep the planner honest, and the LLM client retries with the validation message when they trip: a `url_contains` or `url_stays` value must be a path or route, and a `visible`, `not_visible` or `text_contains` expectation must name its element or the text it looks for, because a bare role ("an alert is visible") is satisfied by the app's own error message.
Expectation targets are resolved the way step targets are: the loose name match first, `exact: true` only when the loose match is ambiguous, so an emitted assertion never trips strict mode on the page it was validated against.

When a generated test still fails on a *step* after this validation, the generator gets one more chance: a `self-repair` LLM call sees the full source, the error, and a live snapshot at the failing step, and returns a rewritten source. The rewrite is applied only when `expectLines(repaired.source)` comes back byte-for-byte identical to the original's expect lines — stricter than `guardExpects`'s signature comparison, because self-repair is only supposed to touch step code, never assertions. A rewrite that touched an expect line at all, even in a way `guardExpects` would tolerate, is rejected outright and the original result stands.

## Test data

Values that must not already exist in the app (a new account's email, a record's name) carry the placeholder `{{unique}}` in the plan.
The toolkit substitutes its own token when it acts live, and generated code turns the value into a template literal over a token minted when the test starts, so a spec stays re-runnable without colliding with data an earlier run created.

## Classifier weights

Signal weights follow PRD section 8.5 with two deviations.
A 5xx response during the failing step counts +0.6 toward defect (4xx +0.3) because a server error is strong evidence on its own.
A test that still fails after a rerun gets +0.2 toward defect, which is what turns a mid-band server-error failure into an escalation instead of an endless rerun loop.
Two signals cover failures on expect lines, which have no failing step.
A strict mode violation (the assertion's locator matched more than one element) counts +0.8 toward script: the locator is wrong, the app is not.
An assertion whose target element is not found is read the way a missing step target is: the classifier parses the locator out of the error, replays the whole flow to snapshot the page, and looks for a near-twin of the same role.
A test that already has a defect ticket stays escalated on every later pass; re-analysing it would only heal it again or file the same defect twice.
A test that passes after an accepted heal is reported as healed (class `script`, action `healed`), not as flaky; only a test that recovers on a plain rerun is flaky.
The runner is configured with a bounded action timeout so that a click on a missing element fails with a locator error naming the step; without it Playwright waits out the whole test timeout and reports `timedOut` with no error location, which leaves nothing for the classifier or the healer to work with.
A confidence below 0.5 is reported as `needs_human` rather than heal, rerun, or escalate — the rule engine is explicitly declining to guess.

## The heal rule

The healer may change how a test reaches an expectation, and may re-target an expectation to another element, but never what is asserted.

For a **step** failure, a replacement element comes from one `heal` LLM call given a live snapshot; the suggestion is only used once `kit.act` actually succeeds against it live, and a confidence below 0.5 reclassifies the failure as a defect ("no element accomplishes the step's intent") instead of guessing.

For an **assertion** failure, no LLM is consulted at all: `pickAssertionTarget` (`nodes/heal.ts`) ranks same-role elements on the live snapshot by accessible-name similarity to the one the plan named, and only accepts a candidate at or above `MIN_ASSERTION_NAME_SIMILARITY` (0.8). `findNearTwins` (`browser/snapshot.ts`) enforces the role match; the similarity score enforces that the name — often the very thing being proven — wasn't part of what changed. Anything short of that bar escalates as a defect rather than healing, because re-targeting to it would change which element the assertion proves.

Whichever path finds a candidate, the patch is kept only once it is verified twice: live (`kit.checkExpectation` must actually pass against the new target) and structurally, by `guardExpects`. `guardExpects` reduces every `await expect(` line to a signature (the target's role, or `page` or `body`; the matcher; its negation; its arguments) and rejects a patch that adds, removes or alters any signature, reclassifying the failure as a defect.
So a heal may turn `expect(page.getByRole('heading', { name: 'Product catalogue' }))` into `expect(page.getByRole('heading', { name: 'Products' }))`, but it can never swap a `status` for the page body, drop a `not`, or change the text a matcher looks for.
A failure on an expect line is healable only when the expectation names an element; a failing URL or body-text assertion goes straight to escalation.

## The take-home suite

A run's generated specs only execute inside the pipeline: they import the runner's fixtures by a path that exists only here, and their `login()` replays steps handed in through an environment variable the orchestrator sets.
Handed to an engineer as-is, every signed-in test would sign in as nobody and fail on its first assertion.

So the report node also writes `output/<run_id>/suite/`: the same specs with their import rewritten, plus a self-contained `fixtures.ts`, a `playwright.config.ts` with no pipeline variables in it, a `package.json` pinning the Playwright version, and a README.
The specs themselves are copied from disk after healing, so what ships is what finished.

The recorded sign-in is baked into the bundle's fixtures, but the credential *values* are read from `QA_USERNAME` and `QA_PASSWORD` instead of being written out, which keeps the "credentials never touch disk" rule intact and leaves the bundle safe to commit.
A signed-in test throws a named error when those are unset, rather than submitting an empty form and failing later for an unrelated-looking reason.

`GET /runs/:id/suite.zip` zips that directory on request.
The archive is built by `suite/zip.ts`, a small deflate-or-store ZIP writer, so handing over a suite costs no archiving dependency; anything larger than a bundle of text files should use a real library instead of growing it.

## Events

Every node emits `node_start` and `node_end`.
Every branch appends a `Decision` to state and to `decisions.jsonl`.
The API replays `events.jsonl` then streams live over SSE.

The runner is a separate process with no handle on the event bus, so it reports through the filesystem.
While a test executes, the Playwright fixture streams JPEG frames from the Chromium screencast to `live/<test>/frame.jpg` and keeps a `state.json` beside it; the run node polls that directory and emits one `test_start` per test the moment its state says `running`.
Every test is recorded on video; because Playwright wipes its output directory on each invocation and this pipeline invokes it many times per run, the run node copies each recording to `traces/videos/<test>.webm` and records that path on the `test_result`.
Generation runs one Playwright invocation per flow, concurrently, so each invocation gets its own report and artifact directory under `traces/playwright/<test ids>/` (`suite` for the full run); without that, parallel generators read each other's report and wiped each other's traces mid-run.
A test quick enough to finish between two polls of the live directory is announced by the watcher's final scan, so a `test_start` always precedes its `test_result`.

## The review gate

A run started with `reviewPlan` routes from the coverage gate to a `review` node the graph is compiled to interrupt before.
`startRun` parks there, records the run as `awaiting_review`, and waits for `POST /runs/:id/review`, whose body (the possibly edited, possibly trimmed plan) is written into the checkpoint as the review node's own output before the graph resumes into the generation fan-out.
Runs that did not ask for review never route through the node, so the default pipeline stays autonomous.

## Single-test re-run

`POST /runs/:id/tests/:testId/rerun` executes one generated spec again in place, merges the fresh result into `results.json`, and appends the events to the run's log so the test's latest status moves without a new run.
The target's login steps carry its credentials and are never written to disk, so after an API restart only tests that do not sign in can be re-run; the route says so instead of failing at login.

## Milestone log

| Milestone | Command | Result |
|---|---|---|
| M1 explore + plan | `npm run qa-pilot -- run http://localhost:3005 --username demo@shop.test --password demo1234 --intent "focus on auth and checkout"` | verified 2026-09-04 (`output/fix-verify-1`): 11 pages crawled, 3 gated; 12 flows across 4 categories (3 happy, 5 negative, 3 authz, 1 error_state), none dropped |
| M2 generate + run | same run | verified: 12 of 12 flows generated, 11 of 12 passed on first run (92%); the one failure is a planner assumption mini-shop does not meet (registration does not sign the user in) and was escalated as a defect with that rationale |
| M3 heal + escalate | generate against the healthy app, then `./demo.sh rename && ./demo.sh coupon` the moment the run node starts (intent "focus on auth, checkout and the coupon code") | verified 2026-09-05 (`output/fix-verify-chaos4`): the two order flows failed on the renamed button, were classified `script`, healed to `Complete purchase` with the diff in the report and passed on rerun; the two coupon flows were classified `defect` at 0.9 with `POST /api/coupon returned 500` in evidence and ticketed once each |
| M4 coverage loop | `npm run qa-pilot -- run http://localhost:3005 --username demo@shop.test --password demo1234` | verified 2026-09-04 (`output/run-2026-09-04T17-38-19`): first plan scored 0.61 with 9 gaps and was sent back with the gap list; the second plan scored 0.93 with 4 gaps and went to generation |
| M5 UI + report | UI run | verified live on a partial run (fake LLM stops at planning); full-run screenshot pending a real API key |
| M6 demo target | mini-shop with three chaos toggles | verified: `renameCheckoutButton`, `breakCoupon`, `cosmeticChange` all work via `POST /__chaos`, toggled by `demo.sh` |

Two automated tests already exercise the scenarios M1 through M3 describe, end to end, with a fake LLM standing in for Claude:
`orchestrator/test/graph.test.ts` runs the full graph (explore, plan with a canned set of flows, coverage, generate, run, classify, report) against mini-shop, breaks the coupon endpoint, and asserts the coupon test (checkout-001) is classified `defect` with confidence >= 0.8 and that a defect ticket exists.
The 500 response is captured by the runner's network annotations and weighted by the classifier's signal function.
`orchestrator/test/heal.test.ts` renames the checkout button and asserts `healNode` patches the locator while `guardExpects` keeps every `expect()` line unchanged.
The runs behind the verified rows are kept under `output/` with their plans, generated specs, results, decisions and reports; nothing in them was hand-edited.
