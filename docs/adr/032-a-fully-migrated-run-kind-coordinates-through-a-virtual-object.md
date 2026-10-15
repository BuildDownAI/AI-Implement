# 032. A fully migrated run kind coordinates through a Virtual Object; shared admission serves run kinds that share team capacity

**Status:** Accepted
**Date:** 2026-09-28
**References:** ADR 017, ADR 018 (rule 5), ADR 030, ADR 031, AII-682, AII-684

## Context

The review-fix pilot (ADR 030, ADR 031) reserves capacity in the SQLite table `dispatch_admissions` before every launch, stamps a lifecycle owner on the row, and fences every Legacy monitor with `isRestateOwnedJob`. Those three mechanisms exist because the pilot migrated one path of the review-fix run kind and left the Legacy, local, and human-comment paths alive beside it. Two owners share one team-capacity pool and one PR.

kg-refresh is different. One refresh runs at a time per KG source repo. It spends no team capacity (`DispatchAdmissionKind` already excludes it). After its switch slice, no Legacy path owns a kg-refresh run. The question was whether to reserve through `dispatch_admissions` anyway, for uniformity with the pilot.

## Decision

We do not. A run kind that migrates whole coordinates through one Restate Virtual Object per resource, and that object's exclusive handler is the lock.

- `KgRepo`, keyed by the KG source repo slug, holds `inFlight = { triggerId, startedAt, invocationId }` in object state. Its exclusive `trigger` handler answers `refresh-in-progress` while the marker is live, else mints the trigger id with `ctx.rand.uuidv4()`, sets the marker, and submits the `KgRefresh` workflow by one-way send. The workflow's terminal step sends `release`. The marker has no lease clock (AII-1297): the `KgRefresh.run` invocation holds the lock. `submit` stores that invocation's id and sends the shared, ingress-private `KgRepo.watch`, which attaches to the invocation and sends `release` when it ends by any route (done, failed, killed, cancelled). A paused run holds the lock until an operator cancels it in the Restate UI, the same rule as `PlanningRun`. `expire` clears only a legacy marker that has no `invocationId`.
- The workflow writes the `dispatch_log` row in one `ctx.run` because the row is run history: the Pipelines page, the in-flight banner, and `waitForQuiet` read it. The row is not the lock.
- No `dispatch_admissions` row, no lifecycle-owner stamp, no `isRestateOwnedJob` fence for this run kind. The deploy drain already sees a running refresh twice: `waitForQuiet` counts kg-refresh rows, and `queryNonCompletedInvocations` counts the `KgRefresh` invocation itself.
  - Amendment 2026-10-02 (AII-1031): the delayed `KgRepo.expire` call (since AII-1297 no longer sent) is not counted by the drain. `queryNonCompletedInvocations` excludes `scheduled` invocations, since a call that has not started has no journal and is not pinned to a deployment; counting it held every self-deploy for 4 h 10 min.

The rule for later run kinds: shared admission is the mechanism for a run kind that competes for team capacity with another owner. A run kind with one owner and its own resource uses a Virtual Object.

## Alternatives considered

- **Reserve through `dispatch_admissions` with owner `restate:{triggerId}`** — rejected. It adds a table write, a release path, and an owner fence to protect against a Legacy path that no longer exists after the switch. It also keeps a second copy of the in-flight marker that can disagree with the object.
- **The dispatch-log row as the lock (conditional insert in one transaction)** — the 2026-09-14 fallback. Rejected as the default: it is a hand-built lock for a property the exclusive handler gives natively. It stays the recorded fallback if the object and the rows ever disagree in the live proof.
- **A workflow keyed by the repo slug as the lock** — rejected. A second trigger inside `workflowRetention` would attach to the completed run instead of starting a new one.

## Consequences

Easier: one fewer table on the kg-refresh path, no owner fence to maintain, and the object's `status` handler is the one place that knows whether a refresh is in flight. Harder: the stale-marker age check is a rule the object carries itself; ADR 030's census for later run kinds must ask which side of this rule each run kind falls on.

Release order: when a `KgRefresh` run escapes through its outer `catch`, it sends `KgRepo.release` only after `failurePath` has written its `persist` and `close-row` entries, inside a `finally` so a throw (an invocation cancel) still releases. The invariant: no new refresh can start while a failed run has a last-refresh write pending, so a late `persist` from the failed run cannot overwrite a newer run's outcome. Scenario `a trigger during the failure path is rejected until it finishes` in `kg-refresh-workflow.restate.test.ts` covers it, including the final persisted outcome.
