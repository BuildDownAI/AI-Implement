# 023. Run the Restate server as an orchestrator sidecar

**Status:** Accepted
**Date:** 2026-09-16

## Context

ADR 017 and ADR 018 commit to Restate as the run lifecycle's durable-execution engine, starting with kg-refresh. Restate needs two live components: `restate-server` itself (the durable log, the admin API, and the ingress that would front it) and an SDK endpoint that the server invokes by push over HTTP/2 (`src/restate/endpoint.ts`, AII-612). Both need somewhere to run before the first workflow (AII-629) can register against them.

The orchestrator already runs one child-process sidecar this way — `KgSidecar` (`src/kg-sidecar.ts`): spawned at boot, polled for readiness over HTTP, stopped with a SIGTERM-then-SIGKILL backstop before the orchestrator's own HTTP server closes. `restate-server` ships as an npm package, `@restatedev/restate-server`, whose platform-specific binary is an `optionalDependencies` entry resolved through a wrapper identical in shape to the sidecar's own resolution — a strong signal that the same pattern fits.

## Decision

Run `restate-server` as a second child-process sidecar of the orchestrator on the same machine, spawned by a new `RestateSidecar` class (`src/restate/server.ts`) that mirrors `KgSidecar`'s shape without sharing its spawn or readiness code — the two differ enough (shell script vs. platform binary; MCP GET vs. admin-API health) that only the stop sequence is common, and that piece was already extracted to `src/process-stop.ts`.

- **No separate Fly app, no additional deployment surface.** `restate-server` starts in `main()` (`src/index.ts`) alongside `KgSidecar`, before `loadConfig()`, and stops in the same `shutdown` closure before `server.close()`.
- **Every listener binds to loopback only:** the ingress at `127.0.0.1:8081`, the admin API at `127.0.0.1:9070`, and the SDK endpoint inside the orchestrator process at `127.0.0.1:9080` (`src/restate/endpoint.ts`). Nothing outside the machine calls any of the three — the server reaches the SDK endpoint by push, and the SDK endpoint registers against the admin API — so none of them needs, or gets, a non-loopback bind.
- **These are constants, not admin-UI settings.** The ports and the admin base URL (`RESTATE_ADMIN_BASE_URL`, `RESTATE_INGRESS_BIND_ADDRESS`) are exported constants in `src/restate/server.ts`; there is no per-project override and no settings-table row, because every consumer is a fixed, same-machine peer.
- **The embedded store's location is configurable, everything else is not.** `RESTATE_DATA_DIR` (env, `.env.example`) overrides the default of the dedup DB's directory plus `/restate` (`restateDataDir()`); unset, that is `/data/restate` on Fly and `./restate` locally. This is the one knob worth exposing, since it is the one thing an operator might need to relocate for disk-layout reasons.
- **Boot never fails on the sidecar's absence.** A missing platform binary, an early exit, a readiness timeout, or a failed registration each log exactly one warning and the process continues — the same non-fatal contract `KgSidecar` already established for `/mcp`. Until a workflow migrates onto Restate, nothing in the orchestrator's existing request paths depends on it; once one does (kg-refresh, AII-683), that seam answers `503 restate-unavailable` rather than hanging.
- **Registration is idempotent and drain-gated.** `register()` (`src/restate/endpoint.ts`) POSTs the endpoint URI to the admin API without `force`; an unchanged endpoint at the same URI answers 200/201 and that is success. A `META0004` conflict — the server refusing to apply a changed service set at that URI outright — only retries with `force: true` after `getInFlightJobs()` confirms zero in-flight kg-refresh rows, since Restate's own guidance is that a forced redeploy over in-flight invocations "can lead inflight invocations to an unrecoverable error state."

## Alternatives considered

- **A separate Fly Machine or app for `restate-server`.** Rejected for this stage: it adds a second deployable, a second health surface, and a network hop between the orchestrator and the server for no benefit while exactly one process (the orchestrator) is the only client of either the admin API or the ingress. Revisit if a later run kind needs the server to survive an orchestrator restart independently, or needs horizontal scaling Restate's own clustering would provide.
- **Bundling `restate-server` into the same process via an embedded binding.** Not offered by the `@restatedev/restate-server` package — it ships a binary, not a library — so this was never viable.
- **A public bind with network-level restriction (security group / firewall rule) instead of loopback.** Rejected: loopback is strictly narrower, needs no external policy to stay correct, and nothing has a reason to reach these ports from off-machine.

## Consequences

- Easier: one deploy artifact, one image, one set of Fly Machine health semantics to reason about. The failure mode for "Restate sidecar didn't start" is identical in shape to the KG sidecar's, which operators already know how to read from the boot log.
- Harder: `restate-server`'s memory and CPU footprint now shares the same Fly Machine as the orchestrator and the KG sidecar. AII-682 tracks a one-week post-merge observation of that footprint; if it is not acceptable, splitting the server out is the alternative recorded above, not a rewrite.
- The SDK endpoint, the server, and the admin API being colocated on loopback means none of the three needs its own authentication — correct only as long as none of them is ever bound off-loopback. A future change that widens any bind address must add authentication at the same time.

## Amendment (2026-09-17)

The operator gate's image boot check measured `restate-server`'s footprint with `docker run --memory 1g`: 881 MiB container total with Restate's defaults (24 partitions, a 2 GiB RocksDB memory budget), falling to ≈ 480–490 MiB with `RESTATE_DEFAULT_NUM_PARTITIONS=4` and `RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE=256 MB` — both now set in `RestateSidecar`'s child environment (`src/restate/server.ts`), alongside pinning the previously-unbound node/fabric port (`RESTATE_BIND_ADDRESS=127.0.0.1:5122`; default is `0.0.0.0:5122`, reachable over the Fly private network otherwise). The partition count is fixed the first time Restate provisions its data directory, so the env var must be set before an existing deployment's first restart onto this change, not after — a running `RESTATE_BASE_DIR` predating it keeps its original partition count regardless. Choosing the Fly Machine size against these numbers remains the operator's decision, not this ADR's — see docs/restate.md § "Memory" for the full figures and docs/deployment.md § "Local image boot check" for the measurement recipe.

## Amendment (2026-09-29): external events enter through an authenticated route; the Restate handler is the durable processor

**Context.** Restate's durable-webhooks guide points the sender at the ingress URL of a handler. Our ingress is loopback-only with no caller authentication (this ADR), a public ingress exposes every public service, and GitHub does not retry a failed delivery.

**Decision.** An external event (a GitHub webhook, a runner callback, an admin REST call) enters through one orchestrator route. The route authenticates the sender (HMAC signature, run token, or admin session), then forwards to the handler over the loopback ingress with an `idempotency-key` taken from the sender's own identity for the event (`x-github-delivery`, the dispatch id). Restate persists the event, deduplicates it, and runs the handler to completion. The route holds no queue, no table, and no retry loop.

Use the Restate primitive in place of a hand-built one: the idempotency key in place of a consume-once token or a dedup table; object state in place of an in-memory queue; a durable promise in place of a status poll; a journaled step in place of a state-machine row.

**Scope.** This is the rule for run kinds that are fully on Restate. Today those are the MCP tools service (ADR 025) and kg-refresh (AII-682). The review-fix pilot kept a SQLite inbox and delivery pump while a Legacy owner ran beside it (ADR 031). *Amended 2026-10-10: both were retired by AII-1187; the pilot now reaches Restate through the ingress client alone.* The main pipeline adopts the rule when it migrates; until then its routes do not change.

**A webhook may be the only trigger** when the sender retries (the runner does) or when a lost event is visible and recoverable (a required check that stays pending, a poll detector). Otherwise the run kind keeps a poll backstop.

**Alternatives rejected.** A public ingress (no caller authentication; every public service exposed; the payload is journaled before any check). An inbox table in front of every handler (a second durable log beside Restate's).

## Amendment (2026-10-01): request identity is the second control beside loopback binding

The Consequences note above, that none of the three listeners needs authentication while loopback-bound, no longer stands alone. `RestateSidecar` generates an ED25519 key pair under the data directory on first boot and gives the private key to the server; the SDK endpoint receives the public key as `identityKeys` and rejects unsigned requests. `RESTATE_IDENTITY_KEY` supplies the public key when the server is external (test runtimes). The key applies to the whole endpoint. Separately, handlers only other services call (`KgRefresh.run`, `KgRepo.release`/`expire`/`recordDryRunOutcome`) are `ingressPrivate`. A corrupt key is regenerated; an unpreparable key keeps the sidecar down; there is no unsigned mode on the sidecar path. Loopback binding stays. Rollback is a revert. See docs/restate.md § "Request identity".

## Amendment (2026-11-07): Restate is a hard dependency

The operator decided on 2026-11-07 that Restate is a hard dependency, superseding this Decision bullet:

> **Boot never fails on the sidecar's absence.**

Its reason no longer holds because kg-refresh, the MCP tools service, the refresh authority, PlanningRun, review fix, self-deploy and `RunnerBackend` now run on Restate (standing rule 3).

Only Restate changes: the KG sidecar remains non-fatal. The following tables define the contract that S1-10 and S1-14 will implement. This amendment records the required behavior ahead of those code changes on the same feature branch; it does not claim that they are complete. Until they land, boot continues after Restate startup or registration failure, as described in [docs/restate.md § Boot sequence](../restate.md#boot-sequence).

Boot (to be implemented by S1-10):

| sidecar.state | registration.state | Outcome |
| -- | -- | -- |
| ready | registered, hook finished | proceed: refresh the runner-backend cache, startupReconciliation, postBootNotice, first poll, poll interval |
| ready | registered, hook still running | keep waiting |
| ready | hook threw (the gate's catch sets unreachable) | log, stop both sidecars, close the server, exit 1 |
| ready | not-attempted (endpoint starting) | keep waiting until the boot deadline |
| starting | not-attempted | keep waiting until the boot deadline |
| timeout, before the boot deadline | not-attempted | keep waiting; the background readiness poll can still reach ready |
| not serving at the boot deadline, and registration is not declined-conflict | any | log, stop both sidecars, close the server, exit 1 |
| missing-binary | not-attempted | exit 1 at once |
| exited | any | exit 1 at once |
| ready | unreachable | exit 1 at once; the hook does not run |
| ready | declined-conflict | keep waiting with no deadline; the 60 s retry continues; the poll loop stays held |
| any | SIGTERM or SIGINT during the wait | normal shutdown, exit 0; the poll never starts |

After boot (to be implemented by S1-14):

| Event | Outcome |
| -- | -- |
| sidecar child exits or errors, not caused by stop() | shutdown with exit code 1; the machine restarts |
| sidecar exits because stop() or restart() ran | no action |
| sidecar exits while a shutdown already runs | ignored |
| an ingress call times out while the child is alive | unchanged: that call degrades (503 restate-unavailable), no shutdown |

GET / (operator decision D6, AII-1750):

`GET /` returns HTTP 200 with `status: "ok"` only when `restateCanServe` is true (sidecar `ready` and registration `registered`); otherwise it returns HTTP 503 with `status: "unavailable"`. Every other body field stays unchanged, including the Restate diagnostics.

| sidecar | registration | HTTP | status |
| -- | -- | -- | -- |
| ready | registered | 200 | ok |
| starting | not-attempted | 503 | unavailable |
| timeout | not-attempted | 503 | unavailable |
| ready | not-attempted | 503 | unavailable |
| ready | declined-conflict | 503 | unavailable |
| ready | unreachable | 503 | unavailable (the process is exiting per S1-10) |
| exited | any | 503 | unavailable |
| missing-binary | not-attempted | 503 | unavailable |

### Current implementation status (2026-11-08, Stage 1)

The Stage 1 runtime changes described prospectively in the November 7 amendment are now implemented. Boot waits for Restate readiness, successful registration, and completion of the registered hook, including the awaited `RunnerBackend` seed. Startup, registration, hook, and boot-deadline failures exit 1; `declined-conflict` continues waiting and retrying without a deadline. An unexpected sidecar exit after boot shuts down the orchestrator with exit 1, while intentional stop/restart teardown is suppressed. `GET /` returns 503 with `status: "unavailable"` whenever Restate cannot serve. The KG sidecar remains non-fatal. See [the current boot and health documentation](../restate.md#boot-sequence).

GitHub Actions planning now always enters `PlanningRun`, regardless of project lifecycle, and refuses dispatch while Restate is unavailable. Fly/local planning retains its lifecycle switch pending AII-1771. Stage 2 ownership changes in ADR 031, 030, and 018 remain prospective. AII-1756 provides protected setup-token storage/API only; Track D supplies the consumer/UI work, and this stage establishes neither live adoption nor a complete credential-flow proof.

The dated decision and prospective tables above remain the historical record; this implementation note does not establish deployed Fly restart policy or health.
