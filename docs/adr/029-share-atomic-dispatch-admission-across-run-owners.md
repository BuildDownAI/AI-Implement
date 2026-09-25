# 029. Share atomic dispatch admission across run owners

**Status:** Accepted — design approved on 2026-09-24; live pilot evaluation pending.
**Date:** 2026-09-23
**References:** ADR 018, ADR 026, Restate review-fix pilot

## Context

The review-fix pilot moves one run lifecycle onto Restate. Other dispatch paths continue to compete for the same team capacity.

Before the pilot, `canDispatch` checked occupancy and capacity without reserving capacity before an external launch. A per-PR Restate object cannot serialize admissions for other PRs or legacy dispatch paths.

## Decision

Use one atomic capacity check and reservation mechanism across every competing dispatch path. Include adoption of that mechanism in this pilot's scope, even when a dispatch path keeps its existing lifecycle owner.

The check and reservation succeed together or have no effect. Preserve the existing dispatch policies.

For a Restate review-fix attempt, cancellation or deadline expiry keeps both the PR and team-capacity reservation until GitHub confirms execution termination. An uncertain launch holds its reservation while it awaits reconciliation. Time passing alone does not establish that a runner stopped or that no launch occurred.

### Approved admission contract

Use a SQLite transaction for eligibility and reservation. Reserve by stable dispatch identity, with scoped issue occupancy and installation/repository/PR occupancy when a PR exists. The team capacity count comes from unreleased reservations for that mapping, not tracker labels. Initial implementation, planning, automatic review-fix, and human-comment dispatch all participate, across their existing GitHub Actions, Fly, and local execution paths. Preserve the existing exclusion of kg-refresh from this team pool.

A repeated acquire with the same identity returns its existing reservation. Another identity for an occupied issue or PR waits. Release requires the reservation's exact owner identity. A stale release cannot free a replacement's slot. Never hold a database transaction open during a network call.

| Condition | Result |
| --- | --- |
| Mapping paused or deployment holds admission | Leave work pending. |
| Issue or PR occupied | Leave work pending; do not spend another attempt. |
| Team at capacity | Leave work pending and report the same count in admin views and dispatch logs. |
| Automatic request parked or at PR budget | Preserve existing park behavior. |
| Human request | Keep the existing budget/park override; still enforce occupancy and team capacity. |
| Admission succeeds | Reserve occupancy and the applicable budget entry once for the dispatch identity. |
| Infrastructure operation retries | Keep the reservation, attempt identity, and original budget entry. |
| New replacement runner | Allocate a new identity and apply the normal budget rules. |
| Backend launch definitely failed | Release capacity; keep the dispatch history and its budget accounting. |
| Backend launch uncertain | Keep occupancy until reconciled; never infer absence from elapsed time. |
| Runner reported but backend is still active | Keep occupancy until the backend confirms termination. |
| Backend confirmed terminal | Release only the matching reservation; the lifecycle owner still controls the business outcome. |

Drain existing competing runs before switching admissions to this mechanism. This avoids inventing reservation owners for historical or partially observed executions. Every newly admitted run gets a prepared record before launch. The legacy monitors may confirm termination for legacy reservations; they cannot finalize or release Restate-owned work.

### Implementation census

The admission callers are the poll dispatch paths and review-fix drain in `src/index.ts`, and the human-comment drain in `src/comment-gapfill-drain.ts`. The existing predicate is `src/dispatch-gate.ts`. Production dispatch-record inserts flow through `appendLog` in `src/log.ts`, including `src/dispatch-failure.ts`; a failure-only history row must not acquire capacity.

The migration inventory included accessors and underlying state: `canDispatch`, `getInFlightJobs`, `getInFlightIssueIds`, `inProgressCountsByScope`, `inProgressCountsByTeam`, and `dispatch_log` status predicates. Relevant readers included `src/poll-selection.ts`, `src/in-flight-work.ts`, `src/admin.ts`, `src/restate/tools.ts`, and the tracker providers. Capacity decisions were distinguished from historical and informational uses. Fixtures and direct SQL writes were part of each affected contract issue's inventory.

The pilot adds schema without tightening existing historical columns. New tables and additive fields have their own migration issues. Any later proposal to tighten a historical constraint must first enumerate all production, fixture, and tool writers; it is not implied by this design.

## Alternatives considered

- **Reserve only for Restate review-fix attempts** — rejected. Another dispatch path can pass its capacity check before it sees the reservation and exceed the limit.
- **Use a separate orchestrator as the full pilot boundary** — rejected as the scope limit. An isolated live test remains useful, but it does not prove safe operation with competing dispatch paths.
- **Release capacity immediately on cancellation** — rejected on 2026-09-24. The external runner can remain active after the cancellation request. A replacement must wait for confirmed termination.

## Consequences

The pilot can share capacity with existing run owners. Its implementation touches admissions beyond review-fix, so the writer inventory and cross-path race tests must cover those paths.

This decision does not migrate those other run lifecycles onto Restate.
