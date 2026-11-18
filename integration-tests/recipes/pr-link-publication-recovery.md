---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Prefixed implementation recovery and immediate roll-up links

Manual: use a disposable testing tracker and sandbox repository.

## Steps

1. Configure a project branch prefix of `custom/nested`. Open an App-authored implementation PR with the generated branch name, withholding the step-report and result link writes to simulate late publication.
2. Run the open-PR sweep and call `list_open_pulls`.
3. Complete a top-level grouping issue with commits ahead of the repository base. Run merge-up, then inspect its link before running the open-PR sweep.
4. Close or merge that roll-up PR before the next sweep, then run merge detection.
5. Restore the disposable environment.

## Asserts

- The prefixed implementation PR has a `branch-match` implementation link to its issue; `list_open_pulls` returns `tracked: true` and that issue.
- Immediately after merge-up, the roll-up PR already has a `result` link with role `roll-up`, its grouping issue identity, and the correct head and base refs.
- Merge detection records `closed-unmerged` or `merged` for the roll-up even though no sweep saw it open. It does not cancel the grouping issue or enqueue implementation reconciliation.
