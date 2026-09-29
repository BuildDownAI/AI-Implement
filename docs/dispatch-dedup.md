# Dispatch dedup

The `dispatched` table (`src/dedup.ts`) is the orchestrator's record of "this issue has a
run in flight or recently handed off". Poll selection skips any issue that has a row, so
an issue is dispatched once until something explicitly clears it.

## Schema

| Column | Meaning |
|---|---|
| `issue_id` | Tracker-native issue id (primary key): a Linear UUID, a Jira numeric id, or a filesystem ticket id |
| `dispatched_at` | Epoch ms when the row was written |
| `issue_identifier` | Human key (`AII-123`, `ACME-42`), for the Audit page |
| `issue_title` | Title at dispatch time, for the Audit page |
| `team_key` | Key of the mapping that dispatched the row; `NULL` for rows written before the column existed |

There is **no TTL**. A row never expires on its own — see "Clearing" for every path
that removes one.

## Writing

`markDispatched` is called only after a dispatch succeeds (`src/index.ts`), and when an
issue that already has an open PR is routed to a review-fix run instead of a fresh
implementation. A failed workflow dispatch writes no row.

## Reading

- `selectIssuesToDispatch` (`src/poll-selection.ts`) skips an issue that has a row.
- `canDispatch` (`src/dispatch-gate.ts`) refuses a non-gap-fill dispatch for an issue
  that has a row. Gap-fill runs are exempt, because they work on an open PR by design.

## Clearing

| Path | When |
|---|---|
| Dispatch rollback | The dispatch threw after the row was written |
| Failed / timed-out run | After `clearWorkingState` resets the tracker, so the issue can be re-dispatched |
| Stuck watchdog (`src/stuck-watchdog.ts`) | A stuck run is reset and retried, within `STUCK_JOB_MAX_ATTEMPTS` |
| Admin job destroy (`src/admin.ts`) | An operator destroys a running job |
| Filesystem retry (`src/filesystem-ticket-lifecycle.ts`) | A local filesystem ticket is retried |
| Manual | `DELETE /api/dedup/{id}` — the Audit page's Delete, admin role only |
| Reconcile loop | See below |

## Reconcile loop

Every poll (`src/index.ts`, before the snapshot fetch) calls `reconcileDispatched`
(`src/dedup-reconcile.ts`) with every row (`getDispatchedRows`) and the unfiltered
`getMappings()`, so paused mappings still reconcile. Each row is placed by
`row.team_key`, falling back to the newest non-null `dispatch_log.team_key` for the issue
(`getLatestTeamKeyForIssue`), then to its mapping and that mapping's `ticketingProvider`.
Rows are grouped by provider id and each provider's `fetchLifecycleStates` is called
**once**, with only its own group's ids.

| Team key | Mapping | Provider call | Answer for the id | Outcome |
|---|---|---|---|---|
| found | exists | succeeds | `active` | keep |
| found | exists | succeeds | `completed` / `cancelled` | clear (`clearedTerminal`), no breaker failure |
| found | exists | succeeds | absent from the map | clear and `recordDispatchFailure(id, "implementation", "reconcile_not found")` (`clearedNotFound`) — the owning tracker says the issue does not exist |
| found | exists | throws, or provider lookup throws | — | **keep** (`keptProviderError`), logged once per provider |
| found | no mapping with that key | — | — | clear (`clearedMappingRemoved`), no breaker failure: poll selection can never dispatch it, so the row guards nothing |
| none from either source | — | — | — | **keep** (`keptUnplaced`) |

A tracker error always means "unknown, keep the row", never "not found". During a
tracker outage rows are therefore kept, where they used to be cleared with a breaker
count. A kept row that should not stay (for example an unplaced legacy row with no job
history) is cleared by an operator with `DELETE /api/dedup/{id}`.

When any counter is non-zero, the poll logs
`[reconcile] kept=<n> terminal=<n> notFound=<n> mappingRemoved=<n> unplaced=<n> providerError=<n>`.

The breaker (`src/dispatch-breaker.ts`) parks an issue once it records
`DISPATCH_BREAKER_THRESHOLD` (default 3) consecutive failures, and `canDispatch`
refuses a parked issue.

Mappings that share a `ticketingProvider` are asked through one sample mapping, as the
reaper's sweep does; per-mapping tracker instances of the same provider id are not
distinguished.
