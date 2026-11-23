---
target: orchestrator
auth: admin
timeout_minutes: 10
---

# Delayed step starts preserve terminal progress

Use a disposable implementation job on a test orchestrator and its dispatch ID.

## Steps

1. Through the test instance's Restate ingress, call `ImplementationRun/<dispatchId>/step` with a valid Step payload in `running` status. Retain that payload.
2. Call the same handler with the same step ID, status `passed`, a non-null `ended_at`, outputs, and a logs URL. Await completion.
3. Deliver the retained `running` payload again and await completion.
4. Inspect the job's step record in the admin UI or autopsy. Repeat with a separate step ID and terminal status `failed`.

## Asserts

- Each step retains its terminal status, end time, outputs, and logs URL after the delayed start arrives.
- Each step ID appears once for this job.
- A different step ID can still advance from running to passed normally.

Automated equivalents: `src/__tests__/step-log.test.ts` and the step parity scenario in `src/__tests__/restate/implementation-run-workflow.restate.test.ts`.
