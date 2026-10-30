# Orchestrator configuration

How an orchestrator decides the effective value of each setting. `.env.example` is the list of variables and what each one is for; this reference covers what boot checks, where each value can live besides the environment, which source wins, and how a value is parsed when it is not what an operator expects.

## The orchestrator's setup checks

The `orchestrator` group of setup checks (`ORCHESTRATOR_CONFIG_CHECKS`, `src/setup-checks/orchestrator-config.ts`) tests for each fault this page describes and names its fix. Each id below links to the section that explains the value it reads. A check only reads, and where the orchestrator decides something from a value with a function of its own (a parse, a precedence, which sign-in providers to keep), the check calls that function, so it reports what the orchestrator does rather than a second reading of the variable. `admin.allowlist` goes further than boot's warning: it also fails an empty list, which admits nobody. The decision to build them this way is [ADR 046](adr/046-orchestrator-setup-checks-only-read-and-what-they-show-depends-on-who-can-reach-an-admin.md).

| Id | Reports |
|---|---|
| [`env.github-app`](#boot-checks-presence-not-validity) | The App pair unset, or a key that does not parse |
| [`env.admin-access-code`](#what-boot-warns-about) | The refused `.env.example` placeholder |
| [`env.runner-mode`](#environment-overrides) | An unrecognized `RUNNER_MODE`, ignored |
| [`env.poll-interval`](#numeric-tuning-values) | A set `POLL_INTERVAL_MS` that is not a whole number of milliseconds from 1 to 2147483647 |
| [`env.breaker-threshold`](#numeric-tuning-values) | A `DISPATCH_BREAKER_THRESHOLD` that turns the breaker off |
| [`settings.seeded`](#settings-rows-seeded-from-the-environment) | A seed-once variable that differs from its row, has no row, or is refused |
| [`settings.env-override`](#environment-overrides) | `RUNNER_MODE` or `FLY_PROCESS_LEVEL_SECRETS` overriding a different saved value |
| [`settings.allowlist-env`](#the-sign-in-allowlist) | `OAUTH_ALLOWED_*` made inert by a saved list |
| [`volume.database`](#the-database-path) | The `/tmp` fallback, or on Fly a database off the volume |
| [`restate`](#boot) | The sidecar not ready, or the endpoint not registered; see [restate.md](restate.md) |
| [`callback.config`](#what-boot-warns-about) | No callback URL, set or derived, or no `RUNNER_TOKEN_SECRET` |
| [`runner.fly-sessions`](#the-summary-main-logs) | Projects whose path resolves to Fly Machines without the sessions token or app |
| [`admin.path`](#what-boot-warns-about) | No usable access code and no sign-in provider |
| [`admin.providers`](#what-boot-warns-about) | A sign-in provider that boot drops, with the reason |
| [`admin.redirect-url`](#what-boot-warns-about) | A sign-in provider without `OAUTH_REDIRECT_BASE_URL` |
| [`admin.allowlist`](#the-sign-in-allowlist) | SSO as the only admin path with no admin address in the list; with BuildDown configured it passes, naming the organization role claim |

## Boot

`main()` (`src/index.ts`) runs in this order: create the database tables, seeding the seed-once settings (below) right after the `settings` table, start the knowledge-graph sidecar and the Restate sidecar, then call `loadConfig()`. Both sidecars start before `loadConfig()` and neither failure stops boot (see [restate.md](restate.md) and [kg-sidecar.md](kg-sidecar.md)). After `loadConfig()`, `main()` logs a summary, starts the HTTP server, refreshes the runner-backend cache, runs boot reconciliation or defers it to the Restate registration hook (see "The Fly sessions app and region"), runs the first poll cycle immediately, and only then schedules the poll interval.

### What `loadConfig` requires

`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are the only values `loadConfig()` requires. Its `required` helper throws `Missing required env var: <name>` when the variable is unset or empty. The two `required` calls sit in the returned object, after every `[main]` warning below, so a boot missing the pair prints those first. The two `[deploy]` warnings are evaluated later in the same object, so they do not print. `main()` is called with a `catch` that logs `[main] Fatal startup error:` and exits with code 1. By then the tables, seeds and both sidecars have already run.

### What boot warns about

Every other gap logs a line and degrades a feature. None stops boot.

| Condition | Log line | Effect |
|---|---|---|
| A sign-in provider has some of its variables set but not all | `[main] <id> sign-in disabled: <variables> not set` | That provider is dropped |
| `BUILDDOWN_OIDC_ISSUER` set with its client pair but not `https://` | `[main] builddown sign-in disabled: BUILDDOWN_OIDC_ISSUER does not start with https://` | BuildDown is dropped |
| `MICROSOFT_OAUTH_TENANT` set with its client pair, and `common`, `organizations` or `consumers` in any case (untrimmed) | `[main] microsoft sign-in disabled: MICROSOFT_OAUTH_TENANT is a multi-tenant value. Set it to your tenant's ID.` | Microsoft is dropped |
| `ADMIN_ACCESS_CODE` is the old `.env.example` placeholder, `your-secret-access-code` | `[main] ADMIN_ACCESS_CODE is the published .env.example placeholder, so it is refused. Set a real code, or sign in with SSO.` | The code is treated as unset (`effectiveAccessCode`, `src/admin-session.ts`) |
| Neither a usable access code nor any sign-in provider | `[main] admin UI disabled — set ADMIN_ACCESS_CODE and/or configure OAuth providers` | Admin UI unavailable |
| Sign-in providers but no `OAUTH_REDIRECT_BASE_URL` | `[main] OAuth providers configured but OAUTH_REDIRECT_BASE_URL not set — …` | SSO redirect URIs cannot be built |
| The allowlist in force has entries but no admin address | `[main] no admin in the sign-in allowlist — /api/ routes will 403; …` | See [access-model.md](access-model.md) |
| No `NOTIFY_WEBHOOK_URL` | `[main] NOTIFY_WEBHOOK_URL not set — notifications disabled` | No webhook notifications |
| No `GITHUB_WEBHOOK_SECRET` | `[main] GITHUB_WEBHOOK_SECRET not set — webhook endpoint will reject all requests` | Webhook endpoint rejects every request |
| No callback URL (set, or derived for `RUNNER_MODE=local`) or no `RUNNER_TOKEN_SECRET` | `[main] runner callback path disabled (…)` | Runner callbacks disabled; see [runner-callbacks.md](runner-callbacks.md) |
| No `LINEAR_CLIENT_ID` or no `LINEAR_CLIENT_SECRET` | `[main] LINEAR_CLIENT_ID/LINEAR_CLIENT_SECRET not set — Linear mappings will be skipped …` | Linear auth is not configured |
| `KG_SOURCE_REPO` set but not a valid `owner/repo` | `[deploy] invalid KG_SOURCE_REPO; self-deploy disabled` | Treated as unset (`readKgSourceRepo`, `src/deploy.ts`) |
| `AI_IMPLEMENT_SOURCE_REPO` and `AI_IMPLEMENT_SOURCE_BRANCH` both stamped, but the repo lacks a non-empty part on each side of its first `/` | `[deploy] image stamped with a malformed AI_IMPLEMENT_SOURCE_REPO (…); self-deploy disabled` | No self-deploy target (`readStampedTarget`, `src/deploy-availability.ts`) |
| `RUNNER_IMAGE_ALLOWED_PREFIXES` fails validation and no row exists yet | `[settings] RUNNER_IMAGE_ALLOWED_PREFIXES is invalid (…), so it was not seeded` | The row is not seeded (logged by the seed, before `loadConfig()`) |

The provider rows come from `resolveProviders` (`src/oauth/providers.ts`), which decides each provider from its `PROVIDER_SPECS` entry and returns the providers it keeps and the ones it drops, with the reason; `loadConfig()` logs each drop. The `admin.providers` check reports the same drops, and `admin.path`, `admin.redirect-url` and `admin.allowlist` count only the providers kept.

`loadConfig()` also logs, without warning, `[main] admin auth: <modes>` when the admin UI is enabled, and `[main] RUNNER_CALLBACK_BASE_URL not set — defaulting to http://host.docker.internal:<PORT> (RUNNER_MODE=local)` when the callback URL is derived for local mode (`resolveRunnerCallbackBaseUrl`, `src/runner-mode.ts`). That derivation reads the `RUNNER_MODE` environment variable only, never the stored runner mode.

Jira is not checked at boot at all. `providerConfigFromEnv` (`src/providers/index.ts`) copies the Jira variables into the provider registry, and `createJiraProviderFromConfig` (`src/providers/jira.ts`) throws on a missing token, site URL, or email-or-cloud-id only when the first poll with a Jira mapping constructs the provider; `ProviderRegistry.forAllMappings` then logs `[registry] Skipping provider "jira" — construction failed: …` and the poll continues without it.

### The summary `main()` logs

After `loadConfig()`, `main()` logs these lines in this order, among others:

| Line | When |
|---|---|
| `[kg] KG_SOURCE_REPO not set — knowledge graph disabled` | `KG_SOURCE_REPO` unset or invalid |
| `[main] Starting AI-Implement dispatcher` | Always |
| `[main] Runner mode: <mode> (source: env\|db\|default)` | Always; see "Environment overrides" |
| `[main] Per-team runners: <key>→<executionMode>, …` | Runner mode `default` |
| `[main] Poll interval: <n>ms` | Always; shows `NaNms` for a non-numeric value (see "Numeric tuning values") |
| `[main] SESSION_IMAGE is deprecated; …` or `[main] SESSION_IMAGE is set but ignored …` | The legacy `SESSION_IMAGE` is set alone, or alongside `AI_IMPLEMENT_RUNNER_IMAGE` |
| `[main] Mapped teams: <keys>` | Always |
| `[main] Notification type: <type>` | Always |
| `[main] Local Docker runner image: <image>` | Runner mode `local` |
| `[main] WARNING: fly-machines mappings exist but FLY_SESSIONS_TOKEN or FLY_SESSIONS_APP is not set` | A mapping uses `fly-machines` and the token or the sessions app is missing |
| `[main] Fly sessions app: <app>` and `[main] Session image: <image>` | A mapping uses `fly-machines` and both are present |

The Fly rows read only each mapping's own execution mode, so under runner mode `fly` or `shadow` a mapping set to GitHub Actions is sent to Fly without this warning (under `fly` with no sessions app it is skipped at dispatch instead, by `checkForcedPathEligibility`). The `runner.fly-sessions` check resolves each mapping's path the way dispatch does (`resolveExecutionPath`, `src/runner-mode.ts`) and reports that case too.

The sessions app in the last two rows is resolved as described in "The Fly sessions app and region". `main()` has not yet refreshed the runner-backend cache at this point, so the value is the environment-then-row fallback unless the Restate registration hook has already refreshed the cache.

### Boot checks presence, not validity

Nothing at boot tests whether a credential works. `required` and every warning above test only that a value is non-empty or has the right shape. `configureLinearAuth` (`src/linear-app-auth.ts`) stores the client pair; the first token mint happens on first use and fails as `Linear token mint failed (<status>): …`. `configureOAuthProviders` stores the provider list without contacting an issuer. The GitHub App key is not parsed in `loadConfig()`; the `env.github-app` check parses it with the mint's own `parseAppPrivateKey` (`src/github-app-auth.ts`).

A wrong credential therefore boots cleanly and surfaces as an error from the first work that uses it. Three such uses run at or shortly after boot, and each logs and continues:

| Work | Credential | Failure log |
|---|---|---|
| `applyVolumeSnapshotRetentionAtBoot` (`src/fly-volumes.ts`), fire-and-forget | `FLY_DEPLOY_TOKEN` | `[fly-volumes] snapshot retention not applied: …` |
| `startupReconciliation` (`src/index.ts`), only when a sessions token and app are set; while the sessions app is still the fallback it is deferred to the Restate registration hook (see "The Fly sessions app and region") | `FLY_SESSIONS_TOKEN` | `[startup] Failed to list machines for reconciliation: …` |
| The first poll cycle, which `main()` awaits before scheduling the interval | The GitHub App pair, tracker credentials | Per-step errors inside the cycle, for example `[poll] Fatal error during poll cycle: …`, which drops that cycle's snapshot and dispatch work but not the process |

## Where a setting lives

A setting's effective value comes from one of four places:

- **The environment alone.** Most variables. An operator cannot change `process.env` in a running process (the orchestrator writes only a few keys of its own, such as `KG_SIDECAR_URL`), so whether the code reads a variable once at boot or on every call, an environment change takes effect only after a restart.
- **A `settings` table row seeded from the environment.** The variable writes the row when no row exists; from then on the row is the authority and the variable is ignored. The pattern and its reasoning are [ADR 022](adr/022-pickup-label-is-a-settings-row-seeded-once-from-the-environment.md).
- **A `settings` table row that the environment overrides.** The variable, when set to a recognized value, wins over the row on every read.
- **A Restate object.** The Fly sessions app and region live in the `RunnerBackend/fly-machines` object, seeded from the environment or the old rows ([ADR 039](adr/039-runner-settings-live-in-per-backend-restate-objects-with-one-contract.md)).

The sign-in allowlist is a fifth shape, closest to the second: the environment applies while its table is empty and is read live rather than copied (see "The sign-in allowlist").

| Key | Lives in | Precedence | Change after first boot |
|---|---|---|---|
| `LINEAR_PICKUP_LABEL` | `settings` row `linear_pickup_label` | Row (trimmed, non-empty) > `AI-Implement` | `/admin#settings` |
| `RUNNER_IMAGE_ALLOWED_PREFIXES` | `settings` row `runner_image_allowed_prefixes` | Row > no extra prefixes | `/admin#settings` |
| `KG_BASE_REPO` | `settings` row `kg_base_repo` | Row > unset | `/admin#settings` |
| `KG_MATERIALIZE_DIRECT` | `settings` row `kg_materialize_direct` | Row > off (rdflib) | Materialize control on `/admin#kg-pipelines` |
| `KG_EXECUTION_MODE` | `settings` row `kg_execution_mode` | Row > Fly when configured, else GitHub Actions | Backend control on `/admin#kg-pipelines` |
| `OAUTH_ALLOWED_DOMAINS`, `OAUTH_ALLOWED_EMAILS` | `access_entries` table | Stored list when it has entries > environment | `/admin#access`; see [access-model.md](access-model.md) |
| `RUNNER_MODE` | `settings` row `runner_mode` | Recognized env value > row > `default` | Unset the variable and restart, then `/admin#runners` |
| `FLY_PROCESS_LEVEL_SECRETS` | `settings` row `fly_process_level_secrets` | Recognized env value > row > on | Unset the variable and restart, then `/admin#runners` |
| `FLY_SESSIONS_APP`, `FLY_SESSIONS_REGION` | Restate `RunnerBackend/fly-machines`; legacy rows `fly_sessions_app`, `fly_sessions_region` | Object state once read > env > row > none | `/admin#settings`, or the `set_runner_backend` tool |
| `FLY_SESSIONS_TOKEN` | Environment only | — | Set the variable and restart |
| `AI_IMPLEMENT_SOURCE_REPO`, `AI_IMPLEMENT_SOURCE_BRANCH` | Image build stamp | `settings` rows `deploy_watched_repo` + `deploy_watched_ref`, when both are set and the repo is well-formed > stamp | `/admin#deployments`; see "Values the image build stamps" |

Some `settings` rows have no environment counterpart at all, such as the retry policy (`retry_policy`), the KG refresh report issue (`kg_refresh_report_issue`) and the deploy policy flags (`deploy_auto`, `deploy_notify_available`). They are changed only from the admin UI.

### Settings rows seeded from the environment

`main()` calls `seedSettingsFromEnv` (`src/seed-once-settings.ts`) immediately after `initSettingsTable()`, before `loadConfig()`. It walks `SEED_ONCE_SETTINGS`, one entry per variable, each naming its row, the admin page that changes it, and what the seed writes for a given value:

| Variable | Writes | Seeds when | What the variable must be |
|---|---|---|---|
| `KG_BASE_REPO` | `kg_base_repo` | Variable non-blank and no row | Any non-blank string; stored trimmed |
| `KG_MATERIALIZE_DIRECT` | `kg_materialize_direct` | Variable non-blank and no row | Exactly `true` seeds on; any other non-blank value seeds off |
| `KG_EXECUTION_MODE` | `kg_execution_mode` | Variable is `github-actions` or `fly-machines` (after trimming) and no row | Any other value seeds nothing |
| `LINEAR_PICKUP_LABEL` | `linear_pickup_label` | Variable non-blank and no row | Any non-blank string; stored trimmed |
| `RUNNER_IMAGE_ALLOWED_PREFIXES` | `runner_image_allowed_prefixes` | Variable non-blank, no row, and `validateRunnerImagePrefixes` accepts it | Comma-separated prefixes, each ending in `/` with a path after the host, no empty path segments, only letters, digits and `. _ : / @ -`, at most 1000 characters; invalid input seeds nothing, and warns only while no row exists |

A sixth seed, `seedRunnerBackends`, writes the Restate object rather than a row and is covered under "The Fly sessions app and region".

**"Seeds once" means "seeds whenever no row exists", not "only on the first boot".** The seed checks for a row on every boot. For the three keys whose admin save can delete the row, that matters: saving `linear_pickup_label` blank, or the Settings page's Reset to default (which sends `null`), or saving `runner_image_allowed_prefixes` or `kg_base_repo` as blank, deletes the row through `setOrchestratorSetting(key, null)`. If the variable is still set, the next boot seeds it again. To return one of these to its default for good, remove the variable as well. The two KG seeds have no such path: their admin routes always write a value, so once a row exists it stays.

The seed does not apply every check an admin route applies. `POST /api/settings` refuses a pickup label longer than 100 characters or containing control characters; the seed only trims. The prefix seed and the prefix route share `validateRunnerImagePrefixes`.

The `settings.seeded` check reads the same list and the same `seedValue` functions, so it compares each set variable with its row as the seed would store it: a variable that differs from its row, one whose row is missing (the next boot seeds it again), and one the seed refuses are each reported.

The readers take the row on each call, so an admin change applies without a restart. The Linear provider re-reads the pickup label at the start of `fetchAIImplementSnapshot` and `fetchFeatureNodeRollUps` (`src/providers/linear.ts`).

`KG_EXECUTION_MODE` is one input among several. `resolveKgBackend` (`src/runner-mode.ts`) applies the global runner mode first, then this setting, then falls back to GitHub Actions when Fly is not configured.

### The sign-in allowlist

`OAUTH_ALLOWED_DOMAINS` and `OAUTH_ALLOWED_EMAILS` are not copied into a table. `refreshEffectiveAllowlist` (`src/access-entries.ts`) reads the `access_entries` table, and when it has no rows builds the list from the environment (`allowlistFromEnv`) on that read. The first save at `/admin#access` writes rows, and from then on the environment is not consulted while the table has entries. The handover, the role rules, and the guards on a save are in [access-model.md](access-model.md). The `settings.allowlist-env` check reports the variables once a saved list makes them inert.

### Environment overrides

Two settings keep a row the admin UI writes, and let an environment variable override it on every read.

| | `RUNNER_MODE` (`getRunnerMode`) | `FLY_PROCESS_LEVEL_SECRETS` (`getFlyProcessLevelSecrets`) |
|---|---|---|
| Recognized values | `default`, `gha`, `fly`, `local`, `shadow`, matched exactly (case-sensitive, untrimmed) | `true`, `1`, `yes` and `false`, `0`, `no`, case-insensitive, untrimmed |
| Unset, blank or unrecognized | Falls through to the row, silently | Falls through to the row, silently |
| Row | `runner_mode`, used when it holds a recognized value | `fly_process_level_secrets`; `true` is on, anything else is off |
| No usable row, or the database is unreadable | `default` | On (only when no row exists, since any row is used) |
| Reported `source` | `env`, `db` or `default` | `env`, `db` or `default` |

Both live in `src/runner-mode.ts`, where the precedence is decided by the pure `resolveRunnerMode` and `resolveFlyProcessLevelSecrets`, which the getters and the `settings.env-override` check share. An explicit false value for `FLY_PROCESS_LEVEL_SECRETS` is an override, not a fall-through. The comment on `resolveRunnerMode` names the variable a break-glass override for when the database is unavailable. The `env.runner-mode` check reports an unrecognized `RUNNER_MODE`, which is otherwise ignored silently.

**What a save answers while the variable is set.** `POST /api/runner-mode` (`setRunnerModeAction`, `src/admin.ts`) writes the row first, then re-reads the effective value. When a written field's source is still `env`, it answers **409** with `RUNNER_MODE env var is set; persisted to DB but has no effect at runtime until the env var is unset` (or the `FLY_PROCESS_LEVEL_SECRETS` equivalent), the mode it persisted, and the effective status. The row is kept, so unsetting the variable and restarting brings the saved value into force. The `set_runner_mode` tool calls the same action and returns its status and body as the reply text. The Runners page disables the mode buttons and the secrets toggle and shows a warning while the source is `env`, so the 409 is what a direct API or tool caller sees.

`.env.example` leaves `RUNNER_MODE` commented out, so a `.env` copied from it uses the mode saved on `/admin#runners`.

### The Fly sessions app and region

`getFlySessionsConfig` (`src/orchestrator-settings.ts`) answers the token, app and region synchronously from a process cache:

1. `FLY_SESSIONS_TOKEN` always comes from the environment. It is never stored in a row or in Restate, because Restate journals every handler input.
2. Once a read of `RunnerBackend/fly-machines` has returned state, the app and region come from that state, including a `null` field. The environment variables and the rows are then ignored for these two values.
3. Before any such read, or while the object holds nothing, each value comes from its environment variable, else its `settings` row, else nothing. This keeps a boot with Restate down able to dispatch.

`refreshRunnerBackendCache` fills the cache. It runs in `main()` before boot reconciliation, in the Restate registration hook, at the start of every poll cycle, and after a successful `set_runner_backend` call through `/mcp` or the Settings page. Each read has a 3-second timeout. A failed read keeps the last value and logs `[runner-backend] Restate unreachable; serving last value (…)` once per outage.

The Restate registration hook runs after the boot registration attempt, whatever its outcome except a declined conflict (which defers it to the retry that resolves the conflict), so it also runs after a failed attempt. `seedRunnerBackends` runs in it. It sends `seed` to `RunnerBackend/fly-machines` with `FLY_SESSIONS_APP` else the `fly_sessions_app` row, and `FLY_SESSIONS_REGION` else `fly_sessions_region`; it skips that send when both are empty, and then seeds `github-actions` with `{}` (not reached when the `fly-machines` send fails). The object's `seed` handler (`src/restate/runner-backend.ts`) writes only when the object is empty, so after the first successful seed the variables and rows are inert. A deployment that boots with nothing configured leaves the object empty, so a variable added later is seeded at a later boot. A failed send logs `[runner-backend] could not seed RunnerBackend; the env vars and settings rows keep serving: …`.

To change the values after the object is seeded, save them on `/admin#settings` or call the admin-role `set_runner_backend` tool. The Settings page's `POST /api/settings` goes through that tool and writes no row; it answers 503 `restate-unavailable` when Restate cannot take the write. Clearing a field there stores `null` in the object, which leaves Fly without that value: it does not fall back to the environment.

`GET /api/settings` reports `runnerBackendSource` (`restate` or `fallback`), and for each value its runtime, row and environment values, with `overriddenByEnv` true only on the fallback path when the variable is set. Boot reconciliation of session machines runs in `main()` only when the cache already holds the `restate` source (`createBootReconciliation`, `src/index.ts`). Otherwise `main()` logs `[main] Runner backend cache is on the fallback; startup reconciliation deferred to Restate registration`, and the hook runs it once, after its own cache refresh: against the object's app when that refresh loaded it, else against the fallback. If the hook never runs, neither does reconciliation.

## Numeric tuning values

The numeric variables are parsed by four different expressions, and a blank or non-numeric value means something different under each. The timer limits below are Node 24's, the pinned major; re-check them when the pin moves.

| Variable | Read by | Expression | Unset | Set but blank | Non-numeric | Other surprises |
|---|---|---|---|---|---|---|
| `POLL_INTERVAL_MS` | `parsePollIntervalMs` (`src/poll-cycle.ts`), from `loadConfig()` | `parseInt(v \|\| "60000", 10)` | 60000 | 60000 | `NaN` | Trailing text is dropped, so `60s` is 60 ms and `1e5` is 1 ms |
| `POLL_INTERVAL_MS` (allowlist cache lifetime) | `src/access-entries.ts` | `parseInt(v \|\| "", 10)`, kept only if finite and above 0 | 60000 | 60000 | 60000 | `60s` is 60 ms here too |
| `POLL_CYCLE_TIMEOUT_MS` | `loadConfig()` | `Number(v) \|\| 600000` | 600000 | 600000 | 600000 | `0` is 600000; a negative value passes through |
| `FETCH_TIMEOUT_MS` | `defaultFetchSignal` (`src/github.ts`), per call | `Number(v) \|\| 60000` | 60000 | 60000 | 60000 | A negative, fractional or above-4294967295 value makes `AbortSignal.timeout` throw `ERR_OUT_OF_RANGE` on every call; a value above 2147483647 is clamped to 1 ms, so every request aborts at once |
| `DISPATCH_BREAKER_THRESHOLD` | `parseBreakerThreshold` (`src/dispatch-breaker.ts`), from `threshold()` per recorded failure | `Number(v ?? 3)` | 3 | **0: breaker off** | **`NaN`: breaker off** | A fraction rounds up in effect (`3.5` parks on the fourth failure) |

**`POLL_INTERVAL_MS` has no guard after parsing.** `main()` passes the value straight to `setInterval`. Node 24, the pinned major (`engines`, `.tool-versions`), runs an interval of `NaN`, 0, a negative number or anything above 2147483647 every 1 ms (with a `TimeoutNaNWarning`, `TimeoutNegativeWarning` or `TimeoutOverflowWarning`). `poll()` is then called every millisecond: `beginCycle` (`src/poll-cycle.ts`) refuses while a cycle is running, and each refusal logs `[poll] Skipping poll cycle — previous poll still running`, so cycles run back to back with a skip line on every tick in between. The boot summary shows the value as parsed (`[main] Poll interval: NaNms`). The allowlist reads the same variable with a strict parse, so a non-numeric value gives the allowlist its 60-second default while the poll loop runs at 1 ms; a value with trailing text, such as `60s`, gives both 60 ms. The two parses were written separately; the strict one's comment says why it guards against `NaN`. The `env.poll-interval` check calls `parsePollIntervalMs` itself and fails any set value that is not digits only, parses to 0, or is above `MAX_POLL_INTERVAL_MS` (2147483647, the timer limit).

**`DISPATCH_BREAKER_THRESHOLD` defaults only when the variable is absent.** `??` substitutes 3 for `undefined` alone. An empty assignment, such as `DISPATCH_BREAKER_THRESHOLD=` in an env file loaded with `--env-file-if-exists` (which sets the variable to an empty string), gives `Number("")`, which is 0. `recordDispatchFailure` parks only when the threshold is above 0, so 0, a negative number and `NaN` all turn the breaker off. Failures are still counted in `dispatch_breaker.consecutive_failures`, but the count never parks an issue (the PR-budget park, `parkIssue`, does not read the threshold and is unaffected). `.env.example` ships `3`, so a `.env` copied from it keeps the default. The `env.breaker-threshold` check calls `parseBreakerThreshold` itself and fails any value it reads as 0 or less, or `NaN`.

## The database path

`resolveDbPath` (`src/dedup.ts`) runs once, when `src/dedup.ts` is first imported, before `main()`. It takes `DEDUP_DB_PATH`, or `/data/dedup.sqlite` when that is unset or blank, and creates its directory with `mkdirSync(…, { recursive: true })`.

When creating the directory fails with `EACCES`, `ENOENT`, `EPERM` or `EROFS`, it logs `[db] Cannot create <dir> (<code>), falling back to /tmp/ai-implement.sqlite` and uses `/tmp/ai-implement.sqlite`. Any other error (for example `ENOTDIR`, when a path component is a file) is rethrown during the import and the process does not start. `getDatabasePath()` reports the path in use, the configured one, and whether the fallback was taken.

The fallback covers only the directory step. An error opening the database file itself is not caught there: it surfaces from the first `getDb()` call, which is `initMappingsTable()` at the top of `main()`, and the process exits through `[main] Fatal startup error:`.

Two consequences of the fallback:

- A local run with no `DEDUP_DB_PATH` (no `.env`, or the variable blank) tries `/data`, and on a machine where `/data` cannot be created, writes to `/tmp/ai-implement.sqlite`. `.env.example` sets `DEDUP_DB_PATH=./dedup.sqlite` to avoid this.
- On Fly, `fly.toml` mounts the volume at `/data`, so a fallback database is not on the volume. The warning line is the only boot signal; the `volume.database` check fails on the fallback, and on Fly also when the database directory is on the same filesystem as `/`, meaning no volume is mounted there.

The Restate sidecar's data directory follows the configured path, not the fallback: `restateDataDir` (`src/restate/server.ts`) reads `RESTATE_DATA_DIR`, else the directory of `DEDUP_DB_PATH` (or `/data/dedup.sqlite`) plus `restate`. See [restate.md](restate.md) § "Data directory".

## Values the image build stamps

The `Dockerfile` final stage turns three build arguments into environment variables: `SOURCE_COMMIT`, `SOURCE_REPO` and `SOURCE_BRANCH` become `AI_IMPLEMENT_SOURCE_COMMIT`, `AI_IMPLEMENT_SOURCE_REPO` and `AI_IMPLEMENT_SOURCE_BRANCH`, each defaulting to `unknown`. An operator does not set them; `.env.example` explains why.

`readStampedTarget` (`src/deploy-availability.ts`) reads them once, in `loadConfig()`, treating `unknown` as absent:

| Stamps present | Result |
|---|---|
| Repo and branch, repo shaped `owner/repo` | A self-deploy target; a missing commit stamp leaves the running commit unknown rather than disabling the target |
| Repo or branch missing | No target |
| Repo without a non-empty part on each side of its first `/` | No target, with the warning in the boot table |

`resolveDeployTarget` lets the `deploy_watched_repo` and `deploy_watched_ref` rows, set on `/admin#deployments`, replace the stamped repo and branch when both are set and the repo is well-formed; the running commit always comes from the stamp. What the target drives (availability, automatic deploy, the watch layers) is in [deployment.md](deployment.md).

`KG_SOURCE_REPO` is also a build argument copied into the image environment by the final stage, because the build clones the knowledge-graph source; see [kg-sidecar.md](kg-sidecar.md).
