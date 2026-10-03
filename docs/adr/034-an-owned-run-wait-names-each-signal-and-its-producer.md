# 034. An owned-run wait names each signal, its producer, and a source the orchestrator owns

**Status:** Accepted
**Date:** 2026-10-02
**References:** ADR 023, ADR 032, ADR 033, [AII-682](https://linear.app/eudoxus/issue/AII-682/migrate-kg-refresh-after-the-review-fix-pilot), [AII-899](https://linear.app/eudoxus/issue/AII-899/make-the-kg-refresh-callback-verify-only-and-report-to-the-kgrefresh), [AII-1010](https://linear.app/eudoxus/issue/AII-1010/kgrefresh-stop-the-github-run-on-a-timeout-and-on-a-late-found-run), [AII-1026](https://linear.app/eudoxus/issue/AII-1026/kgrefresh-run-watch-remove-the-workflow-run-webhook-path-find-a-run), [AII-1028](https://linear.app/eudoxus/issue/AII-1028/investigate-why-the-restate-scenario-tests-have-timing-races-what-the)

## Context

A Restate workflow that owns a run outside Restate (a GitHub Actions run, a Fly machine) must wait for that run. Restate gives a standard pattern for this wait: a durable promise for each event, raced against a durable timer, in a loop when the workflow also does periodic work. The Restate documentation shows it in "Timers and Scheduling" (a workflow promise, a reminder timer, and a timeout in one `RestatePromise.race`) and in "External events" ("For long waits, combine the primitive with a durable timer to implement a timeout").

`KgRefresh` uses this pattern. It waits for three workflow promises (`report`, `progress`, `cancel`) and one timer. A bootstrap deadline (10 minutes) limits the time to the first `progress`; a total deadline (4 hours) limits the time to the `report`.

On 2026-10-02 the first live refresh on the new path failed. The run was healthy, but the workflow ended it with `bootstrap_timeout` after 10 minutes. The cause: the `progress` promise had a handler and a route (`POST /runner/progress`, [AII-899](https://linear.app/eudoxus/issue/AII-899/make-the-kg-refresh-callback-verify-only-and-report-to-the-kgrefresh)), but no sender. The kg-refresh runner entry (`src/pipeline/kg-refresh-run.ts`) used a `NoopStepReporter`. The scenario tests resolved `progress` from the test, so no test saw that the production sender did not exist.

Two facts made this possible:

* The pattern had no written contract. Nothing said that each signal needs a named producer and a test from that producer.
* The only planned producer was in a different deployable. The orchestrator and the runner image deploy at different times, so a signal that only the runner sends can be absent for one deploy or for one pinned image.

## Decision

A workflow that owns a run outside Restate uses one wait, the **owned-run wait**, built only from Restate primitives: workflow promises, durable timers, and journaled steps. It adds no table, no settings row, no reaper rule, and no webhook.

**1. The signals.** The wait has these signals and no others.

| Signal | Primitive | Meaning | Resolved |
| -- | -- | -- | -- |
| result | workflow promise `report` | the run ended and gave its result | one time, by the verify-only runner callback |
| started evidence | workflow promise `progress` | the run executes | one time, by the first proof from any source |
| stop request | workflow promise `cancel` | an operator or a newer trigger stops the run | one time |
| tick | durable timer (`ctx.sleep`) | time for the next status read or a deadline check | each interval |

**2. The deadlines.** Two durable deadlines, both computed from the journaled dispatch time: the bootstrap deadline to the started evidence, and the total deadline to the result. At a deadline the workflow first peeks at the promises, so a signal that arrived at the same moment wins. A timeout cancels the run on its backend ([AII-1010](https://linear.app/eudoxus/issue/AII-1010/kgrefresh-stop-the-github-run-on-a-timeout-and-on-a-late-found-run)).

**3. Each signal has a named producer in production code.** A handler and a route are not a producer. The workflow file names, in the comment at each promise, the module that resolves it in production.

**4. Each producer has a contract test.** One test, in the default suite, starts from the real producer code and ends at the real route handler. A scenario that resolves the promise from the test body does not count as this proof.

**5. Started evidence has a source that the orchestrator owns, when the backend gives one.** The workflow's own status read (ADR 033) is such a source. A status read that shows the run executing counts as started evidence. The runner's progress callback is the second source, and the only one on a backend with no status read. The deadline must not depend only on a signal from another deployable when the orchestrator can read the same fact itself.

For kg-refresh this means:

* On GitHub Actions, a `watch` read with status `in_progress` sets the started evidence. `queued` does not: a run that never leaves the queue still ends with `bootstrap_timeout`.
* The kg-refresh runner entry sends step progress with a `TokenStepReporter` when it has the callback URL and the progress token, the same wiring as `src/run-autonomous.ts`.
* On Fly machines the runner's progress callback is the source.

## Alternatives considered

* **Only the runner sends the signal.** Rejected. It repairs today's failure, but an old or pinned runner image, or a deploy order of orchestrator first, gives the same failure again.
* **Only the status read.** Rejected. Fly machines have no status read in the workflow, and the runner callback already exists and costs one line of wiring.
* **Remove the bootstrap deadline.** Rejected. Without it a dispatch that never starts holds the lock for the total deadline of 4 hours.
* **A longer bootstrap deadline.** Rejected. It moves the failure to slower runs and hides a missing producer.
* **An awakeable for each run.** Rejected in ADR 033 for the same reason as before: the workflow promise already belongs to the workflow, and an awakeable needs a registry for its id.
* **Extract the wait into a shared helper now.** Not yet. `KgRefresh` is the one user. The second workflow that owns a run (planning, [AII-1022](https://linear.app/eudoxus/issue/AII-1022/end-the-planningrun-wait-from-the-planning-callback)) extracts the helper from `waitForOutcome` and keeps this contract.

## Consequences

Easier: a new run kind copies one wait with a fixed list of signals. A missing producer fails a default-suite test, not a live run. The started evidence does not depend on the version of the runner image where the orchestrator can read the run status. The pattern is the documented Restate pattern, so the Restate documentation and examples apply as written.

Harder: each new signal costs a producer comment and a contract test. On GitHub Actions the bootstrap deadline now measures "the run left the queue", not "the runner pipeline reported a step"; a run that starts and then stops with no report is found by the status read (`dispatch_lost`) or the total deadline.

Rule for later run kinds: before a workflow waits for a signal, write its row in the signal table, name the producer, and write the contract test. If the orchestrator can read the same fact itself, that read is a source too.

## Amendment (2026-10-02): awakeables, and new signals for later run kinds

**Awakeables.** The alternative "An awakeable for each run" above was rejected for two reasons. (1) The registry for the id: this no longer holds, because the id can be sent in the `run_config` envelope (ADR 033, amendment of 2026-10-02). (2) The workflow promise already belongs to the workflow: this still holds where a workflow promise already serves the signal, such as the kg-refresh `report`. Use a workflow promise there. Use an awakeable where no workflow promise serves the signal, for example one wait for each pipeline step. An awakeable resolved through the verify-only runner callback is a permitted primitive for an owned-run wait. Rules 3 and 4 apply to it unchanged: a named producer in production code and a contract test from that producer to the real route handler.

**The signal table.** "These signals and no others" is the contract for kg-refresh. A later run kind may add a signal, for example one per pipeline step, if each new signal has a row in its own signal table, a named producer, and a contract test. Re-check this ADR's rules against the new run kind before relying on them (`docs/standing-rules.md` rule 3).
