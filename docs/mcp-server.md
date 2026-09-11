# The MCP server

The orchestrator serves one MCP endpoint, `/mcp`, so a Claude session (and every BuildDown skill that runs in one) can ask the orchestrator questions and, for a declared few actions, act on it. This is the reference for `src/mcp.ts` and `src/mcp-oauth.ts`. The KG sidecar that answers the `kg_*` tools, the OAuth endpoints, and the image build are in [kg-sidecar.md](kg-sidecar.md); who may sign in and with which role is in [access-model.md](access-model.md).

## Shape

`/mcp` is a JSON-RPC endpoint. Two methods matter: `tools/list` and `tools/call`. A request carries a bearer token minted by the MCP OAuth flow; nothing else is accepted, and an admin-UI session or an access code never reaches `/mcp`.

Tools come from two places and are merged into one list:

* **Orchestrator-native tools**, defined in `src/mcp.ts` (`DIAG_TOOLS` for reads, `WRITE_TOOLS` for writes) and served by the orchestrator process itself. They need no sidecar, so they answer on a sidecar-less image.
* **Memory-provider tools** (`kg_*`), forwarded verbatim to the KG sidecar after the token is verified, with the `Authorization` header stripped. Absent a provider, a `kg_*` call answers 503 with the body naming the fix.

## Authentication and the per-request re-check

The token is an OAuth access token (authorization code with PKCE, dynamic client registration; endpoints in [kg-sidecar.md § MCP OAuth](kg-sidecar.md#mcp-oauth)). Access tokens default to one hour (`MCP_ACCESS_TOKEN_TTL` seconds); refresh tokens live 30 days and rotate with reuse detection. The verified token yields an identity: email, subject, provider.

Every request re-checks that identity against the allowlist in force — the same matcher the admin gate uses — so a removal ends access on the next call, not at token expiry. A removed identity gets 401; an unreadable allowlist gets 503, so a database fault never looks like a revoked token. The matching entry's role is what the write tier consults; it is read on every call and never stored in the token.

## Reads are open; writes are declared

A tool is a **read** unless it is on the declared write list. Every allowlisted identity, `user` or `admin`, sees and may call every read tool, including ones added later — there is no per-tool registration for reads. `list_projects` selects its fields explicitly and omits `extraEnv`, so runner environment values never leave through a read.

A **write** exists on `/mcp` only if it is an entry in `WRITE_TOOLS` in `src/mcp.ts`, and each entry names the role it requires. The list is the whole write surface: there is no tool that calls an arbitrary admin route, and every mutation not on the list — allowlist edits, secrets, deploys, page grants — stays on the admin API and its UI.

For a write call the caller's role is the role of the allowlist entry that admitted them on this request; an identity with no entry (a service-class token) has role `null`. A caller whose role is not the entry's gets a tool result with `isError: true` and the text `forbidden: <tool> requires the <role> role`; `tools/list` also omits the tools the caller's role cannot use, but the server-side check is the boundary. Each write call, allowed or refused, is logged as one line with the actor's email, the tool, the role, and the result. (Mechanism: [AII-381](https://linear.app/eudoxus/issue/AII-381/mcp-write-tier-admin-role-tools-add-project-set-runner-mode-pause); decision record: ADR 015.)

## Tools

Reads, orchestrator-native:

| Tool | Returns |
| -- | -- |
| `get_session_identity` | The caller's email, provider, and role (`user`, `admin`, or `null` for an identity with no allowlist entry), as the allowlist resolves them now. Admin-only skills call this first. |
| `get_tenant_health` | Runner mode, in-flight jobs, pending gap-fills, project count, KG degraded flag, and the kg-refresh credential preflight rows |
| `get_kg_status` | KG refresh rail state: stage, served stamp, materialize path, last refresh outcome and gate |
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
| `trigger_kg_refresh` | admin | Same as `POST /api/kg/refresh`: preflight, then dispatch the refresh rail. Answers accepted (202), already-running (409), or the named preflight refusal (422). |

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
