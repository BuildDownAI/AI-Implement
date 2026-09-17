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

`npm run test:restate` runs the `src/__tests__/*.restate.test.ts` files and nothing else. The default `npm test` excludes them in `vitest.config.ts`, so the default suite needs no Docker on any machine or inside a dispatched runner, where the agent runs `npm test` during implement passes. CI runs them in the `restate-tests` job of `.github/workflows/unit-tests.yml`, which inherits the `pull_request` triggers including `ai-implement/feature/**`.

A test starts one Restate container per file with `RestateTestEnvironment.start` from `@restatedev/restate-sdk-testcontainers` and registers the services it needs directly. Container boot takes seconds; a file is capped at 60 seconds. `alwaysReplay: true` forces replay at every suspension and is on for every scenario; `disableRetries: true` surfaces error paths at once. Tests run disarmed: the suite setup clears `RUN_TOKEN`, `RUNNER_CALLBACK_URL`, and `RUN_PROGRESS_TOKEN`, and an armed fixture points at an unroutable host (AII-567).

### How an issue adds Restate tests (operator rule, 2026-09-16)

Every issue that adds or changes Restate behavior writes its tests in this order and states the order in its acceptance criteria:

1. Unit tests first, in the default suite (`src/__tests__/<module>.test.ts`), for every pure part: parsers, formatters, state-table branches with the Restate client injected as a fake. They run with no Docker, inside every dispatched runner.
2. Restate scenarios second, in `src/__tests__/<module>.restate.test.ts`, a sibling of the unit file, run by `npm run test:restate` and the `restate-tests` CI job after `unit-tests`. Register exactly the services the scenario needs (`services: [...]`), one environment with `alwaysReplay: true` for the happy paths and one with `disableRetries: true` for the error paths. Each scenario asserts an observable effect, never a journal internal: a call count on a fake, a state read through a shared handler, a returned value.
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
| SDK endpoint | `127.0.0.1:9080` by default | `restateBindAddress()` (`src/restate/endpoint.ts`), overridable with `RESTATE_ENDPOINT_HOST` / `RESTATE_ENDPOINT_PORT` |

None of the three is an admin-UI setting — every consumer is a same-machine peer, so there is nothing for an operator to point elsewhere (ADR 023).

`RestateSidecar` passes the bind addresses and the data directory to `restate-server` through its config-rs environment convention (`RESTATE_<SECTION>__<KEY>`, verified with `--dump-config` against the installed `@restatedev/restate-server` version):

- `RESTATE_INGRESS__BIND_ADDRESS` → the `ingress.bind-address` config key
- `RESTATE_ADMIN__BIND_ADDRESS` → the `admin.bind-address` config key
- `RESTATE_BASE_DIR` → the top-level `base-dir` config key, set to `restateDataDir()`

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

Expect the ingress, admin, and SDK-endpoint ports (8081, 9070, 9080) to show a `127.0.0.1` local address inside the container, and `docker port` to publish none of them — a listener on `0.0.0.0` or a published port is the regression this check exists to catch.

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

## Writing a workflow for a run kind

Written by the delete slice of the first case, after the first workflow is real.
