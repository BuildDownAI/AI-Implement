# Focused review-fix Restate pilot

Date: 2026-09-23  
Status: focused pilot proposal; implementation and live validation pending  
Repository inspected: `testing`, commit `f00c8dc`

## Pilot objective

Deliver a post-run review-fix implementation that is **simpler, more robust, and more observable**, with a viable path to future modularity. The pilot succeeds on those three operational outcomes. Adding harnesses, SCM providers, or CI systems is future work, not an acceptance requirement.

Use a branch PoC for the complete follow-up lifecycle: feedback arrives on an existing PR, is coalesced and admitted, starts a fix runner, waits for its result, records the conclusion, and handles feedback received during that attempt. Keep the current runner and its internal implement/review and post-push review/fix loops.

Review-fix is the module being built. Extract reusable job-management behavior later when another lifecycle needs it; a universal job framework is not a prerequisite.

## Scope

| Included | Deferred |
|---|---|
| Durable receipt, coalescing, and ownership of follow-up review-fix work | Initial implementation lifecycle migration |
| Dispatch, result callbacks, deadlines, cancellation, and recovery for those attempts | Stage-level replay or restoration inside a runner |
| Preservation of finding snapshots, review policy, budgets, and approval semantics | Changes to reviewer prompts, finding policy, or merge criteria |
| Correlated status, iteration and agent-activity inspection, and a documented operator recovery path | A general recovery console or replacement for Restate's debugger |
| One existing real execution path and controlled failure tests | Second harness/backend, SCM/CI substitution, plugin system |
| Retirement of superseded lifecycle ownership for migrated runs | Repository-wide interface extraction or all-run-kind cutover |

Use the current GitHub Actions review-fix path for the first real pilot, scoped to a dedicated project. Local Docker remains an existing path outside that pilot. During the isolated experiment, drain or disable competing legacy dispatch sources for that project. Shared production use requires preventing races with human-triggered fixes and initial implementation; narrow admission integration is part of safe adoption if those paths remain enabled.

## Success criteria

| Outcome | Evidence |
|---|---|
| Simpler | One owner of each migrated attempt's lifecycle; obsolete drain/recovery decisions are removed or excluded for those runs; identify the code and operator steps eliminated |
| More robust | Restart and duplicate-delivery tests preserve work and one terminal conclusion; late findings survive; overlapping writers are prevented; ambiguous launch is visible and never blindly duplicated |
| More observable | From the existing job view and linked tooling, an operator can identify the active attempt, wait/failure reason, latest evidence, deadline or next action, and runner/workflow history; a non-converging run can be investigated through iteration outcomes and model/tool activity |
| Viable modularity path | Review policy, lifecycle coordination, and provider operations are distinguishable in the implementation; future extraction points and remaining coupling are documented |

A fake worker with controlled acceptance/completion is sufficient for fault-injection tests. One real backend proves the actual handoff. No second integration is required to pass the pilot, and portability remains unproven until one is added.

## Keep the future path inexpensive

Use a small `ReviewFixLifecycle` interface for feedback, results, cancellation, and status. Keep Restate context and replay rules inside the coordination implementation. Put the provider operations needed by this workflow behind an internal worker adapter, with explicit semantics for starting, locating, observing, and stopping an attempt. Reuse the existing runner envelope and stable attempt identity; keep credential values out of journaled payloads.

Keep finding/approval policy separate from retry and waiting mechanics. The lifecycle should consume a normalized runner result rather than interpret agent CLI output. These choices leave room to extract a reusable job lifecycle or replace execution/harness adapters later without requiring those projects now. They are design constraints for this slice, not a mandate to redesign all existing modules.

## Minimum operator experience

Add only the information missing from the existing run view: attempt identity, lifecycle owner, current wait/failure reason, relevant timestamps/deadline, and correlation to the Restate invocation and external execution/logs. Expose concise business status; use existing Restate tooling for journal inspection and low-level intervention.

Provide a short recovery runbook that distinguishes continuing an unfinished operation, reconciling uncertain dispatch, cancelling a live worker, and explicitly starting a new attempt. A new attempt gets new identity and consumes the applicable budget. Cancellation stays visible until the worker is confirmed stopped or intervention is required. Recovery must not let an old result approve a new attempt or let two workers write concurrently.

## Layered visibility into review-fix work

The operator should be able to expand a job into its iterations, then expand an iteration into agent activity. Detail level and log severity are separate dimensions: a successful tool call can be diagnostically useful without being a warning.

| Level | Evidence to capture | Questions it answers |
|---|---|---|
| Job / attempt | Admission, dispatch identity, runner execution, waits/deadlines, infrastructure retries, cancellation, terminal result | Is work queued, running, waiting, retrying, or awaiting intervention? |
| Review/fix iteration | Findings presented and their dispositions, input/output revision or patch reference, changed-file summary, test results, reviewer verdict/report, duration, available usage | What did this pass try to fix, what changed, and why did the next review still object? |
| Agent activity | Harness-emitted messages, tool-call IDs/names and arguments, associated tool-result summaries/errors, command exit status where available, timing, detailed-output references | Where did the effort go? Which commands failed or repeated? What evidence did the agent receive? |

Capture the output the harness exposes. Label absent timings, usage, results, and incomplete uploads as unavailable. A final token/cost total must not be presented as live per-turn measurement. Native turn limits, review iterations, worker attempts, and Restate retries are different counters and must be distinguishable.

### What Restate supplies

Restate's journal records durable operations and results; its UI, CLI, and SQL introspection expose invocation status and journal history. That supplies the lifecycle portion of the view. An external runner remains opaque until it reports activity. Instrumenting the runner does not require moving each model or tool call into a durable workflow. [Introspection](https://docs.restate.dev/services/introspection).

The TypeScript SDK also supports `TRACE`/`DEBUG`/`INFO`/`WARN`/`ERROR` logging. `ctx.console` suppresses repeated log messages during replay. Enabling verbose journal logging increases engine diagnostics; it does not reveal tool output from an uninstrumented worker. Logs and the execution journal have different purposes and retention. [Logging](https://docs.restate.dev/develop/ts/logging).

Restate can export OpenTelemetry traces and propagate trace context to instrumented code. This is useful for deeper cross-process timing, but the pilot's correlated timeline should work without a collector or tracing backend. [Tracing](https://docs.restate.dev/server/monitoring/tracing).

### Existing foundation and gaps

- [`executor.ts`](../../src/pipeline/executor.ts) already parses the harness event stream. [`claude-stream.ts`](../../src/pipeline/claude-stream.ts) provides summary/stream formatting, usage extraction, and a compact tool trace. The trace currently keeps at most 200 calls, truncates input summaries to 160 characters, and stream formatting reduces a tool result to a generic marker. Extend capture before that lossy formatting; do not attempt to reconstruct evidence from formatted console lines.
- [`StepReporter`](../../src/pipeline/reporter.ts) and [`step_log`](../../src/step-log.ts) provide progress callbacks, parent-step IDs, and step inputs/outputs/log references. The reporter has bounded retries and can give up; the table upserts the latest step state. Neither is an append-only activity history or a durable delivery guarantee.
- The existing [job drawer](../../src/admin-ui/drawer.ts) reads job/step details, refreshes while active, and links GitHub Actions executions to their logs. Extend this entry point. The [report card](../../src/report-card.ts) already derives pass, spend, and turn-cap summaries; reuse those meanings rather than creating competing totals.

### Minimal capture and storage additions

Add a small activity recorder to the runner, fed from the existing event parser and the review/fix step boundaries. A versioned event envelope should include attempt/dispatch ID, step and iteration ID, a producer/session ID and monotonic sequence number, timestamp, event kind, severity, and optional tool-call ID. Session/sequence identity must remain stable when retrying delivery; worker restarts get a distinct producer identity. Store input/output revisions and finding keys with iteration summaries so activity can be related to actual progress.

Send bounded batches through an authenticated activity callback, separate from the terminal-result callback, and acknowledge only after durable persistence. The proposed initial store is a small append-only SQLite activity table, with uniqueness on attempt/producer/sequence, plus bounded redacted detail files on the orchestrator's existing persistent volume. This uses the current storage footprint; object storage can be introduced later if evidence warrants it. A paginated read endpoint returns events and artifact references, with filters for step/iteration/kind/severity and a cursor for incremental refresh. Reuse progress authentication where its contract allows; never consume the result token for telemetry.

Spool unacknowledged batches on the runner and retry within a bounded budget. A receiver crash after commit but before acknowledgment must not duplicate activity. A runner destroyed before upload can still lose its unsent tail: preserve acknowledged events, report the last acknowledged sequence and capture gaps, and never claim a complete transcript in that case. A final available artifact can supplement the stream, but cannot be its only persistence path.

Persist enough detail to explain tool failures and model decisions visible in emitted messages. Redact credentials before persistence, cap payloads, and make truncation explicit; large output goes into a referenced detail artifact rather than the Restate journal. Activity ingestion updates diagnostic data only and cannot resolve findings, approve a PR, or complete an attempt. Storage or delivery trouble must surface as degraded visibility without silently launching more work or converting the actual run outcome.

### Inspection tooling for the pilot

| Tool | Reuse or build | What the operator inspects |
|---|---|---|
| Existing admin job drawer | Extend with attempt status, expandable iteration/activity timeline, filters, and cursor-based refresh | Current activity, repeated failures, findings before/after each pass, test evidence, usage, last received event, and capture gaps |
| Restate UI | Reuse through authenticated operator access to the loopback admin endpoint | Invocation journal, pending calls, waits, retries, and workflow state |
| Restate CLI / introspection SQL | Reuse; document a few read-only investigation commands | Precise invocation status, blocking work, retained journal, and correlation IDs |
| Runner-provider log view | Reuse the GitHub Actions link already in the drawer | Process startup, installation, stderr, and infrastructure failures outside the model event stream |
| Activity/detail download | Add authenticated JSONL export and referenced-detail download alongside the activity read endpoint | Searchable evidence for offline investigation and comparison between iterations; ordinary text/JSON tools suffice |
| OpenTelemetry collector plus Jaeger or an existing tracing backend | Optional follow-up | Cross-process spans and timing; requires export configuration and worker instrumentation |

The minimum stack is the existing admin application and SQLite/volume, the existing runner, and Restate's built-in inspection tools. The custom additions are activity capture/delivery/storage, read/export endpoints, and the timeline in the existing drawer. A new log-search cluster, metrics dashboard, and tracing deployment are not required for pilot acceptance.

Restate currently binds its admin endpoint to `127.0.0.1:9070` on the orchestrator machine. A browser link to that address on an operator's laptop will not reach it. Document and verify an authenticated SSH tunnel terminating on that machine's loopback listener, or use an already authenticated operator shell there; this is an access setup task, not a reason to expose the admin API publicly. The app can show the invocation ID with a copyable lookup command until a working UI link is available. Keep application activity reads/downloads behind the existing admin authorization. [Current listener configuration](../../src/restate/server.ts).

Example read-only commands once the CLI targets that admin endpoint:

```sh
restate invocations describe <invocation-id>
restate invocations list --status backing-off
restate invocations list --all
```

The first command inspects the journal as well as status. Use the linked invocation ID instead of finding a run by timestamps alone. Low-level mutations from Restate tooling must follow the recovery runbook so a workflow cancellation does not leave a live external writer. [CLI inspection](https://docs.restate.dev/services/introspection).

### Retention and a non-convergence investigation

Propose seven days after completion as the pilot investigation window for retained journals and activity/detail artifacts, with active attempts retained throughout execution. Configure workflow result/dedup retention separately for callback and retry correctness. Verify the supported settings and completed-journal visibility on this repo's pinned server 1.7.10 / SDK 1.17.1 before cutover. The current upstream docs expose `journalRetention`; that alone does not prove its behavior on the pin. If the pin cannot retain the journal as needed, explicitly choose a compatible upgrade or a diagnostic export captured before entries expire, and test that path. Add size limits and visible truncation/expiry states for locally retained activity so the shared volume cannot grow without bound. [Service retention settings](https://docs.restate.dev/services/configuration).

For a representative run that exhausts its iteration or turn budget, the operator should be able to:

1. Locate its attempt and stopping reason in the existing job drawer.
2. Compare iteration summaries: findings carried forward, dispositions, diff/revision changes, test failures, and reviewer verdicts.
3. Drill into the relevant tool calls and results to identify repeated failures, unproductive investigation, or edits that reverse earlier changes. Finding rewording is not automatically the same finding; preserve the underlying evidence rather than presenting heuristic equivalence as fact.
4. Separate time spent running the agent from provider waits and infrastructure retries, using only timing actually captured.
5. Download the evidence and record an explanation with links to the relevant events/artifacts. Any automated summary is optional and must cite that evidence.

This tests visibility, not automated diagnosis. It adds instrumentation to the current runner while keeping the pilot's lifecycle scope intact.

## What is actually present

- Restate's sidecar, endpoint, Operator object, tools service, and container-test harness exist. The endpoint registers only `Operator` and `orchestratorTools`; no run-lifecycle workflow is registered in this checkout. This does not establish what is deployed elsewhere or exists on another branch. See [endpoint.ts](../../src/restate/endpoint.ts), [server.ts](../../src/restate/server.ts), and the [test harness](../../src/__tests__/restate/harness.ts).
- The existing tool writes deliberately use `maxAttempts: 1` with `onMaxAttempts: "kill"`. That pilot tests access and handler integration, but does not demonstrate recovery of a long-running job. See [tools.ts](../../src/restate/tools.ts).
- There are three relevant layers: the implement/review loop before publication, the post-push review/fix loop inside the same runner, and the post-run review-fix lifecycle that starts another runner. See [feedback-loop.ts](../../src/pipeline/steps/feedback-loop.ts), [post-push-review.ts](../../src/pipeline/steps/post-push-review.ts), and `processReviewFixQueue` in [index.ts](../../src/index.ts).
- Follow-up dispatch currently crosses [review-fix-queue.ts](../../src/review-fix-queue.ts), [webhook.ts](../../src/webhook.ts), `processReviewFixQueue`, [dispatch-gate.ts](../../src/dispatch-gate.ts), [runner-callback.ts](../../src/runner-callback.ts), and monitoring/recovery paths. Human `/ai-implement` requests also have a separate [comment-gapfill-drain.ts](../../src/comment-gapfill-drain.ts).
- The result callback consumes its token before provider writes; its comment explicitly describes downstream failures as best effort without a runner retry path. Review-fix dispatch creates the external execution before writing its job row and finding snapshot. These are concrete recovery seams to exercise, not claims that a particular incident has been reproduced.
- Some reference prose lags implementation: `docs/review-fix-rail.md` describes review-fix dispatch as GitHub Actions only, but the current function has a local-Docker branch too. Outside local mode it still calls GitHub Actions directly. Scope a pilot from the code.

The existing direction already anticipates this work. [ADR 017](../adr/017-move-the-run-lifecycle-onto-a-durable-execution-engine.md) and [ADR 018](../adr/018-adopt-restate-one-run-kind-at-a-time.md) call for evidence, deletion of old lifecycle glue, and add/switch/delete slices. ADR 018 currently orders kg-refresh, a CI-only feedback-loop experiment, then integration testing. A production review-fix pilot would explicitly revise that order; this note does not silently supersede it.

## Proposed module and its interface

The proposed module is `ReviewFixLifecycle`. Its external interface accepts authenticated feedback events, authenticated runner results, and explicit cancellation; it exposes status correlated with the existing run record. Callers should not need to coordinate queue flags, token consumption, sleeps, or retries themselves.

Internally, a short-lived exclusive handler on a per-PR Virtual Object coalesces feedback and records which attempt owns the PR. A workflow keyed by a stable attempt identity performs that attempt. The PR identity must include the installation/tenant where applicable, repository, and PR number. An attempt has its own identity: reusing the PR number alone would collapse legitimate later work into the prior workflow.

The attempt should:

1. Accept feedback durably before the adapter acknowledges acceptance. Journal the event identity and upsert the SQLite finding/audit records idempotently. Avoid acknowledging a SQLite-only insert followed by an unrecorded send to Restate; that recreates a dual-write recovery problem.
2. Coalesce a burst, apply existing review policy, acquire admission, and capture the current head and exact finding snapshot. Keep the 30-finding task cap aligned with what completion can resolve.
3. Persist a prepared run record and snapshot before launch. Dispatch through a worker adapter using the same stable attempt ID across retries; do not mint a new identity on replay.
4. Wait for an authenticated result or a durable deadline. A callback must reach a handler that can run while the workflow waits. Authenticate outside the journaled payload and pass validated, secret-free result data inside.
5. Apply a terminal transition idempotently, resolve only the dispatched findings as permitted by their dispositions, preserve the approval mark semantics, and release admission. Treat closure, cancellation, failure, and approval as distinct outcomes.
6. Notify the PR coordinator of completion and evaluate any feedback that arrived during the attempt. Clearing an old attempt must not erase newer pending work.

The coordinator must not hold an exclusive handler open while waiting for the runner. Other exclusive handlers for the same key would queue behind it, potentially blocking the callback it needs. Restate workflow shared handlers and durable promises support receiving results while a workflow waits. Promise names and validation must distinguish attempts; a delayed result cannot complete a newer attempt. [Handlers](https://docs.restate.dev/foundations/handlers), [external events](https://docs.restate.dev/develop/ts/external-events).

Keep SQLite authoritative for findings, dispatch history, and business conclusions. Restate owns workflow position, waits, and the proposed in-flight coordination marker. SQLite updates still need unique identities and conditional/idempotent transitions: a committed database operation can be retried if its journal acknowledgment was lost. See ADR 018 and [database integration](https://docs.restate.dev/guides/databases).

## The hard parts the pilot must confront

**External dispatch is not automatically exactly-once.** `ctx.run` records a completed result; it cannot atomically commit GitHub's acceptance and Restate's journal. Crash after launch but before journaling is the critical test. The adapter needs provider-supported idempotency or authoritative recovery of an execution by stable attempt ID. Where launch acceptance cannot be determined safely, expose an indeterminate state and park it for intervention instead of blindly launching again. A runner-side claim/fence can prevent duplicate effective work, but that is weaker than proving exactly one external run; record which guarantee the experiment achieves. [External transaction window](https://docs.restate.dev/guides/databases).

**Per-PR serialization does not cover all concurrency.** The current `canDispatch` checks issue occupancy, team capacity, parking, and the PR budget. A PR object does not serialize another PR's team-capacity check, the initial implementation dispatcher, or the separate human-comment dispatcher. For the isolated experiment, use one dedicated project and drain/disable competing dispatch sources. Before shared production operation, all paths that can contend must participate in atomic admission/reservations, with ownership checked on release. A fresh read of `canDispatch` followed by asynchronous launch is not a reservation. This is a required seam, not a reason to migrate every runner immediately.

**Cancelling coordination does not stop an external worker.** Request backend cancellation, invalidate/fence the attempt's authority, and confirm termination before releasing a slot for another writer. Handle late callbacks explicitly. Git head leases remain necessary because humans and external automation do not honor a Restate object lock. See the existing lease in `post-push-review.ts` and [Restate cancellation](https://docs.restate.dev/services/invocation/managing-invocations).

**Durable execution does not restore a working tree.** The inner loop reads and changes files, invokes subprocesses, and commits/pushes. Journaling a successful implementation step without retaining its filesystem output can cause replay to skip the very work the new runner needs. Stage-level migration requires durable commits/patches/artifacts plus an explicit restore contract. The recommended first pilot treats a runner attempt as external work; it does not promise mid-run resume.

**Some policies are the product.** Keep trusted reviewers, current-head checks, self-review suppression, finding dispositions, daily PR budgets and human override semantics, bounded iterations, approval rules, and merge gates. Restate can execute those policies reliably; it cannot decide them. Also distinguish infrastructure retries from another paid agent attempt, so automatic recovery cannot silently spend the dispatch or iteration budget again.

**Workflow durability changes deployment requirements.** The endpoint uses one mutable localhost URI. Its drain query counts SQLite jobs in `dispatched`/`running`; it does not inventory all queued or suspended Restate work. The pilot needs a concrete safe-deployment rule: drain all owned work before replacement, or demonstrate compatible replay/versioned endpoints. Restart recovery on the same durable volume is the pilot target. HA and volume-loss recovery remain separate operational work; record the existing backup/restore limitations rather than expanding this pilot into infrastructure redesign. [Service versioning](https://docs.restate.dev/services/versioning), [self-hosting](https://docs.restate.dev/server/overview).

**Observability needs correlation.** Restate supplies invocation inspection, journal history, retries, and waits. Retain runner logs and domain status. Link issue, PR/head, attempt, Restate invocation, runner execution, and finding snapshot so an operator can answer “what is it waiting for, and what happens next?” without joining logs by hand. Restate's UI does not infer the business meaning of a wait. [Invocation management](https://docs.restate.dev/services/invocation/managing-invocations).

## An experiment with an adoption decision

First build the branch's add slice against the pinned server/SDK and existing test harness, using a fake worker with controllable acceptance and completion. Do not change production routing to answer whether the interface is coherent.

Then exercise the real adapter in an isolated project. These are proposed checks, not completed tests:

| Scenario | Evidence required |
|---|---|
| Duplicate delivery and a burst of reviews | One intended attempt; distinct event audit preserved |
| Feedback arrives during an active fix | No overlapping writer; new feedback survives and can trigger the next attempt |
| Restart before dispatch / after acceptance / during result processing | Stable identity, explicit resolution of ambiguous launch, no silent duplicate work |
| Duplicate, conflicting, stale, and early callbacks | One terminal conclusion; wrong-attempt results rejected; prepared record exists before callback |
| Missing callback, provider outage, lost runner | Durable bounded waiting and a clear final or intervention state |
| Two PRs compete for one slot; competing legacy trigger attempts admission | Capacity is enforced; competing trigger is either explicitly disabled for the pilot or participates in shared admission before shared production use |
| Cancel or close during a fix | External worker handled; late output cannot approve or overwrite newer work |
| New finding after snapshot; head advances | Old completion cannot clear unseen findings or authorize a stale push |
| Deploy requested while work waits | Deployment is held by comprehensive drain or waiting work resumes on proven compatible code |
| Operator investigates a stuck attempt | One navigable chain from business status to workflow and runner evidence |
| Agent exhausts its turn or iteration budget | Iteration comparison and tool results support an evidence-backed explanation of non-convergence |
| Activity delivery duplicates a batch or loses its acknowledgment | One stored copy per event; ordered producer history and explicit gaps |
| Runner dies during activity upload; operator reopens a completed run later | Acknowledged evidence survives, missing tail is visible, and retained journal/activity remain inspectable within the configured window |

Finally make the deletion concrete. For selected Restate-owned runs, the legacy queue drain, callback lifecycle body, timeout/recovery decisions, and competing monitor writes must become inactive and then be removed where exclusive to the migrated path. Shared infrastructure cleanup can remain, but must not independently decide the run's outcome. Retain finding policy, worker adapters, audit/history, and business projections. Count independent lifecycle owners and operator recovery steps before/after, as well as code removed.

If the new workflow mostly wraps `processReviewFixQueue` while all old completion/recovery paths remain active, the experiment has failed to demonstrate simplification. If the dispatch adapter needs a substantial custom scheduler to be reliable, reassess the execution handoff before extending Restate further.

Use ADR 018's add/switch/delete sequence for adoption, with an explicit per-run lifecycle owner. Route callbacks and exclude legacy monitor/recovery decisions by that recorded owner, not merely by the `gap-analysis` phase, which also serves other dispatch paths. A feature toggle must select the owner for new attempts; it must not move an in-flight workflow back to legacy code. Rollback stops new Restate admissions and drains or explicitly terminates owned work before rerouting.

Conclude with a before/after assessment of simplicity, recovery, and observability, plus a short map of future extraction points. Further run kinds and integrations are separate decisions after this pilot. The accompanying [Restate capability research](2026-09-23-restate-pilot-capabilities.md) supplies upstream details and version caveats.
