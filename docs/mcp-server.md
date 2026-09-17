# The MCP server

The orchestrator serves one MCP endpoint, `/mcp`, so a Claude session (and every BuildDown skill that runs in one) can ask the orchestrator questions and, for a declared few actions, act on it. This is the reference for `src/mcp.ts` and `src/mcp-oauth.ts`. The KG sidecar that answers the `kg_*` tools, the OAuth endpoints, and the image build are in [kg-sidecar.md](kg-sidecar.md); who may sign in and with which role is in [access-model.md](access-model.md).

## Shape

`/mcp` is a JSON-RPC endpoint. Two methods matter: `tools/list` and `tools/call`. A request carries a bearer token minted by the MCP OAuth flow; nothing else is accepted, and an admin-UI session or an access code never reaches `/mcp`.

The handshake methods `initialize` and `ping` are answered by the orchestrator itself and `notifications/initialized` is acknowledged with an empty 202 — none of the three touch the memory provider, so a client can connect and list the orchestrator-native tools on a sidecar-less boot; only a `kg_*` tool call still needs one.

Tools come from two places and are merged into one list:

* **Orchestrator-native tools**, defined in `src/mcp.ts` (`DIAG_TOOLS` for reads, `WRITE_TOOLS` for writes) and served by the orchestrator process itself. They need no sidecar, so they answer on a sidecar-less image.
* **Memory-provider tools** (`kg_*`), forwarded verbatim to the KG sidecar after the token is verified, with the `Authorization` header stripped. Absent a provider, a `kg_*` call answers 503 with the body naming the fix.

## Entry points

Three ways to reach a tool's result, all going through the same handler and the same role assertion (`tool()`'s wrapper, `src/restate/tools.ts`) for a tool migrated to the Restate tools service — there is no separate auth mechanism per entry point.

| Entry point | Credential | Notes |
| -- | -- | -- |
| `/mcp` | OAuth bearer token | `tools/call`, described below. |
| `POST /api/tools/<name>` | Admin session (the same session every other `/api/` route requires) | For a caller with no MCP client, such as CI. Maps the session to `Caller { kind: "human", email, role }` using the session's own resolved role — never defaulted to `admin`. `<name>` must match `^[a-z][a-z0-9_]{0,63}$`; anything else answers `404 { error: "unknown tool" }` before the ingress is reached. A run capability ([AII-688](https://linear.app/eudoxus/issue/AII-688/run-identity-on-restate-for-kg-refresh-capabilities-mcp-reads-and-the)) is a later, separate entry point. |
| In-process | None | `callToolAsSystem` (`src/restate/tools-client.ts`) calls the handler directly with `systemCaller()` — for orchestrator code that wants a tool result without an HTTP hop. |

## Authentication and the per-request re-check

Every caller `/mcp` sees is resolved to one `Caller` (`src/mcp-identity.ts`): `{ kind, email, role }`. `IdentityKind` is `"human" | "system"` today — a human sign-in or in-process/system code (`systemCaller()`, always `role: "admin"`, `email: null`) — with a read-only `"run"` kind reserved for [AII-702](https://linear.app/eudoxus/issue/AII-702/accept-a-run-capability-at-mcp-as-a-read-only-run-identity). The client table covers how each kind reaches `/mcp` today:

| Kind | Reaches `/mcp` via | Email | Role |
| -- | -- | -- | -- |
| `human` | An OAuth access token (authorization code with PKCE, dynamic client registration; endpoints in [kg-sidecar.md § MCP OAuth](kg-sidecar.md#mcp-oauth)), verified by `verifyMcpToken` (`src/mcp-oauth.ts`) | The OIDC identity's email | The allowlist entry that admits the email, re-checked every request; `null` for an identity with no entry |
| `system` | Not over HTTP — `systemCaller()` is called by in-process code that needs an unattributed, unrestricted identity | `null` | Always `admin` |

Access tokens default to one hour (`MCP_ACCESS_TOKEN_TTL` seconds); refresh tokens live 30 days and rotate with reuse detection. The refresh grant runs behind the `RefreshAuthority` seam (`src/mcp-identity.ts`): `SqliteRefreshAuthority` (`src/mcp-oauth.ts`) is the only implementation and is wired as the default at module load, so a boot that never calls `setRefreshAuthority()` still refreshes tokens — the seam must never be the reason a boot locks every operator out. Its `rotate()` resolves to a `RefreshOutcome`: `ok` (fresh access + refresh tokens), `replay`, `expired`, `denied` (invalid token, `client_id` mismatch, or an identity the allowlist no longer admits), or `unavailable`.

What ends a session — an identity's ability to keep using its current or next token:

| Event | Effect |
| -- | -- |
| Access token expires (`MCP_ACCESS_TOKEN_TTL`, default one hour) | 401 on the next call; the client refreshes |
| Allowlist removes the identity | The per-request re-check denies on the very next call — not at token expiry, and not up to an hour later |
| Refresh token expires (30 days) | `RefreshOutcome.expired` → `invalid_grant` on the next refresh attempt |
| Refresh token replayed (already rotated away) | `RefreshOutcome.replay` → the entire rotation family is revoked (`revokeFamily`), and every token in the chain, including any legitimately-rotated successor, stops working |
| Allowlist re-check denies a refresh (identity no longer on the allowlist) | `RefreshOutcome.denied` → the rotation family is revoked and `invalid_grant` is returned |
| Allowlist unreadable (database fault) | `RefreshOutcome.unavailable` → 503, and the rotation chain is left untouched — a transient read failure must not look like a removal |

The matching entry's role is what the write tier consults; it is read on every call and never stored in the token.

## Run identities

## Reads are open; writes are declared

A tool is a **read** unless it is on the declared write list. Every allowlisted identity, `user` or `admin`, sees and may call every read tool, including ones added later — there is no per-tool registration for reads. `list_projects` selects its fields explicitly and omits `extraEnv`, so runner environment values never leave through a read.

A **write** exists on `/mcp` only if it is an entry in `WRITE_TOOLS` in `src/mcp.ts`, and each entry names the role it requires. The list is the whole write surface: there is no tool that calls an arbitrary admin route, and every mutation not on the list — allowlist edits, secrets, deploys, page grants — stays on the admin API and its UI.

For a write call the caller's role is the role of the allowlist entry that admitted them on this request; an identity with no entry (a service-class token) has role `null`. A caller's role satisfies an entry when it equals the entry's role or is `admin`. A caller whose role does not satisfy the entry's gets a tool result with `isError: true` and the text `forbidden: <tool> requires the <role> role`; `tools/list` also omits the tools the caller's role cannot use, but the server-side check is the boundary. Each write call, allowed or refused, is logged as one line with the actor's email, the tool, the role, and the result. (Mechanism: [AII-381](https://linear.app/eudoxus/issue/AII-381/mcp-write-tier-admin-role-tools-add-project-set-runner-mode-pause); decision record: ADR 015.)

## Tools

Reads, orchestrator-native:

| Tool | Returns |
| -- | -- |
| `get_session_identity` | The caller's email, provider, and role (`user`, `admin`, or `null` for an identity with no allowlist entry), as the allowlist resolves them now. Admin-only skills call this first. |
| `get_tenant_health` | Runner mode, in-flight jobs, pending gap-fills, project count, KG degraded flag, `kgUnavailable` + `sidecar` (the sidecar liveness probe's `reachable`/`toolsListed`/`lastError`/`checkedAt`, AII-650), and the kg-refresh credential preflight rows |
| `get_kg_status` | KG refresh rail state: stage, served stamp, materialize path, last refresh outcome and gate, plus `kgUnavailable` + `sidecar` (same shape as `get_tenant_health`, AII-650) |
| `get_runner_mode` | Global runner mode and its source |
| `list_projects` | Every project mapping with its settings, minus `extraEnv` |
| `list_in_flight_jobs` | Dispatching or running jobs with elapsed time |
| `get_issue_dispatch_status` | In-flight and dedup state plus recent dispatches for one issue |
| `get_issue_report_card` | Per-pass telemetry, totals, approval and merge state for one issue |
| `get_fleet_report` | Per-repo outcomes over a look-back window |
| `get_deploy_posture` | Autodeploy, deploy hold, running-vs-head commit, runner-channel state |

Reads, memory provider: `kg_hybrid_search`, `kg_search`, `kg_semantic_search`, `kg_neighbors`, `kg_path`, `kg_provenance`, whatever the bound provider lists.

Writes, declared:

| Tool | Role | Does |
| -- | -- | -- |
| `trigger_kg_refresh` | admin | Same as `POST /api/kg/refresh`: preflight, then dispatch the refresh rail. Answers accepted (202), already-running (409), or the named preflight refusal (422). Optional `dryRun` boolean argument (AII-632): dispatches the same runner job with `kg-snapshot-push`'s push skipped — every guard still runs, and the verdict plus per-part line-count table are reported on `get_kg_status` as `lastRefresh.dryRun` / `.detail` / `.partTable`. `current/` and `servedStamp` are never touched, and `stage` is restored to whatever it held before the trigger. A REST body and the Deployments-page button follow in AII-635. |
| `set_runner_mode` | admin | Same as `POST /api/runner-mode`'s mode update: forces (or restores) the global execution path. Accepts every value of `VALID_RUNNER_MODES` (`default`, `gha`, `fly`, `shadow`, `local`), validated by the action, not the tool; `local` is a developer-machine mode the admin UI's buttons do not offer. |
| `pause_project` | admin | Same as the `paused` update of `PATCH /api/mappings/<teamKey>`. |
| `add_project` | admin | Same as `POST /api/mappings`: create or update a project mapping, the upsert behind the admin UI's New project stepper. |
| `trigger_workflow_sync` | admin | Same as `POST /api/mappings/<teamKey>/sync-workflows`: re-sync the workflow templates for one project. |
| `clear_dispatch_dedup` | admin | Same as `DELETE /api/dedup/<issueId>`: clear a dedup entry so the issue can be re-dispatched. |

## How the skills use it

Skills bind the server by name in `CLAUDE.md` (`kg.mcp_server`) and discover tools by description at session start, so a new read tool is usable the day it ships. A skill that performs a declared write is an **admin-only skill**: it calls `get_session_identity` first and stops with a clear message when the role is not `admin`. Read-only skills never call a write tool, whatever the role.

## Failure behaviour

| Condition | Answer |
| -- | -- |
| No or invalid token, or identity no longer allowlisted | 401 |
| `OAUTH_REDIRECT_BASE_URL` unset | 503 to every caller |
| Allowlist unreadable | 503 |
| `kg_*` call with no provider | 503 naming `KG_SIDECAR_URL` |
| Write call below the required role | tool result `isError: true`, `forbidden: <tool> requires the <role> role`; logged |
| `trigger_kg_refresh` with KG refresh not configured | tool result `isError: true`, "KG refresh is not configured" |
