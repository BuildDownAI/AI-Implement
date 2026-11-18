---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Roll-up review queued head (AII-2010)

Manual: use a disposable feature tree and testing orchestrator with its paired
runner image. Observe queue rows and runner logs through normal operator access.

## Steps

1. Run a roll-up review at head A with a reviewer returning a transient failure,
   such as PROVIDER_OVERLOADED, and verify attempt 1 is queued for A.
2. Hold dispatch until a new commit advances the PR to B, then release the retry.
3. Let B's own roll-up review drain without changing its head.

## Asserts

- A's retry envelope carries `reviewOnly.expectedHeadSha` equal to A.
- A's retry logs a skip naming A and B, invokes no reviewer, posts no verdict,
  files no child, queues no retry, and finalizes its dispatch successfully.
- B's review carries B and posts one advisory verdict as usual.

Automated coverage: `review-only.test.ts`, `comment-gapfill-dispatch.test.ts`,
`implementation-run-gapfill.test.ts`, and `runner-callback.test.ts`.
