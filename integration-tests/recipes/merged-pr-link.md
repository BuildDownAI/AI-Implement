---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Merged pull requests survive dispatch pruning (AII-2003)

Manual: use a disposable testing database and signed GitHub webhook deliveries.

## Steps

1. Configure two mappings for the same sandbox repository. Create an implementation pull request link to an issue owned by the second mapping, then remove its dispatch log rows.
2. Deliver a signed `pull_request` `closed` payload with `merged: true`, the linked repository and PR number, head ref, HTML URL and merge commit SHA.
3. Inspect the link and reconciliation queue before the worker drains it. Redeliver the payload.
4. Run the reconciliation worker and check the linked issue in its tracker.
5. Repeat delivery for a roll-up link and an unlinked PR. Restore the disposable environment afterward.

## Asserts

- The implementation link has outcome `merged` and a numeric close timestamp; exactly one reconciliation contains the tracker issue ID, identifier, repository, PR number and merge SHA.
- Redelivery returns `ignored: true` with reason `already queued` and leaves one queue row.
- The worker selects the second mapping and marks its issue merged.
- The roll-up link records `merged`, returns `ignored: true` and queues nothing.
- The unlinked PR returns `ignored: true` with reason `no pull request link` and queues nothing.
