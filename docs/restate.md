# Restate in the orchestrator

Restate is the durable-execution engine that holds workflow position for the run kinds migrated under ADR 017 and ADR 018. It does not replace the orchestrator: workflow code runs inside the Node process, and SQLite stays the system of record. Restate holds the journal and drives the handlers.

## What runs where

| Piece | Where | Owner |
|---|---|---|
| `restate-server` | A sidecar child process of the orchestrator on the same machine (ADR 023) | AII-627 documents it below |
| The SDK endpoint | An HTTP listener inside the orchestrator process, `src/restate/endpoint.ts`, on `127.0.0.1:9080`. The server calls it (push model); nothing else does | AII-612 |
| Workflows | One module per run kind under `src/restate/`, registered in the endpoint | one per migration |

## The endpoint module

`src/restate/endpoint.ts` builds the SDK endpoint with the registered service set and exposes the bind address. The review-fix workflow described below is not in that set yet; AII-811 composes and registers it with production adapters. The endpoint binds to localhost only: the server and the orchestrator share a machine, and the SDK endpoint must never be reachable from outside it.

### Prepared review-fix attempts (AII-796)

`src/restate/review-fix-attempt.ts` defines the `ReviewFixAttempt` workflow over the SDK-free store, worker, and finalizer contracts in `src/review-fix-ports.ts`. The caller admits and persists an immutable attempt in SQLite before invoking `run` under its exact `attemptId` workflow key. The workflow records launch intent and dispatch in one retry-safe step: if the external response or journal acknowledgement is lost, an existing intent forces exact reconciliation instead of a second launch. `result` and `cancel` are shared handlers so they can update the durable promise and persisted authority while `run` waits; result metadata is validated and must match the bound GitHub run ID and attempt before it can support approval.

Cancellation and deadlines revoke approval authority but retain the occupied slot until `inspectTerminal` confirms the backend stopped. An unknown launch similarly retains occupancy while exact reconciliation is inconclusive. The approval-evidence dependency must supply the current PR head, finding dispositions, and policy decision from current stored state; the workflow never infers them from a successful GitHub job. The factory does not wire a real adapter, boot registration, or live project selection. AII-811 owns that composition and AII-815 owns the live SAN evaluation. Workflow completion, journal, and handler-idempotency retention are each set to at least seven days after completion.

### Per-PR feedback coordination (AII-800)

`src/restate/review-fix-pr.ts` defines the unregistered `ReviewFixPR` Virtual Object keyed by installation, repository, and PR. The caller persists accepted feedback before signaling `feedback`; the object journals only a wakeup, not the feedback body. The first signal reads the effective collection window from its injected configuration provider (default five seconds) and schedules one check; later signals do not extend that timer, and a setting change applies only to later windows. An exclusive, short `check` handler reads current pending work from the injected store and atomically asks the attempt store to admit it. Deferred work gets a durable recheck without an attempt deadline or budget entry. A prepared attempt is sent to `ReviewFixAttempt.run` asynchronously, so the PR object never holds its exclusive handler while a runner waits. AII-811 must call `completed` after finalization and may call `capacityAvailable` when another reservation releases; both wake persisted pending feedback. A stale completion cannot clear a replacement attempt. SQLite adapters and boot registration remain with AII-811/AII-802.

## Testing

`npm run test:restate` runs the `src/__tests__/restate/**/*.restate.test.ts` files and nothing else. The default `npm test` excludes the whole `src/__tests__/restate/` folder in `vitest.config.ts`, so the default suite needs no Docker on any machine or inside a dispatched runner, where the agent runs `npm test` during implement passes. CI runs them in the `restate-tests` job of `.github/workflows/unit-tests.yml`, which inherits the `pull_request` triggers including `ai-implement/feature/**`.

Every Restate test lives under `src/__tests__/restate/` and is told apart from a unit test by that folder, not only by the `.restate.test.ts` suffix — a reader never has to check the suffix alone. A test never declares its own container, variants, start/stop hooks, or fetch helper: `src/__tests__/restate/harness.ts` exports `RESTATE_IMAGE_VERSION`, `VARIANTS`, `startVariants(services)` / `stopAll(environments)`, and the three call helpers `callService`, `callObject`, `callWorkflow`, and every test file imports them from there (AII-716).

`startVariants` boots one Restate container per variant with `RestateTestEnvironment.start` from `@restatedev/restate-sdk-testcontainers`, registering only the services the scenario needs. Container boot takes seconds; the normal hook/test cap is 60 seconds. `alwaysReplay: true` forces replay at every suspension; `disableRetries: true` surfaces error paths at once. The AII-796 recovery scenario separately uses the shared harness's pinned, retry-enabled, disk-backed environment to verify an endpoint and sidecar restart without replacing the journal. Tests run disarmed: the suite setup clears `RUN_TOKEN`, `RUNNER_CALLBACK_URL`, and `RUN_PROGRESS_TOKEN`, and an armed fixture points at an unroutable host (AII-567).

**The empty-body rule.** The call helpers read `response.text()` before parsing, so an empty 2xx body — what a `void` handler answers with on success — resolves to `undefined` instead of throwing a JSON-parse error. A non-2xx response throws, with both the status and the body text in the error message. Calling `response.json()` unconditionally is the AII-709 regression: a copy of the fetch helper that skipped this check parsed an empty body as JSON and failed all 13 scenarios against `issue`/`revoke`; the shared helper fixes that class once.

For a component-by-component walkthrough of one Restate test file, the fakes in each tier, and the rule for choosing a Restate test over a unit test, read `docs/restate-testing.md`.

### How an issue adds Restate tests (operator rule, 2026-09-16)

Every issue that adds or changes Restate behavior writes its tests in this order and states the order in its acceptance criteria:

1. Unit tests first, in the default suite (`src/__tests__/<module>.test.ts`), for every pure part: parsers, formatters, state-table branches with the Restate client injected as a fake. They run with no Docker, inside every dispatched runner.
2. Restate scenarios second, in `src/__tests__/restate/<module>.restate.test.ts`, built on `src/__tests__/restate/harness.ts`, run by `npm run test:restate` and the `restate-tests` CI job after `unit-tests`. Register exactly the services the scenario needs (`services: [...]`, passed to `startVariants`), one environment with `alwaysReplay: true` for the happy paths and one with `disableRetries: true` for the error paths. Each scenario asserts an observable effect, never a journal internal: a call count on a fake, a state read through a shared handler, a returned value. A Restate test never declares its own container, variants, or fetch helper — it imports them from the harness.
3. Type-check the Restate file explicitly (a throwaway tsconfig); `typecheck` excludes `src/__tests__`.

An issue with no Restate surface says so in the same place ("unit tests only"), so the absence is a decision and not an omission. The AII-688 tree is the first set of issues that carries this rule.

## Deployment and operations

`RestateSidecar` (`src/restate/server.ts`) owns the `restate-server` child process: spawn, readiness poll, stop. It mirrors `KgSidecar` (`src/kg-sidecar.ts`) — injected spawn, an HTTP readiness poll, and `stop()` through the shared SIGTERM-then-SIGKILL backstop in `src/process-stop.ts` — without sharing its spawn or readiness code, since a shell script polled over an MCP GET and a platform binary polled over an admin-API health check have nothing else in common (ADR 023).

### Boot sequence

`main()` (`src/index.ts`) constructs one `RestateSidecar` and calls `start()` before `loadConfig()`, right after the KG sidecar's own `start()`. Starting the SDK endpoint (`startRestateEndpoint()`) and registering it (`register()`) is driven off `whenReady()` (AII-724's late-readiness promise, below), not off `start()`'s own returned boolean — so a sidecar that only becomes ready in the background, after an initial readiness timeout, still gets its endpoint started and registered, exactly once (AII-807). `createRestateRegistrationGate` (`src/index.ts`) is the latch: its `attempt()` runs the start-and-register sequence at most once per boot, records the outcome via `setRestateStatus`, and refuses outright once shutdown has begun. `shuttingDown` is declared at the very top of `main()`, above the sidecar's own construction, specifically so the gate's `isShuttingDown()` check and the `shutdown` closure below read the exact same flag — a late readiness callback and a shutdown signal race over one latch, not two, so shutdown always wins: a `whenReady()` resolution that arrives after `shuttingDown` flips `true` is a no-op.

A `declined-conflict` outcome, from either the initial `attempt()` or a later retry, is not final (AII-721): the gate arms a single unref'd `setInterval` that re-runs `register()` every 60 seconds until it stops coming back `declined-conflict` — the old deployment's non-completed invocations are expected to drain on their own, so this just keeps checking back rather than requiring an operator restart. The timer is armed at most once (a decline while one is already pending reuses it rather than stacking a second), clears itself the moment an attempt succeeds or fails a different way, and `.unref()` means an armed timer never keeps the process alive on its own. `main()`'s shutdown closure calls the gate's `stopRetrying()` unconditionally, so a shutdown never leaves a pending retry behind.

`stop()` runs in the same `shutdown` closure that stops the KG sidecar, before `server.close()`, and the two sidecars are stopped concurrently — `stopSidecarsConcurrently` (`src/index.ts`), a thin `Promise.all` — rather than one after the other, so neither sidecar's `stopTimeoutMs` adds to the other's inside the 10-second forced-shutdown budget (`SHUTDOWN_BUDGET_MS`). Two sidecars each taking up to their own `stopTimeoutMs` (5s default) to exit now cost one wait, not two, leaving margin for `postShutdownNotice` ahead of them and `server.close()` after.

Every step is non-fatal: a missing platform binary, an early exit, or a readiness timeout each log at least one warning (`[restate] …`) and boot continues. Until a run kind migrates onto Restate, nothing in the orchestrator depends on the sidecar being up. **No run kind has migrated as of this writing** — `RESTATE_SERVICES` is empty and neither `src/kg-refresh.ts` nor `src/index.ts` has a Restate-backed trigger seam yet. The planned first consumer, kg-refresh (AII-683), is expected to answer `503 restate-unavailable` at its trigger seam when the sidecar is down, instead of hanging; that behavior does not exist until AII-683 lands.

#### Late readiness (AII-724)

A readiness timeout no longer ends the sidecar's lifecycle. `start()` still resolves its original boolean at the `pollTimeoutMs` deadline — `main()`'s call to `start()` is unchanged and boot proceeds exactly as before — but `RestateSidecar` keeps polling the same child in the background after that deadline instead of giving up on it. Two things can happen next, each logged and reported exactly once: the child later answers healthy (`[restate] sidecar ready after degraded period …`), or it exits (`[restate] sidecar exited (code=…, signal=…)`, read off the `"exit"` event rather than `"close"`, so the message does not wait on a lagging stream-drain event).

`whenReady(): Promise<boolean>` is how a caller observes that eventual outcome — it resolves once for the child spawned by the most recent `start()`, `true` on ready (immediate or delayed) and `false` on exit, missing binary, or `stop()`. `main()` attaches its continuation to `whenReady()` right after `start()` returns (§ "Boot sequence") — that single attachment covers both an immediate ready (the promise is already settled) and a delayed one, because `createRestateRegistrationGate`'s latch makes calling `attempt()` from that continuation idempotent regardless of when it fires.

`restart()` (`stop()` then `start()`, mirroring `KgSidecar.restart()` at `src/kg-sidecar.ts:179-182`) is the only re-spawn path. There is no automatic restart when the child exits unexpectedly, and no admin route calls `restart()` either — an unattended exit is reported through the status contract below and left there. `stop()` clears the background poll timer and resolves any pending `whenReady()` to `false` before tearing down the child, so a `stop()`/`restart()` during a degraded period cannot leave an orphaned timer polling a child that is no longer current.

**Status contract.** Sidecar lifecycle is reported through `src/restate/status.ts` (`setRestateStatus` / `getRestateStatus`, AII-773), a module-level state machine independent of this class: `starting` → `ready` | `timeout` | `exited` | `missing-binary`, with `timeout` able to transition to `ready` or `exited` once the background poll settles. `RestateSidecar` writes the sidecar half; `createRestateRegistrationGate` writes the registration half after each `attempt()` (§ "Health surfaces" below covers both in full).

#### Operator restart behavior

There is no admin-triggered restart for just the Restate sidecar or its endpoint registration — recovering from a stuck sidecar (`exited`, `missing-binary`, or a registration stuck at `unreachable`/`declined-conflict`) means restarting or redeploying the whole orchestrator process (the backend-outage playbook in `CLAUDE.md`, or a plain process restart on Fly). A fresh process re-runs the entire boot sequence above from scratch: a new `RestateSidecar` instance, a new `createRestateRegistrationGate` with its latch unset, and `status.ts` back at its honest `starting`/`not-attempted` default — so a previous process's stuck state never carries forward, and there is nothing to reset by hand before restarting. In-flight work is unaffected either way: no run kind has migrated onto Restate yet (§ "Boot sequence" above), so a stuck sidecar degrades `/mcp`'s `get_tenant_health` and the kg-refresh trigger seam, never a run in progress.

### Health surfaces (AII-807)

`GET /` (`src/index.ts`) and `get_tenant_health` (`src/restate/tools.ts`, over `/mcp`) both add a `restate` field, `getRestateStatus()` read verbatim — one source of truth (`src/restate/status.ts`), so the two surfaces cannot drift under a flapping sidecar the way two independently-tracked copies could. The shape:

```json
{ "sidecar": { "state": "..." }, "registration": { "state": "..." } }
```

`sidecar.state` — written by `RestateSidecar` (`src/restate/server.ts`):

| Value | Meaning |
|---|---|
| `starting` | `start()` has been called; no readiness answer yet (also the value before `start()` is ever called) |
| `ready` | The admin API answered healthy — immediately, or later via the background poll after a timeout |
| `timeout` | The initial `pollTimeoutMs` deadline passed with no healthy answer; background polling continues (may still transition to `ready` or `exited`) |
| `exited` (`code`, `signal`) | The child process exited or errored, at any point — during startup, after becoming ready, or during the post-timeout background poll |
| `missing-binary` | No `@restatedev/restate-server-<platform>` optional dependency is installed for this OS/arch; `start()` never spawned a child |

`registration.state` — written by `createRestateRegistrationGate` (`src/index.ts`) after each `attempt()`, mapping the finer-grained `register()` outcome (`src/restate/endpoint.ts`) onto this coarser contract:

| Value | Meaning | `register()` outcome(s) it covers |
|---|---|---|
| `not-attempted` | The gate has not run yet — the sidecar has never reported ready, or shutdown began first | *(none — pre-attempt default)* |
| `registered` | The SDK endpoint is registered with the admin API | `registered-no-force` (no conflict), `registered-drained-force` (conflicted, but zero non-completed invocations on the old deployment let a forced re-registration through) |
| `declined-conflict` | A `META0004` conflict was found and the old deployment still has non-completed invocations (or that count could not be determined), so the gate declined to force the registration; a retry is armed and keeps checking back every 60s (§ "Boot sequence" above) | `declined-conflict` |
| `unreachable` | The admin API could not be reached, answered an unexpected error, or `startRestateEndpoint()`/`registerRestateEndpoint()` threw | `unreachable`, plus any thrown error from either call |

Both `sidecar` and `registration` are independent — a `registration.state` other than `not-attempted` implies `sidecar.state` was `ready` at some point, but the reverse is not guaranteed (the gate could still be mid-`attempt()`, or shutdown could have won the race first).

### Ports and paths — all loopback, all constants

| Listener | Address | Constant |
|---|---|---|
| `restate-server` ingress | `127.0.0.1:8081` | `RESTATE_INGRESS_BIND_ADDRESS` (`src/restate/server.ts`) |
| `restate-server` admin API | `127.0.0.1:9070` | `RESTATE_ADMIN_BASE_URL` (`src/restate/server.ts`) |
| `restate-server` node/fabric | `127.0.0.1:5122` | `RESTATE_BIND_ADDRESS` (`src/restate/server.ts`) |
| SDK endpoint | `127.0.0.1:9080` by default | `restateBindAddress()` (`src/restate/endpoint.ts`), overridable with `RESTATE_ENDPOINT_HOST` / `RESTATE_ENDPOINT_PORT` |

None of the four is an admin-UI setting — every consumer is a same-machine peer, so there is nothing for an operator to point elsewhere (ADR 023). The fabric port (`bind-address`) defaults to `0.0.0.0:5122` upstream and was the one listener not already on loopback until it was pinned here — on Fly, an all-interfaces port is reachable over the private network.

`RestateSidecar` passes the bind addresses and the data directory to `restate-server` through its config-rs environment convention (`RESTATE_<SECTION>__<KEY>`, verified with `--dump-config` against the installed `@restatedev/restate-server` version):

- `RESTATE_INGRESS__BIND_ADDRESS` → the `ingress.bind-address` config key
- `RESTATE_ADMIN__BIND_ADDRESS` → the `admin.bind-address` config key
- `RESTATE_BASE_DIR` → the top-level `base-dir` config key, set to `restateDataDir()`
- `RESTATE_BIND_ADDRESS` → the top-level `bind-address` config key (the fabric port, above)

### Sidecar environment is an explicit allowlist, never `...process.env` (AII-728)

`RestateSidecar.start()` builds the spawned child's environment (`childEnv`, `src/restate/server.ts`) from an explicit allowlist rather than spreading the orchestrator's full `process.env`: the sidecar is a separate binary with no business seeing the GitHub App key, ticketing credentials, or anything else the orchestrator process holds. The allowlist is:

- `PATH`, `HOME`, `TMPDIR`, `TZ` — the process-hygiene basics a spawned binary needs, forwarded verbatim from `process.env` when set.
- Every `RESTATE_*` key, in two layers: any `RESTATE_*` key already present in `process.env` is forwarded by prefix match first (an operator-set override), then the six fixed constants above (`RESTATE_INGRESS__BIND_ADDRESS`, `RESTATE_ADMIN__BIND_ADDRESS`, `RESTATE_BASE_DIR`, `RESTATE_BIND_ADDRESS`, `RESTATE_DEFAULT_NUM_PARTITIONS`, `RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE`) are applied on top, so a same-named operator override can never shadow one of them.

Nothing else crosses. A decoy credential set anywhere else in `process.env` (an AWS key, the GitHub App private key, an npm token) never reaches the child.

### Memory

Measured in the built image with `docker run --memory 1g` (2026-09-17): 881 MiB container total with Restate's defaults (24 partitions, 2 GiB RocksDB budget), ≈ 480–490 MiB with `RESTATE_DEFAULT_NUM_PARTITIONS=4` and `RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE=256 MB` (both set in `src/restate/server.ts`'s child environment). The partition count is fixed the first time Restate provisions its data directory — set it before the first deploy, not after; changing it later has no effect on an existing `RESTATE_BASE_DIR`. The Fly Machine size for these numbers is the operator's decision, not this code's (ADR 023 amendment). Decision 2026-09-17: `fly.toml` sets `memory = "2gb"` — the orchestrator and Restate idle at ≈ 585 MiB together and the KG sidecar adds 300–400 MiB, which left no headroom in 1 GB.

### Data directory

`restateDataDir()` resolves the embedded store's location: `RESTATE_DATA_DIR` when set, else the dedup DB's directory plus `/restate` — `/data/restate` on Fly, `./restate` locally (`.env.example`). `.gitignore` excludes `restate/` so a local run's store never gets committed.

### Local image boot check

To confirm the loopback-only claim inside the built image rather than trusting the source:

```bash
docker run --rm -d --name ai-implement-boot-check <image>
sleep 5
docker exec ai-implement-boot-check sh -c "ss -ltnp 2>/dev/null || netstat -ltnp"
docker port ai-implement-boot-check
docker stop ai-implement-boot-check
```

Expect the ingress, admin, fabric, and SDK-endpoint ports (8081, 9070, 5122, 9080) to show a `127.0.0.1` local address inside the container, and `docker port` to publish none of them — a listener on `0.0.0.0` or a published port is the regression this check exists to catch.

### `npm run dev` and `npm run dev:run`

`npm run dev` spawns the Restate sidecar the same way boot does, with its data directory under `./restate` (see `CLAUDE.md` § Running locally). `npm run dev:run`'s mounted-workspace harness does not start it — that path exercises one runner container against a target-repo checkout, not the orchestrator process.

`restate-server` creates `<RESTATE_DATA_DIR>/<hostname>/ingress.sock`, `admin.sock`, and `fabric.sock`, and macOS caps a unix-socket path at 104 bytes. A checkout under a long path trips this at boot — `restate-server` exits with `RT0004 … failed binding on unix-socket file … path must be shorter than 104 bytes` — and the orchestrator logs the one `[restate]` warning and continues degraded, same as any other sidecar-start failure. On macOS, set `RESTATE_DATA_DIR` to a short path (for example `/tmp/restate-dev`) when the checkout path is long; the default `./restate` is fine for a checkout under `~/gitRepos/<repo>`.

## The Operator object

`Operator` (`src/restate/operator-object.ts`, AII-709) is a Virtual Object, one instance per OAuth client id, that is the refresh-token authority for the MCP human identity path. It is not a workflow — there is no run kind here — but it is the first piece of the MCP identity surface to move onto Restate, ahead of any run-kind migration, because the problem it solves (two callers racing one piece of durable state) is the same shape ADR 017 names as Restate's fit.

**Handlers and state table.** `issue`, `refresh`, and `revoke` are `exclusive` — mutual exclusion is the point, since two racing `refresh` calls for the same client must observe each other's writes rather than both reading the pre-rotation state. `describe` and `identity` are `shared`, since a read has no reason to queue behind the others. `identity` returns `{ email, sub, provider, expiresAt }` — no hash — and exists so `RestateRefreshAuthority.rotate` can read the identity behind a client id before touching anything durable; it is kept separate from `describe` (AII-714, backing `get_session_identity`'s `refresh` field) rather than extending it, so `describe`'s response shape stays exactly what that caller already relies on. State:

| Key | Written by | Holds |
|---|---|---|
| `email`, `sub`, `provider` | `issue` | The identity this client id belongs to |
| `family` (`FamilyState`) | `issue`, `refresh` | `currentHash`, `currentToken`, `previousHash`, `rotatedAt`, `expiresAt` |

`issue` fully replaces state, including a fresh `family` with `previousHash: null` — a second sign-in on an already-active client id always wins, unlike `refresh`'s careful two-hash handling. `revoke` clears all state with `ctx.clearAll()`, so a subsequent `issue` on the same client id starts from nothing — a new sign-in after a prior `revoke()` works because there is no state left to conflict with, not because of any flag `issue` resets.

**The grace window.** `refresh` keeps the current hash and exactly one previous hash. A presentation of the current hash rotates and returns the new pair. A presentation of the previous hash within `GRACE_MS` (30 seconds, **inclusive** of the boundary — exactly 30,000ms since rotation still counts) returns the *same* pair the rotation already produced, rather than rotating again. One tick past the boundary, the same presentation is replay and clears state. An unknown hash is also replay, but leaves a live family untouched — nothing to revoke, and a forged or stale presentation must not wipe out a concurrent, correct caller's state. `decideRefresh` is this branch factored out as a pure function of state and time, unit-tested in the default suite (including both sides of the grace-window boundary) rather than against a real 30-second wait.

**Only the hash crosses the ingress inbound.** The ingress journals request bodies, so a journaled raw refresh token would outlive its own rotation. `refresh`'s exclusive handler mints the next raw token itself (`ctx.rand.uuidv4()`, so concurrent callers converge on the identical value once the handler has serialized them) and returns it — unavoidable, since a caller cannot hand back a bearer secret it never received — but no raw token is ever accepted as input. The object keeps the current raw token in state (`currentToken`) for exactly one reason: so a concurrent caller presenting the previous hash within the grace window can be handed the same pair the first caller already received, rather than a second, different one.

**`RestateRefreshAuthority`** (same file) implements the `RefreshAuthority` seam (AII-707, `src/mcp-identity.ts`) as a thin ingress HTTP client and is the default authority for `src/mcp-oauth.ts`'s refresh grant.

**Check before write, mirroring `SqliteRefreshAuthority` (AII-718).** `rotate` reads identity first (the `identity` handler above — a shared, non-mutating call), then runs the allowlist re-check, and only then calls the exclusive `refresh` handler, which is the one durable write in the whole path, followed by the SQLite access-token insert. A durable rotation must be the last fallible step: rotating first and checking after (the original order) meant that if the allowlist read or the insert failed post-rotation, the client had already lost its current refresh token and got a 503 with nothing to retry against — its retry presented the now-previous hash, and once that landed outside `GRACE_MS` it was indistinguishable from replay and wiped the family, forcing a re-sign-in. Reordering means a failed check leaves the family untouched, so a retry presents the same still-current hash and just succeeds. The allowlist is a SQLite-backed, poll-refreshed cache (`src/access-entries.ts`) with no reason to become object state, and this re-check is the same revocation path `SqliteRefreshAuthority.rotate` runs: an unreadable list defers (`unavailable`, no revocation), an identity the list no longer admits gets its family revoked through the object's own `revoke` handler. The window between the identity read and the rotation is accepted, not closed — the allowlist can change in between, same as `SqliteRefreshAuthority`'s pre-existing window between its own read and write.

The one fallible step left *after* the durable rotation is the SQLite insert — a `SQLITE_BUSY` there cannot be retried by re-running `rotate` (the family has already moved), so it is the `GRACE_MS` window's job: a client retry inside the window presents the pre-rotation hash and `decideRefresh`'s "concurrent" branch hands back the same pair, rather than treating it as replay.

Each internal call never throws: a connection failure, a non-2xx response, or an unparseable non-empty body all resolve to `{ status: "unavailable" }`. `handleMcpTokenRequest` distinguishes two causes at the HTTP layer: the identity read or the rotation call itself failing (Restate unreachable) maps to `503 { error: "restate-unavailable" }` with no fallback authority (AII-687 decisions 2 and 4); the allowlist read failing after a successful identity read maps to `503 { error: "temporarily_unavailable", error_description: "Access control is unavailable" }`, matching what `SqliteRefreshAuthority` answered for the same outage before this object existed. `void` handlers (`issue`, `revoke`) answer with an empty body on success — the client treats an empty 200 body as success, not a parse failure.

## The tools service

`src/restate/tools.ts` (AII-710) hosts `orchestratorTools`, the Restate service `/mcp`'s diagnostic and write tools migrate onto one handler at a time. `tool()` wraps `restate.handlers.handler` with a `serde.zod` input/output schema and a fixed wire shape, `{ caller, args }` — `caller` (the already-verified identity and role) travels with every call instead of a bearer token, because the ingress journals request bodies durably and a credential has no business sitting in that journal; `args` is the tool's own arguments. The wrapper also carries the discovery metadata, `mcp.type: "tool"` and `mcp.role: "<user|admin>"`, which Restate's admin API attaches to the handler's deployment record after its first invocation.

`src/restate/tools-client.ts` is the two-way shim `src/mcp.ts` calls: `discoverTools()` reads `GET /services/orchestratorTools` off the admin API and turns each handler carrying `mcp.type: "tool"` into a `tools/list` entry (projecting the wire schema back down to just the `args` shape a caller should see); `callTool()` posts `{ caller, args }` to the ingress at `orchestratorTools/<name>` for `tools/call`. Before either runs, `tool()`'s role assertion checks `caller.role` against the tool's declared role (admin satisfies a `"user"` tool, the same superset rule `roleAllows` in `src/mcp.ts` uses) and short-circuits to an `isError` response naming the tool and the required role — this runs inside the wrapper, so it applies to any caller that reaches the handler, not just a request that came through `/mcp`.

Both admin API and ingress calls degrade the same way: a connection failure, a non-2xx response, or an unparsable body all collapse to an empty result rather than a thrown error. For `discoverTools()` that means a migrated tool silently drops out of `tools/list` while the admin API is unreachable — the same silent-omission precedent the `kg_*` tools already follow when their own capability doesn't exist for a session. For `callTool()` it means `tools/call` on a migrated tool answers `503 { error: "restate-unavailable" }`, distinct from the tool's own `isError` responses (a forbidden role, or a handler-reported failure), which still answer `200`.

A handler error is returned as an `isError` tool result by the wrapper, never retried, so `/mcp` keeps the pre-migration error behaviour. Restate's own suspension signal is not a handler error: the wrapper checks `restate.internal.isSuspendedError` before converting anything to `isError` and rethrows it unconverted, so a handler that awaits `ctx.sleep()`/`ctx.call()`/`ctx.get()` still suspends and resumes normally instead of coming back as a false failure.

## Durable steps in plain terms: what `ctx.run` is and why every side effect goes inside it

Restate runs a handler and writes a journal as it goes. Each recorded step holds the step's result. If the process that runs the handler dies, Restate starts the handler again from the top. This is a replay. During a replay, Restate hands back each recorded result instead of running that step again, until the code reaches the point where it stopped. Then normal execution continues.

Restate can only replay what it recorded. Plain code inside a handler is not recorded. A SQLite write, an HTTP call, a random number, a read of the clock: on replay, each of these runs again. That is how a write could run twice on the tools service before AII-717.

`ctx.run(name, fn)` is the recording wrapper. The first time through, Restate calls `fn`, stores its return value under `name`, and hands the value back. On every replay, Restate returns the stored value and does not call `fn`. One rule follows:

> Inside `ctx.run`, a thing happens once. Outside `ctx.run`, a thing happens on every attempt.

**What goes inside.** Anything that touches the world or the clock: a database write, a call to another service, a dispatch of a runner, a message to a user, a random value, the current time, a read of `process.env`. Restate offers `ctx.rand.uuidv4()` and `ctx.date.now()` for the last two, and the `Operator` object uses them. **What stays outside.** Other Restate context calls: `ctx.get`, `ctx.set`, `ctx.sleep`, `ctx.call`, a nested `ctx.run`. Those are journaled by design and are forbidden inside the closure. The closure must return a value the journal can store: plain JSON, no class instances, no functions. Compute the inputs before the call and pass them in; do not read them inside.

**Two levels of retry, two settings.**

| Level | What fails | Setting | What the tools service chose |
|---|---|---|---|
| The step | `fn` throws inside `ctx.run` | `RunOptions { maxRetryAttempts }` on the call | `1`: a failing action fails once and surfaces as a `TerminalError`, which the `tool()` wrapper turns into an `isError` result |
| The attempt | the handler's process dies, or a step exhausts its retries | `retryPolicy { maxAttempts, onMaxAttempts }` on the handler | `{ maxAttempts: 1, onMaxAttempts: "kill" }` on every write: a dead attempt is never re-delivered, the same as the in-process tools |

With no settings, Restate retries both levels for a long time with a growing back-off. That is the right default for a workflow that must finish. It is the wrong default for a request-scoped tool that a person is waiting on, which is why the writes set both. A handler with no side effect (every read tool) needs neither.

**How this relates to the work around it.**

- *Today, the tools service (AII-713, AII-717).* Each write is one `ctx.run` around one admin action, plus the two settings above. The Restate scenario "ctx.run runs its closure once while the code outside it re-executes on replay" in `src/__tests__/restate/tools.restate.test.ts` is the proof: under the `alwaysReplay` variant a counter inside the wrapper reads 1 and a counter outside it reads more than 1. The unit tier fakes `ctx.run` with a stub that records the name and options and calls the closure (`fakeContext` in `src/__tests__/tools.test.ts`).
- *Today, the `Operator` object (AII-709).* It has no `ctx.run` because it uses only journaled context calls: `ctx.get`/`ctx.set` for state, `ctx.rand` for the token, `ctx.date` for the clock. That is the other way to be replay-safe: touch nothing outside Restate.
- *Next, the run-kind workflows (ADR 017, AII-682, AII-684, AII-686).* A workflow is a sequence of `ctx.run` steps: dispatch the runner, record the run id, wait for the report through a durable promise, run each rail gate as its own step, revert as the compensation step when a gate fails. Because each step is recorded, a restart resumes at the last recorded step instead of dispatching a second runner. That is the whole reason ADR 017 chose an engine: the sweeps, state machines, and reapers a run kind carries today exist to reconstruct exactly this position by hand. Every step in those workflows follows the same rule as the tools service; the difference is that a workflow keeps the default retry policy, because finishing is the point.
- *Testing (docs/restate-testing.md).* Anything that only holds because of the journal is a Restate-tier test. The step logic itself, what a step does once called, is a unit test with the `run` stub.

A one-line rule of thumb for review: if a handler line touches the world or the clock, it is inside `ctx.run`; if it touches Restate, it is outside; if it touches neither, it does not matter.

## Working with Restate: patterns and pitfalls

Every rule below cost a failed run, a live-gate finding, or a discarded review to learn on the AII-687 tree. Each is enforced in code where noted; this section is the one place they are collected so the next migration does not relearn them.

### A `void` handler answers with an empty 200 body — read the text before parsing

A Restate handler that returns nothing answers a successful ingress call with an empty body, not `null` or `{}`. A client that calls `response.json()` unconditionally throws a parse error and reports success as failure. Read `response.text()` first and treat an empty 2xx body as success; parse only a non-empty body. The shared test helpers and `RestateRefreshAuthority.invoke` both do this. The AII-709 regression was a copy of the fetch helper that skipped the check and failed all 13 `issue`/`revoke` scenarios; `src/__tests__/restate/harness.ts` fixes the class once.

### A thrown handler error is retried forever — catch it, and never swallow the suspension signal

Restate retries a handler that throws until it succeeds. A tool handler that lets an application error propagate makes the ingress call hang and `/mcp` with it. The `tool()` wrapper (`src/restate/tools.ts`) catches handler errors and returns an `isError` tool result instead — but it first checks `restate.internal.isSuspendedError` and rethrows that unconverted, because a handler awaiting `ctx.sleep()` / `ctx.call()` / `ctx.get()` signals suspension by throwing, and converting that to `isError` would turn a normal suspension into a false failure. Any code that wraps a handler body in `try/catch` must re-throw the suspension error.

### The ingress journals request and response bodies — never send a raw secret through it

`restate-server` records the bytes of every ingress request and response in its journal, and a journaled value outlives the call. A raw refresh token sent as a handler argument would sit in the journal past its own rotation. The `Operator` object accepts only hashes as input and mints the next raw token inside the exclusive handler (`ctx.rand.uuidv4()`), returning it once; the raw value lives in object state only long enough to answer a concurrent caller inside the grace window (`docs/restate.md` § "The Operator object", ADR 025). Treat the journal as durable, readable storage: a credential has no business in it, which is also why `caller` (an already-verified identity) travels with a tool call instead of the bearer token.

### Never interpolate a caller-supplied segment into an ingress URL

`callTool` builds `orchestratorTools/<name>` and the REST route builds an ingress path from `<name>`; `fetch` normalizes `..` path segments, so an unescaped `..%2FOperator%2F<key>%2Frevoke` reaches a sibling service with no role check. Validate the shape first (`POST /api/tools/<name>` rejects anything outside `^[a-z][a-z0-9_]{0,63}$` with a 404 before the ingress is touched) and `encodeURIComponent` every dynamic segment. AII-712's live gate cleared a whole `Operator` family this way before the fix.

### An idempotency key must name one request — the caller names it, the server never derives one

Restate scopes an idempotency key by (service, handler, key) and keeps the keyed result for 24 hours by default, so a second call with the same key attaches to the first result instead of running. A key derived from per-connection counters cannot name one request on a stateless door: `/mcp` has no session id, and an MCP client restarts its JSON-RPC ids at zero on every connection, so a key built from the OAuth client id, the access token's issue time, and the JSON-RPC id still let a later connection inside the same token's lifetime collide with an earlier one's cached result and silently do nothing (`set_runner_mode`'s live gate reproduced this before the fix). The server does not get to guess which repeats are retries and which are new intent — MCP clients don't retry `tools/call` on their own, so a repeat is a human or a script, and a repeat with the same arguments is usually a new intent, not a lost response. The rule: the caller names the request; the server never derives a key from per-connection counters. `/mcp`'s `tools/call` accepts one only via `params._meta.idempotencyKey`, validated against `^[A-Za-z0-9._:-]{1,128}$` (`src/mcp.ts`); `POST /api/tools/<name>` accepts the same contract via an `Idempotency-Key` header (`src/admin.ts`). The shape check is shared (`IDEMPOTENCY_KEY_SHAPE`, `src/mcp.ts`). Before the key reaches Restate, the server prefixes it with the caller's identity (`scopeIdempotencyKey`, `src/mcp.ts`, applied by both doors): Restate scopes a key by (service, handler, key) with no notion of caller, so two callers that reuse one literal key for the same write would otherwise attach to each other's cached result and the second write would silently not run. The caller's own key stays the suffix, unchanged. No key supplied means no key forwarded to Restate at all — the call runs every time.

### Register the SDK endpoint without `force`, and force only after draining

`register()` (`src/restate/endpoint.ts`) posts the deployment without `force` at boot: an unchanged endpoint answers 200/201, and a changed service set at the same URI answers a `META0004` conflict. `force: true` overrides the deployment but "can lead inflight invocations to an unrecoverable error state" (Restate's own guidance), so it is used only after confirming zero non-completed invocations on the deployment it would replace. Never force a registration to get past a conflict.

That confirmation (AII-721/AII-841) is `queryNonCompletedInvocations()` (same file): `POST {adminBaseUrl}/query` with an `Accept: application/json` header — omitting that header answers Arrow IPC instead, which would need an undeclared production dependency — runs a DataFusion SQL count over non-completed `sys_invocation` rows scoped to deployments registered at the endpoint URI. The scope checks `pinned_deployment_id`, `last_attempt_deployment_id`, and unassigned invocations whose `target_service_name` currently maps to the old deployment in `sys_service`. The pinned 1.7.10 runtime test found a suspended running invocation with only `last_attempt_deployment_id`, and an exclusive invocation queued behind it with neither deployment ID; checking `pinned_deployment_id` alone incorrectly reported zero for both. `status != 'completed'` covers non-terminal states without an enumerated allowlist. Persistent Virtual Object state lives in a separate `state` table that never appears in `sys_invocation`, so durable state alone never counts as invocation activity — this is what replaced the old `getInFlightJobs()` (SQLite `dispatch_log`) guard, which only ever saw GitHub Actions/local-Docker job rows, not Restate's own invocations.

A query error, a non-2xx response, or a response shape this function doesn't recognize all resolve to `null` ("unknown"), which `register()` treats the same as a nonzero count: fail closed, decline the force. No deployment registered yet at the endpoint's URI resolves to `0` — nothing to drain. `getInFlightJobs()` stays exactly as used elsewhere (`src/dispatch-gate.ts`, `src/admin.ts`, `src/restate/tools.ts`) for legacy GitHub Actions/local-Docker job tracking; this drain check is unrelated to it.

A `declined-conflict` outcome is not treated as final: `createRestateRegistrationGate` (`src/index.ts`) retries on a timer rather than requiring an operator restart — see § "Boot sequence" above.

Both `postDeployment()` calls inside `register()` — the initial no-force attempt and the forced retry after a `META0004` conflict — carry `signal: AbortSignal.timeout(10_000)` (AII-728). A hung admin API answers the same `{ outcome: "unreachable" }` a connection failure already produces; `main()`'s unconditional `await registerRestateEndpoint()` therefore cannot block boot indefinitely on a sidecar that accepted the TCP connection but never answered.

### All Restate ports bind loopback — check the fabric port too

The orchestrator, the server, the admin API, and the SDK endpoint are same-machine peers, so ingress (8081), admin (9070), the SDK endpoint (9080), and the node/fabric port (5122) all bind `127.0.0.1` (§ "Ports and paths"). The fabric port defaults to `0.0.0.0:5122` upstream and was the one listener not on loopback until `RESTATE_BIND_ADDRESS` pinned it; on Fly an all-interfaces port is reachable over the private network. The local image boot check exists to catch a bind that regresses to `0.0.0.0`. On macOS, a long checkout path trips the 104-byte unix-socket limit (`RT0004`); set `RESTATE_DATA_DIR` to a short path.

### The partition count and machine size are fixed early — decide them before the first deploy

`restate-server` fixes its partition count the first time it provisions a data directory; changing `RESTATE_DEFAULT_NUM_PARTITIONS` afterward has no effect on an existing store (§ "Memory"). The default 24 partitions and 2 GiB RocksDB budget cost far more resident memory than a one-operator orchestrator needs, so the sidecar sets 4 partitions and a 256 MB budget, and `fly.toml` carries 2 GB — both must be right on the first boot of a new volume, not tuned later.

### Test with two environment variants, and assert observable effects

A Restate scenario registers only the services it needs and runs two environments from the shared harness: `alwaysReplay: true` forces replay at every suspension for the happy paths, `disableRetries: true` surfaces error paths at once (§ "Testing"). Assert an observable effect — a call count on a fake, a state read through a shared handler, a returned value — never a journal internal. Keep the pure decision logic (for example `decideRefresh`'s grace-window branch) in the default unit suite so it runs with no Docker; the container scenario proves the wiring, not the arithmetic.

### A passthrough tool that gains a zod schema gains a new validation layer — test it against the downstream contract

The ingress runs `input` before the handler ever sees the call. When a tool that used to pass its body through untouched (`WRITE_TOOLS` in `src/mcp.ts`, pre-AII-713) gets a zod schema, that schema can reject a value the handler it wraps has always accepted — `.optional()` alone refuses `null`, so a tool description that says "pass null to reset" needs `.nullable()` too, or the ingress 4xxs before `src/admin.ts` ever runs (AII-720). Test the schema with the values the downstream action's contract accepts, not only the happy shape it was migrated from.

### A dependency on Restate is a new failure mode — degrade, don't hang

Anything that reaches the ingress or the admin API gains a dependency on the sidecar being up. Decide the degraded answer before you migrate: a discovered tool drops out of `tools/list` while the admin API is unreachable (the same silent-omission the `kg_*` tools already use), a `tools/call` or a refresh answers `503 restate-unavailable`, and `get_session_identity` still answers because it is not a Restate handler. The rule from ADR 025: Restate down narrows to "this one surface is unavailable," never "nobody can use MCP," and never a 401 — a 503 says retry, a 401 says re-authenticate.

**"Down" includes "hangs," not only "refuses" (AII-728).** A connection failure resolves instantly; a sidecar that accepts a connection and never answers does not, and an unbounded `fetch` would hold the caller (and, for registration, boot itself) open indefinitely. Every fetch that crosses into the sidecar carries `signal: AbortSignal.timeout(ms)`, and a timeout is wired through the exact same fallback branch as a thrown connection error — no new status value anywhere:

| Call | Bound | Degrades to |
|---|---|---|
| `discoverTools()` (`src/restate/tools-client.ts`) — admin discovery | 5s | `[]` (drops out of `tools/list`, same as an unreachable admin API) |
| `callTool()` (`src/restate/tools-client.ts`) — tool ingress | 60s | `{ status: "unavailable" }` |
| `RestateRefreshAuthority.invoke()` (`src/restate/operator-object.ts`) — backs `issue`/`refresh`/`revoke`/`describe`/`identity` | 10s | `"unavailable"` (`rotate()` reports `{ status: "unavailable", cause: "restate" }`) |
| `postDeployment()` inside `register()` (`src/restate/endpoint.ts`) — both the no-force call and the forced retry | 10s | `{ outcome: "unreachable" }` |

The `RestateSidecar`'s own readiness poll (`_pollReadiness`, `RESTATE_HEALTH_URL`) already bounds each attempt at 2s via `http.get(url, { timeout: 2_000 })` and is unaffected by this table — it was bounded before AII-728 and named here only so the four bounds above are not mistaken for a fifth.

### Every side effect in a handler goes inside `ctx.run`, and a tool handler never retries

Restate re-delivers an invocation whose attempt died: a process crash, a dropped stream, or a deploy that killed the orchestrator mid-handler. On the new attempt, a step recorded with `ctx.run` is replayed from the journal and not re-executed; code outside `ctx.run` runs again. A handler that calls an admin action outside `ctx.run` therefore runs that action twice after a crash, and because `register()` runs before the first poll, the second run lands before the pipeline has seen anything (AII-717: a replayed `clear_dispatch_dedup` deleted the dedup row the first poll had just written). Two rules follow. First, every side effect in a handler, including a call into `src/admin.ts` or a `handle.trigger()`, goes inside a named `ctx.run` with `RunOptions { maxRetryAttempts: 1 }`; the value computed inside is journaled once, and a thrown action becomes a `TerminalError` the `tool()` wrapper converts to `isError` with no new retry path. Second, a request-scoped tool handler (every `role: "admin"` write on `orchestratorTools`) declares `retryPolicy: { maxAttempts: 1, onMaxAttempts: "kill" }`, so a dead attempt is never re-delivered at all: the caller is synchronous, sees the failure, and repeats the call by hand, which is exactly what the in-process tools did. The wrapper's try/catch does not change either rule: it stops Restate retrying a *thrown* error, not a *crashed* attempt. The boundary test asserts both: every admin handler body contains `ctx.run`, and only the four adapter modules import `src/restate/` (ADR 025 amendment, 2026-09-17).

## Writing a workflow for a run kind

Written by the delete slice of the first case, after the first workflow is real.
