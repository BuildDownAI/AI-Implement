# Restate feature map: kg-refresh (fully migrated) against the review-fix pilot (partial)

First review: 2026-09-30, at `ai-implement/feature/aii-682` head `ecd8619` (kg-refresh) and
`testing` `354b68c` (review-fix pilot, tools service, Operator object). Reassessed 2026-10-01
against the feature branch after AII-938, AII-973, AII-975, AII-974, AII-993, AII-977 and
AII-976 landed. Only the KG column was re-verified; the RF and Tools columns and § 5.2 are the
first review's statements (the pilot is out of scope for this tree), and the `~line` anchors in
§ 5.2 are as of `354b68c`.
SDK `@restatedev/restate-sdk` 1.17.1, server 1.7.10.

This document answers three questions:

1. Which Restate features does each pipeline use today?
2. Which features does the kg-refresh pipeline use that the review-fix pilot does not?
3. Which Restate features does neither pipeline use yet, and where would each one fit?

It also lists the hand-rolled mechanisms that stand in for a Restate primitive, with the
primitive that replaces each one, and the review findings with their status (§ 6).

Companion documents: [restate.md](restate.md) (engine, patterns), [restate-review-fix-pilot.md](restate-review-fix-pilot.md), [issueless-runs.md](issueless-runs.md) (kg-refresh lifecycle), ADR 023, 025, 030, 031, 032.

## 1. Services

| Service | Kind | Key | File |
|---|---|---|---|
| `KgRefresh` | Workflow | trigger id (= the dispatch id, AII-938) | `src/restate/kg-refresh-workflow.ts` |
| `KgRepo` | Virtual Object | KG source repo slug | `src/restate/kg-repo.ts` |
| `ReviewFixAttempt` | Workflow | attempt id | `src/restate/review-fix-attempt.ts` |
| `ReviewFixPR` | Virtual Object | PR key | `src/restate/review-fix-pr.ts` |
| `Operator` | Virtual Object | operator identity | `src/restate/operator-object.ts` |
| `orchestratorTools` | Service | — | `src/restate/tools.ts` |

All six register through one endpoint (`src/restate/endpoint.ts`, `src/index.ts`). The service
and handler types that the typed clients use are in `src/restate/kg-refresh-types.ts`.

## 2. Feature matrix

"KG" = `KgRefresh` + `KgRepo`. "RF" = `ReviewFixAttempt` + `ReviewFixPR`. "Tools" = `orchestratorTools` + `Operator`.

| Restate feature | KG | RF | Tools | Notes |
|---|---|---|---|---|
| Workflow `run` handler | yes | yes | — | |
| Shared workflow handlers | yes: `report`, `progress`, `cancel`, `status` | yes: `result`, `cancel` | — | |
| Durable promises (`ctx.promise` get/peek/resolve) | yes (`report`, `cancel`, `progress`) | yes | — | RF uses peek-then-resolve (§ 6 P1) |
| `ctx.run` named steps | yes | yes (~25) | yes (one per write) | |
| `ctx.run` retry options | `maxRetryAttempts: 3` on the gate, `dispatch`, `outcome`, `merge` and `delete-branch` steps | none | `maxRetryAttempts: 1` | No `initialRetryInterval`, `maxRetryDuration` anywhere |
| Handler `retryPolicy` | none | none | `{ maxAttempts: 1, onMaxAttempts: "kill" }` on writes | |
| `ctx.sleep` | yes (race arm, cancel watch) | yes (1 s polling loops) | test seam only | |
| `RestatePromise.race` | yes | no | no | KG races report / cancel / progress / tick |
| `.orTimeout` | no | yes (once) | no | |
| Awakeables (`ctx.awakeable`) | no (removed by AII-1026, ADR 033) | no | no | |
| One-way send | yes, typed (`objectSendClient`, `workflowSendClient`; AII-975) | yes, untyped (`genericSend`) | — | |
| Delayed send | yes: `KgRepo.expire` self-send (AII-973) | yes (`ReviewFixPR.check` self-timer) | no | |
| Request-response call (`objectClient`, `workflowClient`) | yes (from tools handlers, typed) | no | yes | |
| Virtual Object state (`get`/`set`/`clear`) | yes (`inFlight`, `pending`, `outcome:<repo>#<pr>`, `sha:<repo>#<pr>`) | yes | yes (+ `clearAll`) | |
| Workflow state (`ctx.set` inside `run`) | yes (`step`, `runId`, …) | no | — | |
| Exclusive vs shared object handlers | yes (`status`, `dryRunOutcome` shared) | no (all exclusive) | yes (`describe`, `identity` shared) | |
| `ctx.rand`, `ctx.date` | yes | yes | yes | |
| `TerminalError` | yes | yes | no (wrapper answers `isError`) | |
| `TerminalError` with `errorCode` | yes: 404 and 409 (AII-975) | no | no | |
| Invocation cancellation (`ctx.cancel`, admin cancel) | no (own `cancel` promise) | no (own `cancel` promise) | no | § 5.1 |
| `ctx.attach` / `/restate/attach` | tests only | no | no | |
| Ingress `idempotency-key` | yes: runner report (dispatch id), webhook enqueue (delivery id) | yes: delivery pump key | when the caller supplies one | |
| SDK ingress client (`@restatedev/restate-sdk-clients`) | yes: `createKgRefreshIngressClient` (AII-975) | no | no | |
| Service options: `workflowRetention`, `journalRetention` | yes | yes | no | |
| Service options: `idempotencyRetention` | on `report`, `cancel` | on `result`, `cancel` | no | KG `status` and `progress` carry no retention (AII-973) |
| Service options: `inactivityTimeout`, `abortTimeout` | yes (15 m / 20 m) | no | no | § 6 C6 |
| Service options: `ingressPrivate` | yes: `KgRefresh.run`, `KgRepo.release`, `expire`, `recordDryRunOutcome` (AII-976) | no | no | |
| Service options: `enableLazyState` | no | no | no | |
| Zod input schemas (`serde.zod`, `.strict()`) | yes (AII-938) | no | yes | |
| Hooks | no | no | no | |
| Request identity keys (`identityKeys`) | yes | yes | yes | Endpoint-wide (AII-976); see [restate.md § Request identity](restate.md#request-identity-aii-976) |
| Admin API: registration with drain check | shared | shared | shared | `endpoint.ts` |
| Admin API: SQL introspection (`sys_invocation` …) | shared | shared | shared | deploy drain, census |
| Admin API: cancel / kill / purge / restart | no | no | no | |
| Two-runtime scenario tests (container + binary, `alwaysReplay` / `disableRetries`) | yes | yes | yes | |

## 3. What kg-refresh uses that the review-fix pilot does not

These are the features the fully migrated run kind picked up. Each one replaced a hand-built
mechanism the pilot still carries (§ 5.2).

| Feature | kg-refresh use | Pilot equivalent it replaces |
|---|---|---|
| **Virtual Object as the lock** (exclusive `trigger`, `inFlight` state, `release` from the workflow) | `KgRepo` (ADR 032) | `dispatch_admissions` rows + lifecycle-owner stamps + `isRestateOwnedJob` fences |
| **Object state as the queue** (`pending` map, drained by `release`) | `KgRepo.enqueueDryRun` (AII-730) | `ReviewFixPR` deferred recheck every 30 s; `capacityAvailable` (never called) |
| **Direct ingress from the authenticated route with an idempotency key** (ADR 023 amendment) | runner callback → `KgRefresh/{id}/report`; webhook → `KgRepo/{slug}/enqueueDryRun` | SQLite inbox + `ReviewFixDeliveryPump` (2 s `setInterval`) |
| **Request-response calls between services** (`ctx.objectClient`, `ctx.workflowClient`) | tools handlers call `KgRepo.trigger` / `KgRefresh.status` natively | none; the pilot only sends |
| **Race of durable promises against a timer** (`RestatePromise.race`) | wait loop: report / cancel / progress / tick | 1 s `ctx.sleep` loop with a GitHub call per tick |
| **Awakeables / signals** | A durable external signal into a workflow | Only through a channel every deployment already has (ADR 033); no GitHub App event or setting may be required |
| **Typed send clients and an SDK ingress client** (AII-975) | `objectSendClient` / `workflowSendClient` over `src/restate/kg-refresh-types.ts`; `createKgRefreshIngressClient` maps 404 and 409 | `genericSend`; hand-written `fetch` wrappers |
| **Zod `.strict()` inputs** (AII-938) | `KgRefresh.run` and every `KgRepo` handler with an input | none |
| **Lease expiry owned by the object** (AII-973) | `KgRepo` sends itself a delayed `expire` at the workflow's total deadline plus `KG_REPO_STALE_MARGIN_MS` | missed-close recovery poll |
| **Per-PR verdict and same-sha dedup in object state** (AII-977) | `KgRepo.recordDryRunOutcome`, `dryRunOutcome`, `forgetPr`; keys `outcome:<repo>#<pr>`, `sha:<repo>#<pr>` | SQLite rows and process memory |
| **Workflow state for progress** (`ctx.set("step", …)`) read by a shared `status` handler | `get_kg_status` stage derivation (`kgStageForStep`, `src/restate/tools.ts`) | SQLite row is the only progress record |
| **`inactivityTimeout` / `abortTimeout`** | 15 m / 20 m on `KgRefresh` | unset (defaults) |
| **Saga shape** (one `ctx.run` per rail gate, `revert` as compensation) | fetch → stage → swap → verify, `revert` | the pilot has no compensating step |
| **Exact run identity** (`returnRunDetails: true`, reconcile by title, reconcile-first `dispatch`) | `dispatch` step | reconcile loop by polling |
| **Credentials minted inside the dispatch step, never journaled** (AII-933, AII-973) | `mintRunTokens` is called inside `ctx.run("dispatch")`; the step result carries no token | `mintPreparedReviewFixToken` at launch (SQLite consume-once claim) |
| **`ingressPrivate` handlers** (AII-976) | `KgRefresh.run`, `KgRepo.release`, `expire`, `recordDryRunOutcome` | none; the pilot handlers are not marked |

## 4. Restate features neither pipeline uses yet

| Feature | What it gives | Where it fits first |
|---|---|---|
| **`.orTimeout` on the whole wait** | The total deadline as one timer | `KgRefresh` computes deadlines by hand with `ctx.date.now()` |
| **Invocation cancellation** (`ctx.cancel`, admin `PATCH /invocations/{id}/cancel`) | `TerminalError` at the next await; compensation in `catch` | Both workflows keep their own `cancel` promise. Justified today: Restate cancel cannot wait for GitHub to confirm the run stopped. Keep the promise, but treat an invocation cancel as a first-class path (the `catch` already releases the lock). |
| **Per-step retry policies** (`initialRetryInterval`, `maxRetryDuration`) | Bounded backoff per external call | GitHub and SQLite steps in both pipelines use the default intervals |
| **Handler `retryPolicy` with `onMaxAttempts: "pause"`** | A run pauses for an operator instead of dying | `KgRefresh.run` after a non-retryable gate failure |
| **`enableLazyState`** | State loaded on access, not per invocation | `KgRepo` now holds `pending` plus one `outcome:` and one `sha:` key per PR |
| **Hooks** | One interceptor for handler and `ctx.run` logging / tracing | Replace the `tool()` wrapper's audit lines and the per-step `console.*` calls |
| **Admin cancel / kill / purge / restart-as-new** | Operator recovery without code | The Deployments page cancel; a stuck `KgRefresh` today needs the SQL census + a manual force |
| **Versioned deployments** (register each build at a new URI) | In-flight invocations stay pinned to the old code; new code registers at once | The drain-then-force registration in `endpoint.ts` blocks new code while any 4 h workflow runs |
| **Kafka / event ingestion** | Not applicable today | — |
| **Virtual queues, rate-limiting patterns** | Per-key admission with fairness | The `dispatch_admissions` team-capacity table once every dispatch kind is on Restate (a capacity Virtual Object) |

Used by kg-refresh since the first review, and so removed from this list: typed send clients and `@restatedev/restate-sdk-clients` (AII-975), `TerminalError` with
`errorCode` (AII-975), `ingressPrivate` and request identity keys (AII-976). The pilot does not
use them yet.

## 5. Hand-rolled mechanisms

### 5.1 kg-refresh (fully migrated)

| Mechanism | Restate primitive | Status |
|---|---|---|
| GitHub run watch loop (`watch-N` / `reconcile-N`) | — | poll each 60 s (ADR 033) |
| Stale-marker age check (4 h 10 m) | delayed self-send `expire` | done (AII-973), § 6 B3 |
| Callback routed by the current marker | workflow keyed by the dispatch id | done (AII-938), § 6 B4 |
| Hand-written ingress client sniffing "conflicting report" | sdk-clients + `TerminalError` `errorCode: 409` | done (AII-975) |
| Untyped `genericSend`, cast handles | typed send clients | done (AII-975) |
| Gate failure JSON-encoded into a `TerminalError` message | a result union from `ctx.run` (`GateResult`) | done (AII-975) |
| Dead branch: `kgStageForStep` matched `watch-`/`reconcile-` that `step` never holds | — | done (AII-975) |
| `dryRunOutcomesByPr` (memory + the `kg_refresh_dry_run_outcomes` settings row), `kgDryRunLastSha` (memory) | `KgRepo` state (per-PR keys) | done (AII-977); the settings row is deleted at boot (`src/kg-refresh.ts`) |
| Own `cancel` promise + poll until GitHub confirms | invocation cancellation | stays, justified: the cancel path must hold the marker until GitHub confirms that the run stopped |
| Job-row id in a process `Map` with SQL fallback (`jobIds`, `src/restate/kg-refresh-production.ts`) | return the id from `ctx.run("reserve")` | done (AII-1011): the map is gone; `closeJobLog` resolves the row by dispatch id |
| `kg_refresh_last_refresh` / `kg_refresh_snapshot_sha` settings rows (`src/kg-refresh.ts`) | `KgRepo` state | stays; the served-snapshot record is read outside Restate at boot |

### 5.2 Review-fix pilot (partial) — exists because a Legacy owner runs beside it

Not changed by this tree.

| Mechanism | Code | Restate primitive once the kind migrates whole |
|---|---|---|
| SQLite inbox + delivery pump (2 s `setInterval`) | `review-fix-inbox.ts`, `review-fix-client.ts` ~199–397 | direct ingress with `idempotency-key`; longer `idempotencyRetention` |
| `dispatch_admissions` rows | `dispatch-admission.ts`, `dedup.ts` ~255–294 | a per-mapping capacity Virtual Object (`acquire`/`release`, waiters woken by send) |
| Lifecycle-owner stamps (`lifecycle_owner`) | `dispatch-admission.ts` ~31, `runner-tokens.ts` ~213, `deploy.ts` ~123 | implicit: the workflow key exists; `sys_invocation` census |
| `isRestateOwnedJob` fences (three copies) | `index.ts` ~2434, `stuck-watchdog.ts` ~19, `reaper.ts` ~22 | deleted with the Legacy owner |
| Per-project lifecycle selector | `config.ts` ~140 | deleted (rollout flag) |
| Consume-once publication token claim | `runner-tokens.ts` ~331 | a shared handler that resolves a durable promise once |
| 1 s reconcile / inspect polling loops | `review-fix-attempt.ts` ~161–178, 213–234 | awakeable + backoff race (as kg-refresh does) |
| 30 s deferred recheck; `capacityAvailable` never called | `review-fix-pr.ts` ~10, 77, 85, 110 | send to waiting PRs on release |
| Queue-drain nudge re-enqueued every 30 s bucket | `index.ts` ~3762–3771 | webhook sends directly to `ReviewFixPR.feedback` with an idempotency key |
| Missed-close recovery poll | `index.ts` ~860–872 | delayed self-send while `active` |
| Admin reconcile/adopt writes SQLite behind the workflow's back | `review-fix-admin-facade.ts` ~109–138 | a shared `adopt` handler resolving an `execution` promise |

## 6. Findings

Severity was a judgement for the review discussion, not a ticket priority. The finding text is
the first review's; the Status column is the state on the feature branch.

| # | Finding | Scope | Severity | Status |
|---|---|---|---|---|
| C1 | **Run options were dropped.** `trigger_kg_refresh` passed `ref`, `acceptNewBaseline`, `actorEmail`, but the workflow input had no field for them, so a PR-check dry-run ran against the default branch and accept-baseline was ignored. | KG | high | fixed (AII-938): zod `.strict()` schemas on `run`, `trigger`, `enqueueDryRun`; the options reach the dispatch |
| B4 | **Callbacks were routed by the current marker, not by their dispatch id.** A late report from an older run was accepted as the current run's report. | KG | medium | fixed (AII-938): the trigger id is the dispatch id; the callback addresses `KgRefresh/{dispatchId}/report` |
| B3 | **The stale-marker lease could overlap two rails.** The marker's age clock and the workflow's deadline started at different times. | KG | medium | fixed (AII-973): no age check; `KgRepo` owns a delayed `expire` self-send |
| C2 | **Catch-all blocks caught the suspension signal** and then called `ctx.*`. | KG (RF has the same shape) | medium | fixed for KG (AII-973): each catch rethrows on `restate.internal.isSuspendedError` |
| C3 | **Non-idempotent or non-durable side effects inside `ctx.run`.** `dispatch` retried a `workflow_dispatch` that is not idempotent; `onOutcome` was not awaited. | KG | medium | fixed (AII-973): `dispatch` reconciles by title before each attempt; `outcome` is an awaited step |
| C4 | **Secrets in the journal.** The run tokens were a step result, retained for 7 days. | KG | medium | fixed (AII-973): tokens are minted inside the `dispatch` step and never leave it |
| C5 | **Retention on high-frequency shared handlers.** `status` and `progress` kept journals and idempotency entries for 7 days. | KG | low | fixed (AII-973): no retention on `status` or `progress` |
| C6 | **`abortTimeout` 20 m vs long gates.** A `stage`/`materialize` or `canary` step over 20 m is aborted and retried; `swap` is marked not safe to retry. | KG | low–medium | open: set from the measured rail duration of one live refresh (operator closing work on AII-682) |
| C9 | **No endpoint or ingress security features.** No `identityKeys`; no `ingressPrivate`. Loopback binding was the only control (ADR 023). | all | medium | fixed (AII-976): request identity key on the sidecar, endpoint-wide; `ingressPrivate` on the kg-refresh handlers only other services call. The pilot handlers are not marked |
| P1 | **Peek-then-resolve on durable promises is not atomic** across `result` and `cancel` shared handlers (`review-fix-attempt.ts` ~295–318). | RF | low–medium | not addressed, by decision (pilot) |
| P2 | **Default infinite retries** on every pilot step; `tool()` swallows all non-suspension errors with an internal API (`restate.internal.isSuspendedError`). | RF, Tools | low | not addressed, by decision (pilot) |
| P3 | **Pump retries 4xx forever.** A `TerminalError` from a key/scope mismatch becomes a poison row retried every 5 s (`review-fix-client.ts` ~89–92). | RF | low–medium | not addressed, by decision (pilot) |
| P4 | Dead handler `ReviewFixPR.capacityAvailable`; stale "nothing uses the workflow" comments. | all | cleanup | kg-refresh comments fixed (AII-975); pilot part not addressed, by decision |

## 7. Record: what landed and what remains

Landed on the feature branch, in merge order:

1. AII-938 — C1 + B4: zod schemas, options forwarded to the dispatch, trigger id = dispatch id.
2. AII-973 — B3, C2, C3, C4, C5: object-owned lease expiry, reconcile-first `dispatch`, awaited `outcome`, tokens outside the journal, suspension rethrown, retention trimmed.
3. AII-975 — typed send clients, the SDK ingress client with 404 and 409, the `GateResult` union, dead branch and stale comments removed.
4. AII-974 — an awakeable run watch resolved by the `workflow_run.completed` webhook. It was never deployed and AII-1026 removed it (ADR 033): it needed a GitHub App event subscription on each deployment.
5. AII-993 — a test pattern, not a Restate feature: `eventually`, `queryInvocations`, `settle` in `src/__tests__/restate/harness.ts` and the guard `src/__tests__/restate-test-hygiene.test.ts`. AII-994 converts the remaining scenario files.
6. AII-977 — per-PR dry-run outcome and same-sha dedup on `KgRepo` state.
7. AII-976 — C9: request identity key and `ingressPrivate`. A corrupt key file is regenerated, a key that cannot be prepared keeps the sidecar down, and the sidecar path has no unsigned mode.
8. AII-1026 — the `workflow_run` path and awakeable are removed; the run watch is one 60 s status read (ADR 033).

Remains:

- C6: `abortTimeout` from one measured live refresh.
- The three "stays" rows of § 5.1.
- The § 4 features.
- The pilot: § 5.2 and P1–P4, when the review-fix kind migrates whole.
