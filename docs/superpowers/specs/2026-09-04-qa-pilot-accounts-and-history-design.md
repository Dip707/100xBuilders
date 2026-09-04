# qa-pilot accounts, run history, and UI restructure

Date: 2026-09-04
Status: approved design, pre-implementation
Supersedes nothing; extends `2026-09-04-qa-pilot-design.md`

## 1. Summary

qa-pilot today has no notion of a user, keeps no index of the runs it has performed, and presents everything through a single 59-line page.
This design adds three things.
Email and password accounts, so a run belongs to somebody.
A MongoDB Atlas store holding identity and a run index, so finished runs are listable and reopenable.
A restructured Next.js UI built as an app shell with routes, modelled on the TestSprite layout the user supplied as a reference.

The orchestrator pipeline itself, its nodes, prompts, and artifacts are untouched.
This is a shell around the existing engine, not a change to it.

## 2. Decisions taken during brainstorming

| Topic | Decision | Reason |
| --- | --- | --- |
| Auth model | Email and password accounts, sessions in an httpOnly cookie | Self-contained, no external provider, works offline, gives per-user run history |
| Run store scope | Full history plus replay of finished runs | A stored run drives the same components as a live one, so there is one read path to maintain |
| Database | MongoDB Atlas, URL supplied by the operator in `.env` | Chosen by the user |
| Trust boundary | The orchestrator API owns auth and the store; the UI is a thin client | The CLI also creates runs, so a single writer over one schema is only possible if the store lives in the orchestrator |
| Artifact storage | Stays on disk in `output/<run_id>/` | `EventBus` already rehydrates from `events.jsonl`, and traces and screenshots must be on a filesystem to be served |
| Password hashing | `node:crypto` scrypt with `timingSafeEqual` | No new dependency, no native build, a legitimate password KDF |
| Session storage | Cookie holds a random token; the database holds only its SHA-256 | A leaked database yields no usable sessions |
| Store injection | A narrow `Store` interface with `mongoStore` and `memoryStore` implementations | Mirrors the existing injected LLM client, so the test suite needs no database |
| Orphaned runs | Detected by a stale `heartbeatAt`, read lazily | A boot-time sweep on a shared Atlas cluster would mark a teammate's in-flight runs as interrupted |
| UI structure | App shell with routes: login, signup, overview, new run, run detail | Each screen does one job, and a run becomes a shareable deep link |
| UI look | Light theme, green accent, generous density, per the TestSprite reference | Supplied by the user as the target |
| Status colour | Green stays the brand accent; every status carries an icon and a word | Brand green and "test passed" green would otherwise collide, and icon plus word survives colour blindness |
| Projects concept | Out of scope | A new subsystem, not part of the request; the run table groups by target URL informally so it can be layered on later |

## 3. Scope

In scope.
Signup, login, logout, and session handling.
Ownership of runs, enforced on every run-scoped route.
A MongoDB store for users, sessions, and run metadata.
Recording of every run from both the API and the CLI.
A listable run history and a run-detail screen that serves live and finished runs identically.
A full restructure of the Next.js UI into an app shell with the screens in section 10.

Out of scope.
Password reset and email verification, since there is no mail transport in this project.
Organisations, teams, and sharing a run with another account.
A projects concept, monitoring, or scheduled runs.
Backfilling the run documents for the run directories already sitting in `output/`, noted in section 15 as deferred.
Any change to the planner, generator, runner, healer, classifier, or report.

## 4. Data model

Three collections in the database named by `QA_PILOT_MONGO_DB`, default `qa_pilot`.

```
users     { _id: string uuid, email: string, passwordHash: string, createdAt: ISO string }
sessions  { _id: sha256 hex of the cookie token, userId: string, createdAt: ISO, expiresAt: Date }
runs      { _id: run id, userId, url, intent?, hasPrd: boolean, status,
            startedAt: ISO, heartbeatAt?: ISO, finishedAt?: ISO, durationMs?,
            coverageScore?, planIterations?, flowsTotal?,
            testsPassed?, testsFailed?, healsAccepted?, defectsCount?,
            llmCalls?, partialReason? }
```

`status` is one of `running`, `done`, `partial`, `failed`, `interrupted`.

Indexes, created idempotently on first connect.

| Collection | Index | Purpose |
| --- | --- | --- |
| `users` | `{ email: 1 }` unique, collation `{ locale: "en", strength: 2 }` | One account per address regardless of case |
| `sessions` | `{ expiresAt: 1 }` with `expireAfterSeconds: 0` | Mongo reaps expired sessions instead of application code |
| `runs` | `{ userId: 1, startedAt: -1 }` | The history query |

`_id` is a string uuid for users and the existing `run-2026-...` identifier for runs, rather than an `ObjectId`.
Run identifiers are already meaningful, filesystem-safe, and present in URLs and directory names, so a second identity for the same run would mean a mapping layer for no gain.

Two things the database deliberately does not hold.
The artifacts, which stay in `output/<run_id>/` as `events.jsonl`, `decisions.jsonl`, `plan.md`, `report.html`, `traces/`, and the generated specs.
The credentials for the application under test, which stay in memory for the duration of a run exactly as they do today; the run document keeps `url`, `intent`, and a `hasPrd` flag only.

## 5. Store module

New directory `orchestrator/src/store/`.

| File | Responsibility |
| --- | --- |
| `types.ts` | The `Store` interface, `User`, `RunRecord`, `RunStatus`, and the shared `withDerivedStatus` helper |
| `mongo.ts` | `mongoStore()`: a memoised `MongoClient`, index creation, and the interface implementation |
| `memory.ts` | `memoryStore()`: the same interface over plain `Map`s, for tests |
| `index.ts` | `defaultStore()`, which returns `mongoStore()` configured from the environment |

The interface.

```ts
export interface Store {
  createUser(email: string, passwordHash: string): Promise<User>;
  findUserByEmail(email: string): Promise<(User & { passwordHash: string }) | null>;
  findUserById(id: string): Promise<User | null>;

  createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void>;
  findSession(tokenHash: string): Promise<{ userId: string; expiresAt: Date } | null>;
  deleteSession(tokenHash: string): Promise<void>;

  insertRun(rec: RunRecord): Promise<void>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;
  touchRun(id: string): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(userId: string, limit?: number): Promise<RunRecord[]>;

  close(): Promise<void>;
}
```

`createUser` surfaces a duplicate address as a typed `EmailTakenError` rather than leaking a Mongo duplicate-key error to the route layer.

`getRun` and `listRuns` both pass their results through `withDerivedStatus`, a pure function in `types.ts` that rewrites a `running` status to `interrupted` when `heartbeatAt` is more than five minutes old.
Both implementations share that one function, so the in-memory fake cannot drift from the real store on this rule.

The Mongo client is created lazily and memoised, so the driver's connection pool is reused across requests.
`serverSelectionTimeoutMS` is set to roughly eight seconds, so a wrong URL or a blocked Atlas IP allowlist fails at boot with a readable error rather than hanging the API.

## 6. Authentication

### 6.1 Password hashing

`orchestrator/src/auth/password.ts`.

`hashPassword` generates a 16-byte random salt and derives a 64-byte key with `crypto.scrypt` at `N=16384, r=8, p=1`, returning `scrypt$N=16384,r=8,p=1$<salt base64>$<hash base64>`.
The parameters are stored inside the string so the cost can be raised later without invalidating existing hashes.
`verifyPassword` parses the parameters from the stored string, re-derives, and compares with `crypto.timingSafeEqual`.
A hash that does not parse returns false rather than throwing, which is what makes the CLI's sentinel account in section 7.3 unloggable-into.

### 6.2 Sessions

`orchestrator/src/auth/session.ts`.

A session token is 32 bytes from `crypto.randomBytes`, base64url encoded.
The token is sent to the browser in the `qa_pilot_session` cookie and never stored; the `sessions` document is keyed by its SHA-256 hex digest.
Cookie attributes: `httpOnly`, `sameSite=Lax`, `path=/`, `maxAge` 30 days, and `secure` unless the request host is localhost.

`sameSite=Lax` is correct here even though the UI is served from a different port.
SameSite is evaluated on the registrable domain and ignores the port, so `localhost:3000` and `localhost:4000` are the same site and the cookie is sent, including on the `<img>` requests that load screenshots.
The requests are still cross-origin, so CORS carries `credentials: true` and the UI uses `credentials: "include"` and `EventSource` with `withCredentials`.

### 6.3 The `requireUser` middleware

Reads the cookie, hashes it, resolves the session, loads the user, and puts it on the Hono context.
Applied to every route except `POST /auth/signup`, `POST /auth/login`, and `GET /health`.
Missing or expired session returns 401.

Because the database is in Atlas, every request would otherwise cost a network round trip, and the live view fetches one screenshot per exploration step.
So the middleware keeps an in-process cache keyed by token hash with a 30-second TTL and a bounded size, evicting the oldest entry when full.
Atlas remains the source of truth; the cache exists only so a burst of screenshot requests does not pay for it repeatedly.
`POST /auth/logout` evicts its entry immediately, so a logout takes effect at once rather than after the TTL.

### 6.4 Login throttle

An in-process fixed window keyed by lowercased email: ten attempts per five minutes, then 429 with `Retry-After`.
A successful login clears the counter.
This is not a distributed rate limiter, and it does not need to be for a self-hosted tool; without it the login endpoint is a free brute-force oracle.

## 7. Run recording and replay

### 7.1 `startRun` becomes the single writer

`RunInputSchema` gains a required `userId`.
`RunStateAnnotation` does not: the graph has no interest in who owns a run, and adding it to graph state would widen the checkpointed payload for nothing.

`startRun` becomes `async` and returns after the run document exists.

```ts
export async function startRun(
  input: RunInput,
  opts?: { headless?: boolean; llm?: LlmClient; store?: Store },
): Promise<{ runId: string; done: Promise<RunState> }>
```

The document must exist before `POST /run` hands the client a run identifier, otherwise the UI navigates to `/runs/<id>` and races a 404.
`opts.store` defaults to `defaultStore()`, mirroring the existing `opts.llm ?? makeLlmClient(bus)`.

Order of operations.
Insert the run document with `status: "running"`, `startedAt`, `url`, `intent`, and `hasPrd`.
Subscribe to the bus so every `node_end` event calls `store.touchRun(runId)`, fire and forget, failures logged and swallowed.
Invoke the graph.
On resolution write the summary; on rejection write `status: "failed"` with `partialReason` set to the error message.

The summary is derived from the final `RunState`.

| Field | Source |
| --- | --- |
| `status` | `state.partial ? "partial" : "done"` |
| `finishedAt`, `durationMs` | Wall clock against `startedAt` |
| `coverageScore` | `state.coverage?.score` |
| `planIterations`, `flowsTotal` | `state.planIterations`, `state.plan.length` |
| `testsPassed`, `testsFailed` | Tally over `state.results.tests` |
| `healsAccepted` | `state.healLog.filter(h => h.accepted).length` |
| `defectsCount` | `state.defects.length` |
| `llmCalls` | `state.llmCalls` |

### 7.2 Replay

No new read path.
`EventBus` already rehydrates from `events.jsonl` when constructed, and `GET /events/:runId` already replays the full history before subscribing to live events.
For a finished run that replay ends at the `done` event and the stream closes, so the run-detail screen renders a stored run through exactly the components that render a live one.

### 7.3 The CLI

The CLI resolves a reserved account with the address `local@qa-pilot`, created on first use with the sentinel hash `-`.
`verifyPassword` rejects an unparseable hash, so nobody can log in as it through the API.
CLI runs therefore appear in that account's history, and `demo.sh` and the README flow keep working with no credentials.

## 8. API surface

| Method | Path | Auth | Change |
| --- | --- | --- | --- |
| `GET` | `/health` | none | New: `{ ok, mongo }` so Atlas reachability is checkable before a demo |
| `POST` | `/auth/signup` | none | New |
| `POST` | `/auth/login` | none | New, throttled |
| `POST` | `/auth/logout` | session | New |
| `GET` | `/auth/me` | session | New |
| `POST` | `/run` | session | Now records the run before responding |
| `GET` | `/runs` | session | New: the caller's runs, newest first |
| `GET` | `/runs/:id` | session, owner | New: the run record plus an artifact manifest |
| `GET` | `/events/:runId` | session, owner | Stream semantics unchanged |
| `GET` | `/report/:runId` | session, owner | Guard added |
| `GET` | `/runs/:runId/files/*` | session, owner | Guard added, existing traversal guards kept |

An ownership failure returns **404, not 403**, so the API never confirms that another account's run identifier exists.
The existing `isValidRunId` format check and the `relative`-based traversal guard stay exactly as they are; ownership is an additional gate, not a replacement.

The artifact manifest on `GET /runs/:id` reports which of `plan.md`, `plan.json`, `coverage.json`, `results.json`, `heal-log.json`, `defects.json`, `report.md`, and `report.html` exist, plus the trace filenames.
That lets the UI enable or disable the "Open report" and "Download traces" actions honestly instead of offering links that 404.

CORS gains `credentials: true`, with the allowed origin read from `QA_PILOT_UI_ORIGIN` and defaulting to `http://localhost:3000`.

`createApi` gains an injected store: `createApi({ start, store })`.
Its `start` is typed `(input) => Promise<{ runId: string }> | { runId: string }`, so the existing synchronous fake in `test/api.test.ts` still satisfies it.

## 9. UI design language

Tokens are declared once in `app/globals.css` through Tailwind 4's `@theme`, replacing the `neutral-950` and `amber-500` literals currently scattered through the components.

| Token group | Values |
| --- | --- |
| Surfaces | `--bg-app` warm off-white for the sidebar and page ground, `--bg-surface` white for cards, `--bg-inset` for segmented-control tracks |
| Text | `--fg` near-black, `--fg-muted` warm gray, `--fg-subtle` |
| Border | One hairline warm gray, one slightly stronger for input borders |
| Accent | Forest green solid, mint tint for badges and the sidebar card |
| Status | Pass, fail, flaky, defect, env, needs-human, each a hue plus a required icon and word |
| Radii | 8 inputs, 12 inner boxes, 16 cards, full for buttons and pills |
| Spacing | 4, 8, 12, 16, 24, 32, 48 |

Typography uses Geist Sans, already loaded through `next/font`, for the interface, and Geist Mono for run identifiers, target URLs, and the agent feed.
No new font dependency.

The current `globals.css` also sets `font-family: Arial, Helvetica, sans-serif` on `body`, which overrides the Geist variables the layout takes the trouble to define.
That is removed as part of this work.

Green is both the brand accent and the natural colour for a passing test.
Rather than split the greens, every status renders an icon and a word together, never a bare coloured dot: a check for passed, a cross for failed, a warning for flaky, a filled dot for defect.
This is more legible than the present coloured bullet and does not depend on hue.

## 10. UI screens

### 10.1 Routes

```
app/
  layout.tsx              fonts, globals, nothing else
  login/page.tsx
  signup/page.tsx
  (app)/
    layout.tsx            the shell, plus the client-side auth gate
    page.tsx              Overview
    runs/new/page.tsx     Start a run
    runs/[id]/page.tsx    Run detail, live or replayed
middleware.ts             cookie presence check, redirects to /login
```

`middleware.ts` checks only that the cookie is present, purely so an unauthenticated visitor is redirected rather than seeing a flash of empty shell.
It is not a security boundary, and the spec should not be read as claiming otherwise: the API validates every request independently, and a forged cookie gets a 401 from `:4000`.

This check works because cookies are not scoped by port.
The API on `localhost:4000` sets the cookie for host `localhost`, so requests to the Next server on `localhost:3000` carry it and middleware can see it.
That is a property of the localhost setup, not a guarantee: if the API and the UI are ever served from different hostnames, middleware stops seeing the cookie, the redirect stops firing, and the auth gate in `(app)/layout.tsx` is what handles an unauthenticated visitor.
The gate must therefore work on its own, with the middleware treated strictly as a nicety.

### 10.2 Authentication screens

No shell.
A centred card on the app ground: product mark, title, email and password fields in the shared input style, a full-width green pill button, a cross-link to the other screen, and an inline error above the button.

### 10.3 The shell

A 260px sidebar on the warm ground with a hairline right border, collapsible from an icon in its top block.

Top: the product mark and name, mirroring the reference's workspace block.
Nav: Overview, New run, Runs.
A `Reference` section with Architecture and Documentation, the latter carrying an external-link icon.
Bottom: a mint-tinted card holding the LLM budget meter, calls used against the run cap, which is the honest analogue of the reference's credit meter.
Below it a user row: initials avatar, truncated email, and a chevron opening a menu whose only item is Log out.

Main area: a breadcrumb row closed by a hairline divider, then a centred content column capped near 1040px for the forms and the dashboard, widened for the run detail, which needs the room.

### 10.4 Overview

Title and subtitle.
A row of four stat cards: runs, pass rate, defects found, heals applied.
A "Recent runs" card wrapping the history table, with columns for status, target, intent, started as a relative time, duration, a coverage meter, pass and fail counts, defects, and heals.
A row click opens the run.
The empty state is a card with one line of explanation and a green pill reading "Start your first run".

### 10.5 Start a run

Four cards, following the reference's label-left, control-right rows with helper text under the control and inset dividers between rows.

`Target`: URL, required, with helper text naming what it is; then intent, with helper text giving the "focus on auth and checkout" example.

`Sign in to the target app`: a `Require sign in?` checkbox with the reference's explanatory paragraph, revealing username and password rows only when it is checked.
This fixes a real problem in the current form, where both fields are always visible even for a target with no login at all.

`Add sources`: an inner bordered box for the product requirements document, with a mint sparkle reading "Strongly recommended" and an outlined `Upload PRD` button, a "paste instead" toggle to a textarea, and helper text about requirement extraction.

`Budget`, collapsed as advanced: max flows, max LLM calls, max minutes.
All three already exist in `RunInput` and are currently unreachable from the UI.

A sticky footer bar holds an outlined `Cancel` pill and a solid green `Start run` pill, the latter disabled until the URL parses.

### 10.6 Run detail

One component set serves a live run and a stored one.

A header with the target in mono, a status pill, the start time and elapsed duration, and `Open report` and `Download traces` actions enabled from the artifact manifest.

The pipeline strip, full width, directly under the header: the eight nodes as connected steps, showing done with a check, active in green, pending muted, and a revisit count where a node ran more than once.
This is what a demo audience watches, so it gets the top of the page rather than one row of loose pills.

Below it two columns.
The left is a tabbed card holding Feed, Decisions, Results, Plan, and Report, with tabs styled as the reference's segmented control, each panel scrolling inside itself, and the card sized against the viewport so no panel is a stubby fixed-height box.
The right is a sticky rail with a Browser card showing the latest screenshot and a Summary card holding the coverage meter, flows planned, pass and fail counts, heals, defects, and LLM calls against budget.

The report iframe lives in its tab rather than as a full-width section below the fold, which is where it sits today.

The agent feed is a dark inset console block inside its otherwise light card.
It reads as logs, and the existing per-agent colour coding would wash out to mud on white.

## 11. UI code structure

```
components/
  ui/        Button Input Textarea Checkbox Segmented Field Card CardRow
             StatusPill Table Tabs Meter Breadcrumb EmptyState Spinner
  shell/     Sidebar Topbar UserMenu BudgetCard
  run/       RunHeader Pipeline Feed Decisions Results PlanPanel BrowserCard
             SummaryCard ReportFrame
  runs/      RunTable StatCard
lib/
  api.ts     typed fetch wrapper, credentials: "include", 401 redirects to /login
  auth.tsx   AuthProvider and useUser over GET /auth/me
  events.ts  useRunEvents, unchanged except for withCredentials
  derive.ts  pure event-to-view-model functions
```

The primitives are hand-rolled rather than taken from shadcn or Radix.
The reference's surfaces are plain, the interactive needs here are a checkbox, tabs, and a menu, and the dependency would outweigh the gain.

`lib/derive.ts` is the one piece of real logic in the UI, and it currently lives inline in JSX inside `Pipeline`, `Results`, and `Decisions`.
Extracting it gives three pure functions: pipeline state from the event list, a test tally with classifications, and the decision list.
Extract it first, pin it with tests, then rebuild the components on top; that way the rewrite cannot silently change what the panels compute.

## 12. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `QA_PILOT_MONGO_URL` | required | MongoDB Atlas connection string |
| `QA_PILOT_MONGO_DB` | `qa_pilot` | Database name |
| `QA_PILOT_UI_ORIGIN` | `http://localhost:3000` | CORS origin allowed to send credentials |

All three are added to `.env.example` as placeholders and to the README configuration table.
The Atlas URL is a live credential: it goes in `qa-pilot/.env`, which is already gitignored, and it is never committed.

## 13. Testing

| Area | Test |
| --- | --- |
| Store contract | One suite parametrised over `memoryStore` and `mongoStore`; the Mongo pass is skipped unless `QA_PILOT_MONGO_URL` is set, forces a database name ending in `_test`, and refuses to drop one that does not |
| Passwords | scrypt round trip, wrong password rejected, unparseable hash returns false rather than throwing |
| Sessions | Token is never stored in plaintext, expiry is honoured, logout deletes the document and evicts the cache |
| Auth routes | Signup, login, logout, and me against `memoryStore`; duplicate address rejected case-insensitively; eleventh login attempt returns 429; cookie flags asserted |
| Ownership | Account B receives 404, not 403, on account A's run for `/runs/:id`, `/events`, `/report`, and `/files/*` |
| Run recording | The document exists before `startRun` resolves; the summary is written on success; `failed` is written when the graph throws; `node_end` touches the heartbeat |
| Derived status | A `running` record with a heartbeat older than five minutes reads as `interrupted` |
| UI logic | `lib/derive.ts` unit tests for pipeline state, the results tally, and the decision list |

Two existing files need edits rather than additions.
`test/api.test.ts` gains an injected `memoryStore` and an authenticated-request helper; its traversal and format assertions are kept verbatim, since those guards are unchanged.
`test/graph.test.ts` has one `startRun` call site, at line 42, that needs `await` now that the function is async.
The only other call sites are `src/api.ts` and `src/cli.ts`, which change as part of this work anyway.

The `ui` workspace has no test runner today.
Vitest is added there for the `lib/derive.ts` tests only, and the root `test` script is extended to include it.

## 14. Risks

Atlas has to be reachable when the demo runs, which is the cost of the database choice.
`GET /health` reports Mongo status so this is checkable in advance, and a bad URL fails at boot with a readable error instead of a hang.

Every authenticated request costs an Atlas round trip, and the screenshot path is the hot one.
The 30-second session cache in section 6.3 is the mitigation; without it the live view would be visibly slow.

The UI restructure is the largest piece of work here and touches every existing component.
Extracting `lib/derive.ts` and testing it before the JSX moves is what keeps that from being a behavioural rewrite as well as a visual one.

scrypt with a per-user salt and no pepper is appropriate for a self-hosted tool and would not be sufficient for a public multi-tenant service.
Stating it here so the choice is deliberate rather than assumed.

## 15. Deferred

Backfilling run documents for the directories already in `output/`.
A short `qa-pilot import-runs` command could read each directory's artifacts and insert a document under the local account, which would keep existing development runs visible in history.
It is not needed for any demo that starts from a fresh run, so it is left out of the first implementation.
