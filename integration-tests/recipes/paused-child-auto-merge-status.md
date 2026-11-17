---
target: orchestrator
auth: admin
timeout_minutes: 10
---

# Paused projects do not report children as awaiting auto-merge (AII-1978)

Use a disposable project with auto-merge enabled and a tracked, approved child PR targeting a grouping branch. Pause the project before the approval is recorded so the merge worker cannot merge it. Let the child run finish and any queued review work drain.

## Steps

1. Call `list_open_pulls` and find the child PR.
2. Confirm its workflow does not report `auto-merge-pending`; a completed approved run with no other queued work reports `settled` / `completed`.
3. Unpause the project and call `list_open_pulls` again before the next auto-merge tick.
4. Confirm the approved child reports `active` / `auto-merge-pending` while it remains open.

## Asserts

- Pausing suppresses the pending auto-merge status even with auto-merge enabled and an approved child.
- Unpausing restores the pending status for the same eligible PR without waiting for the GitHub list cache to expire.
