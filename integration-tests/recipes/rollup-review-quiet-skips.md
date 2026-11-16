---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Roll-up review quiet skips (AII-1868)

Manual: requires a disposable repository and project mapping on a testing
orchestrator containing AII-1868. Observe its logs and queue through the operator's
normal admin access. Do not use a production feature tree.

## Steps

1. Finalize a grouping parent with an empty description and no implementation run,
   then let its children complete and open its roll-up PR.
2. Wait for the synthetic roll-up review queue item to drain, then wait another poll.
3. In a separate tree whose parent has an implementation run, configure an allowed
   custom runner image through `.ai-implement/image.yml` on the default branch.
   Complete the children and let the roll-up review drain. Repeat for GHA and Fly.
4. Remove the override and advance the roll-up head to request another review.
5. Restore the sandbox's original image configuration and pause its mapping.

## Asserts

- The parent without a run produces a terminal `skipped` queue item and a
  `no parent dispatch log` message. No no-record comment is posted, and the next
  poll does not process that item again.
- Each custom-image review produces a terminal `skipped` item and a runner-image
  log message. No runner launches, PR comment, or failure notification appears.
- The paired-image review launches and posts its advisory verdict.
- Skips create no findings, approval mark, or `LateExternalReview` input.

Automated coverage: `src/__tests__/comment-gapfill-dispatch.test.ts` and
`src/__tests__/implementation-run-gapfill.test.ts`.
