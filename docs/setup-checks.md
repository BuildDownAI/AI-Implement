# Setup checks

The setup checks read an orchestrator's setup and report each fault before an issue is spent on it, each with the fix that clears it. A check only reads: [ADR 047](adr/047-orchestrator-setup-checks-only-read-and-what-they-show-depends-on-who-can-reach-an-admin.md) records why, and what each audience may see. This page covers the command that runs them without the server, how to read what it prints, where a running orchestrator shows them, and every check, by group.

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

## In a running orchestrator

Inside the server, the checks run in the `SetupChecks` Restate object (`src/restate/setup-checks.ts`), which keeps the last run. Nothing starts a run on its own yet: an admin starts one, and each surface below shows the stored run, or nothing before the first.

| Where | Who | Shows |
|---|---|---|
| `POST /api/setup-checks/run` | admins | starts a run, waits up to 60 seconds for it, and answers it with every field |
| `GET /api/setup-checks` | admins, and a user granted a page that lists the route (none does yet) | the stored run with every field, or `null` before the first run |
| `get_tenant_health`, field `setupChecks` | every allowlisted identity | each row's `id`, `title`, `state` and `project`, the count of failing core rows (`failingCore`) and `checkedAt`; `null` before the first run |

Why each audience sees what it sees is [ADR 047](adr/047-orchestrator-setup-checks-only-read-and-what-they-show-depends-on-who-can-reach-an-admin.md)'s second decision. Both routes answer 503 `restate-unavailable` while Restate cannot take the call (the sidecar not ready, or the endpoint not registered) or does not answer. For the same reason a stored run's `restate` row always passes: a run reaches the object only while Restate can serve. A Restate fault shows on `GET /` and in the setup command instead. `failingCore` counts rows, as the command's last line does, so a check that fails for two projects counts twice. A run's detail and fix are kept in the object's state and journal, which only admins can read, through the Restate UI. Neither carries a secret's value.

## The checks, by group

This is the one list of every check. Each group has its own heading, and each id links to the section of that group's reference that explains the value it reads. An id never changes, so search for the one the command printed.

### orchestrator

The orchestrator's own environment and settings (`ORCHESTRATOR_CONFIG_CHECKS`, `src/setup-checks/orchestrator-config.ts`), explained in [orchestrator-configuration.md](orchestrator-configuration.md).

| Id | Reports |
|---|---|
| [`env.github-app`](orchestrator-configuration.md#boot-checks-presence-not-validity) | The App pair unset, or a key that does not parse |
| [`env.admin-access-code`](orchestrator-configuration.md#what-boot-warns-about) | The refused `.env.example` placeholder |
| [`env.runner-mode`](orchestrator-configuration.md#environment-overrides) | An unrecognized `RUNNER_MODE`, ignored |
| `kg.remote-store` | Missing or empty `KG_STARDOG_RUN_TOKEN`, `KG_STARDOG_DB` or `KG_NAMESPACE` when `KG_BACKEND=stardog_run`. This feature check reads only the environment; it makes no Stardog request. A wrong token shows as `sidecar.lastError` on `GET /` after boot, not in this check. |
| [`env.poll-interval`](orchestrator-configuration.md#numeric-tuning-values) | A set `POLL_INTERVAL_MS` that is not a whole number of milliseconds from 1 to 2147483647 |
| [`env.breaker-threshold`](orchestrator-configuration.md#numeric-tuning-values) | A `DISPATCH_BREAKER_THRESHOLD` that turns the breaker off |
| `model.credentials-adopted` | Warns to run `node dist/model-account-cli.js adopt-env` when an environment credential exists without configured defaults; otherwise warns to run `node dist/model-account-cli.js adopt-projects`, listing mapped projects with absent or legacy rows (use `set_project_agent_mode` for projects with stored legacy rows). Fails with no model access configured when mappings exist without defaults or environment credentials. Passes with no credentials/defaults/mappings, or configured defaults and projects; notes an unused environment credential when present. Reads only; does not validate credentials. |
| [`settings.seeded`](orchestrator-configuration.md#settings-rows-seeded-from-the-environment) | A seed-once variable that differs from its row, has no row, or is refused |
| [`settings.env-override`](orchestrator-configuration.md#environment-overrides) | `RUNNER_MODE` or `FLY_PROCESS_LEVEL_SECRETS` overriding a different saved value |
| [`settings.allowlist-env`](orchestrator-configuration.md#the-sign-in-allowlist) | `OAUTH_ALLOWED_*` made inert by a saved list |
| [`volume.database`](orchestrator-configuration.md#the-database-path) | The `/tmp` fallback, or on Fly a database off the volume |
| [`restate`](orchestrator-configuration.md#boot) | The sidecar not ready, or the endpoint not registered; see [restate.md](restate.md). The orchestrator does not dispatch until Restate serves. |
| [`callback.config`](orchestrator-configuration.md#what-boot-warns-about) | No callback URL, set or derived, or no `RUNNER_TOKEN_SECRET` |
| [`runner.fly-sessions`](orchestrator-configuration.md#the-summary-main-logs) | Projects whose path resolves to Fly Machines while the backend source is `not-loaded` (Restate has not answered yet), or with source `restate` without the sessions token or app. Wait for Restate to serve; read the [restate] lines in the orchestrator log. |
| [`admin.path`](orchestrator-configuration.md#what-boot-warns-about) | No usable access code and no sign-in provider |
| [`admin.providers`](orchestrator-configuration.md#what-boot-warns-about) | A sign-in provider that boot drops, with the reason |
| [`admin.redirect-url`](orchestrator-configuration.md#what-boot-warns-about) | A sign-in provider without `OAUTH_REDIRECT_BASE_URL` |
| [`admin.allowlist`](orchestrator-configuration.md#the-sign-in-allowlist) | SSO as the only admin path with no admin address in the list; with BuildDown configured it passes, naming the organization role claim |

### tracker

The tracker each project uses (`TRACKER_CONFIG_CHECKS`, `src/setup-checks/tracker-config.ts`), explained in [ticketing-providers.md](ticketing-providers.md). Each provider reads its own facts once per run (`fetchSetupFacts`), and the checks judge them; a run that cannot read them reports its dependent checks as *cannot verify*, with the reason.

| Id | Reports |
|---|---|
| [`tracker.provider`](ticketing-providers.md#choosing-a-provider-per-mapping) | A tracker in use whose provider cannot be built, or that has no setup checks |
| [`tracker.linear.credentials`](ticketing-providers.md#the-apps-credentials) | Linear refusing the app's credentials, with its HTTP status |
| [`tracker.linear.team-access`](ticketing-providers.md#team-access) | A Linear project whose key names no team the app can see |
| [`tracker.linear.pickup-label`](ticketing-providers.md#the-pickup-label) | No label with the pickup label's exact name at workspace level or in the team, or one only in a different case |
| [`tracker.linear.lifecycle-labels`](ticketing-providers.md#lifecycle-labels) | A lifecycle label the orchestrator would reuse in a different case |
| [`tracker.linear.workflow-states`](ticketing-providers.md#workflow-states) | A team with no `started`-type or no `completed`-type state |
| [`tracker.jira.credentials`](ticketing-providers.md#credentials) | Jira refusing the credentials, with its HTTP status, or OAuth mode, whose access token is never refreshed |
| [`tracker.jira.fields`](ticketing-providers.md#custom-fields) | A required field that matches no field or several by name, which stops every Jira project; a warning for an optional field named twice |
| [`tracker.jira.field-cache`](ticketing-providers.md#field-cache) | Field IDs the poll cached before the project's fields changed in Jira |
| [`tracker.jira.status-options`](ticketing-providers.md#the-ai-implement-status-options) | A status field that is not a select field, or lacks an option the project uses |
| [`tracker.jira.repo-option`](ticketing-providers.md#repo-option) | A select repo field with no option equal to the project's Repo Field Value |
| [`tracker.jira.jql`](ticketing-providers.md#jql) | The project's JQL refused by Jira as the poll runs it |
| [`tracker.filesystem.directory`](ticketing-providers.md#filesystem-setup) | A ticket directory that is missing, is not a directory, or that the orchestrator cannot write and search |

## Bootstrap mode before sign-in

Before an admin path is configured, unauthenticated `GET /` shows
`setupChecks.failingOnAdminPath`: the ids of failing local checks that can block
reaching an admin. It checks these afresh on each request, even while Restate is
down, without contacting any network service. It never shows titles, details,
fixes, projects or configured values. Use the ids to identify what needs attention
before anyone can sign in.

This list stops appearing once a real access code is set, a kept SSO provider has
its redirect URL and an admin address in the effective allowlist, or BuildDown has
its redirect URL. An unreadable allowlist keeps bootstrap mode off, so an outage
does not expose diagnostics. `setupChecks.checkedAt` and `failingCore` remain:
they describe the last known setup run, restored after Restate registration on
restart, or are both `null` before a run is known.
