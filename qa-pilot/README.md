# qa-pilot

Autonomous test orchestration agent.
Give it a URL and it explores the app, plans tests, scores coverage, generates Playwright tests, runs them, heals broken scripts, escalates real defects, and writes a report.
Every orchestrator decision is streamed live to a UI.

## Quick start

Requirements: Node 22, an Anthropic API key.

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

## The copilot

**Copilot** (`/copilot`) is a chat that acts on finished runs.
Type "rerun the tests that failed last time, especially the checkout ones" and it resolves the run you mean, checks that those tests exist, reruns them and reports the outcome in the chat, with each test's status moving live while it runs.
Ask "why did the coupon test fail?" and it answers from the run's results, the classifier's verdict and the defect ticket.
Every chat is saved under a title taken from the first request, so the dropdown reads like a list of things you asked for.
A run's login is never stored, so after the API restarts a rerun of signed-in tests asks for the target app's account in masked inputs; the values travel only with that request.
*Ask copilot* on a run header opens a chat scoped to that run.
The run picker under the message box names the run the chat is on and moves it to another one; a chat already under way is repointed on the server too, so the run survives a reload.
A rerun that was decided but not yet executed is dropped when the chat leaves its run, rather than firing later against a run nobody was looking at.

When a rerun still fails and the pipeline's classifier called that failure an app defect, the row offers to file it.
Connect Linear or Jira once under Settings (the user menu): the tab goes to the tracker's own sign-in through Composio and comes back, you pick the team or project when there is more than one, and the row reads *Raise in Linear* or *Raise in Jira*.
The ticket carries the repro steps, expected and actual, the classifier's evidence, the rerun error and a link back to the case, and the row turns into the issue's link.
qa-pilot never holds a tracker password or API key; Composio keeps the OAuth token and qa-pilot stores only the connected account's id.
A failure the classifier called an environment error, a script bug or flaky is named as such and never invited to a ticket.

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
| `ANTHROPIC_API_KEY` | required | Claude API key |
| `QA_PILOT_MODEL` | `claude-opus-5` | model for every LLM call |
| `QA_PILOT_HEADLESS` | `1` | `0` shows the agents' browser windows; a run opens one per planned flow, so watch the run screen instead |
| `QA_PILOT_EXPLORE_AGENT_STEPS` | `12` | LLM-chosen exploration steps after the crawl (each is one LLM call); `0` disables the explorer agent |
| `QA_PILOT_SCREENCAST` | `1` | `0` turns off the live viewport stream on the run screen |
| `QA_PILOT_API_PORT` | `4000` | API port |
| `QA_PILOT_OUTPUT` | `qa-pilot/output/` | where run artifacts go |
| `COMPOSIO_API_KEY` | required to connect a tracker | Composio project key; Linear and Jira connect through Composio's OAuth |
| `COMPOSIO_LINEAR_AUTH_CONFIG_ID`, `COMPOSIO_JIRA_AUTH_CONFIG_ID` | created on first use | reuse existing Composio auth configs instead of letting qa-pilot create managed ones |
| `QA_PILOT_API_ORIGIN` | `http://localhost:4000` | where the browser reaches the API, for the OAuth callback |
| `QA_PILOT_UI_ORIGIN` | `http://localhost:3000` | the UI's origin, allowed by CORS, returned to after OAuth, and used for the case link a filed ticket carries |

## Tests

```bash
npm test
```

Unit tests cover coverage scoring, the classifier, codegen, the healer's expect guard, and the event bus.
An integration test runs the full graph against mini-shop with a fake LLM.

## Milestone verification

See ARCHITECTURE.md for the graph and the milestone log.
