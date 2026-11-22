---
title: "A test file posted to the live orchestrator from inside dispatched runners and burned every run's result token"
module: runner-callback
category: workflow-patterns
date: 2026-09-08
problem_type: workflow_issue
component: test_suite
severity: high
root_cause: test_reached_live_service
resolution_type: test_fix
symptoms:
  - "Every implementation run's terminal report refused `409 already_consumed`; no PR link, no summary, no approval mark on the run record"
  - "`get_issue_dispatch_status` shows `conclusion: success` with `mergeVerdict: hold`; grouped child PRs held 'no approval mark' forever"
  - "On GitHub Actions the tracker never advanced, so the issue held a dispatch slot; the per-team cap filled with finished runs"
  - "The test suite was green the whole time"
tags:
  - run-token
  - runner-callback
  - vitest
  - environment-leak
  - approval-mark
  - self-inflicted
related_components:
  - runner-callback
  - auto-merge
  - kg-refresh
---

# A test file burned every dispatched run's result token

**Window:** 2026-09-04 (the test file landed) to 2026-09-07 22:37Z (PR #467, AII-567).
**Cost:** about three days of build-down. Held child PRs, a fix (AII-572) chasing a mark that could
never be written, hand merges after gauntlets, a team cap stuck at 3/3 on finished runs, and a
gap-fill on an old branch that lost its report even after the fix.

## What happened

A dispatched runner carries `RUN_TOKEN` and `RUNNER_CALLBACK_URL` in its environment. The run's
terminal report is posted with that single-use token; the orchestrator consumes it on first use.

`src/__tests__/kg-refresh-run.test.ts` called the real `runKgRefresh` at ten sites, eight of them
without a fake fetch. `postRunnerResult` reads both credentials from the environment and falls back
to the global `fetch`. Inside the runner, the agent's own `npm test` therefore posted to the live
orchestrator eight times mid-run. The first post consumed the token. Minutes later the run's real
report was refused.

We caused this ourselves, and the suite hid it: every test passed either way.

## Why it was hard to see

- The only evidence was a listener counting `POST /runner/result` (8 per run), or the
  `[runner-callback] POST failed HTTP 409` line deep in a 30-minute run log.
- The visible symptom was elsewhere: the merge gate holding PRs, the tracker not advancing, the
  cap filling. Each looked like its own bug.

## The fix, and its limit

PR #467 adds a file-level `beforeEach` that clears both credentials in that one file. That protects
only branches that contain it: a branch cut before #467 still burns the token when the agent runs
its tests (observed on the #466 gap-fill, 2026-09-08). AII-588 moves the hook to a vitest setup
file so every suite starts disarmed. A runner-side guard was considered and rejected: it would put a
test-only branch in production code, and a throwing variant lands in the same `catch` that posts again.

## The rule

1. A test that touches a runner entry point (`runKgRefresh`, `runAutonomous`, `postRunnerResult`)
   runs with `RUN_TOKEN`, `RUNNER_CALLBACK_URL`, and `RUN_PROGRESS_TOKEN` cleared.
2. A test that deliberately re-arms points at an unroutable host.
3. Verify with a listener, not with the test result: with the credentials set to a local listener,
   `npm test` must produce zero `POST /runner/result`.
4. On a branch that predates the fix, merge `testing` in before re-running, or expect the 409.

## How to recognise it fast

`get_issue_dispatch_status` → `conclusion: success` and `mergeVerdict: hold` on the same run; the
GHA log → `POST failed HTTP 409: {"error":"already_consumed"}`.
