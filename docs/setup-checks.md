# Setup checks

The setup checks read an orchestrator's setup and report each fault before an issue is spent on it, each with the fix that clears it. A check only reads: [ADR 047](adr/047-orchestrator-setup-checks-only-read-and-what-they-show-depends-on-who-can-reach-an-admin.md) records why, and what each audience may see. This page covers the command that runs them without the server, how to read what it prints, and every check, by group.

## Running the command

The command runs the checks with no HTTP server, no Restate and no sign-in, so it works on a new orchestrator before any of those do.

| Where | Command |
|---|---|
| Locally | `npm run check-setup`, which loads `.env` the way `npm run dev` does |
| On Fly | `fly ssh console -a <app> -C "node /app/dist/check-setup.js"`, inside the running machine, with the app's secrets in its environment |

`--json` prints the run instead of the table: a `SetupCheckRun`, holding `checkedAt` and one result per check with its `id`, `title`, `group`, `tier`, `state`, `detail` and `fix`. `--help` prints the usage.

The authority is shell access on the host, as for [access recovery](access-model.md#recovery-from-lockout). Shell access already implies reading every secret, so the command prints each check's detail and fix. No check prints a secret's value; a check names the variable instead.

### What it reads

- **The environment** of the shell it runs in.
- **The database** at `DEDUP_DB_PATH` (default `/data/dedup.sqlite`), resolved the way the server resolves it and opened read-only: the command never creates the file, never runs a migration and never writes. With the orchestrator running, it reads the same file beside it. When no database exists at that path, each check that reads it reports *cannot verify*, naming the path, which is expected before an orchestrator's first boot.
- **Restate's status**, from the running orchestrator's own health route: `GET /` on `127.0.0.1` at `PORT` (default 8080), with a five-second limit. The orchestrator starts Restate as its own child process, so with the orchestrator stopped the command cannot tell whether Restate would run, and `restate` reports *cannot verify* rather than failing.
- **The Fly sessions app and region**, from Restate's `RunnerBackend` object when the orchestrator answers with its endpoint registered, as the server reads them; otherwise from the environment, then the saved settings rows.

## Reading the output

For example, a raw copy of `.env.example` with no orchestrator running prints, among its other rows:

```
orchestrator
  FAIL           env.github-app: GitHub App credentials
                 GITHUB_APP_PRIVATE_KEY does not parse as a private key
                 Fix: Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY. The private key is the PEM file from the GitHub App's settings page.
  CANNOT VERIFY  restate: Restate engine
                 The orchestrator is not answering on port 8080, so its Restate status cannot be read.
                 Fix: The check itself could not run, its detail names the error.

3 core checks fail.
```

Results print grouped by check group, one row per check, or per project for a per-project check: its state, id and title, then what it read, then its fix when it has one. The states are `PASS`, `WARN`, `FAIL`, `CANNOT VERIFY` (the fact could not be read, with the reason in the detail) and `N/A` (the check does not apply to this setup).

Each check has a tier: `core` applies to every deployment, `mode` to one execution mode, and `feature` to an optional feature. The last line counts the failing core checks.

| Exit code | Means |
|---|---|
| 0 | No core check fails |
| 1 | At least one core check fails |
| 2 | An unknown argument; nothing ran |

A warning, a check that cannot verify, and a failing `mode` or `feature` check are reported without changing the exit code, so a script stops on a broken setup alone.

## The checks, by group

This is the one list of every check. Each group has its own heading, and each id links to the section of that group's reference that explains the value it reads. An id never changes, so search for the one the command printed.

### orchestrator

The orchestrator's own environment and settings (`ORCHESTRATOR_CONFIG_CHECKS`, `src/setup-checks/orchestrator-config.ts`), explained in [orchestrator-configuration.md](orchestrator-configuration.md).

| Id | Reports |
|---|---|
| [`env.github-app`](orchestrator-configuration.md#boot-checks-presence-not-validity) | The App pair unset, or a key that does not parse |
| [`env.admin-access-code`](orchestrator-configuration.md#what-boot-warns-about) | The refused `.env.example` placeholder |
| [`env.runner-mode`](orchestrator-configuration.md#environment-overrides) | An unrecognized `RUNNER_MODE`, ignored |
| [`env.poll-interval`](orchestrator-configuration.md#numeric-tuning-values) | A set `POLL_INTERVAL_MS` that is not a whole number of milliseconds from 1 to 2147483647 |
| [`env.breaker-threshold`](orchestrator-configuration.md#numeric-tuning-values) | A `DISPATCH_BREAKER_THRESHOLD` that turns the breaker off |
| [`settings.seeded`](orchestrator-configuration.md#settings-rows-seeded-from-the-environment) | A seed-once variable that differs from its row, has no row, or is refused |
| [`settings.env-override`](orchestrator-configuration.md#environment-overrides) | `RUNNER_MODE` or `FLY_PROCESS_LEVEL_SECRETS` overriding a different saved value |
| [`settings.allowlist-env`](orchestrator-configuration.md#the-sign-in-allowlist) | `OAUTH_ALLOWED_*` made inert by a saved list |
| [`volume.database`](orchestrator-configuration.md#the-database-path) | The `/tmp` fallback, or on Fly a database off the volume |
| [`restate`](orchestrator-configuration.md#boot) | The sidecar not ready, or the endpoint not registered; see [restate.md](restate.md) |
| [`callback.config`](orchestrator-configuration.md#what-boot-warns-about) | No callback URL, set or derived, or no `RUNNER_TOKEN_SECRET` |
| [`runner.fly-sessions`](orchestrator-configuration.md#the-summary-main-logs) | Projects whose path resolves to Fly Machines without the sessions token or app |
| [`admin.path`](orchestrator-configuration.md#what-boot-warns-about) | No usable access code and no sign-in provider |
| [`admin.providers`](orchestrator-configuration.md#what-boot-warns-about) | A sign-in provider that boot drops, with the reason |
| [`admin.redirect-url`](orchestrator-configuration.md#what-boot-warns-about) | A sign-in provider without `OAUTH_REDIRECT_BASE_URL` |
| [`admin.allowlist`](orchestrator-configuration.md#the-sign-in-allowlist) | SSO as the only admin path with no admin address in the list; with BuildDown configured it passes, naming the organization role claim |
