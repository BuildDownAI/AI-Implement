---
target: orchestrator
auth: none
timeout_minutes: 15
---

# Final attribution after live model calls (AII-2074)

Manual: requires an admin session, a local Docker serve runner and a test project with implementation and review stages configured.

## Steps

1. Dispatch an implementation run that performs an implementation call followed by a review call.
2. While the run is live, inspect its invocation rows in Reports and confirm both calls arrive.
3. Wait for the final runner result, whose attribution names the implementation call.
4. Open the job in the admin UI and inspect its attribution and invocation rows in Reports.
5. Replay the same final result through the authenticated result intake.

## Asserts

- The job attributes the run to the implementation call named by the final result.
- Exactly two invocation rows remain after finalization and replay.
- The implementation row follows the review row; stored usage and any timeout status remain intact.
