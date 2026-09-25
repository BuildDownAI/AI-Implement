# AII-812 review-fix lifecycle cleanup audit

At feature commit `d46a6fb`, the owner-based switch and the AII-813 fault matrix are already landed. An inventory of the planned deletion seams found no remaining Legacy queue, callback, timeout, or replay branch that can own an automatic GitHub Actions Restate attempt. Removing the remaining code would delete delivery or ownership protection, not duplicate lifecycle coordination.

| Seam | Current role | Why it stays |
| --- | --- | --- |
| `processReviewFixQueue` in `src/index.ts` | For selected Restate/GHA work, records a feedback delivery in the durable inbox, then returns before Legacy admission or dispatch. | This is a delivery nudge for pending queue rows, including a missed webhook signal or a project toggle. It owns no runner, deadline, or outcome. The local execution path continues into Legacy dispatch. |
| `handleRunnerResult` in `src/runner-callback.ts` | Authenticates the pilot attempt marker, durably records the result and cycle evidence, then returns before consuming a Legacy token or calling a provider. | Callback ingress must survive. Duplicate and stale callbacks remain classified against the immutable attempt. |
| `src/review-fix-queue.ts` | Stores accepted finding versions and queue events and supports existing Legacy queue reads. | It has no Restate lifecycle owner branch to delete; accepted history must remain readable. |
| `isRestateOwnedJob` guards in `src/index.ts` | Stop Legacy monitors, timeout remediation, and boot recovery from acting on a Restate admission. | Removing a guard would let a Legacy path finalize or release a Restate owner. |

The existing `processReviewFixQueue — owner selection` cases in `src/__tests__/review-fix-drain.test.ts` prove selected GHA work only reaches the inbox while local review-fix remains Legacy. `src/__tests__/runner-callback.test.ts` proves a pilot result bypasses Legacy token state and a consumed Legacy token still returns 409. `src/__tests__/dispatch-admission.test.ts` and `src/__tests__/reaper.test.ts` prove the owner fences. The integrated `review-fix-pilot.restate.test.ts` suite proves the production-composed Restate/SQLite path against a real engine with simulated external GitHub APIs.

[AII-813 current-head CI](https://github.com/BuildDownAI/AI-Implement/actions/runs/36186518818) passed unit tests and all 131 pinned Restate tests on `5511da2`, merged to the feature branch as `d46a6fb`. AII-812's own post-audit verification must be recorded against the final feature head. Live SAN behavior remains the separate AII-815 evaluation.
