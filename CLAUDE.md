# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repo currently contains no application code — just `README.md` and
`problem_explanation_9dm9yp4f98s.pdf` (the hackathon problem statement). There
is no build system, package manifest, test runner, or lint config yet. When
the first code is added, update this file with the actual commands
(build/lint/test/run) and the real architecture — don't rely on this section
staying accurate once implementation starts.

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

- No stack has been chosen yet. When scaffolding the project, pick a stack
  and record it here (commands to install, run the orchestrator, run each
  sub-agent, and run any tests) so future sessions don't have to rediscover it.
- Since the deliverable *is* an agent pipeline (Planner → gap-check →
  Generator → Execute/Heal → Report), keep that stage boundary explicit in
  whatever code structure gets built — the evaluation criteria specifically
  reward visible orchestration logic, not just working tests.
