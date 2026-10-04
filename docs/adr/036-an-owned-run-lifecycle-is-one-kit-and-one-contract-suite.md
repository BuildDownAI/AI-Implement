# 036. An owned run's lifecycle is one kit and one contract suite

**Status:** Accepted
**Date:** 2026-10-04
**References:** ADR 034, ADR 035, [AII-1018](https://linear.app/eudoxus/issue/AII-1018/own-each-planning-run-of-a-pilot-project-with-a-restate-workflow-so-a), [AII-1058](https://linear.app/eudoxus/issue/AII-1058/planningrun-close-the-gaps-found-in-the-aii-1018-build-down-before-a), [AII-1055](https://linear.app/eudoxus/issue/AII-1055/planning-the-pipeline-work-that-stays-on-legacy-after-planningrun-as), [AII-1062](https://linear.app/eudoxus/issue/AII-1062)

## Context

ADR 035 gave the owned-run wait one helper. The steps before and after the wait were still written by hand in each workflow. The build-down of AII-1018 found five gaps in `PlanningRun`, and each gap was a lifecycle step that a Legacy function did and the workflow did not. `KgRefresh` has one of the same gaps. Every run kind that moves to Restate needs the same steps.

A fact about `ctx.run` (confirmed for SDK 1.17.1): a step with no `maxRetryAttempts` retries without limit. When a bounded step uses its last attempt, `ctx.run` throws a `TerminalError`. A status read with no bound can therefore hold the wait for ever, and the deadline never comes.

## Decision

**1. One kit holds the steps.** `src/restate/owned-run-lifecycle.ts` has four functions. Each runs a plain function the caller passes in one named `ctx.run` step with `maxRetryAttempts: 3`, and re-throws a suspension.

| Function | Step | When all attempts fail |
| -- | -- | -- |
| `reserveOwnedRun` | `reserve` | throws; nothing is held |
| `readOwnedRunStatus` | caller's name | logs, returns `unknown` |
| `cleanupOwnedRun` | `cleanup` | logs, returns |
| `reportOwnedRunOutcome` | `outcome` | logs, returns |

**2. One error rule.** A best-effort step swallows every error except a suspension, because the release must run. The reservation is the one step that does not swallow.

**3. The caller's function must be safe to run twice.** The kit fixes the step name and the bound. It cannot make an effect idempotent. The reservation is check-then-take, keyed by the dispatch id, so a retry after a commit returns `true`. The launch checks for an existing run in the same step.

**4. One contract suite proves the lifecycle.** `src/__tests__/restate/owned-run-contract.ts` exports `registerOwnedRunContract(adapter, envFor)`. An adapter says how to start the workflow, how to inject each fault, and how to read the calls it recorded. The five scenarios: a status read that fails on each attempt still reaches the deadline, stops, and releases; a crash after the launch adopts the run; a normal end runs `cleanup` with the run id, `outcome` once, then the release; a refused reservation launches nothing, cleans up nothing, and releases nothing; a failed `cleanup` and `outcome` still release. Each run kind runs the suite against its own workflow.

## The rule for a new run kind

Before a run kind moves to Restate, list each Legacy function that fences on `isRestateOwnedJob` and name the kit step (or workflow step) that does its work. The functions today:

| File | Legacy work it skips for a Restate-owned job | Kit step that must do it |
| -- | -- | -- |
| `src/reaper.ts` | removes a machine of a terminal or orphaned job | `cleanupOwnedRun` |
| `src/stuck-watchdog.ts` | stops the runner, re-arms or clears dedup, notifies | the stop in the workflow, `reportOwnedRunOutcome` |
| `src/index.ts` | TTL and monitor handling per backend, breaker count and notice at a terminal job, startup sweep of stale machines | `readOwnedRunStatus` and the deadline, `reportOwnedRunOutcome`, `cleanupOwnedRun` |

A Legacy function with no named step is a gap, and it is closed in the workflow before the switch.

## Alternatives considered

* **A base class or a state machine for a run.** Rejected. Four thin functions on `ctx.run` are enough, and each run kind keeps its own order and its own stop.
* **Copy the steps into each workflow.** Rejected. That is how the gaps of AII-1018 came about.
* **Let each best-effort step fail the workflow.** Rejected. A failed notice must not keep a reservation held.

## Consequences

Easier: a new run kind calls four functions and runs one suite. A step with no bound cannot be added without a decision.

Harder: an adapter must supply fault injection, and the caller must write each effect to be safe to run twice.
