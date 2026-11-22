---
target: orchestrator
auth: admin
timeout_minutes: 30
---

# Rejected outside findings stay closed

Manual recipe; use a testing PR whose outside review includes a demonstrably incorrect finding.

## Steps

1. Run a fix pass that dispositions the finding `invalid` with a reason. Record its finding key and dispatch id.
2. Inspect the PR thread, fix-pass comment, final comment, and corresponding `review_findings` row.
3. Deliver the same outside finding again with the same source, path, line, and body. Let the late external review evaluate a head whose checks pass and whose only listed findings are deferred or rejected.
4. Repeat with a different finding key, then with an open or missing ledger row.

## Asserts

- A threaded finding receives `Not changed: {reason}` before its thread resolves. A summary-only finding needs no thread mutation.
- Fix-pass and terminal comments show the rejection and reason under `Rejected by the fix pass`.
- The row is `rejected`, stays rejected on re-report, and is excluded from open findings; the repeated key causes no new review-fix dispatch.
- With clean internal review and no new gating finding, the run approves. Late external review writes the approval mark when every listed finding is deferred or rejected.
- A different key still gates; an open or missing row withholds late approval.

Automated regressions: `finding-dispositions`, `post-push-review`, `runner-callback`, `review-ledger-store`, and `late-external-review` unit tests.
