# 023. Run the Restate server as an orchestrator sidecar

**Status:** Proposed
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
