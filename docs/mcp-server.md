# The MCP server

The orchestrator serves one MCP endpoint, `/mcp`, so a Claude session (and every BuildDown skill that runs in one) can ask the orchestrator questions and, for a declared few actions, act on it. This is the auth and tools-service reference: the door, the identity contract, the tools service and its entry points, every tool with its role, and failure behaviour. The OAuth endpoints and the image build live in [kg-sidecar.md](kg-sidecar.md); who may sign in and with which role — the allowlist itself — is in [access-model.md](access-model.md); the Restate mechanics behind the tools service (the sidecar, the SDK endpoint, `tool()`'s wrapper) are in [restate.md](restate.md) § "The tools service", and the reusable rules for building on Restate are in [restate.md](restate.md) § "Working with Restate: patterns and pitfalls".

Reference for `src/restate/tools.ts`, `src/mcp.ts`, `src/mcp-oauth.ts`, and `src/mcp-identity.ts`.

## The door

`/mcp` is a JSON-RPC endpoint. Two methods matter: `tools/list` and `tools/call`. A request carries a bearer token minted by the MCP OAuth flow; nothing else is accepted, and an admin-UI session or an access code never reaches `/mcp`.

The handshake methods `initialize` and `ping` are answered by the orchestrator itself, `notifications/initialized` (and every other notification) is acknowledged with an empty 202, an unknown JSON-RPC method answers `-32601`, an unknown tool name answers `-32602`, and a non-POST request answers 405. Nothing on `/mcp` is proxied anywhere: the door implements the streamable-HTTP contract itself and has no SSE channel and no server-side session.

## Identity: kind, role and the caller

Every caller `/mcp` sees is resolved to one `Caller` (`src/mcp-identity.ts`): `{ kind, email, role }`. `IdentityKind` is `"human" | "system"` today — a human sign-in or in-process/system code (`systemCaller()`, always `role: "admin"`, `email: null`) — with a read-only `"run"` kind reserved for [AII-702](https://linear.app/eudoxus/issue/AII-702/accept-a-run-capability-at-mcp-as-a-read-only-run-identity) (see "Run identities" below). `role` is `"user" | "admin" | null`, resolved from the allowlist entry that admits the caller's email — `null` for an identity with no entry. `caller` travels with every Restate tool call instead of a bearer token, because the ingress journals request bodies durably and a credential has no business sitting in that journal (`tool()`'s wire shape, `src/restate/tools.ts`, `docs/restate.md` § "The tools service").

A tool is a **read** unless its handler declares `role: "admin"`. Every allowlisted identity, `user` or `admin`, sees and may call every read tool, including ones added later — there is no per-tool registration for reads. `list_projects` and `get_project_binding` both select their fields explicitly and omit `extraEnv`, so runner environment values never leave through a read.

A **write** exists on `/mcp` only if it is a handler on the `orchestratorTools` Restate service declaring `role: "admin"` in its `mcp.role` metadata (`tool()`, `src/restate/tools.ts`); the role is asserted inside that wrapper, not by the adapter, so the check holds regardless of which entry point reaches the handler. The six write handlers are the whole write surface: there is no tool that calls an arbitrary admin route, and every mutation not among them — allowlist edits, secrets, deploys, page grants — stays on the admin API and its UI.

A caller's role satisfies a handler's declared role when it equals that role or is `admin` (the same superset rule `docs/access-model.md` § Roles uses). A caller whose role does not satisfy it gets a tool result with `isError: true` and the text `forbidden: <tool> requires the <role> role`; `tools/list` also omits the tools the caller's role cannot use, but the check inside `tool()` is the boundary. Each write call, allowed or refused, is logged as one line with the actor's email, the tool, the role, and the result — written by the wrapper itself, so a call that reaches a handler through `POST /api/tools/<name>` or `callToolAsSystem` (see "Entry points" below) is audited too, not just a call through `/mcp`. (Mechanism: [AII-381](https://linear.app/eudoxus/issue/AII-381/mcp-write-tier-admin-role-tools-add-project-set-runner-mode-pause), moved onto the tools service by [AII-713](https://linear.app/eudoxus/issue/AII-713/migrate-the-declared-mcp-writes-into-the-tools-service-as-durable); decision record: ADR 015.)

## Which client holds which token

The client table covers how each kind reaches `/mcp` today:

| Kind | Reaches `/mcp` via | Email | Role |
| -- | -- | -- | -- |
| `human` | An OAuth access token (authorization code with PKCE, dynamic client registration; endpoints in [kg-sidecar.md § MCP OAuth](kg-sidecar.md#mcp-oauth)), verified by `verifyMcpToken` (`src/mcp-oauth.ts`) | The OIDC identity's email | The allowlist entry that admits the email, re-checked every request; `null` for an identity with no entry |
| `system` | Not over HTTP — `systemCaller()` is called by in-process code that needs an unattributed, unrestricted identity | `null` | Always `admin` |

Access tokens default to one hour (`MCP_ACCESS_TOKEN_TTL` seconds); refresh tokens live 30 days and rotate with reuse detection. The refresh grant runs behind the `RefreshAuthority` seam (`src/mcp-identity.ts`): `SqliteRefreshAuthority` (`src/mcp-oauth.ts`) was its first implementation; `RestateRefreshAuthority` (`src/restate/operator-object.ts`) is the default as of AII-709, serializing concurrent refreshes of one client id through the `Operator` Virtual Object (`docs/restate.md` § "The Operator object"). Its `rotate()` resolves to a `RefreshOutcome`: `ok` (fresh access + refresh tokens), `replay`, `expired`, `denied` (invalid token, `client_id` mismatch, or an identity the allowlist no longer admits), or `unavailable`.

The matching allowlist entry's role is what the write tier consults; it is read on every call and never stored in the token.

## What ends a session

An identity's ability to keep using its current or next token:

| Event | Effect |
| -- | -- |
| Access token expires (`MCP_ACCESS_TOKEN_TTL`, default one hour) | 401 on the next call; the client refreshes |
| Allowlist removes the identity | The per-request re-check denies on the very next call — not at token expiry, and not up to an hour later |
| Refresh token expires (30 days) | `RefreshOutcome.expired` → `invalid_grant` on the next refresh attempt |
| Refresh token replayed (already rotated away) | `RefreshOutcome.replay` → the entire rotation family is revoked (`revokeFamily`), and every token in the chain, including any legitimately-rotated successor, stops working |
| Allowlist re-check denies a refresh (identity no longer on the allowlist) | `RefreshOutcome.denied` → the rotation family is revoked and `invalid_grant` is returned |
| Allowlist unreadable (database fault) | `RefreshOutcome.unavailable` → 503, and the rotation chain is left untouched — a transient read failure must not look like a removal |

## The tools service and discovery

Tools come from two places and are merged into one list:

* **`get_session_identity`**, the one tool the door itself serves, because it reports the door's own state for this request.
* **Every other tool** is a handler on the `orchestratorTools` Restate service (`src/restate/tools.ts`, `docs/restate.md` § "The tools service"), discovered from Restate's admin API on each `tools/list` and called through the ingress on `tools/call`. Reads (`get_*`, `list_*`, and the six `kg_*` tools) are `role: "user"`; the six declared writes are `role: "admin"` — every tool's role lives on the handler's own `mcp.role` metadata, asserted inside the shared `tool()` wrapper, rather than in a separate list in `src/mcp.ts`.

The `kg_*` handlers call the KG sidecar through `MemoryProvider.callKgTool` (`src/kg-provider.ts`) rather than proxying the HTTP request; absent a provider, or when the provider lacks the tool's capability, the handler answers a tool result with `isError: true` and the same text `/mcp` always used, and `tools/list` omits those tools. When Restate itself is unreachable, a handler call — read or write — answers `503 restate-unavailable` and the discovered tools drop out of `tools/list` until it recovers. A write carries a Restate idempotency key only when the caller supplies one explicitly via the MCP `_meta` extension point — `params._meta.idempotencyKey` on `tools/call`, validated against `^[A-Za-z0-9._:-]{1,128}$` (a key outside that shape answers `-32602` and the tool never runs; the shape is shared with `src/admin.ts` via `IDEMPOTENCY_KEY_SHAPE`, `src/mcp.ts`) — prefixed with the caller's identity (`scopeIdempotencyKey`, `src/mcp.ts`, so two callers that reuse one literal key cannot collide; the caller's own key stays the suffix) and forwarded as `deps.idempotencyKey` to `callTool` (`src/mcp.ts`, `RESTATE_WRITE_TOOL_NAMES`). `/mcp` never derives one: it is stateless (no session id, and an MCP client restarts its JSON-RPC ids on every connection), so nothing in the request names "one connection's attempt at this call" except what the caller states. Omitting `_meta.idempotencyKey` means no key at all — the write runs every time, which is correct for a stateless door where a repeat is ordinarily a new intent, not a lost-response retry. Reads ignore the field entirely, valid or not. `POST /api/tools/<name>` (`src/admin.ts`) honours the same contract via an `Idempotency-Key` request header, for a caller such as CI with no MCP client.

Skills bind the server by name in `CLAUDE.md` (`kg.mcp_server`) and discover tools by description at session start, so a new read tool is usable the day it ships. A skill that performs a declared write is an **admin-only skill**: it calls `get_session_identity` first and stops with a clear message when the role is not `admin`. Read-only skills never call a write tool, whatever the role.

## Entry points

Three ways to reach a tool's result, all going through the same handler and the same role assertion (`tool()`'s wrapper, `src/restate/tools.ts`) for a tool bound to the Restate tools service — there is no separate auth mechanism per entry point.

| Entry point | Credential | Notes |
| -- | -- | -- |
| `/mcp` | OAuth bearer token | `tools/call`, described above. |
| `POST /api/tools/<name>` | Admin session (the same session every other `/api/` route requires) | For a caller with no MCP client, such as CI. Maps the session to `Caller { kind: "human", email, role }` using the session's own resolved role — never defaulted to `admin`. `<name>` must match `^[a-z][a-z0-9_]{0,63}$`; anything else answers `404 { error: "unknown tool" }` before the ingress is reached. A run capability ([AII-688](https://linear.app/eudoxus/issue/AII-688/run-identity-on-restate-for-kg-refresh-capabilities-mcp-reads-and-the)) is a later, separate entry point. |
| In-process | None | `callToolAsSystem` (`src/restate/tools-client.ts`) calls the handler directly with `systemCaller()` — for orchestrator code that wants a tool result without an HTTP hop. |

## Tools

Every tool's `Role` column comes straight from its handler's `mcp.role` metadata (`src/restate/tools.ts`), the same value `discoverTools()` surfaces and `tool()` asserts — this table doesn't declare anything of its own.

Reads, orchestrator-native:

| Tool | Role | Returns |
| -- | -- | -- |
| `get_session_identity` | user | The caller's email, provider, and role (`user`, `admin`, or `null` for an identity with no allowlist entry), as the allowlist resolves them now; `kind` (`"human"` today); `token: { issuedAt, expiresAt, clientId, clientPath }` for the access token that resolved this request; `refresh: { expiresAt } | null`, the refresh token's expiry from the `Operator` object's `describe()` — `null` when the client has no live refresh token, or during a Restate outage (never an error: identity must answer regardless). Admin-only skills call this first. A skill that reads `get_session_identity` should warn the operator when `refresh.expiresAt` is within 48 hours, so a re-auth happens before the refresh token itself expires. |
| `get_tenant_health` | user | Runner mode, in-flight jobs, pending gap-fills, project count, KG degraded flag, `kgUnavailable` + `sidecar` (the sidecar liveness probe's `reachable`/`toolsListed`/`lastError`/`checkedAt`), and the kg-refresh credential preflight rows |
| `get_kg_status` | user | KG refresh rail state: stage, served stamp, materialize path, last refresh outcome and gate, plus `kgUnavailable` + `sidecar` (same shape as `get_tenant_health`) |
| `get_runner_mode` | user | Global runner mode and its source |
| `list_projects` | user | Every project mapping with its settings, minus `extraEnv` |
| `get_project_binding` | user | The binding a skill needs for its own project — team key, repo, default branch, `tracker: { kind, team }`, the effective pickup label (the live ADR 022 settings row, not a hardcoded default; `null` for a mapping whose tracker isn't Linear, since the setting is a Linear-only row and a Jira or filesystem tracker's pickup signal is its own `AI-Implement-Status` field), and `kg: { present, orchestratorUrl, sourceRepo, baseRepo, searchTool }`. `kg.*` reflects orchestrator-wide config (`KG_SOURCE_REPO`, the `kgBaseRepo` setting, `RUNNER_CALLBACK_BASE_URL`), not the mapping — the KG is one graph, not per-project. Pass `repo` or `team` to select one project, returned as a single object; omit both to list every configured mapping, as an array — there is no per-caller filtering. An unmatched `repo` or `team` answers `isError: true` rather than falling back to every mapping. Never includes `extraEnv` or a token. |
| `list_in_flight_jobs` | user | Dispatching or running jobs with elapsed time |
| `get_issue_dispatch_status` | user | In-flight and dedup state plus recent dispatches for one issue |
| `get_issue_report_card` | user | Per-pass telemetry, totals, approval and merge state for one issue |
| `get_fleet_report` | user | Per-repo outcomes over a look-back window |
| `get_deploy_posture` | user | Autodeploy, deploy hold, running-vs-head commit, runner-channel state |

Reads, KG (handlers on the same service, each `role: user`, each calling the bound `MemoryProvider.callKgTool`; listed only when a provider is configured and declares the capability): `kg_hybrid_search`, `kg_search`, `kg_semantic_search`, `kg_neighbors`, `kg_path`, `kg_provenance`. The sidecar's own result is returned verbatim in `content[0].text`, `degraded` flag included; the sidecar's own error text comes back as `isError: true`.

Writes, declared:

| Tool | Role | Does |
| -- | -- | -- |
| `trigger_kg_refresh` | admin | Same as `POST /api/kg/refresh`: preflight, then dispatch the refresh rail. Answers accepted (202), already-running (409), or the named preflight refusal (422). Optional `dryRun` boolean argument: dispatches the same runner job with `kg-snapshot-push`'s push skipped — every guard still runs, and the verdict plus per-part line-count table are reported on `get_kg_status` as `lastRefresh.dryRun` / `.detail` / `.partTable`. `current/` and `servedStamp` are never touched, and `stage` is restored to whatever it held before the trigger. |
| `set_runner_mode` | admin | Same as `POST /api/runner-mode`'s mode update: forces (or restores) the global execution path. Accepts every value of `VALID_RUNNER_MODES` (`default`, `gha`, `fly`, `shadow`, `local`), validated by the action, not the tool; `local` is a developer-machine mode the admin UI's buttons do not offer. |
| `pause_project` | admin | Same as the `paused` update of `PATCH /api/mappings/<teamKey>`. |
| `add_project` | admin | Same as `POST /api/mappings`: create or update a project mapping, the upsert behind the admin UI's New project stepper. |
| `trigger_workflow_sync` | admin | Same as `POST /api/mappings/<teamKey>/sync-workflows`: re-sync the workflow templates for one project. |
| `clear_dispatch_dedup` | admin | Same as `DELETE /api/dedup/<issueId>`: clear a dedup entry so the issue can be re-dispatched. |

## Run identities

Placeholder. [AII-702](https://linear.app/eudoxus/issue/AII-702/accept-a-run-capability-at-mcp-as-a-read-only-run-identity) adds a third `IdentityKind`, `"run"`: a Restate-issued, read-only capability a dispatched run carries so it can call `/mcp` reads (e.g. `kg_*`, `get_project_binding`) without an OAuth session. This section describes that identity's shape, how it's minted and verified, and which tools it may call once that issue lands.

## Failure behaviour

| Condition | Answer |
| -- | -- |
| No or invalid token, or identity no longer allowlisted | 401 |
| `OAUTH_REDIRECT_BASE_URL` unset | 503 to every caller |
| Allowlist unreadable | 503 |
| `kg_*` call with no provider, or a capability the provider lacks | tool result `isError: true` with the pre-migration text (`no memory provider is configured` / `Tool not supported by this memory provider: <tool>`); the tool is also absent from `tools/list` |
| Any handler call — read or write — while Restate is unreachable | 503 `restate-unavailable`; `initialize` and `get_session_identity` still answer, since neither is a Restate handler — `get_session_identity`'s `refresh` field degrades to `null` rather than erroring |
| GET or DELETE on `/mcp` | 405 with `Allow: POST` |
| Unknown JSON-RPC method / unknown tool name | JSON-RPC error `-32601` / `-32602` at HTTP 200 |
| Write call below the required role | tool result `isError: true`, `forbidden: <tool> requires the <role> role`; logged |
| `trigger_kg_refresh` with KG refresh not configured | tool result `isError: true`, "KG refresh is not configured" |
| `get_project_binding` with an unmatched `repo` or `team` | tool result `isError: true`, `No project mapping found for repo: <repo>` / `for team: <team>` |
