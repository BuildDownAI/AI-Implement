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


## Cancellation regressions

1. For one disposable implementation issue, open two implementation PRs. Merge
   one and close the other unmerged before a single merge poll, repeating with
   the opposite publication order.
2. For a grouping parent's closing run, revoke the run before it reports a PR
   URL, then let its App-authored implementation PR publish late. Sweep while
   it is open, close it unmerged, and poll twice.
3. Supply the exact run-to-PR URL association and poll again.

Assert that the issue in step 1 is never cancelled and its merge reconciliation
is queued once. In step 2 the grouping parent is never cancelled; the closed
link retains a null cancellation decision and finalization waits for current-PR
identity. Step 3 finalizes the current grouping parent once. An older late
publication must not supersede a newer implementation PR.
