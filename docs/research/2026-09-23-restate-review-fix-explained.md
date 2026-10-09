# Use Restate to control the review-fix loop

Date: 2026-09-23.

This document explains the recommended design for the [Restate pilot](2026-09-23-restate-pilot-options.md). The design still requires implementation and tests.

The text follows ASD-STE100 grammar rules. It includes additional technical terms for this system.

## Purpose

Use Restate to control each follow-up fix attempt from start to finish. A fix attempt is one runner execution that addresses review feedback on a pull request (PR).

The runner changes code. It also runs tests, reviews the changes, and pushes the changes to the PR branch.

The pilot starts when new feedback arrives after the previous runner stops. Keep the review/fix cycles inside the runner.

Restate keeps an execution journal. This journal records the results of completed operations. After a restart, Restate uses these results to continue the workflow.

Sources: [Restate repository](https://github.com/restatedev/restate), [durable steps](https://docs.restate.dev/develop/ts/durable-steps).

## System parts

| Part | Function | Identity |
| --- | --- | --- |
| `ReviewFixPR` Virtual Object | Collects feedback and identifies the active attempt for one PR. | Installation or tenant, repository, and PR number. |
| `ReviewFixAttempt` Workflow | Controls one attempt from preparation to its final result. | One unique attempt ID. |
| Runner | Changes the code and reports the result. | The attempt ID and the execution ID from GitHub Actions. |
| SQLite database | Keeps findings, snapshots, run history, and final results. | Records that refer to the attempt ID. |

A finding is one problem that a reviewer reports. A snapshot is the saved list of findings that an attempt must address.

A handler is a function that processes a request. An exclusive handler processes one request at a time for its PR. A shared workflow handler can receive a result while the main workflow waits.

Keep each exclusive handler short. Use a durable send to start the attempt workflow. Then return from the PR handler. A durable send lets Restate deliver the request after the handler returns or the process restarts.

This arrangement lets the PR object receive feedback while the runner works.

Sources: [handler behavior](https://docs.restate.dev/foundations/handlers), [workflow services](https://docs.restate.dev/develop/ts/services).

## Procedure for one attempt

### 1. Receive the feedback

Authenticate the webhook request. Use a stable event ID to identify repeated requests. Send the feedback to the PR object.

Save the feedback durably before you acknowledge acceptance. Here, durable means that the system keeps the data after a process restart.

Update the SQLite records for findings and feedback events. A repeated request must have the same effect as one request.

### 2. Combine the feedback

Schedule a short delay before the next check. Return from the handler during this delay. This delay lets the PR object combine several comments into one task.

At the next check, apply the rules for reviewers, the current commit, the dispatch budget, and approval. If an attempt is active, keep the new feedback for a later attempt.

### 3. Prepare the attempt

Reserve the required capacity. Select the current commit. Save the finding snapshot. Assign a unique attempt ID. Before you start the runner, save the prepared run record.

Make the capacity check and reservation one atomic operation. An atomic operation succeeds completely or has no effect. All dispatch paths that compete for capacity must use the same reservation mechanism.

The PR object controls one PR. It cannot enforce capacity limits across a team by itself.

### 4. Start the runner

Use a worker adapter to start the GitHub Actions runner. The adapter is a small module that connects the workflow to GitHub Actions. It must support operations to start, find, inspect, and stop an execution.

When you retry an infrastructure operation, use the same attempt ID.

### 5. Wait for the result

Use a named workflow promise, such as `result`, to wait for the runner. A workflow promise keeps the wait and its result across restarts.

Set a durable deadline. Provide a separate path for a cancellation request.

Authenticate the result callback. A result callback is the request through which the runner reports its result. Validate the result data. Send the validated data to the shared workflow handler.

Use the shared handler to resolve the promise. Only the main workflow decides the final outcome of the attempt.

Source: [workflow promises and timers](https://docs.restate.dev/develop/ts/external-events).

### 6. Record the final outcome

Check that the attempt still has authority to report a final outcome. Make this check part of the database update. Record only one final outcome for the attempt.

If their dispositions permit resolution, resolve only findings from the saved snapshot. A disposition is the agent's decision about a finding: `fixed`, `follow-up`, or `invalid`.

Keep the approval rules and the checks for the current commit. Do not release the capacity reservation until another runner can safely change the branch.

### 7. Check for more feedback

Send the completed attempt ID to the PR object. Compare this ID with the active attempt ID.

If the IDs match, clear the active attempt. Then check the feedback that remains. Keep feedback that arrived after the snapshot.

## Example

Three review comments arrive. The PR object combines them into one attempt. A fourth comment arrives while the runner works. The PR object keeps that comment for a later attempt.

A repeated result callback has no additional effect. A late callback from an old attempt cannot approve a newer attempt.

## Limits and recovery

### An uncertain launch can cause a duplicate runner

GitHub can accept a launch before Restate records the result. If the process stops between these events, a retry of `ctx.run` can start another runner.

Use the attempt ID to prevent duplicate launches or reliably find the accepted execution. If the launch result remains uncertain, show the status “launch outcome unknown.” Require reconciliation before another launch. Reconciliation determines whether GitHub accepted the original launch.

Use unique IDs and conditional updates for SQLite operations. With these controls, repeated operations do not change the result twice.

Source: [database integration](https://docs.restate.dev/guides/databases).

### A cancelled workflow can leave a runner active

A Restate cancellation does not prove that the runner stopped. An external operation can finish before the handler receives the cancellation.

Cancel the execution in GitHub Actions. Remove the attempt's authority to approve or change the PR. Before you admit a replacement runner, confirm that the previous runner stopped.

Keep the Git head lease. With this check, a push cannot overwrite branch changes that the runner did not expect.

Source: [cancellation behavior](https://docs.restate.dev/services/invocation/managing-invocations).

### A retry and a new attempt have different effects

An infrastructure retry continues the same attempt. A replacement runner starts a new attempt. Assign a new ID to the replacement attempt. Count it against the applicable dispatch budget.

Restate records operation results. It does not restore a deleted working directory. Keep recovery of the working directory outside this pilot.

Source: [durable steps](https://docs.restate.dev/develop/ts/durable-steps).

## Adoption procedure

The current endpoint registers only `Operator` and `orchestratorTools`. It does not register a workflow that controls a run.

1. Add the workflow and tests with a simulated worker.
2. Test the real adapter in one isolated GitHub Actions project.
3. Switch the selected dispatch paths to Restate.
4. Disable the old completion and recovery logic for Restate attempts.
5. Delete the old logic that only served those paths.

Record which system controls each run. Transfer responsibility from these parts:

- [`processReviewFixQueue`](../../src/index.ts)
- [`review-fix-queue.ts`](../../src/review-fix-queue.ts)
- [`runner-callback.ts`](../../src/runner-callback.ts).

Before the production pilot, update the proposed adoption order in ADR 018.

Sources: [endpoint](../../src/restate/endpoint.ts), [adoption ADR](../adr/018-adopt-restate-one-run-kind-at-a-time.md).

## Required checks

Before the switch, test these conditions:

- The orchestrator restarts during an attempt.
- The system cannot determine whether GitHub accepted a launch.
- A callback arrives twice or refers to an old attempt.
- New feedback arrives while the runner works.
- A cancellation request arrives while the runner works.
- Two dispatch paths request the same capacity.

Add the attempt status and deadline to the current job view. Add links to the Restate workflow and GitHub Actions execution. Add evidence from each review/fix cycle and the agent activity.

The Restate journal shows workflow operations. The runner must report its own agent activity.

Source: [introspection](https://docs.restate.dev/services/introspection).

Test with server version **1.7.10** and SDK version **1.17.1**, as specified in the lockfile. Verify that the system retains journals and activity evidence for the proposed seven-day investigation period. Configure retention of workflow results separately.

Before an incompatible code replacement, stop new admissions. Then wait until all Restate work under this module's control ends. Alternatively, keep separate endpoint versions for active workflows.

These runtime checks remain incomplete.

Sources: [lockfile](../../package-lock.json), [retention settings](https://docs.restate.dev/services/configuration), [deployment versions](https://docs.restate.dev/services/versioning).

Language reference: [ASD-STE100, Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf).
