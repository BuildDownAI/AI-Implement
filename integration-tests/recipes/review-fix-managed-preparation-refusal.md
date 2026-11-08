---
target: orchestrator
auth: admin session
timeout_minutes: 5
---

# Managed review-fix preparation refusal (AII-1755)

Manual: use a testing orchestrator with the review-fix pilot enabled and a disposable
PR targeting a workflow with private run configuration and stage-agent support.

## Steps

1. Opt the project into managed agent configuration with a ready Claude subscription
   stage. Queue a review-fix attempt and inspect admission and launch evidence.
2. Repeat with a non-subscription profile that is ready at admission, disabling that
   profile before launch preparation.
3. Repeat with a supported ready profile and inject an ambiguous GitHub dispatch
   failure using the testing transport.

## Asserts

- The ready subscription passes admission; the retained managed-dispatch guard
  rejects launch with the fixed reason `review-fix managed preparation refused`.
- The disabled profile also rejects launch with that fixed reason.
- Neither explicit preparation refusal dispatches a workflow or leaves a usable grant.
- Ambiguous dispatch failure stays `unknown`; its grant is revoked while attempt
  occupancy is retained for reconciliation. Raw errors and credentials are absent
  from the worker outcome.
