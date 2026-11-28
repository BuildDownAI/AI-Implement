---
target: orchestrator
auth: admin
timeout_minutes: 10
---

# Held KG push status (AII-2125)

Use a test instance whose last real refresh reached the decision gate and ended with a stored failed `kg-snapshot-push` step. Historical outcomes work; no new refresh is required.

## Steps

1. Call MCP `get_kg_status` and authenticated `GET /api/kg/status`.
2. Confirm `lastRefresh.held` is true and both answers show `lastRefresh.steps`'s `kg-snapshot-push` status as `held`, whether the outcome's `ok` is true or false.
3. Open `/admin#kg-pipelines`. Confirm the last refresh step table shows `kg-snapshot-push: held`.
4. On a test instance with an outcome without `held: true` and a failed push step, repeat the reads and confirm the push status remains `failed`.

## Asserts

- MCP and HTTP agree on the last refresh's step statuses.
- Only a failed push step on a held outcome changes to `held`; other step statuses and timing fields match the stored outcome.
- Read the `kg_refresh_last_refresh` settings record through a read-only database inspection before and after the status requests: it is unchanged and its push step remains `failed`.
