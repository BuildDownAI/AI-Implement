---
target: orchestrator
auth: runner progress bearer
timeout_minutes: 5
---

# Review publication phase restriction (AII-1652)

Manual: use a testing orchestrator and a disposable repository/PR. Obtain valid
progress tokens from test runs without recording their values in test output.

## Steps

1. POST `/runner/review-publication` with a planning run's progress bearer and
   `{ "prNumber": 42, "headSha": "<current PR head SHA>", "iteration": 0,
   "body": "Phase restriction smoke test", "comments": [] }` (substitute the test PR).
2. Repeat with a kg-refresh run's progress bearer.
3. Confirm neither request starts a `PostPushReviewPublication.publish` invocation
   in the Restate admin UI and neither creates a GitHub review.
4. Repeat with implementation and gap-analysis progress bearers from runs scoped
   to the test repository. Use distinct iteration values to avoid deduplication.
5. Repeat an allowed request unchanged to verify duplicate suppression.

## Asserts

- Planning and kg-refresh requests return 403 `{ "error": "phase_not_allowed" }`.
- Both allowed phases return 200 publication results and create COMMENT reviews.
- Repeating the same publication returns the original result without another review.

The automated Restate test also exercises missing-run phase rejection and injects
an unexpected route error to verify one error log and a 500 response; intentional
ingress failures continue to return 503.
