---
target: orchestrator
auth: admin
timeout_minutes: 240
---

# KG refresh usage reaches job accounting

Manual recipe; requires a testing deployment with KG refresh configured and a runner that emits invocation usage.

## Steps

1. Trigger a KG refresh from the testing orchestrator's KG page and record its dispatch id.
2. Wait for the runner result to be accepted and the refresh to finish (resolve any snapshot approval normally).
3. Call `list_job_accounting` for the dispatch's project and locate the KG refresh job by dispatch id.

## Asserts

- The job contains the runner's model invocations and token/cost usage, attributed to the frozen dispatch configuration.
- Retrying an identical authenticated runner result leaves each invocation represented once.
- A result from an older runner without usage is still acknowledged.

The automated callback regression is `src/__tests__/kg-refresh-callback-contract.test.ts`; durable intake and accounting are covered by `src/__tests__/restate/kg-refresh-workflow.restate.test.ts`.
