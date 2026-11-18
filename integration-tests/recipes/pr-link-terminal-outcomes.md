---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Durable PR terminal outcomes (PR 1723)

Manual: use disposable tracker issues, sandbox PRs and a disposable testing database.

## Steps

1. Create two implementation PR links for one issue. Merge one PR and close the other without a merge before the next merge poll. Run detection and reconciliation. Repeat with the links inserted in the opposite order.
2. Recover a bot implementation PR solely through the open-PR branch sweep, with no job report or stored PR URL. Target the issue's own `ai-implement/feature/<issue-key>` branch. Close it unmerged and poll; repeat for `multi-issue`.
3. For an ordinary Linear implementation PR, fail the cancellation comment request once. Poll again with the comment endpoint restored.
4. Restore the disposable environment.

## Asserts

- The issue with a merged implementation reaches Done and is never cancelled by its closed sibling, regardless of link order.
- Each recovered grouping implementation stores grouping ownership and finalizes its parent on close without cancellation.
- A failed Linear comment leaves the issue active and cancellation unchecked. The next poll posts the explanation, cancels the issue and completes the cancellation decision.

Automated coverage: `npx vitest run src/__tests__/poll-merged-prs.test.ts src/__tests__/pr-link-sweep.test.ts src/__tests__/providers/linear.test.ts`.
