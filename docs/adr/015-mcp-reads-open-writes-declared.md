# 015. MCP reads are open to every allowlisted user; writes exist only on a declared list with a role per tool, resolved on every call

**Status:** Accepted
**Date:** 2026-09-11
**References:** [AII-329](https://linear.app/eudoxus/issue/AII-329/orchestrator-diagnostics-tools-on-mcp-aii-69-tier-1) (read-only `/mcp`), [AII-340](https://linear.app/eudoxus/issue/AII-340/access-model-split-admin-vs-user-roles-admin-superset-of-user) (Admin/User roles), [AII-381](https://linear.app/eudoxus/issue/AII-381/mcp-write-tier-admin-role-tools-add-project-set-runner-mode-pause) (write tier), [AII-595](https://linear.app/eudoxus/issue/AII-595/mcp-add-get-kg-status-stage-served-stamp-last-refresh-outcome-so) (`get_kg_status`), [AII-615](https://linear.app/eudoxus/issue/AII-615/mcp-write-tier-declared-admin-only-write-tools-reads-open-to-every) (planning parent), `docs/mcp-server.md`, `docs/access-model.md`

## Context

`/mcp` was read-only by a hard constraint ([AII-329](https://linear.app/eudoxus/issue/AII-329/orchestrator-diagnostics-tools-on-mcp-aii-69-tier-1)) and one shared tier for every allowlisted identity. Roles landed in the allowlist ([AII-340](https://linear.app/eudoxus/issue/AII-340/access-model-split-admin-vs-user-roles-admin-superset-of-user)): an address entry can carry `admin`, a domain admits as `user`, and the admin API enforces the split. The MCP token carries only email, subject, and provider, so the surface stayed role-blind, and [AII-595](https://linear.app/eudoxus/issue/AII-595/mcp-add-get-kg-status-stage-served-stamp-last-refresh-outcome-so) left the KG refresh trigger on REST for that reason.

The BuildDown skills run inside MCP sessions. bd-kg-refresh needs one write, the refresh trigger, and today it needs an admin bearer token from the access code or a signed-in browser. Operators want the skills to work through MCP alone, want any read tool, present or future, to work for every user without registration, and want the write surface limited to actions they choose one by one, because some mutations must stay reachable only through the admin API.

## Decision

A tool is a read unless it appears in one declared write list in `src/mcp.ts`. Reads are open to every allowlisted identity and need no registration. Each write entry names its required role. On every write call, and on every identity call, the caller's role is the role of the allowlist entry that admitted them on that request, which the gate already resolves; an identity with no entry has role `null` and no writes. A caller's role satisfies an entry when it equals the entry's role or is `admin`. A call whose role does not satisfy the entry's is refused server-side as a tool result with `isError: true` naming the role; `tools/list` hides such tools as a courtesy, never as the boundary. Every write call is logged with actor, tool, role, and result, refusals included; [AII-616](https://linear.app/eudoxus/issue/AII-616/after-the-mcp-write-tier-one-audit-trail-for-every-mutating-route-and) later moves that line into the mutation audit table. The first entry is `trigger_kg_refresh`, admin.

## Alternatives rejected

* **Stamp the role into the token at mint.** No lookup per call, but a demoted admin keeps writes until the refresh chain ends, up to 30 days. Revocation on a write surface must be immediate, and the per-request recheck already exists.
* **Gate reads per tool as well.** Every new read tool would need registration, and the operators' requirement is the opposite: reads work by default.
* **A generic tool that calls any admin route.** Collapses the declared list into the whole admin API and makes the audit line meaningless.
* **A user-tier write for the KG refresh.** Dropped: the operators want the first admin-only skills, and one write role keeps the model simple until a second is needed.
* **A JSON-RPC error object for refusals.** Some clients surface it as a transport failure; the `isError` tool result is the shape every diagnostic error already uses and reads as text in the session.

## Consequences

Adding a read tool is a one-file change with no access work. Adding a write is an entry in the list with a role and a handler reused from the admin API, plus a row in the tools reference. Skills that write are admin-only by construction and check identity first. The REST trigger and the Deployments-page button remain for browser sessions; MCP is the path for skills. Service-class tokens ([AII-442](https://linear.app/eudoxus/issue/AII-442/vend-run-scoped-kg-tokens-to-runners-over-the-callback)) inherit `role: null` and can never write.
