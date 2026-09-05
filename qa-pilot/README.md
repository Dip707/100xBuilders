# qa-pilot

Autonomous test orchestration agent.
Give it a URL and it explores the app, plans tests, scores coverage, generates Playwright tests, runs them, heals broken scripts, escalates real defects, and writes a report.
Every orchestrator decision is streamed live to a UI.

## Quick start

Requirements: Node 22, and an Anthropic API key — or a Gemini key routed through the bundled LiteLLM proxy (see [Running on a Gemini key](#running-on-a-gemini-key)).
A database is optional; with no `QA_PILOT_MONGO_URL` the process keeps runs in memory.

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Then edit `.env` and set `ANTHROPIC_API_KEY` to a real key.

Run the three services in separate terminals:

```bash
npm run shop   # demo target on http://localhost:3005
npm run api    # orchestrator API on http://localhost:4000
npm run ui     # live UI on http://localhost:3000
```

Or run from the CLI without the UI:

```bash
npm run qa-pilot -- run http://localhost:3005 --username demo@shop.test --password demo1234 --intent "focus on auth and checkout"
```

Outputs land in `output/<run_id>/`: `plan.md`, `plan.json`, `coverage.json`, `tests/*.spec.ts`, `results.json`, `heal-log.json`, `defects.json`, `report.md`, `report.html`, `decisions.jsonl`, `events.jsonl`, `traces/` (Playwright traces, one `videos/<test>.webm` recording per test, and agent screenshots), and `live/` (the frames the runner streams while a test executes).

### Taking the suite with you

`output/<run_id>/suite/` is the generated suite as a standalone Playwright project: the specs, the fixtures they need, a config, and a README.
It has no dependency on qa-pilot, so an engineer can keep it in their own repository.

```bash
cd output/<run_id>/suite
npm install
npx playwright install chromium
export QA_USERNAME='...' QA_PASSWORD='...'   # only if the target needs a login
npm test
```

The sign-in the agent recorded is baked into `fixtures.ts`, but the credentials are read from the environment and never written to the bundle, so the suite is safe to commit.
`BASE_URL` overrides the target, so the same suite runs against another environment.
In the UI, **Download suite** on the run header returns the same thing as a zip.

## The UI

Every run has three screens, reachable from the sidebar once a run is open.

- **Test runs** (`/runs/<id>`): the execution strip and summary card, then every planned test grouped by use case with its status in this run.
  The *Agent actions view* tab shows the pipeline strip, the agent feed, the branch decisions, the plan and the report.
  Its **Browser** panel is a live view of what the agents are looking at: Chromium streams JPEG frames over CDP, so the browsers stay headless and every fanned-out generator is watchable at once, one tile per agent.
  When the run ends the stream closes and the panel falls back to the last screenshot on disk.
- **Test cases** (`/runs/<id>/cases`): the same tests with their latest status, filterable by Planned, Running, Passed, Failed or Blocked, searchable, with *Run all* to re-execute them.
- **Test coverage** (`/runs/<id>/coverage`): the plan as a graph, one lane per use case fanning out to its tests, with the evaluator's remaining gaps drawn as dashed nodes in the lane they belong to, next to the score and per-check breakdown.

Clicking a test anywhere opens its detail drawer: priority, category and description, the steps as the runner executes them with the failing step marked, the result with the classifier's verdict and evidence, and a *Preview* pane that shows the browser live while the test runs and its recording afterwards, with the generated Playwright source on the *Code* tab.
*Re-run* executes that one test again in place.

The **Review** card on the start form pauses the run after the coverage gate.
The proposed tests appear in a review sheet where each can be renamed, re-prioritised or deselected; nothing is generated until *Run all* is confirmed.
It is off by default so a run stays fully autonomous.

## Demo script (5 minutes)

1. Start the three services and open the UI.
2. Paste the URL and "focus on auth and checkout" and press Start.
3. Watch the explorer crawl in the headed browser and the plan appear.
4. Watch the coverage evaluator score the plan; if below 0.75 it re-plans with the gap list.
5. Before the run node starts, run `./demo.sh rename` so the checkout button is renamed; the healer patches the locator and the diff shows in the decision log.
6. Run `./demo.sh coupon`; the classifier marks the coupon test `defect` with the 500 in evidence and escalates a ticket.
7. Open the report: coverage, heals, defects, untested risk, decision timeline.
8. `./demo.sh reset` afterwards.

A screenshot of the live UI during a fake-LLM run that stops at planning, showing the pipeline strip, agent feed, browser thumbnail, decisions, results, and report panels; a full-run screenshot is pending a real API key.

![qa-pilot UI](docs/ui.png)

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Claude API key. Also required when proxying to another provider — the SDK will not send a request without *some* key |
| `QA_PILOT_MODEL` | `claude-opus-5` | model for every LLM call |
| `QA_PILOT_LLM_BASE_URL` | unset | point the LLM client at an Anthropic-compatible proxy instead of the Anthropic API. Setting it also turns on compat mode |
| `QA_PILOT_LLM_COMPAT` | auto | `1` forces compat mode on, `0` forces it off. Auto-detected from `QA_PILOT_LLM_BASE_URL` |
| `QA_PILOT_LLM_MAX_RETRIES` | `5` | attempts per LLM request before giving up on a transport failure (429/5xx/connection) |
| `QA_PILOT_LLM_RETRY_BASE_MS` | `1000` | first backoff window; doubles each attempt, jittered |
| `QA_PILOT_LLM_RETRY_CAP_MS` | `30000` | ceiling on any single backoff, including one the server asks for |
| `QA_PILOT_MONGO_URL` | unset | Mongo connection string. **Optional** — without it the process falls back to the in-memory store and warns. `MONGO_URI` is accepted as an alias |
| `QA_PILOT_MONGO_DB` | `qa_pilot` | database name |
| `QA_PILOT_STORE` | auto | `mongo` forces Mongo (and fails loudly with no URL); `memory` forces the in-memory store |
| `QA_PILOT_HEADLESS` | `1` | `0` shows the agents' browser windows; a run opens one per planned flow, so watch the run screen instead |
| `QA_PILOT_SCREENCAST` | `1` | `0` turns off the live viewport stream on the run screen |
| `QA_PILOT_API_PORT` | `4000` | API port |
| `QA_PILOT_OUTPUT` | `qa-pilot/output/` | where run artifacts go |
| `QA_PILOT_FAKE_LLM` | unset | `1` swaps in the fake LLM client; used by tests and for a UI walkthrough with no key |

### Persistence

Runs and accounts live in Mongo when `QA_PILOT_MONGO_URL` is set, and in memory otherwise.
The in-memory store passes the same contract test as the Mongo one, so the pipeline behaves identically — but everything is lost when the process exits, and a single-test re-run will not find a run from before a restart.
`GET /health` reports which backend is actually in use.

### Running on a Gemini key

There is no Anthropic-key requirement in principle: the client speaks the Messages API, so any Anthropic-compatible proxy works.
`litellm.config.yaml` and `scripts/litellm-proxy.sh` start a LiteLLM proxy on port 4444 backed by Gemini.

```bash
echo 'GEMINI_API_KEY=your-key' >> .env
./scripts/litellm-proxy.sh          # in its own terminal
```

Then in `.env`:

```
QA_PILOT_LLM_BASE_URL=http://localhost:4444
ANTHROPIC_API_KEY=sk-local-dev
QA_PILOT_MODEL=gemini-3.8-flash
```

Setting `QA_PILOT_LLM_BASE_URL` switches the client into **compat mode**, which is not cosmetic.
The native path relies on `output_config` (Anthropic structured outputs) to guarantee that every reply parses, and on `thinking` for reasoning depth.
LiteLLM is configured with `drop_params: true`, so it accepts both and discards them before Gemini ever sees them — the call would succeed and the model would answer in prose.
Compat mode stops sending those two parameters and renders the JSON Schema into the system prompt instead, so the contract survives the translation layer.

#### Retries

A newly released model can return `503 "this model is currently experiencing high demand"` for minutes at a time.
The Anthropic SDK retries such a response twice over roughly 1.5 seconds and then gives up — too short for that, and invisible, since it happens inside the call and never reaches the event bus.

So the client owns the policy instead (`maxRetries: 0` on the SDK): five attempts by default with jittered exponential backoff, roughly 30 seconds of patience, honouring `retry-after` when the server sends one and capping it so a provider asking for ten minutes cannot hang a run.
Every retry is logged to the event bus, so an outage shows up in the agent feed as a retry rather than as an unexplained node failure.

Transport retries are deliberately **not** charged to the LLM budget: a 503 spends no tokens, and counting it would let an outage exhaust `maxLlmCalls` without the model having answered once.
A schema-validation retry *is* charged, because that one did spend tokens.

## Tests

```bash
npm test
```

Unit tests cover coverage scoring, the classifier, codegen, the healer's expect guard, and the event bus.
An integration test runs the full graph against mini-shop with a fake LLM.

## Milestone verification

See ARCHITECTURE.md for the graph and the milestone log.
