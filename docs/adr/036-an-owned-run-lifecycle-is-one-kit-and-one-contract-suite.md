# 036. An owned run's lifecycle is one kit and one contract suite

**Status:** Accepted
**Date:** 2026-10-04
**References:** ADR 034, ADR 035, [AII-1018](https://linear.app/eudoxus/issue/AII-1018/own-each-planning-run-of-a-pilot-project-with-a-restate-workflow-so-a), [AII-1058](https://linear.app/eudoxus/issue/AII-1058/planningrun-close-the-gaps-found-in-the-aii-1018-build-down-before-a), [AII-1055](https://linear.app/eudoxus/issue/AII-1055/planning-the-pipeline-work-that-stays-on-legacy-after-planningrun-as), [AII-1062](https://linear.app/eudoxus/issue/AII-1062)

## Context

ADR 035 gave the owned-run wait one helper. The steps before and after the wait were still written by hand in each workflow. The build-down of AII-1018 found five gaps in `PlanningRun`, and each gap was a lifecycle step that a Legacy function did and the workflow did not. `KgRefresh` has one of the same gaps. Every run kind that moves to Restate needs the same steps.

A fact about `ctx.run` (confirmed for SDK 1.17.1): a step with no `maxRetryAttempts` retries without limit. When a bounded step uses its last attempt, `ctx.run` throws a `TerminalError`. A status read with no bound can therefore hold the wait for ever, and the deadline never comes.

## Decision

**1. One kit holds the steps.** `src/restate/owned-run-lifecycle.ts` holds the lifecycle functions. Each runs a plain function the caller passes in one named `ctx.run` step with `maxRetryAttempts: 3`, and re-throws a suspension.

| Function | Step | When all attempts fail |
| -- | -- | -- |
| `acceptOwnedRunReport` | `record-usage` | throws; report remains unresolved |
| `reserveOwnedRun` | `reserve` | throws; nothing is held |
| `readOwnedRunStatus` | caller's name | logs, returns `unknown` |
| `cleanupOwnedRun` | `cleanup` | logs, returns |
| `reportOwnedRunOutcome` | `outcome` | logs, returns |

**2. One error rule.** A best-effort step swallows every error except a suspension or invocation cancellation (409), because the release must run. Reservation and report intake do not swallow failures.

**3. The caller's function must be safe to run twice.** The kit fixes the step name and the bound. It cannot make an effect idempotent. The reservation is check-then-take, keyed by the dispatch id, so a retry after a commit returns `true`. The launch checks for an existing run in the same step.

**4. One contract suite proves the lifecycle.** `src/__tests__/restate/owned-run-contract.ts` exports `registerOwnedRunContract(adapter, envFor)`. An adapter says how to start the workflow, how to inject each fault, and how to read the calls it recorded. The first five scenarios: a status read that fails on each attempt still reaches the deadline, stops, and releases; a crash after the launch adopts the run; a normal end runs `cleanup` with the run id, `outcome` once, then the release; a refused reservation launches nothing, cleans up nothing, and releases nothing; a failed `cleanup` and `outcome` still release. Each run kind runs the suite against its own workflow.

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

## Result intake

`acceptOwnedRunReport(ctx, "report", value, onAccept?)` accepts plain JSON without secrets. It compares recursively sorted object keys (array order matters): the first value is accepted, an equal value is a duplicate, and a different value throws 409, including after the owning run completes. Resolved `null` is a value. The optional callback runs in bounded `record-usage` before resolution; exhausted failures propagate without resolving. Completed steps replay from the journal, including a crash before resolution. As with other kit effects, an unfinished step may retry, so the callback must be idempotent. A reserved companion promise (`owned-run-report-owner:<promiseName>`) atomically elects one reporting invocation before any callback runs. Concurrent reports attach to that invocation before comparing the resolved value, so equal reports are duplicates and different reports conflict without recording usage again. If attaching proves the owner definitively failed, contenders advance to the next numbered companion promise and elect a new owner atomically. A later report can therefore recover an unresolved result after exhausted storage attempts; a crash or suspension retains the current owner and its journal.

Scenario 6 checks accepted, duplicate, conflict and one callback on every harness variant. All four runner workflows execute it under every harness variant; none leaves scenario 6 pending.

## Status after adoption

The original kit adopters are: `PlanningRun` (AII-1064, AII-1065, AII-1068) and `KgRefresh` (AII-1066). `PlanningRun` runs scenarios 1–6. `KgRefresh` runs scenarios 1 and 6. Four scenarios do not apply to it:

* **Scenario 2** (a crash after the launch adopts the run): the `dispatch` step already looks the run up by title before it dispatches.
* **Scenario 3** (a normal end runs `cleanup`, `outcome`, then the release): a normal end runs the rail gates, and `KgRefresh` has no `cleanup` step.
* **Scenario 4** (a refused reservation): `KgRefresh` holds no `dispatch_admissions` reservation. Its marker is the `KgRepo` object (ADR 032).
* **Scenario 5** (a failed `cleanup` and `outcome` still release): `KgRefresh` has no `cleanup` step to fail.

The AII-1058 gaps are closed in `PlanningRun`. The table above lists each fenced Legacy function by call site in [restate.md](../restate.md#the-owned-run-lifecycle-kit).

`ImplementationRun` also uses the lifecycle kit and scenarios 1–6. `ReviewFixAttempt` uses `readOwnedRunStatus` and runs scenario 6; scenarios 1–5 wait for AII-1627. All four workflows call `acceptOwnedRunReport` from their shared `report` handler (`result` for `ReviewFixAttempt`). Optional usage is stored through `recordUsage` for the dispatch id in `record-usage` before the report promise resolves. Only shared handlers changed; the `run` journals are unchanged, so live runs can replay without a drain. The kit fixture executes all six scenarios.

The authenticated runner callback checks a Restate-owned run's token without consuming it and forwards sanitized usage with a dispatch-scoped idempotency key. It does not write usage itself. Runner result posts use one bounded retry policy: deadline plus grace, or eight attempts. AI-Implement records model usage; the control plane calculates costs from its own price table, and the `list_job_accounting` contract is unchanged.

Every owned-run result uses the authenticated dispatch id as its forwarding idempotency key, including ReviewFixAttempt. Identical retries reuse the cached acknowledgement, including after admission release. The review-fix client compares the returned result fingerprint with the forwarded metadata and usage, rejecting changed bodies even when ingress returns a cached acknowledgement.
