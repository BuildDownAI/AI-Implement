# 030. Control review-fix attempts with Restate

**Status:** Accepted — design approved on 2026-09-24; live pilot evaluation pending.
**Date:** 2026-09-24
**References:** ADR 018, ADR 026, ADR 027, ADR 028; [pilot research](../research/2026-09-23-restate-review-fix-explained.md)

## Context

The pilot moves GitHub Actions review-fix coordination onto Restate. The runner keeps its existing internal review/fix cycles. Restate must coordinate an external execution whose launch response and termination can be uncertain.

Before attempt correlation, the GitHub adapter matched runs by branch, dispatch time, and issue title. That could not reliably distinguish two attempts for the same issue. Cancellation of orchestration also does not establish termination of the external runner.

## Decision

- Give every attempt a stable identity and use it to match the exact GitHub execution. If launch acceptance remains unknown, hold the attempt for reconciliation. Do not launch again merely because a lookup returns no result or a timer expires.
- On cancellation or deadline expiry, keep the PR and capacity reserved until GitHub confirms termination. Reject a late result's attempt to approve newer work.
- Store the lifecycle selection per project in SQLite. Show the control on Projects and default it to Legacy. A setting change selects the owner of future attempts; existing attempts retain their recorded owner.
- Before replacing the endpoint with incompatible code, stop new admissions and drain all active Restate work on that endpoint. The pilot does not add separately hosted endpoint versions. Pending work and unresolved launches follow the explicit endpoint drain contract.
- Retain structured tool activity, bounded redacted outputs, and evidence for every review/fix cycle for seven days. Show missing event ranges. Journal retention and completed-workflow retention need separate verification against the pinned runtime.
- Require the pilot's failure tests, a live restart recovery, and one week of operating evidence before starting kg-refresh. Keep the broader run-ledger evaluation after two lifecycle migrations.
- Save authenticated feedback in a durable SQLite delivery record before acknowledging the webhook. Retry delivery to Restate with the same event identity. The delivery mechanism makes no attempt, approval, timeout, or recovery decisions.
- Require a valid runner result for approval. A successful GitHub execution cannot replace a missing result. Identical result callbacks have no additional effect. Conflicting results prevent approval while finalization is pending; later conflicts produce an alert without rewriting a final outcome.
- Use `BuildDownAI/AI-Implement-Sandbox`, mapping `SAN`, for the first live test. Select GitHub Actions and one capacity slot there before enabling the pilot on other projects.

### Coordination boundary

`ReviewFixPR` identifies one PR by installation, repository, and PR number. Its exclusive handlers only ingest feedback, schedule checks, select an attempt, or acknowledge completion. They return while the external runner works. `ReviewFixAttempt` identifies one attempt and owns its main execution, durable waits, deadline, and final outcome. Shared handlers accept validated result and cancellation events while the main workflow waits.

SQLite remains authoritative for accepted feedback, findings, snapshots, admission, run history, and final outcomes. Restate owns coordination and execution position. A repeated database step must be safe even when its first commit succeeded before the journal recorded the result.

The pilot migrates GitHub Actions work currently selected through the review-fix queue, including its existing automatic open-PR and lease-rejection triggers. Human `/ai-implement` dispatches and local Docker review-fix retain their existing lifecycle, but use shared admission. Existing reviewer policy, human override rules, merge gates, and the 30-finding task cap remain in force.

### Approved operating contract

The following defaults were approved with the architecture at Gate 1 on 2026-09-24. Implementation issues carry the relevant rules inline.

| Situation | Required behavior |
| --- | --- |
| Duplicate authenticated event | One durable delivery record and one application of findings. |
| Restate unavailable | Keep accepted feedback pending in SQLite; retry delivery. Never acknowledge data held only in process memory. |
| Invalid webhook or unavailable SQLite | Reject acceptance. Do not claim durability. Failed GitHub delivery requires the documented redelivery path. |
| Feedback burst | Check after a fixed five-second coalescing window. Later arrivals do not extend the window indefinitely. |
| PR already active, capacity full, or project paused | Preserve pending feedback. Do not create another runner. |
| Admission succeeds | Atomically reserve occupancy, capture the exact finding snapshot, and persist the prepared attempt before launch. |
| Launch accepted | Bind the exact GitHub run identity; enter the durable result wait. |
| Launch definitely rejected before execution | Record launch failure and release its reservation. |
| Launch outcome unknown | Retain reservations and reconcile by attempt identity. No blind second dispatch. An empty search result is not proof of rejection. |
| Result arrives before launch response | Accept it only for the prepared attempt and its verifiable execution identity. It can help reconcile the launch. |
| Identical result retry | Acknowledge the stored result without repeating its effects. |
| Conflicting result before finalization | Persist the conflict and prevent approval. Stop or inspect the execution before releasing occupancy. |
| Conflicting or stale result after finalization | Reject a new effect and record an alert. Keep the stored final outcome immutable. |
| Valid successful result | Check current attempt authority, reported output commit, current PR head, finding dispositions, and existing approval policy before approval. |
| Missing result | Wait until the attempt deadline; end without approval. GitHub success alone never grants approval. |
| Cancellation, closure, or deadline | Revoke the attempt's application authority, request GitHub cancellation, and wait for confirmed termination before replacement. |
| GitHub unavailable during stop verification | Show that termination is unconfirmed. Retain occupancy. |
| Finding appears or is reported again after the snapshot | Keep that newer finding version open. Snapshot membership by finding ID alone cannot clear it. |
| More than 30 findings | Snapshot only findings actually included in the task. Preserve the rest for later work. |
| Old completion notification | Clear the PR object's active attempt only when the attempt IDs match. |
| PR merged or closed | Stop further automatic attempts and retain history. Apply the existing benign-terminal distinctions. |
| Lifecycle setting changes | Existing attempts keep their owner. Serialize a PR's pending work with any active attempt, regardless of owner. |

Persist the attempt deadline at admission using the project's effective Job Timeout plus 30 minutes for queue and report delivery. The current Job Timeout default is 90 minutes, so the pilot default deadline is 120 minutes. Waiting for team capacity does not consume this deadline. A running attempt does not inherit later setting changes. Callback credential lifetime must cover that deadline and a bounded final-delivery grace period; retries must not mint a new attempt identity.

After an uncertain launch, probe for at most two minutes before displaying an operator-action state. This limit changes visibility, not the reservation or permission to relaunch. Recovery controls offer reconcile, adopt a verified matching execution, and cancel. They offer no unconditional force-release action. A replacement is a new attempt and uses the normal dispatch budget.

Result validation and authority checks occur outside the journaled request before forwarding secret-free data. Credentials are acquired inside external-operation adapters and never returned as journaled step results. Match installation, repository, PR, attempt, and execution; a rerun of a finished GitHub execution cannot revive an old attempt. Apply the same authority to publication-token issuance and pipeline publication checks. An already-started external push can finish before cancellation takes effect; Git leases and confirmed termination before replacement bound that race.

### Evidence and retention

Extend the existing job drawer with lifecycle owner, attempt status, deadline, pending feedback, the finding snapshot, and links to the workflow and GitHub execution. Evidence includes each cycle's input/output commit, finding dispositions, tests, verdict, usage, and tool activity. Missing information is shown as missing rather than inferred from GitHub's conclusion.

Use immutable activity events identified by attempt, producer, and sequence. A duplicate event has no extra effect; a conflicting payload for an existing identity is rejected and surfaced. Acknowledge only persisted batches. Use bounded retries, producer-local buffering, and a final sequence marker to distinguish a complete stream from a missing tail.

Approved pilot limits: 16 KiB per redacted activity event and 10 MiB of activity per attempt. Truncate at the producer and record truncation explicitly. On the attempt cap, stop storing activity payloads and record a durable limit marker; preserve cycle summaries and the final outcome separately. Capture observable tool actions and results, not hidden model reasoning. Telemetry failure does not grant approval or rerun agent work. Seven days means at least seven days after completion; retain active and unresolved attempts regardless of age. Protect correlated run records from the existing count-based log pruning during that window.

Configure completed-workflow retention, journal retention, and event-handler idempotency retention separately to cover the investigation window. Keep stable SQLite event and attempt identities beyond journal expiry so late delivery cannot recreate a completed attempt. Verify the configured values and expiry behavior against server 1.7.10 and SDK 1.17.1; declaration support alone is not runtime evidence.

### Rollout and drain

The Projects control selects Legacy or Restate for new eligible review-fix attempts. It defaults to Legacy without an environment-only override. Reject enabling Restate until the installed workflow and runner support attempt correlation and the callback contract. Unsupported local execution remains on its existing path; changing runner mode cannot move an active attempt.

Drain existing competing executions before the first shared-admission cutover. Additive schema changes preserve old history as Legacy; the pilot does not reinterpret historical jobs or backfill active workflows. New admission and old history use separate compatibility rules.

For incompatible endpoint replacement, stop both run admissions and new external invocations on that endpoint. Continue callbacks and workflow-internal completion so active work can finish. Keep newly accepted feedback in the durable delivery records until deployment completes. Quiesce delayed checks and delivery into the endpoint; confirm no queued, running, suspended, or unresolved owned invocation remains. Unknown launches or unconfirmed termination hold deployment. MCP tools and authentication refresh can briefly report unavailability during this maintenance window. Persistent Virtual Object state alone is not an active invocation.

Keep add, switch, and delete slices. The switch records ownership and excludes Restate attempts from legacy callback, monitor, timeout, reaper, and boot-recovery outcome decisions. Delete only glue exclusive to migrated paths; local and other legacy work still need their existing lifecycle. The durable ingress delivery mechanism is not a second lifecycle recovery loop.

Rollback stops new Restate admissions and drains owned work before routing new work to Legacy. Preserve the database and journal; a code revert must not make active ownership records unreadable. High availability, volume-loss recovery, runner workspace restoration, additional execution backends, and the wider credential program remain outside this pilot.

### Backlog reconciliation accepted on 2026-09-24

| Existing work | Action at filing |
| --- | --- |
| AII-614, AII-682, AII-629/AII-626 | Update the adoption order and preserve later migrations. |
| AII-611, AII-688 | Retain outside the pilot and preserve the later evaluation. |
| AII-569 | Reuse for reservation-backed capacity reporting, after admission core. |
| AII-721, AII-724, AII-728 | Reuse as feature children before the live pilot. |
| AII-727 | Reuse coverage and serialize endpoint changes. |
| AII-761 | Keep separate; land before pilot credential changes. |
| AII-423, AII-67 | Keep outside; use the import guard and job drawer already present. |
| AII-285, AII-651 | Link the pilot; retain the broader remaining scope. |
| AII-568, AII-210 | Keep legacy fixes separate; exclude Restate attempts from their outcome decisions. |

Assign the final ADR number when the implementation PR opens, using the highest existing ADR number.

## Alternatives considered

- **Relaunch after an uncertain response and rely on a runner claim** — rejected. The pilot first reconciles the original execution instead of knowingly admitting duplicate launches.
- **Release capacity before termination** — rejected. GitHub can still be running the cancelled execution.
- **One global lifecycle switch** — rejected. A project setting permits an isolated rollout while other projects continue on Legacy.
- **Keep multiple endpoint versions** — deferred. It adds infrastructure to the first run-lifecycle pilot.
- **Keep only cycle summaries and GitHub log links** — rejected. An investigation needs retained activity and explicit evidence gaps.
- **Begin the next migration after CI and one live success** — rejected. It omits restart recovery and the agreed operating observation period.
- **Reject feedback whenever Restate is down** — rejected. GitHub does not automatically redeliver a failed webhook. A durable delivery record preserves accepted events across a sidecar outage.
- **Infer approval from GitHub success** — rejected. A successful execution does not establish the runner's review result.

## Consequences

Operators can see which system owns an attempt and why it waits. The pilot favors an explicit blocked state over an uncertain second execution.

An unknown launch or unconfirmed termination can hold capacity and delay incompatible deployment. Evidence collection adds a runner-to-orchestrator contract and requires bounded storage. The operating defaults above were approved at Gate 1 on 2026-09-24.
