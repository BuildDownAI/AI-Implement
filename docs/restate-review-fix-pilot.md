# Restate review-fix pilot: operator runbook

**Status:** Live evaluation pending. No live pilot success or operating-period evidence has been recorded. Complete the preflight and the separate [AII-815 live evaluation](https://linear.app/eudoxus/issue/AII-815/run-and-evaluate-the-san-review-fix-pilot) before wider enablement.

This pilot moves **automatic GitHub Actions review-fix attempts** to Restate. The runner's internal review/fix cycles, local review-fix runs, and human comment-triggered gap-fill runs stay on their existing lifecycle. SQLite owns accepted feedback, finding versions, attempt snapshots, reservations, and final outcomes. Restate owns durable coordination and waits. A project defaults to Legacy; a change selects only future automatic attempts. An active attempt keeps its recorded owner. See [ADR 029](./adr/029-share-atomic-dispatch-admission-across-run-owners.md), [ADR 030](./adr/030-control-review-fix-attempts-with-restate.md), and [ADR 018](./adr/018-adopt-restate-one-run-kind-at-a-time.md).

## Before enabling SAN

1. Confirm the feature branch and all its child checks have landed in the deployment target. Use the [fault-coverage record](./restate-testing.md) to separate real-engine/SQLite evidence from mocked GitHub/tracker behavior. The container suite is a prerequisite, not a live recovery claim.
2. On the Projects page, find the mapping for `BuildDownAI/AI-Implement-Sandbox` (`SAN`). Set the execution backend to GitHub Actions and the team capacity to **one**. Leave review-fix lifecycle at **Legacy** while preparing. Verify the target repository and dispatch ref; the workflow capability probe checks that ref, not merely the default branch.
3. Use **Sync workflows** for SAN and merge the resulting workflow PR in the sandbox repository. Confirm the installed workflow and runner declare `run_attempt_token` and `run_publication_token` on the dispatch ref. The Projects save gate verifies these capabilities again.
4. Drain all active competing Legacy executions that lack a shared admission reservation before first activation. Check Pipelines/Jobs and the capacity view; finish or explicitly cancel and **verify backend termination** for each. The enablement gate refuses activation while an unreserved Legacy worker is active. Do not invent reservations for old jobs or backfill a live attempt.
5. Confirm the Restate sidecar is healthy and its endpoint registered. Check that the selected SAN PR has no active writer, no uncertain launch, and no unconfirmed stop. A green service check does not resolve one of those attempt states.
6. Save SAN's **Review-fix lifecycle = Restate** on Projects. A rejected save is a preflight failure: read its explicit reason (execution mode, endpoint health, undrained Legacy worker, or missing installed workflow capability) and fix that prerequisite. Do not bypass it by editing SQLite.

After activation, use one SAN PR and one feedback delivery. Observe the attempt ID, immutable owner, SQLite reservation, exact GitHub run ID and attempt number, runner result, PR head, and finalizer decision in the job drawer and [live evaluation](https://linear.app/eudoxus/issue/AII-815/run-and-evaluate-the-san-review-fix-pilot). The first live trial must include a real restart/recovery window and a week of operating evidence before the next run-kind migration. Approval still requires a matching valid runner result, current authority, output commit matching the current PR head, finding dispositions, and the normal merge gates. GitHub success by itself cannot approve.

## Read an attempt before acting

Open the PR's job drawer. Record the attempt ID, lifecycle owner, deadline, pending feedback, finding snapshot, dispatch identity, GitHub execution identity, and any alert or activity gap. Use the drawer's **Reconcile**, **Adopt**, and **Cancel attempt** controls only for the exact attempt displayed. Their admin API equivalents are `POST /api/review-fix/attempts/:attemptId/reconcile`, `/adopt` (body `{"githubRunId":"...","githubRunAttempt":1}`), and `/cancel`; the existing admin gate applies. A `202 durable-accepted` response means an action was queued while Restate was unavailable, not that the action or termination has completed. Re-read the attempt and backend state.

| Observed state | Operator action and release condition |
| --- | --- |
| Feedback pending while paused, parked, at capacity, or another writer occupies the PR | Keep it pending. Clear the specific policy or occupancy blocker; no runner, deadline, or budget entry should appear before admission. A human request may override park/budget, never capacity or occupancy. |
| Prepared, no launch identity yet | Inspect the exact attempt. A prepared row holds the reservation and deadline. Do not start a second dispatch by hand. |
| Launch definitely rejected | Confirm failure is recorded and the matching reservation is released. The budget entry remains history. |
| Launch uncertain | Use **Reconcile** to search by attempt identity. An empty search is not proof that launch failed. After two minutes, an alert makes the held capacity visible; the alert does not authorize retry or release. |
| A matching execution found but not bound | Verify installation, repository, PR, attempt token, run ID and run-attempt number, then use **Adopt**. A mismatched or unverified execution must not be adopted. |
| Early, duplicate, conflicting, or stale result | Check the stored callback classification. Identical retries acknowledge the stored result; a conflict before finalization blocks approval and needs execution reconciliation/stop. A conflict after finalization alerts without changing the final outcome. Never edit the outcome to match a later callback. |
| GitHub succeeded without a valid result | Wait until the persisted deadline and stop path. Do not approve from GitHub conclusion. |
| Cancel, PR closure, or deadline | **Cancel attempt** revokes application authority first, then requests backend cancellation. Check the response: `partial` or `durable-accepted` is not proof of stop. Keep occupancy until the exact GitHub execution is confirmed terminal; then the owner finalizes and releases once. |
| GitHub unreachable or termination unknown | Keep the reservation and show operator action required. Retry reconciliation/inspection after backend recovery. There is no force-release control. |
| Finalized | Confirm the final outcome and release belong to this attempt. A delayed completion may clear the PR's active attempt only when IDs match. Newer or re-reported finding versions remain open. |

## Failed webhook or callback delivery

For a review webhook, distinguish acceptance failure from delivery to Restate. A valid event is first committed to SQLite's review-fix event/finding queue, then acknowledged to GitHub; if Restate is unavailable after that commit, the durable inbox and delivery pump retry with the same identity. Do not create a second event or a new attempt. If GitHub received a non-2xx because validation or SQLite acceptance failed, locate the failed delivery in the repository's webhook delivery history and **manually redeliver that delivery** after correcting the cause. GitHub does not automatically retry a failed webhook; redelivery preserves its GUID for deduplication. See [review-fix rail](./review-fix-rail.md#webhook-intake-atomic-acceptance-and-redelivery-aii-792).

The runner retries a transient `/runner/result` failure with the same serialized result, bounded by the attempt deadline plus delivery grace; a 409 conflict or 410 stale result is terminal for that callback retry. Inspect the attempt and GitHub execution if delivery exhausts. Never rerun agent work to repair a callback transport failure. See [runner callback contract](./runner-callbacks.md).

## Incompatible endpoint deployment and rollback

For an endpoint change that cannot be registered compatibly, close **new admission and new external invocations** on the old endpoint using the deployment drain control. Leave result/cancel delivery and already-running workflow completion available. Keep incoming review feedback in SQLite while delivery into that endpoint is held. Check the drain census for queued, running, suspended, and unresolved owned invocations; include unknown launches and unconfirmed terminations. A failed census is unknown occupancy, not an empty endpoint. Register the replacement only after the old deployment is proven drained; persistent Virtual Object state alone does not count as an active invocation. See [Restate endpoint operations](./restate.md) and [drain contract](../src/restate/drain.ts).

To disable the pilot, first change SAN's project choice to **Legacy** for future automatic review-fix admissions. This does not transfer, cancel, or free active Restate owners. Drain each existing attempt to a verified terminal backend state and final outcome before replacing incompatible code or reverting the branch. Preserve SQLite records and the Restate journal so active ownership stays readable. A code revert with unresolved Restate-owned attempts is not a safe rollback.

## Evidence, limits, and evaluation record

Activity is keyed by attempt, producer, and sequence. Inspect the job drawer for missing ranges, final sequence, conflicts, truncation, and the limit marker. Producers redact before transport; never ship credentials, tokens, or hidden model reasoning. The limits are **16 KiB per redacted event** and **10 MiB of activity per attempt**. Hitting the activity cap stops activity payload storage, not the independent cycle summaries (input/output commits, dispositions, tests, verdict, usage) or final outcome. Activity and cycle evidence remain at least seven days after completion; active and unresolved attempts are not age-purged. Durable identity tombstones remain after evidence expires so late replay cannot create a new attempt.

Keep the [container evidence record](./restate-testing.md) alongside the [AII-815 live record](https://linear.app/eudoxus/issue/AII-815/run-and-evaluate-the-san-review-fix-pilot). For every invariant below, record the exact commit, test or live observation, output/link, and what boundary it actually proves:

| Invariant | Automated evidence required before rollout | Live evidence still required |
| --- | --- | --- |
| One writer and shared capacity across Legacy/Restate | Atomic admission tests, mixed-owner capacity and PR-occupancy tests | SAN capacity-one overlap observation |
| No duplicate launch after lost response or restart | Real-engine replay plus SQLite identity and simulated GitHub reconciliation | Restart an active SAN attempt and inspect the exact GHA execution |
| No approval without authority and matching result | Callback ingress, conflict/stale, no-result and finalizer gates | Inspect a real runner result and current PR head |
| Cancel/deadline retains capacity until verified stop | Fault-injected cancellation and backend-terminal checks | Exercise a controlled stop and observe confirmed termination |
| Feedback/finding versions survive delivery and snapshot | SQLite queue, >30 overflow and rereport tests | Observe a real webhook and its persisted snapshot |
| Drain, evidence and retention are bounded | Container drain tests, evidence cap/gap tests, retention tests, configuration inspection | Verify deployed retention settings and operating-window behavior |

The [AII-813 fault-matrix merge](https://github.com/BuildDownAI/AI-Implement/pull/715) landed at feature commit `d46a6fb`. [Current-head CI](https://github.com/BuildDownAI/AI-Implement/actions/runs/36186518818) passed unit tests and all 131 pinned Restate 1.7.10 tests, including the named mixed-owner capacity, lost-acknowledgement, activity-cap/gap, callback-ingress, cancellation, and restart scenarios in `review-fix-pilot.restate.test.ts`. These are real-engine/SQLite results with simulated external GitHub behavior. The unchanged integrated-suite rerun after AII-812 deletion and the AII-815 live observations remain pending.

The knowledge-graph recon for this pilot was advisory and produced no useful matches; it is not design validation. The approved architecture and issue-specific tests are the decision and verification sources. Update the deletion and live records as those gates finish; never describe a mocked GitHub response or config declaration as a proven live recovery.
