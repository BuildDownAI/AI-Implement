# 035. The owned-run wait is one helper, one sender, and one test kit

**Status:** Accepted
**Date:** 2026-10-03
**References:** ADR 033, ADR 034, [AII-1037](https://linear.app/eudoxus/issue/AII-1037/planning-parent-one-owned-run-wait-for-restate-owned-runs-helper-run), [AII-1038](https://linear.app/eudoxus/issue/AII-1038/add-test-gates-and-a-wait-for-a-named-workflow-step-to-the-restate), [AII-1039](https://linear.app/eudoxus/issue/AII-1039/add-the-shared-owned-run-wait-helper-with-no-callers-yet), [AII-1041](https://linear.app/eudoxus/issue/AII-1041/add-the-run-signal-sender-and-move-the-kg-refresh-runner-to-it), [AII-1043](https://linear.app/eudoxus/issue/AII-1043/add-a-guard-each-restate-workflow-promise-has-a-contract-test), [AII-1046](https://linear.app/eudoxus/issue/AII-1046/kgrefresh-stops-a-fly-machine-or-a-local-container-at-a-timeout-and-at), [AII-1019](https://linear.app/eudoxus/issue/AII-1019/add-the-planningrun-workflow-and-its-scenarios)

## The two patterns, in plain words

**The owned-run wait.** A Restate workflow starts a run somewhere else (a GitHub Actions run, a Fly machine, a local container) and then waits for it. The wait is a race. On one side are the events the run can cause: its result, a sign that it started, a request to stop it. On the other side is a timer. The first one to happen wins, and the workflow decides what to do. Every event on the list needs a named sender in production code and a test that proves the sender reaches the workflow. A deadline stops the run; it does not just stop waiting.

**The gated race test.** A test for a race must not guess at timing. The test holds a fake dependency at a gate, waits until the workflow reaches the step it wants to test, then makes the event happen and releases the gate. The test never sleeps to give the workflow time. It waits for a named step, or for a gate to be reached.

## Context

ADR 034 sets the rules of the owned-run wait: a fixed signal list, two deadlines, a named producer for each signal, and a contract test for each producer. At the time of ADR 034 only `KgRefresh` followed them, and each rule was applied by hand in that one workflow.

The work under [AII-1037](https://linear.app/eudoxus/issue/AII-1037/planning-parent-one-owned-run-wait-for-restate-owned-runs-helper-run) moved the rules into shared code, so that the next run kind does not copy them or re-read five issues to find them.

## Decision

**1. One helper does the wait.** `awaitOwnedRun` in `src/restate/owned-run-wait.ts` creates the promise arms one time for each call and returns the first event: a signal, a status read that shows the run started or ended, or a deadline. At a deadline it peeks at the promises first, so a signal that arrived at the same moment wins. The helper only reports the event. It never cancels, releases, or finalizes, because each run kind does different work at the same event. The workflow keeps that work.

The case table, as it landed:

| Run kind | Signals | Deadlines | Status read |
| -- | -- | -- | -- |
| `KgRefresh` | `report`, `cancel`, `progress` | bootstrap and total | yes, on GitHub Actions |
| `ReviewFixAttempt` | one promise, `wake`, that carries a result, a cancel, or a conflict | total only | none |
| `PlanningRun` | planned ([AII-1019](https://linear.app/eudoxus/issue/AII-1019/add-the-planningrun-workflow-and-its-scenarios)) | planned | planned |

**2. One sender sends the started signal.** *(Amended by AII-1127.)* The kg-refresh runner entry (`src/pipeline/kg-refresh-run.ts`) reports each pipeline step with `TokenStepReporter` (`src/pipeline/reporter.ts`), which posts `{ step }` to `/runner/progress` with the reusable progress token. It retries, and it never throws, because a failed signal must not fail the run. The first accepted post is the started evidence; the callback validates and redacts the step, and the workflow keeps it as a durable `step:<id>:running` or `step:<id>:ended` promise (evidence, never a wait signal, ADR 034). `RunSignalSender`, `progressOnFirstStep` and `src/pipeline/run-signal.ts` were removed because the step reporter sends the same heartbeat. The result keeps its own path: `postRunnerResult` in `src/runner-result.ts`.

**3. One test kit holds a race still.** `src/__tests__/restate/harness.ts` exports `gate` and `waitForStep`. `gate(label)` is a single-use gate: a fake calls `wait()` and parks until the test calls `release`; the test calls `reached()` to know the fake got there. A gate never re-arms, because a re-arming gate would park a retried `ctx.run` step a second time and deadlock the scenario. `waitForStep(read, step)` polls a workflow's status read until its `step` equals the named step, so a test sends a signal only after the workflow reached that step. The one permitted sleep is `settle`, and only before a negative assertion.

**4. One guard checks that each promise has a producer test.** `src/__tests__/restate-producer-guard.test.ts` runs in the default suite with no Docker. It finds each `ctx.promise("<name>")` in a Restate workflow file under `src/restate/` and requires a default-suite test titled `contract: <Workflow>.<promise>`. Scenario tests in `src/__tests__/restate/` resolve promises from the test body, so the guard does not read them. The guard has no allowlist.

**5. A timeout and a cancel stop the run on each backend the workflow uses.** Ending the wait does not end the run. In `KgRefresh`, at a bootstrap timeout, a total timeout, or a cancel, the workflow stops the run on the backend:

* GitHub Actions: `cancelWorkflowRun`.
* Fly machines: `destroyMachine` (`src/fly-machines.ts`).
* Local Docker: `stopLocalContainer` (`src/local-docker.ts`).

The workflow reaches the Fly and local-Docker stops through its `stopMachineRun` dependency, composed in `src/restate/kg-refresh-production.ts`. The reaper stays the backstop for a stop that fails. `ReviewFixAttempt` has no status read and stops its run through its own worker (`worker.cancel`), not through these three calls; a run kind states its own stop.

## Alternatives considered

* **Copy the wait into each workflow.** Rejected. Each copy can drift from ADR 034, and a missing producer is the failure ADR 034 was written to prevent.
* **Let the helper cancel the run.** Rejected. The right stop differs by run kind (`KgRefresh` stops a backend run; `ReviewFixAttempt` stops through a worker and waits to confirm it ended).
* **Sleep in tests to let the workflow reach a step.** Rejected. A sleep is a guess, and the timing races it hides are what [AII-1028](https://linear.app/eudoxus/issue/AII-1028/investigate-why-the-restate-scenario-tests-have-timing-races-what-the) investigated.
* **An allowlist in the producer guard.** Rejected. An allowlist is where a missing sender hides.

## Consequences

Easier: a new run kind calls one helper with its signal list and deadlines, and reuses the sender and the test kit. A promise with no producer test fails the default suite. A race test is deterministic.

Harder: the helper reports and does not act, so each run kind writes its own handling of every event, including the stop on each backend.

## Checklist for a new run kind that a workflow owns

1. List the signals in a table: name, primitive, meaning, who resolves it. Use only the signals the run kind needs.
2. Wait with `awaitOwnedRun`. Choose the deadlines (bootstrap, total, or total only) and say whether a status read exists.
3. Name the production producer of each signal in a comment at the promise. Send the started signal with `TokenStepReporter` and the result with `postRunnerResult`.
4. Add a default-suite test titled `contract: <Workflow>.<promise>` for each promise, from the real producer to the real route handler. `src/__tests__/restate-producer-guard.test.ts` fails without it.
5. Write the race scenarios with `gate` and `waitForStep` from `src/__tests__/restate/harness.ts`. Do not sleep to wait for a step.
6. Name how a timeout and a cancel stop the run on each backend the run kind uses.
7. Re-check ADR 034 and this ADR against the new run kind (`docs/standing-rules.md` rule 3), and amend them if a reason no longer holds.
8. Use the lifecycle kit steps (`reserveOwnedRun`, `readOwnedRunStatus`, `cleanupOwnedRun`, `reportOwnedRunOutcome` in `src/restate/owned-run-lifecycle.ts`) around the wait. [ADR 036](036-an-owned-run-lifecycle-is-one-kit-and-one-contract-suite.md).
9. Run the contract suite (`registerOwnedRunContract`) against the workflow, and list each `isRestateOwnedJob` fence with the kit step that replaces it. [ADR 036](036-an-owned-run-lifecycle-is-one-kit-and-one-contract-suite.md).
