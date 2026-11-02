# 044. One ImplementationRun per implementation attempt

**Status:** Accepted
**Date:** 2026-10-26
**References:** ADR 018, ADR 035, ADR 036, [AII-1018](https://linear.app/eudoxus/issue/AII-1018/own-each-planning-run-of-a-pilot-project-with-a-restate-workflow-so-a), [AII-1550](https://linear.app/eudoxus/issue/AII-1550/run-implementation-jobs-as-a-restate-workflow), [AII-1553](https://linear.app/eudoxus/issue/AII-1553)

## Context

An implementation run that gets stuck is retried: the stuck watchdog clears the dispatched row, and a later poll dispatches the issue again with a new dispatch id, up to three attempts, then asks for a human. `PlanningRun` has no retry; it parks the issue. `ImplementationRun` had to choose between retrying inside one workflow, parking like planning, or keeping the poll-loop retry.

## Decision

One `ImplementationRun` (`src/restate/implementation-run-workflow.ts`) owns exactly one implementation attempt: one dispatch id, one reservation, one runner. At its deadline it stops the run and calls the existing bounded stuck cleanup through the `finishJob` dep (`remediateStuckJob` with `ownerCall`). The poll loop starts the next attempt as a new `ImplementationRun`. After three attempts (`STUCK_JOB_MAX_ATTEMPTS`) the "Stuck — Needs Human" path runs, as today.

`report` carries optional model usage but no job outcome. The runner callback keeps writing the outcome to SQLite, and the finish step (`finishImplementationJob`, `src/restate/implementation-run-finish.ts`) reads the `dispatch_log` row to learn what the callback already did. Every ticket move goes through `finalizeImplementation` (`src/implementation-finalize.ts`).

## Consequences

- The key is the dispatch id, and one workflow never owns two reservations, so release stays a single statement.
- Customer-visible retry behaviour does not change.
- Attempt history stays in SQLite (`dispatch_log`, `stuck_attempts`); Restate holds only each attempt's position.

## Alternatives considered

- **Retry inside the workflow.** One workflow would own several runs and reservations; a cancel or crash between attempts could leave a reservation with no owner.
- **Park the issue, as planning does.** Simpler, but it removes the automatic retry that customers rely on today.
