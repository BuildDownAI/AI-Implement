---
target: orchestrator
auth: admin
timeout_minutes: 15
---

# Stopped jobs without invocation rows (AII-2102)

Manual: requires a configured-agent project and a stopped implementation dispatch with a stored agent snapshot but no model invocation rows.

## Steps

1. Record the implementation model frozen in the dispatch's stored snapshot.
2. Open Reports for that repository and a window containing the dispatch.
3. Inspect the per-model implementation entry. Repeat for a timed-out dispatch and dispatches concluded as `ended_without_callback` and `workflow_cancelled`.
4. Change the repository or date window to exclude the dispatch.

## Asserts

- Each included dispatch contributes one job and one stopped job to its frozen implementation model, even if that model has no calls.
- It adds no calls, tokens or spend. Unmeasured values remain unknown.
- Configured planning and review models gain no membership from the snapshot alone.
- Excluded dispatches do not contribute; dispatches with actual calls use call attribution instead.
