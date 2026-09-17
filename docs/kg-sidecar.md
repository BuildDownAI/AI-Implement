# KG sidecar and the `/mcp` endpoint

The orchestrator bundles a Python knowledge-graph sidecar that serves `kg_*` tools, and exposes them to MCP clients through an OAuth-authenticated proxy at `/mcp`. This covers the deploy shape, how the image is built, the OAuth flow, and the ways a deploy can ship without a working sidecar.

Reference for `docker-entrypoint.sh`, the KG stages of `Dockerfile`, `src/mcp.ts`, `src/mcp-oauth.ts`, and `src/deploy.ts`. `CLAUDE.md` carries the summary and points here.

This document is the orchestrator's half. For the graph's full lifecycle — the ingest stack in the KG repository, the committed snapshot format, and what it means that the orchestrator and the KG are one deployable unit — see [kg-architecture.md](kg-architecture.md).

## Deploy shape

The sidecar runs **inside the orchestrator container on loopback** — no separate service, no public port, no second Fly app. `docker-entrypoint.sh` starts it on `127.0.0.1:8765`, waits for it, exports `KG_SIDECAR_URL`, and only then executes Node.

Startup has two entry points, tried in order: `kg/start.sh` (preferred — the vendor script knows its own arguments, and is generated at build time) or a bare `kg/server.py` with a pre-built `.venv`. Neither present means no sidecar.

Readiness is polled for up to 30 seconds. **Any HTTP response counts as ready**, including 4xx and 5xx — the check is whether the server accepts connections, not whether it answers correctly. The poll also bails early if the sidecar process has already exited, rather than waiting out the full timeout.

**Sidecar failure is non-fatal at every stage.** A missing entry point, a crash, or a readiness timeout all leave `KG_SIDECAR_URL` unset and let the orchestrator boot normally; `/mcp` returns 503 and every other route is unaffected.

For local development, start the sidecar yourself and set `KG_SIDECAR_URL` in `.env`, or leave it blank to run without `/mcp`.

## What `/mcp` tells you, and what it hides

The endpoint needs **both** `KG_SIDECAR_URL` and `OAUTH_REDIRECT_BASE_URL`, but the two are not equally visible from outside, because the auth gate sits between their checks.

- **`OAUTH_REDIRECT_BASE_URL` unset** — `/mcp` answers **503** to every caller.
- **`KG_SIDECAR_URL` unset** — `/mcp` answers **401** to an unauthenticated caller. Only an authenticated request that actually needs the sidecar reaches the 503; an authenticated `tools/list` still answers **200**, listing the built-in diagnostic tools alone. The sidecar check sits below both the auth gate and that routing deliberately, so those diagnostics stay reachable on a sidecar-less image. When a sidecar-requiring request does hit the 503, the body names the fix: `{"error":"no memory provider is configured (sidecar: KG_SIDECAR_URL unset)"}` — set `KG_SIDECAR_URL` and restart.

**So an unauthenticated probe of `/mcp` cannot distinguish a sidecar-less release from a healthy one — both answer 401.** The public endpoint that can is `/.well-known/oauth-protected-resource`, which 503s when either variable is missing.

Inside the container the question is settled without a request at all: `docker-entrypoint.sh` exports `KG_SIDECAR_URL` only after the sidecar answers its readiness check, so an absent value is the sidecar-less signal. That is what the orchestrator itself reads at boot.

## Building the image

### Base image

`node:24-slim` (Debian bookworm), not Alpine. fastembed and onnxruntime ship pre-built glibc wheels, and Alpine's musl libc makes those fail to install without a full from-source build. Slim costs roughly 30 MB and makes the sidecar viable without cross-compilation.

### Acquiring the KG source

The knowledge-graph repository is private. A **BuildKit build secret** mounts a GitHub token for exactly one `RUN` layer to clone it; the token is never written to `ARG`, `ENV`, or image history.

Set `KG_SOURCE_REPO` to a GitHub `owner/repo` value to bundle a graph — for example
`Answer9-llc/knowledge-graph-answer9-app` for a project-specific graph. An unset value builds
without a sidecar: the orchestrator boots normally, but `/mcp` returns 503. `KG_SOURCE_REPO` is
deliberately a repo identifier, not a URL: `src/deploy.ts` validates it before minting a
repo-scoped installation token, and the Dockerfile validates the same build arg before
constructing the clone URL.

**Where that token comes from is an operational prerequisite, not a detail.** A self-deploy mints it from the GitHub App installation, scoped to the configured knowledge-graph repository alone with `contents: read` — which only works if that repository is part of the installation. The installation grants selected repositories rather than the whole organisation, so it has to be added deliberately. Without it the mint fails with a 422 naming an inaccessible repository, before any build starts; the deploy reports a failure rather than shipping a sidecar-less image, which is the one good thing about failing this early. A manual deploy sidesteps the question entirely by passing an operator's own token.

That requirement is a consequence of automating the deploy, and it is worth understanding rather than working around. The operator script that preceded self-deploy cloned the repository with `gh auth token` — a *human's* credential, which reached the repository because that human could. An orchestrator has no human behind it; its only GitHub identity is the App installation, so access that used to be ambient has to be granted explicitly. The gap was always there, and borrowing a person's credentials merely hid it.

**Changing this is a deliberate decision, not a configuration tweak.** Two alternatives exist, and both cost something the current shape does not:

- **A read-only deploy key** on the knowledge-graph repository. The narrowest option — nothing else gains access — but it adds a secret to store and rotate, needs one per fork, and the clone would have to move from HTTPS to SSH.
- **A personal access token.** Works immediately and widens nothing at the installation, but reintroduces a person-shaped credential that leaves when they do, which is the property automating the script was meant to remove.

The App installation was chosen because it adds no new secret and keeps the per-deploy token scoped to a single repository. Its cost is that installation-*wide* tokens — the dependency-token vending path mints one — now reach the knowledge-graph repository too. That is bounded: the setting defaults to off per project, and a per-project repository list is already planned to replace the all-or-nothing scope. Revisit this if that plan changes.

The mount is declared `required=false`, so a build with no secret still succeeds — it logs `[kg] sidecar-less build` and produces a working orchestrator without `/mcp`. That fail-soft behaviour is deliberate, and it is also the trap described below.

### The four build stages

1. **Clone** — copies `kg_query`, `kg_ingest`, and `snapshot` plus the top-level files, then generates `start.sh` with the runtime environment baked in.
2. **Dependency install** — creates `/app/kg/.venv` from `requirements.txt`. Absent requirements means no venv, and everything downstream skips.
3. **Model bake** — warms the fastembed model `BAAI/bge-small-en-v1.5` into `FASTEMBED_CACHE_PATH=/app/kg/.fastembed-cache` so the running sidecar never fetches it at query time. **Soft failure** — logs `[kg] WARNING: EMBEDDINGS BUILD FAILED`, writes `kg/.embeddings-failed`, and continues lexical-only.
4. **Materialize and embed** — `kg_ingest.materialize --no-embed` produces `out/graph.trig`, then a second full pass adds semantic vectors. The graph pass is a **hard failure**: it is the one step not wrapped in a fallback, so a broken graph fails the build. The embed pass is **soft**: it writes `kg/.embeddings-failed` and falls back to lexical-only search.

When `docker-entrypoint.sh` detects `kg/.embeddings-failed` at boot (or finds `out/embeddings.npz` absent as a belt-and-suspenders fallback for images built without the marker) it exports `KG_EMBEDDINGS_DEGRADED=1`, logs a warning, and the orchestrator surfaces this in two places: `GET /` returns `{"kgDegraded": true}` in the health payload, and deploy notifications include a warning line so the degraded state is visible immediately after a deploy. Liveness is reported separately: after the sidecar is ready the orchestrator probes it (`tools/list` + one `kg_neighbors`) and every health read carries `kgUnavailable` plus a `sidecar` record (`reachable`, `toolsListed`, `lastError`, `checkedAt`) beside `kgDegraded` — see [deployment.md](deployment.md#kg-sidecar-health) (AII-648, AII-650).

`start.sh` exports the same `FASTEMBED_CACHE_PATH`, so the running sidecar reads the baked cache rather than downloading on first query. `kg_hybrid_search` therefore returns results immediately on boot with no separate data-load step.

### The graph is built from committed data, at build time

The clone brings three directories — `kg_query` (the server), `kg_ingest` (the transformer), and `snapshot` (the source data) — plus `requirements.txt` and `sources.yml`. The KG repository owns both the mechanism and the data.

**There is no runtime ingestion.** Nothing crawls, refreshes, or re-materializes while the orchestrator runs. The graph's freshness is a product of two separate things: when the snapshot was last committed to the KG repository, and when this image was last built. A perfectly healthy sidecar can serve a months-old view of the world, and nothing in its responses indicates the age of what it is serving. The clone is `--depth 1`, so the image does not carry the history that would let you check.

Updating the graph therefore means updating the snapshot upstream **and** rebuilding the orchestrator image. A redeploy alone changes nothing about graph content.

The container runs as the unprivileged `node` user.

## Deploying

**A plain `fly deploy` silently produces a sidecar-less image.** Deploy through the orchestrator itself, or with the manual command in [deployment.md](deployment.md#deploy-paths) when there is no orchestrator to ask.

Three separate mistakes each produce a silently degraded deploy, and each has happened repeatedly:

- **The build secret is required for the clone.** Without it the build fail-softs to a sidecar-less image rather than failing.
- **`--no-cache` is required.** A build secret is not part of the layer cache key, so a repeat deploy otherwise reuses a stale — possibly sidecar-less — clone layer even when the secret is present.
- **The token must be exported, not inlined.** An inline `GH_TOKEN=... fly deploy ... "$GH_TOKEN"` prefix does not affect same-line expansion and passes an empty secret.

Self-deploy carries all three by construction: they are assembled in one place and a test asserts each is present, so they cannot be dropped the way a hand-typed command can. The exported-token trap disappears entirely there, because the secret is passed as an argument rather than through a shell.

A release that boots is not necessarily a release that serves, and the difference is invisible from the Fly dashboard. **After a self-deploy** the orchestrator checks itself: the process that comes up in place of the one that started the deploy runs the liveness probe described below and records whether its own image actually serves, and `/admin#deployments` shows the result. A release made any other way records nothing, because no deploy hold was taken for it — those still need the manual check below.

The self-deploy record is now honest about the KGB-28 failure mode (AII-648): a sidecar can come up — `KG_SIDECAR_URL` gets set, the readiness poll answered — and still not actually serve `kg_*` tools, because the Python MCP SDK's streamable-HTTP transport can reject a stateless `tools/list` with `400 Missing session ID`. Before this probe existed, that shipped as `deployed-ok`: the deploy record only checked whether `KG_SIDECAR_URL` was set, not whether the sidecar actually answered a real query. Two things had to change together, in the same file (`src/kg-provider.ts`) — the proxy has to tolerate a session-demanding sidecar for real MCP traffic (AII-649), and the boot-time record has to stop trusting the env var alone (this issue). They're separable in principle but landed together because both touch `sendWithSessionRetry`.

To check by hand, poll **`/.well-known/oauth-protected-resource`** — 200 means both variables are set, 503 means one is missing. Polling `/mcp` for a 401 proves only that the route is configured.

### Verifying more than "it answers"

A 401 proves the endpoint is alive and OAuth-gated. It does not prove the graph is queryable.

The clone copies the KG's `sources.yml`, which pins the IRI namespace. Without it the server falls back to a placeholder namespace and every type-filtered `kg_*` tool returns empty — the graph loads, queries match nothing, and nothing errors. Verify a deploy with a real query (`kg_search` returning non-empty, or `degraded:false` in a `kg_hybrid_search` response), not just the 401.

**The orchestrator now runs that verification itself at boot, rather than only telling an operator to do it by hand (AII-648).** Right after `sidecar.start()` sets `KG_SIDECAR_URL`, `main()` calls `SidecarMemoryProvider.probe()`: a session-tolerant `tools/list` (reusing the same `sendWithSessionRetry` handshake `listTools` and `proxyCall` use) that must return all six `kg_*` tool names, followed by one cheap `tools/call` — `kg_neighbors` on the served graph's spine IRI (`<namespace>resource/graph/spine`, namespace read from whichever `sources.yml` is actually being served — the runtime overlay if one is staged, else the baked image) with `limit: 1` — that must come back a JSON-RPC `result`, not an `error`. The boot log carries the outcome: `[kg] sidecar probe: ok (6 tools)` or `[kg] sidecar probe FAILED: <reason>`.

The result lives in a module-level `sidecarHealth` record (`{ reachable, toolsListed, lastError, checkedAt }`, exported from `src/kg-provider.ts`) and `isKgUnavailable()`, which is `true` only when the *last completed* probe failed — a sidecar that has never been probed is not reported as unavailable. Every failed `listTools` or `proxyCall` also triggers a re-probe, throttled to at most one real sidecar round-trip per 60 seconds so a persistently down sidecar doesn't double every failing request's latency. The boot-time probe itself is never subject to that throttle — the first check always runs.

Every buffered sidecar request the provider makes — the session handshake, `listTools`, and both probe steps — carries a 10-second request timeout, the same bounding pattern `KgSidecar`'s own readiness poll uses (2s, scaled up here because these calls run a real query rather than just checking that the port accepts connections). Without this, a sidecar that accepts the connection but never answers — the process is up, `[kg] sidecar ready` already logged, but `tools/list` or `kg_neighbors` hangs — would leave `main()`'s `await memoryProvider.probe()` unresolved forever, which blocks `startServer()` (so the health check, admin UI, and poll loop never come up) and `postBootNotice()` (so not even `deployed-not-serving` gets recorded) — a strictly worse outcome than the silently-wrong `deployed-ok` this issue exists to fix. A timed-out request resolves `ok: false` rather than retrying the session handshake, so the worst case for a hung `tools/list` is one timeout, not a multiple of it. This timeout deliberately does not apply to `proxyCall`'s streamed real-traffic path — a legitimate hybrid-search or embedding query can run longer than 10 seconds.

**The deploy record now reflects the probe, not just the env var.** `decideDeployOutcome` (`src/deploy-notify.ts`) takes the probe's `lastError` as an explicit input (`sidecarProbeError`) rather than inferring health from `KG_SIDECAR_URL` alone: when the URL is set but the probe failed, the release records `deployed-not-serving` with `detail: "KG sidecar liveness probe failed: <lastError>"` — distinct from the pre-existing `"KG sidecar did not start"` detail used when the sidecar never came up at all. The record is written after the probe resolves, not before, so it can never race the check it depends on. This is the detection half only (AII-648); a follow-on issue plumbs `isKgUnavailable()` and `sidecarHealth` into `GET /`, `get_kg_status`, `get_tenant_health`, and the Deployments admin page.

### Building without the sidecar

```bash
docker build .                 # local, no secret
fly deploy --remote-only       # degraded: /mcp returns 503, all other routes healthy
```

## MCP OAuth

`/mcp` returns 401 with a `WWW-Authenticate` header pointing at `/.well-known/oauth-protected-resource`. A compliant client discovers the authorization server from there and completes an RFC 6749 authorization-code flow with PKCE.

| Endpoint | Purpose |
|----------|---------|
| `POST /mcp/register` | RFC 7591 dynamic client registration — returns `client_id` |
| `GET /mcp/authorize` | Starts the PKCE flow; delegates to the configured OIDC provider |
| `GET /mcp/callback/{provider}` | OIDC callback; applies the allowlist, mints a 5-minute auth code |
| `POST /mcp/token` | `authorization_code` exchanges code + PKCE verifier for an access token and a refresh token; `refresh_token` rotates both |
| `GET /.well-known/oauth-protected-resource` | Resource metadata pointing at the authorization server |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 authorization-server metadata |

Authorization is **fail-closed**, against the same allowlist the admin UI uses — which is database-backed and edited at `/admin#access`, with `OAUTH_ALLOWED_DOMAINS` / `OAUTH_ALLOWED_EMAILS` seeding it until the first save. See [access-model.md](access-model.md).

The list is re-checked on **every `/mcp` request**, not only at sign-in. An access token otherwise outlives a removal by up to its full hour; re-checking closes that window to a single request. A removed identity gets the same 401 an invalid token does, while an unreadable allowlist answers 503 — a database fault must not look like a revoked token.

### Token lifetimes and rotation

Access tokens default to one hour and are configurable through `MCP_ACCESS_TOKEN_TTL` (seconds). Refresh tokens live **30 days**, so a client re-authenticates in a browser roughly monthly rather than hourly.

Refresh is **rotating with reuse detection**. Each refresh mints a replacement in the same rotation chain, tracked by a `family_id` on the `mcp_refresh_tokens` table. Presenting an already-rotated token is treated as a replay: the entire family is deleted and a warning is logged, so a stolen token cannot be used alongside the legitimate client — both are forced back through a full sign-in.

Registration is bounded in the same spirit: a dynamically registered client that never completes its first authorization is pruned after 24 hours, and expired refresh tokens are swept on the same pass.

`MCP_ALLOWED_REDIRECT_ORIGINS` controls which callback origins dynamic clients may use. Loopback IP-literal HTTP callbacks are allowed by default; any other HTTPS origin must be listed explicitly, and arbitrary HTTPS callbacks are denied.

The orchestrator never forwards a caller's request to the sidecar. Since AII-711 a `kg_*` tool call is a handler on the `orchestratorTools` Restate service that calls `MemoryProvider.callKgTool(name, args)`, which sends its own JSON-RPC `tools/call` to the sidecar with the probe headers and no caller credential, so the sidecar never sees the caller's token. It should be reachable only from loopback.

Register two additional redirect URIs in the provider consoles, alongside the admin-UI ones:

- `${OAUTH_REDIRECT_BASE_URL}/mcp/callback/google`
- `${OAUTH_REDIRECT_BASE_URL}/mcp/callback/microsoft`

## Memory sizing

Fastembed models load into process memory at startup. A small model such as `BAAI/bge-small-en-v1.5` is ~130 MB on disk but expands to roughly 300–400 MB resident. With the orchestrator's own Node footprint of 100–150 MB, **256 MB Fly machines are too small** and will OOM-kill one process or the other.

Minimum with the sidecar is **512 MB** for serving alone. The refresh rail needs more: its materialize step runs as a second Python process beside the serving sidecar, and at ~31.6k quads it reached 271 MB RSS and was OOM-killed on a 512 MB machine (2026-09-08). **1 GB** is the working size for an orchestrator that refreshes its graph in place.

```toml
[[vm]]
  size = "shared-cpu-1x"
  memory = "1gb"
```

`fly.toml` ships 1 GB as the base default. Adjust per client in `clients/<slug>.toml`.

## Memory provider contract

The orchestrator abstracts KG access behind a `MemoryProvider` interface (defined in `src/kg-provider.ts`). The bundled sidecar is provider `"sidecar"` and is selected by default. An external implementer can build a conforming provider without reading orchestrator source; this section is the authoritative contract.

### The capability contract

Every `MemoryProvider` maps to up to six MCP tool names. The provider declares which it can serve via a `MemoryProviderCapabilities` object; callers degrade gracefully when a capability flag is `false`.

| Capability flag | MCP tool names | Degradation when `false` |
|---|---|---|
| `hybridSearch` | `kg_hybrid_search`, `kg_search`, `kg_semantic_search` | Tools are absent from `tools/list`; a `tools/call` for any of them returns a tool result with `isError: true` and the text `Tool not supported by this memory provider: <tool>` |
| `neighbors` | `kg_neighbors` | Same — absent from list, `isError` on call |
| `path` | `kg_path` | Same |
| `provenance` | `kg_provenance` | Same |
| `stalenessStamp` | *(no dedicated tool — served via `kg_neighbors` on the spine IRI)* | Callers that check graph freshness skip the staleness check or treat the result as unknown |

The `kg_*` handler enforces the capability filter (`src/restate/tools.ts`): a `tools/call` for a tool whose capability is `false` returns a tool result `{ isError: true, content: [{ type: "text", text: "Tool not supported by this memory provider: <tool>" }] }` at HTTP 200 — never a 503 and never a proxy error. Before AII-711 the same refusal travelled as a JSON-RPC `-32601` error; the text is unchanged and is what the skills layer's dual-target degradation rules key on.

### Interface

```typescript
interface MemoryProviderCapabilities {
  hybridSearch: boolean;
  neighbors: boolean;
  path: boolean;
  provenance: boolean;
  stalenessStamp: boolean;
}

interface MemoryProvider {
  readonly id: string;
  readonly capabilities: MemoryProviderCapabilities;
  listTools(body: Buffer, headers: http.IncomingHttpHeaders): Promise<unknown[]>;
  callKgTool(name: string, args: Record<string, unknown>): Promise<KgToolResult>;
  /** Legacy; no caller since AII-711. Deleted with the door restructure (AII-715). */
  proxyCall(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void;
}

type KgToolResult = { ok: true; result: unknown } | { ok: false; error: string };
```

- `id` — unique string identifying the provider (e.g. `"sidecar"`).
- `capabilities` — declare gaps up front; the orchestrator reads this once per request and filters the advertised tool list accordingly.
- `listTools` — return the MCP tool-definition objects (same shape as a JSON-RPC `tools/list` result) that this provider can serve. Only tools whose capability flag is `true` should appear here; the orchestrator will not enforce a second filter.
- `callKgTool` — run one `kg_*` tool and return its parsed JSON-RPC `result`, or `{ ok: false, error }` with a human-readable message. Called by the `kg_*` Restate handlers only for tools that cleared the capability check; it never receives the caller's credential and never writes to an HTTP response. The bundled provider's error texts are `KG sidecar unavailable: connection refused`, `KG sidecar error`, or the sidecar's own JSON-RPC error message.
- `proxyCall` — legacy request forwarding with no remaining caller; still on the interface until AII-715 removes it.

### Session handling

Only a 400 or 404 from the sidecar is buffered (to classify it as a session signal); every other response is relayed to the client as it arrives, so long or SSE responses are neither held in memory nor delayed until the sidecar closes the stream.

The bundled `SidecarMemoryProvider` prefers a stateless sidecar: `listTools` and `callKgTool` each send a single POST with no MCP session, and that request count never grows when the sidecar answers straight away. A stateful sidecar — the Python MCP SDK's streamable-HTTP transport defaults to this — is tolerated rather than fatal: on a `400` "Missing session ID" rejection, the provider performs a lazy `initialize` → `notifications/initialized` handshake against the same sidecar URL, caches the returned `mcp-session-id` on the provider instance, and retries the original call once with that header attached. The cached id is negotiated once per process lifetime and reused by `listTools`, `callKgTool` and `probe`, not renegotiated per request. A `404` on a previously-used session clears the cached id and re-initializes exactly once. At most one handshake and one retry happen per inbound call — if the handshake itself fails, the original rejection is surfaced rather than retried again.

`probe()` (the liveness check described above) is a third consumer of this same handshake path — it shares `sendWithSessionRetry` rather than issuing a raw, session-less request, so a sidecar that demands a session behaves identically for the probe as it does for real `tools/list`/`tools/call` traffic.

### Provider selection

The active provider is chosen at boot from the `MEMORY_PROVIDER` environment variable (default: `"sidecar"`). Per-mapping override is stored in the `memory_provider_id` column on the `mappings` table (TEXT, nullable, JSON-ready for future per-phase selection); it is not yet surfaced in the admin UI, and is not yet consulted at request time — `handleMcpRequest` uses the single global provider resolved at boot. This is scaffolding for future per-mapping routing.

### Building a conforming external provider

1. Implement `MemoryProvider` in TypeScript (or any language that can be imported/loaded into the orchestrator process).
2. Declare your `capabilities` conservatively — `false` for any tool you cannot reliably serve.
3. In `listTools`, return only tools whose capability is `true`.
4. In `callKgTool`, handle every tool the capabilities declare as true and never throw: resolve `{ ok: false, error }` for anything you cannot serve, so the handler surfaces the text as an `isError` tool result.
5. Register the provider in `resolveMemoryProvider()` in `src/kg-provider.ts` and add `MEMORY_PROVIDER=your-id` to `.env.example`.

## Orchestrator-native diagnostic tools

These tools need no working sidecar. Since AII-711 they are handlers on the `orchestratorTools` Restate service (`src/restate/tools.ts`), discovered by `/mcp` from Restate's admin API; only `get_session_identity` is served by the door itself.

| Tool | Description |
|---|---|
| `get_tenant_health` | Runner mode, in-flight job count, pending gap-fill queue count, project count, KG degraded flag |
| `get_kg_status` | KG refresh rail state — stage, served snapshot stamp, last refresh outcome and gate. Same object as `GET /api/kg/status`, callable without an admin token |
| `get_runner_mode` | Global runner mode and its source (env / db / default) |
| `list_projects` | All project mappings with per-project settings |
| `list_in_flight_jobs` | Currently dispatching or running jobs with elapsed time |
| `get_issue_dispatch_status` | Dispatch state for a specific issue identifier |
| `get_issue_report_card` | Full dispatch history, telemetry, and approval status for an issue |
| `get_fleet_report` | Aggregated per-repo stats over a configurable look-back window |
| `get_deploy_posture` | Deploy posture summary — see below |

### `get_deploy_posture`

No inputs. Returns a read-only snapshot of the current deploy and runner-channel state so that skills can price a merge before filing or merging.

```json
{
  "autoDeploy": true,
  "watchedRepo": "BuildDownAI/AI-Implement",
  "watchedRef": "testing",
  "runningCommit": "<sha>",
  "headCommit": "<sha>",
  "upToDate": false,
  "deploy": {
    "held": false,
    "inFlight": false,
    "lastOutcome": "deployed-ok"
  },
  "runnerChannel": {
    "image": "ghcr.io/builddownai/ai-implement-runner",
    "channelTag": "next",
    "channelCommit": "<sha or null>",
    "matchesHead": false
  },
  "mergeCost": "deploy+image"
}
```

Field notes:

- `autoDeploy`, `held`, `runningCommit`, `headCommit`, `lastOutcome`, `watchedRepo`, `watchedRef` — from the same source as `GET /api/deployment-status`.
- `upToDate` — `true` when `runningCommit === headCommit`, `null` when either is unknown.
- `deploy.inFlight` — `true` when runner jobs are currently executing (not whether a deploy is in progress).
- `deploy.lastOutcome` — one of `"deployed-ok"`, `"deployed-not-serving"`, `"build-failed"`, or `null` when no deploy has completed yet.
- `runnerChannel.channelTag` — `"next"` for `testing`, `"latest"` for `main`, `null` for other branches (no corresponding runner build).
- `runnerChannel.channelCommit` — the source commit baked into the channel image via its OCI config labels (`org.opencontainers.image.revision` or `AI_IMPLEMENT_SOURCE_COMMIT`). Best-effort: a registry error or missing label yields `null`.
- `runnerChannel.matchesHead` — `true` when `channelCommit === headCommit`, `null` when `channelCommit` is null.
- `mergeCost` — `"deploy+image"` when `autoDeploy` is on (every merge triggers a deploy and a runner image build); `"image"` when autoDeploy is off but the watched branch has a runner build (`main` or `testing`); `"none"` otherwise.

## Repository layout

`kg/` holds only a `.gitkeep` placeholder in git — the actual server code and snapshot are cloned at build time and never committed. The directory is excluded from workflow sync and never copied to target repos.
