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

**5. Seed once (ADR 022).** At boot, after the endpoint registers, `seed` is called and awaited for `fly-machines` from `FLY_SESSIONS_APP` / `FLY_SESSIONS_REGION`, else the `fly_sessions_*` rows (skipped when neither exists), with idempotency key `seed:runner-backend:fly-machines`, and `github-actions` with `{}`. Afterward the env vars and rows are inert for these values; the rows are left in place, so a revert still has the pre-seed values.

**2026-11-07 amendment (AII-1727):** Await seed handler completion before refreshing the cache. A send only waits for ingress acceptance, so the following refresh could read the object before the seed writes its value. This ordering is required before S1-11 removes the env-then-row fallback. The handler, state, and idempotency keys are unchanged. Each call has a 3-second caller timeout: success waits for handler completion, while timeout logs and returns through the existing failure path so cache refresh and deferred reconciliation can continue. The timeout does not cancel the underlying durable seed invocation; a Fly failure still skips the GitHub seed until a later boot.

**6. Outage rule: serve the last value read.** `getFlySessionsConfig()` stays synchronous and reads a process cache. `refreshRunnerBackendCache()` reads the object through the ingress client at boot and once per poll cycle (3 s timeout). On success it replaces the cache; on failure it keeps the last value and logs once per outage. Before the first successful read, and while the object is empty, the cache is not used and the old env-then-row rule applies, so a boot with Restate down still dispatches. The Settings page reports which applies: `restate` or `fallback`.

## Amendment — 2026-11-08 (AII-1742): cache-only app and region

Re-checking §6 under standing rule 3: its pre-read env-then-row rule existed so a boot with Restate down could still dispatch. AII-1741 now holds dispatch until the registration hook has seeded and refreshed, so that reason no longer holds. The pre-read rule is removed: app and region always come from the cache, initially null, and a successful empty-object read loads null values. Environment variables and legacy rows remain boot seed inputs only; a later variable applies through the seed only at a boot where the object is empty. The token remains env-only.

The serve-last-value outage rule stays: a thrown read preserves the cache and logs once per outage, re-armed by any successful read, including null. Before any successful read the warning says `nothing loaded yet`. The source label remains `fallback` until a successful read and `restate` afterward, including an empty read. If a boot seed fails and the object remains empty after refresh, Fly dispatch skips until a boot seeds it; the seed failure log names this outcome.

## What GitHub Actions does not let us control

The `github-actions` schema is empty because the orchestrator cannot set these through the dispatch: runner size (the repo's `AI_IMPLEMENT_RUNNER_LABEL` Actions variable picks `runs-on`), machine lifecycle (GitHub creates and destroys the runner), and anything beyond the 10 inputs a `workflow_dispatch` accepts. A future setting joins the schema only if the orchestrator can enforce it.

## Consequences

* Env precedence flips for these two values: once the object is read, an env var no longer wins. Change them at `/admin#settings`.
* AII-1244 reuses the `RunnerBackend` definition and the `get`/`set`/`seed` contract.
