---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Grouping PR retention and reopened merges (AII-2014)

Manual: use disposable tracker issues, sandbox PRs and a disposable testing database.

## Steps

1. Report a grouping parent's implementation PR through the authenticated job PR writer. Report a later non-grouping gap-fill for the same PR, then remove the issue's dispatch rows.
2. Close that PR without merging and run the merge poll. Make finalization fail once, then succeed on the next tick.
3. For an ordinary implementation PR, close without merging and poll to record a skipped reconciliation tombstone.
4. Reopen that PR and run the open-PR sweep, then merge it. Run merge detection and the reconciliation worker.
5. Repeat step 3 with another PR, but deliver a signed merged-PR webhook after reopening and merging. Redeliver the webhook and run the worker. Restore the disposable environment.

## Asserts

- The grouping link retains ownership after the gap-fill and pruning. Failed finalization leaves it open with no tombstone or cancellation; successful finalization tombstones once without cancelling the parent.
- Both merge paths promote the existing skipped row to pending with the same row ID and record a merged link.
- The worker marks each ordinary issue merged once; repeated detection/delivery creates no additional row.
