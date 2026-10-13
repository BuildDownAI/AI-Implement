# 039. Admins reach the Restate UI through the orchestrator

**Status:** Accepted
**Date:** 2026-10-12
**References:** ADR 023, ADR 034, [AII-1248](https://linear.app/eudoxus/issue/AII-1248), [AII-1255](https://linear.app/eudoxus/issue/AII-1255), [AII-1261](https://linear.app/eudoxus/issue/AII-1261), [AII-1128](https://linear.app/eudoxus/issue/AII-1128)

## Context

The Restate admin API (`127.0.0.1:9070`) and ingress (`127.0.0.1:8081`) bind to loopback (`src/restate/server.ts`). The only access was `fly proxy`. An operator who wants to open a held `KgRefresh` run, or resolve its `decide` promise from the Restate UI playground, needs a door that uses the admin session.

The spike (AII-1255, server 1.7.10) found:

* The UI's router has `basename: "/ui/"` and imports `/ui/assets/...` by absolute path, so under a path prefix it renders nothing.
* The UI calls the admin API at the root of its own origin: `GET /health`, `/version`, `/services`, `/services/<name>`, `/services/<name>/openapi`, `/deployments`, `POST /query`, and `/invocations/<id>/...` (cancel, kill, purge, pause, resume, restart).
* The playground calls the ingress at the address the server advertises (`/version` `ingress_endpoint`, OpenAPI `servers[0].url`), settable with `RESTATE_INGRESS__ADVERTISED_ADDRESS`; a path prefix works there.
* There is no WebSocket or SSE; the live view polls `POST /query`.

## Decision

**1. One door: an allowlist of root paths plus `/admin/restate/ingress/`.** The first draft said "one admin path". The spike showed that cannot work, so `src/restate/ui-proxy.ts` forwards `/ui*`, the listed `GET` reads, `POST /query`, `/invocations/*`, `POST /deployments`, and a narrow part of `/admin/restate/ingress/` (prefix removed, to the ingress). Anything else is not handled. No new listener opens.

**1a. The ingress door is deny-by-default (AII-1283).** Only `POST` to `KgRefresh/<key>/decide` and `KgRefresh/<key>/status` (and the `/restate/call/`, `/restate/send/` and `/send` forms of them) is forwarded; every other ingress path answers 403. The ingress was loopback-only before this door, and services rely on that: `Operator` holds raw refresh tokens and its handlers are not `ingressPrivate`, and `KgRefresh.report`/`progress`/`cancel` are guarded by the runner token that the callback route checks. Paths with `..`, `//`, or encoded `%2e`/`%2f`/`%5c` answer 400, and `/ui` accepts only `GET` and `HEAD`. `POST /query` still reads state and journals; that is tracked on AII-1248.

**2. Admin role only.** Every handled path runs `authenticateAdminRequest` and requires role `admin`. Page grants never apply, because the door includes powers that no page grant describes.

**3. Session credentials never reach Restate.** `cookie`, `authorization`, hop-by-hop headers, and `x-forwarded-*` are stripped from the forwarded request, and `set-cookie` and `access-control-*` from the response. The ingress journals request headers and bodies, and a session token must never reach a journal.

**4. The advertised ingress address is derived, not configured.** With `OAUTH_REDIRECT_BASE_URL` set, the sidecar advertises `<base>/admin/restate/ingress/`. Unset, it keeps the loopback default.

**5. Reserved paths.** `/ui`, `/health`, `/version`, `/services`, `/deployments`, `/query`, and `/invocations` belong to this door. A future orchestrator route there would collide.

## Consequences

* This replaces the AII-1128 rule "do not expose `/query`". A free SQL endpoint over the introspection tables is now reachable, for admins only.
* **Accepted admin powers:** *Restart as new…*, *+ Deployment* (register), and cancel, kill, purge in the UI.
* **Same-origin trust.** The UI is first-party static assets from the pinned server, served from the orchestrator origin, so its JavaScript runs with the admin cookie in scope. `HttpOnly` still protects the token itself. Do not add GET-mutating paths: `SameSite=Lax` does not block a cross-site top-level GET.
* **Ingress identity.** Calls through the ingress reach tools handlers with a caller the orchestrator did not verify (the wire shape is `{ caller, args }`), so a playground user can assert any caller. Admin-only gating makes this acceptable; handlers must not take authority from `caller` beyond the role check.
* **Producers.** The Restate UI playground is a third producer of the `decision` signal in ADR 034.
* **Logging.** Every ingress request, and non-read requests elsewhere (except the `POST /query` polls), log `[restate-ui] <email> <METHOD> <path>`.
* **Rollback:** revert; this removes the door and the advertised address.
