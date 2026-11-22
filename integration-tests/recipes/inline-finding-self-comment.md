---
target: orchestrator
auth: admin
timeout_minutes: 15
---

# Inline findings do not trigger review-fix runs

Manual recipe; use a testing PR with the AI-Implement App trusted as a review author.

## Steps

1. Complete a dispatch for the PR, then have AI-Implement post an inline finding on its current head. Confirm the body ends with `<!-- ai-implement review-finding:v1 -->` and its creation time follows the dispatch.
2. Deliver its `pull_request_review_comment` webhook and inspect the response, review findings, and pending review-fix queue.
3. Post a current-head review from a trusted Claude bot quoting the same trailer in the middle, followed by a blocking finding, and deliver its webhook.

## Asserts

- The App's inline comment returns `{ ignored: true, reason: "self" }`, records no outside finding, and queues no review-fix.
- The Claude review quoting the trailer is read and its outside finding is recorded and forwarded for review-fix.

Automated regressions: `review-ledger.test.ts` and `webhook.test.ts`.
