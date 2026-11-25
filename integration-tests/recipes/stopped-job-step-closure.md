---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Close running steps when a runner ends without a report (AII-2100)

Manual lifecycle check on a sandbox project with operator access to its runner backend and job page.

## Steps

1. Dispatch a sandbox implementation job and wait until the job page shows both a running top-level step and a running sub-step. Record any already finished steps.
2. Kill the runner without delivering a final callback, then let the orchestrator finish the job as `failed` / `ended_without_callback`.
3. Reload the job page and inspect its persisted `step_log` rows. Both previously running rows must be `cancelled` with ISO `ended_at` values; previously finished rows must retain their original status and end time.
4. Repeat using a timeout and workflow cancellation. Expect the same closure for status `timed_out` and conclusion `workflow_cancelled`.
5. As a control, allow a live runner to report a completed job while later steps are still running. Those running steps must remain open until their own reports arrive.

## Asserts

The three specified stop cases leave no running step rows for that job. Other jobs and finished steps remain unchanged. Automated coverage also verifies that a later final report replaces a cancelled row: `npm test -- src/__tests__/step-log.test.ts`.
