---
target: orchestrator
auth: admin session
timeout_minutes: 5
---

# Managed review-fix preparation refusal (AII-1755)

Current combined D behavior: managed Claude subscription profiles consume stored
protected setup-tokens without a session reservation. The current checks below
cover successful launch, explicit preparation refusal, and ambiguous dispatch.

Manual: use a testing orchestrator with the review-fix pilot enabled and a disposable
PR targeting a workflow with private run configuration and stage-agent support.

## Steps

1. Opt the project into managed agent configuration with a ready Claude subscription
   stage with a stored protected setup-token. Queue a review-fix attempt and inspect
   admission and launch evidence.
2. Repeat with a non-subscription profile that is ready at admission, disabling that
   profile before launch preparation.
3. Repeat with a supported ready profile and inject an ambiguous GitHub dispatch
   failure using the testing transport.

## Asserts

- The ready subscription passes admission and launches successfully (`accepted`),
  dispatching the workflow with its managed configuration.
- The profile disabled before preparation rejects launch with the fixed reason
  `review-fix managed preparation refused`, without dispatch or a usable grant.
- Ambiguous dispatch failure stays `unknown`; its grant is revoked while attempt
  occupancy is retained for reconciliation. Raw errors and credentials are absent
  from the worker outcome.

## Historical pre-D behavior (recorded 2026-11-09; not current assertions)

Before the protected setup-token consumer from Track D was integrated, a ready
Claude subscription passed admission but the subscription guard refused launch
with `review-fix managed preparation refused`, without dispatch or a usable grant.
That subscription-refusal expectation is superseded by the current Steps/Asserts.
