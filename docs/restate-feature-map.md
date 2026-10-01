# Restate feature map

An inventory of the Restate SDK features, which of the three Restate consumers in the orchestrator use each one, and what the rest would buy. It describes the feature branch `ai-implement/feature/aii-682` after the kg-refresh children landed (reassessed 2026-10-01 against the branch head; the first version, written 2026-09-30, described `ecd8619`). Setup and operations live in [restate.md](restate.md); the tests in [restate-testing.md](restate-testing.md).

Columns: **KG** is kg-refresh (`src/restate/kg-refresh-workflow.ts`, `src/restate/kg-repo.ts`, `src/restate/kg-refresh-production.ts`); **RF** is the review-fix pilot (`src/restate/review-fix-attempt.ts`, `src/restate/review-fix-pr.ts`, `src/restate/review-fix-client.ts`); **Tools** is the operator object and tools service (`src/restate/operator-object.ts`, `src/restate/tools.ts`). The RF and Tools columns are unchanged since the first version.

## 1. Feature matrix: state and control flow

| Feature | KG | RF | Tools |
|---|---|---|---|
| Virtual object (`KgRepo`, `ReviewFixPR`, `Operator`) | yes | yes | yes |
| Workflow (`KgRefresh`) | yes | no | no |
| Durable steps (`ctx.run`) | yes | yes | yes |
| Durable timers (`ctx.sleep`) | yes | yes | yes |
| Durable promises (`ctx.promise`) | yes (`cancel`) | yes | no |
| Awakeables (`ctx.awakeable`) | yes (the run watch) | no | no |
| Delayed sends (`delay`) | yes (`expire` self-send) | yes (`genericSend`) | no |
| Object state (`ctx.set` / `ctx.get`) | yes | yes | yes |
| Deterministic time (`ctx.date.now`) | yes | yes | yes |
| `orTimeout` | no (`RestatePromise.race` with a tick arm) | yes | no |

## 2. Feature matrix: contracts and clients

| Feature | KG | RF | Tools |
|---|---|---|---|
| zod input schemas (`serde.zod`) | yes | no | yes |
| Typed send clients (`objectSendClient`, `workflowSendClient`) | yes | no (`genericSend`) | no |
| Request-response calls (`objectClient`, `workflowClient`) | yes | no | yes |
| `TerminalError` | yes | yes | yes |
| `TerminalError` with `errorCode` | yes (404 and 409) | no | no |
| SDK ingress client (`@restatedev/restate-sdk-clients`) | yes (`createKgRefreshIngressClient`) | no | no |
| Idempotency keys on ingress calls | yes | yes | yes |
| Retention on `report` / `cancel` / `run` | yes (`KG_REFRESH_RETENTION_MS`) | yes (`REVIEW_FIX_RETENTION_MS`) | no |
| Retention on `status` / `progress` | none | none | none |
| `retryPolicy` per handler | no | no | yes (`maxAttempts: 1`, `onMaxAttempts: "kill"`) |
| `ingressPrivate` | yes | no | no |
| Request identity keys | yes, all services on the endpoint | yes | yes |

Request identity is endpoint-wide, so the three columns share one answer: see [restate.md § Request identity (AII-976)](restate.md#request-identity-aii-976). The mechanism is not restated here.

## 3. What landed for kg-refresh

| Capability | Where | Issue |
|---|---|---|
| Awakeable run watch: the workflow creates an awakeable per GitHub run, registers it, and the `workflow_run` webhook resolves it; a tick is the backstop for a lost delivery | `src/restate/kg-refresh-workflow.ts` (`KG_REFRESH_WATCH_INTERVAL_MS`), `src/restate/kg-refresh-production.ts` (`registerRunWatch`, `resolveRunWatchAwakeable`) | AII-974 |
| Typed Restate clients and an SDK ingress client with a 409 mapping | `src/restate/kg-refresh-production.ts` (`createKgRefreshIngressClient`) | AII-975 |
| Lease expiry owned by the object: `expire` is a delayed self-send, replacing the stale-marker age check | `src/restate/kg-repo.ts` (`expire`, `KG_REPO_STALE_MARGIN_MS`) | AII-973 |
| Tokens outside the journal | `src/restate/kg-refresh-workflow.ts` | AII-973 |
| Per-PR dry-run outcome and same-sha dedup in `KgRepo` state (`sha:<repo>#<pr>`); the `kg_refresh_dry_run_outcomes` settings blob is deleted at boot | `src/restate/kg-repo.ts` (`recordDryRunOutcome`, `dryRunOutcome`), `src/kg-refresh.ts` | AII-977 |
| Request identity key on the sidecar | `src/restate/server.ts` (`ensureRequestIdentityKey`), `src/restate/endpoint.ts` (`resolveIdentityKeys`) | AII-976 |
| `ingressPrivate` on handlers only other services call (`run`, `release`, `expire`, `recordDryRunOutcome`) | `src/restate/kg-repo.ts`, `src/restate/kg-refresh-workflow.ts` | AII-976 |
| zod validation of the `KgRefresh` and `KgRepo` inputs | `src/restate/kg-refresh-workflow.ts` (`kgRefreshOptionsSchema`), `src/restate/kg-repo.ts` | AII-938 |

## 4. Features nothing uses yet

Each row says where it would fit.

| Feature | Where it fits |
|---|---|
| Invocation cancellation (SDK context cancel, admin cancel API) | Replace the own `cancel` durable promise once the kind does not need to hold the marker until the run concludes |
| Per-step retry intervals | `ctx.run` steps that call GitHub could back off longer than the default without a hand-written loop |
| `onMaxAttempts: "pause"` | Park a stuck invocation for an operator instead of failing it or retrying forever |
| Lazy state (SDK service option) | `KgRepo` accumulates `sha:` keys per PR; lazy loading keeps the exclusive handlers from reading all of them |
| Hooks | Cross-cutting tracing or logging around handlers |
| Admin cancel / kill / purge | Operator recovery of one invocation without a restart |
| Versioned deployments | Drain-free deploys of an endpoint whose in-flight journals the new code could not replay |
| Kafka subscriptions | Event intake that today enters through an orchestrator HTTP route |
| Virtual queues | Per-team admission that `dispatch_admissions` does by hand |

## 5. Hand-built mechanisms Restate could replace

### 5.1 kg-refresh

| Mechanism | Status |
|---|---|
| Stale in-flight marker age check | done (AII-973) |
| Run monitor and status poll | done (AII-974, awakeable run watch) |
| Untyped ingress calls | done (AII-975) |
| Unvalidated inputs | done (AII-938) |
| SQLite settings rows for the per-PR outcome and the `sha:<repo>#<pr>` key | done (AII-977); the state lives on `KgRepo`, and `kg_refresh_dry_run_outcomes` is deleted at boot |
| Timing flakes in the scenarios | done (AII-993) |
| The own `cancel` durable promise in `src/restate/kg-refresh-workflow.ts` | stays: cancel must wait for the backend run to terminate and hold the marker until then, which invocation cancellation does not do by itself |

## 6. Findings

| Id | Finding | Status |
|---|---|---|
| C1 | Stale marker check by age | fixed (AII-973) |
| B4 | Untyped clients and ingress | fixed (AII-975) |
| B3 | Unvalidated inputs | fixed (AII-938) |
| C2 | Lease expiry outside the object | fixed (AII-973) |
| C3 | Tokens in the journal | fixed (AII-973) |
| C4 | Run conclusion found by polling | fixed (AII-974) |
| C5 | Per-PR outcome in SQLite settings | fixed (AII-977) |
| C6 | Live measurement of the new timing | waits for the live measurement |
| C9 | Endpoint accepts unsigned requests | fixed (AII-976) |
| P1–P4 | Pilot (review-fix) rows | not addressed, by decision |

## 7. Record of what landed and what remains

Landed on the branch, in the order they merged:

- AII-973: object-owned lease expiry, tokens outside the journal.
- AII-938: zod schemas for the `KgRefresh` and `KgRepo` inputs.
- AII-975: typed clients and the SDK ingress client.
- AII-974: the awakeable run watch from the `workflow_run` webhook.
- AII-993: Restate test hygiene, `eventually` in `src/__tests__/restate/harness.ts` and the guard `src/__tests__/restate-test-hygiene.test.ts` (a test pattern, not a Restate feature).
- AII-977: per-PR dry-run outcome and same-sha dedup on `KgRepo` state.
- AII-976: request identity key and `ingressPrivate`.

Remains: C6 (live measurement), the pilot rows P1–P4 (not addressed, by decision), the own `cancel` promise (§ 5.1), and the § 4 features.
