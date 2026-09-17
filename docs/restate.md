# Restate in the orchestrator

Restate is the durable-execution engine that holds workflow position for the run kinds migrated under ADR 017 and ADR 018. It does not replace the orchestrator: workflow code runs inside the Node process, and SQLite stays the system of record. Restate holds the journal and drives the handlers.

## What runs where

| Piece | Where | Owner |
|---|---|---|
| `restate-server` | A sidecar child process of the orchestrator on the same machine (ADR 023) | AII-627 documents it below |
| The SDK endpoint | An HTTP listener inside the orchestrator process, `src/restate/endpoint.ts`, on `127.0.0.1:9080`. The server calls it (push model); nothing else does | AII-612 |
| Workflows | One module per run kind under `src/restate/`, registered in the endpoint | one per migration |

## The endpoint module

`src/restate/endpoint.ts` builds the SDK endpoint with the registered service set and exposes the bind address. The service set is empty until the first workflow registers. It binds to localhost only: the server and the orchestrator share a machine, and the SDK endpoint must never be reachable from outside it.

## Testing

`npm run test:restate` runs the `src/__tests__/restate/**/*.restate.test.ts` files and nothing else. The default `npm test` excludes the whole `src/__tests__/restate/` folder in `vitest.config.ts`, so the default suite needs no Docker on any machine or inside a dispatched runner, where the agent runs `npm test` during implement passes. CI runs them in the `restate-tests` job of `.github/workflows/unit-tests.yml`, which inherits the `pull_request` triggers including `ai-implement/feature/**`.

Every Restate test lives under `src/__tests__/restate/` and is told apart from a unit test by that folder, not only by the `.restate.test.ts` suffix — a reader never has to check the suffix alone. A test never declares its own container, variants, start/stop hooks, or fetch helper: `src/__tests__/restate/harness.ts` exports `RESTATE_IMAGE_VERSION`, `VARIANTS`, `startVariants(services)` / `stopAll(environments)`, and the three call helpers `callService`, `callObject`, `callWorkflow`, and every test file imports them from there (AII-716).

`startVariants` boots one Restate container per variant with `RestateTestEnvironment.start` from `@restatedev/restate-sdk-testcontainers`, registering only the services the scenario needs. Container boot takes seconds; a file is capped at 60 seconds. `alwaysReplay: true` forces replay at every suspension and is on for every scenario; `disableRetries: true` surfaces error paths at once. Tests run disarmed: the suite setup clears `RUN_TOKEN`, `RUNNER_CALLBACK_URL`, and `RUN_PROGRESS_TOKEN`, and an armed fixture points at an unroutable host (AII-567).

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

`main()` (`src/index.ts`) constructs one `RestateSidecar` and calls `start()` before `loadConfig()`, right after the KG sidecar's own `start()`. On success it starts the SDK endpoint (`startRestateEndpoint()`) and registers it (`register()`), logging the outcome. `stop()` runs in the same `shutdown` closure that stops the KG sidecar, before `server.close()`.

Every step is non-fatal: a missing platform binary, an early exit, or a readiness timeout each log exactly one warning (`[restate] …`) and boot continues. Until a run kind migrates onto Restate, nothing in the orchestrator depends on the sidecar being up. **No run kind has migrated as of this writing** — `RESTATE_SERVICES` is empty and neither `src/kg-refresh.ts` nor `src/index.ts` has a Restate-backed trigger seam yet. The planned first consumer, kg-refresh (AII-683), is expected to answer `503 restate-unavailable` at its trigger seam when the sidecar is down, instead of hanging; that behavior does not exist until AII-683 lands.

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

**Handlers and state table.** `issue`, `refresh`, and `revoke` are `exclusive` — mutual exclusion is the point, since two racing `refresh` calls for the same client must observe each other's writes rather than both reading the pre-rotation state. `describe` is `shared`, since a read has no reason to queue behind the others. State:

| Key | Written by | Holds |
|---|---|---|
| `email`, `sub`, `provider` | `issue` | The identity this client id belongs to |
| `family` (`FamilyState`) | `issue`, `refresh` | `currentHash`, `currentToken`, `previousHash`, `rotatedAt`, `expiresAt` |

`issue` fully replaces state, including a fresh `family` with `previousHash: null` — a second sign-in on an already-active client id always wins, unlike `refresh`'s careful two-hash handling. `revoke` clears all state with `ctx.clearAll()`, so a subsequent `issue` on the same client id starts from nothing — a new sign-in after a prior `revoke()` works because there is no state left to conflict with, not because of any flag `issue` resets.

**The grace window.** `refresh` keeps the current hash and exactly one previous hash. A presentation of the current hash rotates and returns the new pair. A presentation of the previous hash within `GRACE_MS` (30 seconds, **inclusive** of the boundary — exactly 30,000ms since rotation still counts) returns the *same* pair the rotation already produced, rather than rotating again. One tick past the boundary, the same presentation is replay and clears state. An unknown hash is also replay, but leaves a live family untouched — nothing to revoke, and a forged or stale presentation must not wipe out a concurrent, correct caller's state. `decideRefresh` is this branch factored out as a pure function of state and time, unit-tested in the default suite (including both sides of the grace-window boundary) rather than against a real 30-second wait.

**Only the hash crosses the ingress inbound.** The ingress journals request bodies, so a journaled raw refresh token would outlive its own rotation. `refresh`'s exclusive handler mints the next raw token itself (`ctx.rand.uuidv4()`, so concurrent callers converge on the identical value once the handler has serialized them) and returns it — unavoidable, since a caller cannot hand back a bearer secret it never received — but no raw token is ever accepted as input. The object keeps the current raw token in state (`currentToken`) for exactly one reason: so a concurrent caller presenting the previous hash within the grace window can be handed the same pair the first caller already received, rather than a second, different one.

**`RestateRefreshAuthority`** (same file) implements the `RefreshAuthority` seam (AII-707, `src/mcp-identity.ts`) as a thin ingress HTTP client and is the default authority for `src/mcp-oauth.ts`'s refresh grant. After the object answers a successful rotation, it re-checks the effective allowlist and mints the access token in SQLite — the allowlist is a SQLite-backed, poll-refreshed cache (`src/access-entries.ts`) with no reason to become object state, and this re-check is the same revocation path `SqliteRefreshAuthority.rotate` ran before this issue: an unreadable list defers (`unavailable`, no revocation), an identity the list no longer admits gets its family revoked through the object's own `revoke` handler. It never throws: a connection failure, a non-2xx response, or an unparseable non-empty body all resolve to `{ status: "unavailable" }`, which `handleMcpTokenRequest` maps to `503 { error: "restate-unavailable" }` with no fallback authority (AII-687 decisions 2 and 4). `void` handlers (`issue`, `revoke`) answer with an empty body on success — the client treats an empty 200 body as success, not a parse failure.

## The tools service

`src/restate/tools.ts` (AII-710) hosts `orchestratorTools`, the Restate service `/mcp`'s diagnostic and write tools migrate onto one handler at a time. `tool()` wraps `restate.handlers.handler` with a `serde.zod` input/output schema and a fixed wire shape, `{ caller, args }` — `caller` (the already-verified identity and role) travels with every call instead of a bearer token, because the ingress journals request bodies durably and a credential has no business sitting in that journal; `args` is the tool's own arguments. The wrapper also carries the discovery metadata, `mcp.type: "tool"` and `mcp.role: "<user|admin>"`, which Restate's admin API attaches to the handler's deployment record after its first invocation.

`src/restate/tools-client.ts` is the two-way shim `src/mcp.ts` calls: `discoverTools()` reads `GET /services/orchestratorTools` off the admin API and turns each handler carrying `mcp.type: "tool"` into a `tools/list` entry (projecting the wire schema back down to just the `args` shape a caller should see); `callTool()` posts `{ caller, args }` to the ingress at `orchestratorTools/<name>` for `tools/call`. Before either runs, `tool()`'s role assertion checks `caller.role` against the tool's declared role (admin satisfies a `"user"` tool, the same superset rule `roleAllows` in `src/mcp.ts` uses) and short-circuits to an `isError` response naming the tool and the required role — this runs inside the wrapper, so it applies to any caller that reaches the handler, not just a request that came through `/mcp`.

Both admin API and ingress calls degrade the same way: a connection failure, a non-2xx response, or an unparsable body all collapse to an empty result rather than a thrown error. For `discoverTools()` that means a migrated tool silently drops out of `tools/list` while the admin API is unreachable — the same silent-omission precedent the `kg_*` tools already follow when their own capability doesn't exist for a session. For `callTool()` it means `tools/call` on a migrated tool answers `503 { error: "restate-unavailable" }`, distinct from the tool's own `isError` responses (a forbidden role, or a handler-reported failure), which still answer `200`.

A handler error is returned as an `isError` tool result by the wrapper, never retried, so `/mcp` keeps the pre-migration error behaviour. Restate's own suspension signal is not a handler error: the wrapper checks `restate.internal.isSuspendedError` before converting anything to `isError` and rethrows it unconverted, so a handler that awaits `ctx.sleep()`/`ctx.call()`/`ctx.get()` still suspends and resumes normally instead of coming back as a false failure.

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

### An idempotency key must name one request, not a per-client counter

Restate scopes an idempotency key by (service, handler, key) and keeps the keyed result for 24 hours by default, so a second call with the same key attaches to the first result instead of running. A key built from only the OAuth client id and the JSON-RPC request id is not unique over time: MCP clients restart their JSON-RPC ids at zero every session, so a later session's write collided with a day-old result and silently did nothing. `writeIdempotencyKey` (`src/mcp.ts`) names one request — client id, the access token's issue time, the JSON-RPC id, and a hash of the arguments — so a genuine retry deduplicates while a new session or a different call runs. When you add an idempotency key, prove a collision live: the same key with different arguments must run, not attach.

### Register the SDK endpoint without `force`, and force only after draining

`register()` (`src/restate/endpoint.ts`) posts the deployment without `force` at boot: an unchanged endpoint answers 200/201, and a changed service set at the same URI answers a `META0004` conflict. `force: true` overrides the deployment but "can lead inflight invocations to an unrecoverable error state" (Restate's own guidance), so it is used only after `getInFlightJobs()` confirms zero in-flight work — the self-deploy interlock drains runs before the replacement process registers. Never force a registration to get past a conflict.

### All Restate ports bind loopback — check the fabric port too

The orchestrator, the server, the admin API, and the SDK endpoint are same-machine peers, so ingress (8081), admin (9070), the SDK endpoint (9080), and the node/fabric port (5122) all bind `127.0.0.1` (§ "Ports and paths"). The fabric port defaults to `0.0.0.0:5122` upstream and was the one listener not on loopback until `RESTATE_BIND_ADDRESS` pinned it; on Fly an all-interfaces port is reachable over the private network. The local image boot check exists to catch a bind that regresses to `0.0.0.0`. On macOS, a long checkout path trips the 104-byte unix-socket limit (`RT0004`); set `RESTATE_DATA_DIR` to a short path.

### The partition count and machine size are fixed early — decide them before the first deploy

`restate-server` fixes its partition count the first time it provisions a data directory; changing `RESTATE_DEFAULT_NUM_PARTITIONS` afterward has no effect on an existing store (§ "Memory"). The default 24 partitions and 2 GiB RocksDB budget cost far more resident memory than a one-operator orchestrator needs, so the sidecar sets 4 partitions and a 256 MB budget, and `fly.toml` carries 2 GB — both must be right on the first boot of a new volume, not tuned later.

### Test with two environment variants, and assert observable effects

A Restate scenario registers only the services it needs and runs two environments from the shared harness: `alwaysReplay: true` forces replay at every suspension for the happy paths, `disableRetries: true` surfaces error paths at once (§ "Testing"). Assert an observable effect — a call count on a fake, a state read through a shared handler, a returned value — never a journal internal. Keep the pure decision logic (for example `decideRefresh`'s grace-window branch) in the default unit suite so it runs with no Docker; the container scenario proves the wiring, not the arithmetic.

### A dependency on Restate is a new failure mode — degrade, don't hang

Anything that reaches the ingress or the admin API gains a dependency on the sidecar being up. Decide the degraded answer before you migrate: a discovered tool drops out of `tools/list` while the admin API is unreachable (the same silent-omission the `kg_*` tools already use), a `tools/call` or a refresh answers `503 restate-unavailable`, and `get_session_identity` still answers because it is not a Restate handler. The rule from ADR 025: Restate down narrows to "this one surface is unavailable," never "nobody can use MCP," and never a 401 — a 503 says retry, a 401 says re-authenticate.

### Every side effect in a handler goes inside `ctx.run`, and a tool handler never retries

Restate re-delivers an invocation whose attempt died: a process crash, a dropped stream, or a deploy that killed the orchestrator mid-handler. On the new attempt, a step recorded with `ctx.run` is replayed from the journal and not re-executed; code outside `ctx.run` runs again. A handler that calls an admin action outside `ctx.run` therefore runs that action twice after a crash, and because `register()` runs before the first poll, the second run lands before the pipeline has seen anything (AII-717: a replayed `clear_dispatch_dedup` deleted the dedup row the first poll had just written). Two rules follow. First, every side effect in a handler, including a call into `src/admin.ts` or a `handle.trigger()`, goes inside a named `ctx.run` with `RunOptions { maxRetryAttempts: 1 }`; the value computed inside is journaled once, and a thrown action becomes a `TerminalError` the `tool()` wrapper converts to `isError` with no new retry path. Second, a request-scoped tool handler (every `role: "admin"` write on `orchestratorTools`) declares `retryPolicy: { maxAttempts: 1, onMaxAttempts: "kill" }`, so a dead attempt is never re-delivered at all: the caller is synchronous, sees the failure, and repeats the call by hand, which is exactly what the in-process tools did. The wrapper's try/catch does not change either rule: it stops Restate retrying a *thrown* error, not a *crashed* attempt. The boundary test asserts both: every admin handler body contains `ctx.run`, and only the four adapter modules import `src/restate/` (ADR 025 amendment, 2026-09-17).

## Writing a workflow for a run kind

Written by the delete slice of the first case, after the first workflow is real.
