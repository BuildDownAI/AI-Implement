# 039. Runner settings live in per-backend Restate objects with one contract

**Status:** Accepted
**Date:** 2026-10-12
**References:** ADR 022, ADR 037, [AII-1237](https://linear.app/eudoxus/issue/AII-1237), [AII-1243](https://linear.app/eudoxus/issue/AII-1243), [AII-1244](https://linear.app/eudoxus/issue/AII-1244)

## Context

The Fly sessions app and region were an env var, else a `settings` row, read by `getFlySessionsConfig()` (AII-1237). That left two stores with a precedence rule an operator could not see, and no shape for the next backend setting. ADR 037 already put per-pipeline Fly settings in `FlyMachineProfile`.

## Decision

**1. Two levels.** `RunnerBackend/<backend>` holds a backend's deployment-wide settings; `<Backend>RunProfile/<pipeline>` (today `FlyMachineProfile/<pipeline>`, ADR 037) holds per-pipeline settings. A setting belongs to the narrowest level that varies.

**2. One contract.** Every such object has `get` (shared), `set` (exclusive, `ingressPrivate`; merges the given fields), and `seed` (exclusive; writes only when empty). Each key has one strict zod schema; an unknown key, an unknown field, or an invalid value is a `TerminalError` 400 and leaves state unchanged. `RunnerBackend` keys: `fly-machines` = `{ app: string | null, region: string | null }`; `github-actions` = `{}`, reserved.

**3. One writer.** `set` is `ingressPrivate`; the only writer is the admin-role `set_runner_backend` tool (`get_runner_backend` reads). The Settings page `POST /api/settings` goes through that tool, so the role check is the tool wrapper's, and a Restate failure answers 503 rather than writing a row the object would ignore.

**4. Secrets stay env.** No schema has a token field. Restate journals every handler input, so `FLY_SESSIONS_TOKEN` is read from env only.

**5. Seed once (ADR 022).** At boot, after the endpoint registers, `seed` sends `fly-machines` from `FLY_SESSIONS_APP` / `FLY_SESSIONS_REGION`, else the `fly_sessions_*` rows (skipped when neither exists), with idempotency key `seed:runner-backend:fly-machines`, and `github-actions` with `{}`. Afterward the env vars and rows are inert for these values; the rows are left in place, so a revert still has the pre-seed values.

**6. Outage rule: serve the last value read.** `getFlySessionsConfig()` stays synchronous and reads a process cache. `refreshRunnerBackendCache()` reads the object through the ingress client at boot and once per poll cycle (3 s timeout). On success it replaces the cache; on failure it keeps the last value and logs once per outage. Before the first successful read, and while the object is empty, the cache is not used and the old env-then-row rule applies, so a boot with Restate down still dispatches. The Settings page reports which applies: `restate` or `fallback`.

## What GitHub Actions does not let us control

The `github-actions` schema is empty because the orchestrator cannot set these through the dispatch: runner size (the repo's `AI_IMPLEMENT_RUNNER_LABEL` Actions variable picks `runs-on`), machine lifecycle (GitHub creates and destroys the runner), and anything beyond the 10 inputs a `workflow_dispatch` accepts. A future setting joins the schema only if the orchestrator can enforce it.

## Consequences

* Env precedence flips for these two values: once the object is read, an env var no longer wins. Change them at `/admin#settings`.
* AII-1244 reuses the `RunnerBackend` definition and the `get`/`set`/`seed` contract.
