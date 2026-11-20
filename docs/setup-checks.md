# Setup checks

The setup checks read an orchestrator's setup and report each fault before an issue is spent on it, each with the fix that clears it. A check only reads: [ADR 047](adr/047-orchestrator-setup-checks-only-read-and-what-they-show-depends-on-who-can-reach-an-admin.md) records why, and what each audience may see. This page covers the command that runs them without the server, how to read what it prints, where a running orchestrator shows them, and every check, by group.

## Running the command

The command runs the checks with no HTTP server, no Restate and no sign-in, so it works on a new orchestrator before any of those do.

| Where | Command |
|---|---|
| Locally | `npm run check-setup`, which loads `.env` the way `npm run dev` does |
| On Fly | `fly ssh console -a <app> -C "node /app/dist/check-setup.js"`, inside the running machine, with the app's secrets in its environment |

`--json` prints the run instead of the table: a `SetupCheckRun`, holding `startedAt` and `checkedAt` (when the run began and when its last check finished) and its results, one per check, or per project for a per-project check, with its `id`, `title`, `group`, `tier`, `onAdminPath`, `state`, `detail` and `fix`, plus `project` on a per-project row, `fixUrl` where a page applies the fix, `waitsOn` on a row that cannot be read until another check is addressed (naming that check, as its fix does), and `verifiable: false` on a row of a check that can never be verified (below). A row from a run narrower than a full one, such as a project's own run in the server, also carries its own `checkedAt`; a row without one dates from the run's. A check whose prerequisite does not apply returns no result (below). `--help` prints the usage.

The authority is shell access on the host, as for [access recovery](access-model.md#recovery-from-lockout). Shell access already implies reading every secret, so the command prints each check's detail and fix. No check prints a secret's value; a check names the variable instead.

### What it reads

- **The environment** of the shell it runs in.
- **The database** at `DEDUP_DB_PATH` (default `/data/dedup.sqlite`), resolved the way the server resolves it and opened read-only: the command never creates the file, never runs a migration and never writes. With the orchestrator running, it reads the same file beside it. When no database exists at that path, each check that reads it reports *cannot verify*, naming the path, which is expected before an orchestrator's first boot.
- **Restate's status and the orchestrator's instance identifier**, from the running orchestrator's own health endpoint: `GET /` on `127.0.0.1` at `PORT` (default 8080), with a five-second limit. The orchestrator starts Restate as its own child process, so with the orchestrator stopped the command cannot tell whether Restate would run, and `restate` reports *cannot verify* rather than failing. The identifier is what `callback.reachable` compares the callback address's answer with, since the command is a separate process from the server.
- **The Fly sessions app and region**, from Restate's `RunnerBackend` object when the orchestrator answers with its endpoint registered, as the server reads them; otherwise from the environment, then the saved settings rows.
- **GitHub, as the App:** `GET /app`, each project owner's installation, what the installation's read-only token sees of the projects' repositories, an unauthenticated read of a repository on an owner the App is not installed on, the App's webhook deliveries from the last day, and the knowledge graph refresh's preflight. Every call is a `GET`, a GraphQL query, or the installation token mint every orchestrator read already uses.
- **The callback address**, `GET /` under `RUNNER_CALLBACK_BASE_URL`, from this host, with a five-second limit.

## Reading the output

For example, a raw copy of `.env.example` with no orchestrator running prints, among its other rows:

```
Orchestrator
  FAIL           env.github-app: GitHub App credentials
                 GITHUB_APP_PRIVATE_KEY does not parse as a private key
                 Fix: Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY. The private key is the PEM file from the GitHub App's settings page.
  CANNOT VERIFY  restate: Restate engine
                 The orchestrator is not answering on port 8080, so its health endpoint cannot be read.
                 Fix: The check itself could not run, its detail names the error.

3 core checks fail.
```

Results print grouped by check group, under the group's display name (the `tracker` group prints as "Ticketing system"), one row per check, or per project for a per-project check: its state, id and title, then what it read, then its fix when it has one. The states are `PASS`, `WARN`, `FAIL`, `CANNOT VERIFY` (the fact could not be read, with the reason in the detail) and `N/A` (the check does not apply to this setup).

A check whose prerequisite does not apply prints no row, so the one check that gates it speaks for the rest. With no project on Linear, only `tracker.linear.credentials` reports it, and likewise `tracker.jira.credentials` for Jira; with no project at all, only `tracker.provider` reports it, for the GitHub checks that run once per project as well. With no Filesystem project, `tracker.filesystem.directory` prints nothing. A check that cannot read what another check reports still prints its row, *cannot verify*, with a fix that names that check: "More information is needed. Address the tracker.jira.credentials check first." A per-project check prints that row once for each project that depends on the failed check, so each project's own rows show the fault: when the Linear provider cannot be built, every Linear project gets a *cannot verify* row from each per-project Linear check, pointing at `tracker.provider`, and Jira projects get none. A check that does not apply to a project's configuration, such as reference repositories for a project that reads none, still says so whatever its dependency answers. The table prints one project's rows that wait on the same check as one line naming every check (`joinWaitingRows`, `src/check-setup.ts`), and the Setup page and the New project stepper show them the same way, while `--json`, the stored run and every count keep each row.

Each check has a tier: `core` applies to every deployment, `mode` to one execution mode, and `feature` to an optional feature. The last line counts the failing core checks.

Each check also declares whether it can be verified (`verifiable` on `SetupCheck`). Two never can, because nothing the orchestrator can read settles them: `github.target-secrets` and `github.review-process` always answer *cannot verify* where they apply, so their rows carry `verifiable: false`. The admin UI's project markers and the New project stepper's Create gate leave those rows out, so a project whose setup is otherwise sound reads as passing.

| Exit code | Means |
|---|---|
| 0 | No core check fails |
| 1 | At least one core check fails |
| 2 | An unknown argument; nothing ran |

A warning, a check that cannot verify, and a failing `mode` or `feature` check are reported without changing the exit code, so a script stops on a broken setup alone.

## In a running orchestrator

Inside the server, the checks run in the `SetupChecks` Restate object (`src/restate/setup-checks.ts`), which keeps the last run. An admin starts a full run from the Setup page, one project's checks run from the admin UI (below), and the orchestrator runs them itself at boot, after a saved change and after a runtime failure ([When the checks run on their own](#when-the-checks-run-on-their-own)). Each surface shows the stored run, or nothing before the first.

| Where | Who | Shows |
|---|---|---|
| The admin **Setup** page (`/admin#setup`) | admins, and users granted the page | the stored run with every row's detail and fix, a card per group and one per project; while a run goes, its progress. Only an admin can start a run, or run one project's checks from its card |
| Overview | admins | a line naming the groups that have failing checks, linking to the Setup page |
| The **Projects** page | admins | each project's Setup and Optional setup markers from the stored run, and a notice linking to the Setup page while any checked project has one that does not pass ([admin-ui.md](admin-ui.md#what-each-page-shows-and-changes)) |
| The **New project** stepper's Review | admins | the unsaved project's checks, under the settings each reads, before Create |
| `POST /api/setup-checks/run` | admins | starts a run and answers 202 with its invocation id at once, without waiting for it; 409 `run-in-progress`, with the running run's `startedAt`, while one is going |
| `POST /api/setup-checks/project` | admins | runs one saved project's checks (`{ "project": "<key>" }`), waits for them (60 seconds at most), and answers `run`, the stored run they merged into, and `groups`; 404 `no-such-project`; 503 `restate-unavailable` with `setupCommand` |
| `POST /api/setup-checks/candidate` | admins | runs an unsaved project's checks in this process for the project as the save body would store it, storing nothing, and answers its `results` and `groups`; the save's own 400 when the save would refuse the body; 500 `setup-checks-failed` when the run throws |
| `GET /api/setup-checks` | admins, and users granted the Setup page | `run`, the stored run with every field (`null` before the first); `progress`, the run in progress (`null` when none), with its `startedAt`, the `total` number of checks, the `finished` rows and the checks still `running` by `id`, `title` and `group`; and `groups`, each group's display name |
| `get_tenant_health`, field `setupChecks` | every allowlisted identity | each row's `id`, `title`, `state` and `project`, the count of failing core rows (`failingCore`) and `checkedAt`; `null` before the first run |
| `get_issue_dispatch_status`, fields `breakers` and `projectSetupChecks` | every allowlisted identity | for one issue, the setup checks behind each phase's dispatch breaker (`configurationProblem`, `setupChecks`), and its project's rows needing attention by `id`, `title` and `state` ([mcp-server.md](mcp-server.md)) |

**A project's own run** (`runProjectSetupChecks`, `src/setup-checks/index.ts`) narrows the checks to that one project. It runs every check that judges projects (`perProject` on `SetupCheck`), plus the orchestrator-wide rows those depend on: `tracker.provider`, the project's ticketing system's credentials check, `github.app-identity` and `github.clock`. A per-project check that throws answers one row, stamped with the project. It runs in the `SetupChecks` object's `runProject` handler, behind any full run, and never touches a full run's progress. Its rows merge into the stored run (`mergeSetupCheckRun`): the project's stored rows are replaced by the new ones, and so are the orchestrator-wide rows it read afresh, so a pointer at a failed dependency points at that dependency's current row. The exception is `tracker.provider`, which keeps its stored row, since that row names every project on a provider. Each merged row carries its own `checkedAt`, while the run's `startedAt` and `checkedAt` keep dating the last full run. A project's run can be answered by a full run instead (below), which shows no progress, so a run an admin started meanwhile, queued behind it, keeps its claim and a second start is still refused. The admin UI runs a project's checks from three places: the Projects page's **Check setup** for a project no run has checked, the Setup page's **Check this project** on its card, and once a sync the admin UI started ends.

**An unsaved project's run** is the same narrowed run, for the mapping a save would store. It runs in process, stores nothing, and leaves out `github.workflow-default-branch` and `github.workflow-mapping-branch`, which no project passes before its first workflow sync (`BEFORE_FIRST_SYNC`).

**A partial run carries its scope** (`SetupCheckRun.scope`: the checks it ran, and its projects when it names some), and `mergeSetupCheckRun` replaces exactly the stored rows in that scope. A check in scope that now answers nothing leaves no row. A full run replaces the stored run whole, and rows of projects no longer saved are dropped. Every partial run is the one scoped run (`runSetupChecksInScope`) with its own list of checks.

**A partial run is answered by a full run instead** (`partialRunNeedsFullRun`, `src/setup-checks/index.ts`), stored whole, whether it is a project's run, the orchestrator-wide run or a recheck. With no stored run yet, it would stand for every check. And when it finds a check every project's rows wait on in a state the stored run does not show, failing or recovered, the change reaches every project that shares the check, whose stored rows the partial run cannot correct. Those checks are `env.github-app`, `tracker.provider`, `github.app-identity` and each ticketing system's credentials check (`SHARED_DEPENDENCIES`). So a recheck that finds the App's credentials refused, or a project's run that finds them accepted again, leaves no project's rows reading as before. Once a full run has stored the change, a later partial run that finds the same state merges as it is. A recheck answered this way stores the full run without its `cause`.

### When the checks run on their own

| When | What runs | Where it goes |
|---|---|---|
| Boot, once the server listens | the orchestrator group, less `restate` and `runner.fly-sessions`, which read what only Restate fills, in this process | one `[setup-checks]` log line per row that fails, cannot verify or warns. Nothing is stored |
| Boot, once Restate serves | every orchestrator-wide check, through the object's `runOrchestratorWide` | the stored run, and a log line per row the first run did not cover |
| A poll cycle after a saved change | the run that change needs (below) | the stored run |
| A runtime failure that names a check | `recheck` for that check (below) | the stored run, the rows marked with the failure's `cause` |

Boot waits for neither of its runs, and a run that throws logs one line.

**During a deploy hold.** While a self-deploy holds new work back, nothing starts a run through the `SetupChecks` object ([restate.md](restate.md#a-call-or-send-that-starts-an-invocation-waits-out-a-deploy-hold) has the rule). Boot's run once Restate serves waits for the hold to clear, which on a boot after a self-deploy is when that deploy ends. The change detector's runs wait for a later cycle, a recheck is refused, and the Setup page's **Run checks** and **Check this project** answer 503 `restate-unavailable`. The stored run is still read.

**After a saved change.** Each poll cycle, the change detector (`createSetupCheckChangeDetector`, `src/setup-checks/change-detector.ts`) reads the saved setup (`readSavedSetup`) through the checks' own readers and compares it with the last cycle's. So a change made anywhere, from the admin UI, an MCP tool, the setup command, the control plane or by hand, gets its run.

| Change | Run sent |
|---|---|
| A project's mapping saved or added | that project's run, and the orchestrator-wide run, since four orchestrator-wide checks name projects |
| A project's mapping deleted | the orchestrator-wide run alone, since the project has no rows of its own left |
| A project's workflow sync started or ended | that project's run |
| A seed-once setting, a runner setting, the allowlist, an agent configuration revision or the Fly sessions settings | the orchestrator-wide run |
| The runner mode or the pickup label | a full run, since both reach checks of each kind |

Nothing the orchestrator writes for itself is read, so a cycle with nothing saved sends nothing. Which of the checks' readers the saved setup reads, and why each other one is left out (a variable, the process's own state, or a read from GitHub or the ticketing system, none of which a save changes), is `SAVED_SETUP_READERS`: a reader added to the context does not compile until it is placed there, and a test holds each placement to what `readSavedSetup` reads. The detector writes its record to the `setup_checks_change_detector` settings row, which is not one of the settings it reads, whenever the record changes: a fingerprint of each part of the saved setup it last read, which tells a change apart without holding the setup, and the runs still waiting. So a process's first cycle compares with what the last process read: a restart with nothing saved is not a change, while a save made just before it, or while the orchestrator was down, and a run still waiting when it stopped all keep their runs. With no record written yet, the first cycle only reads. One run of each kind is sent per cycle, at most once per five minutes, so the last of a burst of saves is always checked. More than three project runs waiting become one full run, and a full run answers for every other. A run Restate could not take, a run held back by a deploy hold, or a full run refused because one is already going, waits for the next cycle.

**After a runtime failure.** `recheck({ id, project?, cause? })` on the `SetupChecks` object runs one check again: one project's rows of a per-project check given a project, else every row of the check. A check its rows wait on (`waitsOn`) runs with it, and so does each check that check's rows wait on in turn, since a later read can find what the first did not, so no row waits on an older one (`recheckWaitedOn`, `src/setup-checks/index.ts`). The rows keep the failure's `cause`, one of `SETUP_RECHECK_CAUSES` (`src/setup-checks/contract.ts`). A recheck is held for an hour, whatever the check answered: a recheck of the same rows within the hour does nothing, and so does one whose stored rows all already need attention and were checked within the hour. So a failure path that fires on every poll runs its check at most once an hour. Each check it waits on is held the same way, so a check many projects' rows wait on runs once in the hour, and runs at most once in any one recheck, so the chain always ends. An unknown check, or a project no mapping holds, does nothing. Code outside `src/restate/` asks for one through `recheckSetupCheck`, for each check behind a failure through `recheckSetupChecks`, or through `pointAtSetupChecks` from a log line (`src/setup-checks/recheck.ts`, which imports nothing that reads the check list, so any runtime path can import it). Each sends through the one sender `startServer` sets (`setSetupCheckRecheckSender`): the object's ingress client (`createSetupChecksIngressClient().recheck(...)`), which answers false while Restate cannot serve or a deploy holds new work back. Before the server starts, a request does nothing.

### Runtime failures that name a check

Each of these ends the log line or tracker comment it already writes with the checks that explain the failure, `. Setup check: <id>. Read it on the Setup page at /admin#setup` in a log line and the ids as code in a tracker comment (`trackerSetupChecksSentence`), and asks for each to be rechecked for its project, with the cause shown.

| Failure | Where | Checks | Cause |
|---|---|---|---|
| A workflow dispatch GitHub refuses | `surfaceDispatchFailure` (`src/dispatch-failure.ts`) for every launch, and `GithubReviewFixWorker.launch` (`src/review-fix-worker.ts`) for a review fix | a 404: `github.installation`, `github.workflow-default-branch` and `github.workflow-mapping-branch`; a 403: `github.permissions` | `dispatch-404`, `dispatch-refused` |
| A launch its backend or the forced runner mode refuses | the poll's and planning's forced-mode skips (`checkForcedPathEligibility`, `src/runner-mode.ts`), the planning launch (`src/planning-launch.ts`), ImplementationRun's launch and gap-fill launch (`src/restate/implementation-run-production.ts`, `src/restate/implementation-run-gapfill.ts`), and the gap-fill drain's deferral (`src/comment-gapfill-drain.ts`) | `runner.project-backend` for Bedrock or the ephemeral full-access opt-in off GitHub Actions, `runner.fly-sessions` for a missing sessions app or token, `model.credentials-adopted` for a container run with no model credential | `launch-refused` |
| Planning without the runner callback pair | the poll (`src/index.ts`) | `callback.config` | `planning-refused` |
| A GitHub Actions run whose "Generate GitHub App token" step failed | ImplementationRun's and PlanningRun's close (`src/restate/implementation-run-production.ts`, `src/restate/planning-run-production.ts`) | `github.target-secrets` | `token-step` |
| A tracker read the poll cannot make | a provider that fails to build (`ProviderRegistry.forAllMappings`, `src/providers/registry.ts`), a failed snapshot and a failed roll-up read (`src/index.ts`) | `tracker.provider`; the tracker's credentials and fields checks (`trackerReadChecks`, `src/poll-selection.ts`) | `tracker-read` |
| A GitHub read the App is refused | the poll's per-issue catch (`src/index.ts`), the gap-fill drain's token mint (`src/comment-gapfill-drain.ts`), a workflow sync (`runWorkflowSync`, `src/workflow-sync-queue.ts`) | by the error's category (`gitHubAppErrorChecks`, `src/setup-checks/recheck.ts`): `github.app-identity` and `github.clock`, `github.installation`, or `github.permissions` | `github-read`, `workflow-sync` |
| A token a run asks for that cannot be minted | the token, dependency-token and publication-token endpoints (`src/token-vending.ts`, `src/dependency-token-vending.ts`, `src/publication-token-vending.ts`), and the reference-token endpoint for one owner (`src/reference-token-vending.ts`) | by the error's category; `github.reference-repos` for a reference token | `token-vending` |
| A tracker write refused | the setup park (`checkTrackerWrites`, `src/tracker-write-gate.ts`) and the plan-complete park (`planCompleteFailureChecks`, `src/runner-callback.ts`) | `tracker.linear.lifecycle-labels`; for plan-complete, `tracker.jira.status-options` on Jira, and `tracker.linear.team-access` for a mutation Linear refuses | `tracker-write` |
| A failure the runner reports in its result | the result callback (`src/runner-callback.ts`), its failure comment and its reference-repository comment | `GIT_AUTH` and `CHECKS_PERMISSION_DENIED`: `github.permissions`; `PROVIDER_AUTH` on a run without a managed credential: `model.credentials-adopted`; a reference repository that missed the run for `no-auth`, `ref-not-found` or `token-error`: `github.reference-repos` | `runner-reported` |

A parked issue's comment (`fireBreakerTrip`, `src/index.ts`) names, for a breaker that ended on a 404, the checks the stored run shows failing for the project, otherwise every check that can cause it, and asks for no recheck, since the dispatches already did; `get_issue_dispatch_status` names them by the same rule (`breakerSetupChecks`, `src/dispatch-failure.ts`). A refused result token names no check: it reached this orchestrator, so both callback checks pass for it, and another orchestrator's mint or a changed `RUNNER_TOKEN_SECRET` is behind it.

### Times

Each module keeps its setup-check times together, and these are all of them.

| Time | Value | Where | What it is |
|---|---|---|---|
| `MIN_SETUP_CHECK_RUN_INTERVAL_MS` | 5 minutes | `src/setup-checks/change-detector.ts` | the least time between two runs of one kind the change detector sends |
| `RECHECK_HOLD_MS` | 1 hour | `src/setup-checks/recheck.ts` | how long a recheck answers for its rows |
| `INGRESS_TIMEOUT_MS` | 10 seconds | `src/restate/setup-checks.ts` | bound on reading the stored run, and on Restate accepting a sent run |
| `WAITED_RUN_TIMEOUT_MS` | 60 seconds | `src/restate/setup-checks.ts` | bound on a run its caller waits for: a project run, or boot's orchestrator-wide run |
| `ORCHESTRATOR_HEALTH_TIMEOUT_MS` | 5 seconds | `src/health-body.ts` | bound on `callback.reachable`'s read of this orchestrator's `GET /` |
| `RUNNING_POLL_MS`, `IDLE_POLL_MS` | 5 seconds, 60 seconds | `src/admin-ui/pages/setup.ts` | how often the Setup page reads while a run goes, and otherwise |
| `START_WAIT_MS` | 30 seconds | `src/admin-ui/pages/setup.ts` | how long the Setup page waits for a started run to show its progress |

Why each audience sees what it sees is [ADR 047](adr/047-orchestrator-setup-checks-only-read-and-what-they-show-depends-on-who-can-reach-an-admin.md)'s second decision. Starting a run is admin-only even for a user granted the page, since a grant reaches only a page's `GET` routes. Both routes answer 503 `restate-unavailable` while Restate cannot take the call (the sidecar not ready, or the endpoint not registered) or does not answer; the `GET`'s 503 also carries `setupCommand`, the setup command as an operator runs it against this orchestrator (`setupCommandFor`: the `fly ssh` form for the app when `FLY_APP_NAME` is set, otherwise `npm run check-setup`), which the Setup page shows, since that command runs without Restate. A run's progress is kept in the orchestrator's memory while the run goes, not in Restate: each check adds its rows as it finishes, and the record clears once the finished run is stored, so a restart mid-run loses it, and Restate retrying the run starts a fresh record. For the same reason a stored run's `restate` row always passes: a run reaches the object only while Restate can serve. A Restate fault shows on `GET /` and in the setup command instead. `failingCore` counts rows, as the command's last line does, so a check that fails for two projects counts twice. A run's detail and fix are kept in the object's state and journal, which only admins can read, through the Restate UI. Neither carries a secret's value.

## The checks, by group

This is the one list of every check. Each group has its own heading, and each id links to the section of that group's reference that explains the value it reads. An id never changes, so search for the one the command printed.

In the code, each group's checks are a module beside `src/setup-checks/index.ts`, which builds the list from them and runs it. A check is written against `src/setup-checks/contract.ts` (the ids, a result, the context it reads, and `waitOn` for a row that waits on another check), never against `index.ts`, which imports every check module at load, so the dependency runs one way. The change detector is `src/setup-checks/change-detector.ts`, which reads the saved setup through the same context and imports nothing from `index.ts`. The runtime side, how a failure names its checks and asks for a recheck, is `src/setup-checks/recheck.ts`, which also imports nothing from `index.ts`, while what reads the check list for a recheck (its scope, its hold, the checks it waits on) stays in `index.ts`.

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
| [`callback.reachable`](runner-callbacks.md#the-path) | The callback address answering without the orchestrator's health response, not at all within five seconds, or as a different orchestrator, which refuses this one's runs. Not applicable in local runner mode or for a `host.docker.internal` address, which resolves only inside a local runner's container |
| [`runner.fly-sessions`](orchestrator-configuration.md#the-summary-main-logs) | Projects whose path resolves to Fly Machines while the backend source is `not-loaded` (Restate has not answered yet), or with source `restate` without the sessions token or app. Wait for Restate to serve; read the [restate] lines in the orchestrator log. |
| [`runner.project-backend`](execution-backends.md#ephemeral-full-access-for-codex-implementation-aii-1437) | Projects that use Bedrock or the ephemeral full-access opt-in, which run only on GitHub Actions, whose runs go to Fly Machines or local Docker, which refuse them; under a forced runner mode its fix is the runner mode |
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
| [`tracker.linear.lifecycle-labels`](ticketing-providers.md#lifecycle-labels) | A lifecycle label the orchestrator would reuse in a different case (`warn`), or a missing label whose creation permission cannot be checked read-only (`cannot-verify`); mixed cases warn and report both |
| [`tracker.linear.workflow-states`](ticketing-providers.md#workflow-states) | A team with no `started`-type or no `completed`-type state |
| [`tracker.jira.credentials`](ticketing-providers.md#credentials) | Jira refusing the credentials, with its HTTP status, or OAuth mode, whose access token is never refreshed |
| [`tracker.jira.fields`](ticketing-providers.md#custom-fields) | A required field that matches no field or several by name, which stops every Jira project; a warning for an optional field named twice |
| [`tracker.jira.field-cache`](ticketing-providers.md#field-cache) | Field IDs the poll cached before the project's fields changed in Jira |
| [`tracker.jira.status-options`](ticketing-providers.md#the-ai-implement-status-options) | A status field that is not a select field, or lacks an option the project uses |
| [`tracker.jira.repo-option`](ticketing-providers.md#repo-option) | A select repo field with no option equal to the project's Repo Field Value |
| [`tracker.jira.jql`](ticketing-providers.md#jql) | The project's JQL refused by Jira as the poll runs it |
| [`tracker.filesystem.directory`](ticketing-providers.md#filesystem-setup) | A ticket directory that is missing, is not a directory, or that the orchestrator cannot write and search |

### github

The GitHub App and each project's repository on GitHub (`GITHUB_CONFIG_CHECKS`, `src/setup-checks/github-config.ts`). One set of GitHub reads is shared by every check in a run (`githubSetupFacts`, `src/setup-checks/index.ts`), and a check whose prerequisite fails reports *cannot verify*, naming the check to clear first. The `mode` rows apply to projects that run on GitHub Actions, and are not applicable for the others.

| Id | Reports |
|---|---|
| [`github.app-identity`](orchestrator-configuration.md#boot-checks-presence-not-validity) | GitHub refusing the App's ID and private key, naming the host clock when it explains the refusal |
| `github.clock` | The host clock more than 300 seconds from the `Date` of GitHub's answer, the margin the App's credentials allow |
| [`github.installation`](deployment.md#github-app-permissions-install-prerequisite) | A project's owner without the App installed, or a selected-repositories installation that leaves the project's repository out |
| [`github.permissions`](deployment.md#github-app-permissions-install-prerequisite) | An installation lacking a required permission, or holding it at a lower level; a warning for a missing optional one (Checks, Commit statuses) |
| `github.target-secrets` | Always *cannot verify*: a GitHub Actions run reads `AI_IMPLEMENT_APP_ID` and `AI_IMPLEMENT_PRIVATE_KEY` from the repository's or organization's Actions secrets, which the App has no permission to read |
| [`github.webhook-signature`](review-fix-rail.md#prerequisites) | A warning when a webhook delivery in the last day was answered 401, a `GITHUB_WEBHOOK_SECRET` that differs from the App's |
| [`github.webhook-events`](review-fix-rail.md#prerequisites) | The App not subscribed to a webhook event the orchestrator handles (`GITHUB_APP_EVENTS`, `src/github-app-permissions.ts`), every gap at once: a failure for `pull_request_review`, `pull_request_review_comment` or `issue_comment`, whose absence turns a feature off, and a warning for `pull_request` or `push`, which the poll covers later. One row for the App, since every project shares its subscriptions; no row without `GITHUB_WEBHOOK_SECRET`, which `github.webhook-signature` reports |
| [`github.kg-grants`](kg-architecture.md#process-refreshing-the-graph) | A malformed `KG_SOURCE_REPO`, or a grant the knowledge graph refresh's preflight finds missing, which refuses every refresh |
| [`github.workflow-default-branch`](workflow-sync.md#what-a-sync-writes) | A project's workflow file, or its planning workflow file while planning is on, missing from the repository's default branch, which GitHub dispatches from. The detail names why: the files are on the project's branch only, a sync is in progress, the last sync failed, or the sync pull request is still open. A warning when the files are present and a sync pull request still carries changes to them |
| [`github.workflow-mapping-branch`](workflow-sync.md#the-sync-branch-and-pull-request) | A project branch that differs from the repository's default and does not exist, or lacks the workflow files |
| [`github.reference-repos`](runner-context.md#reference-repositories) | A reference repository a run cannot clone: not a GitHub repository, outside the installation, private on an owner without the App, missing, or with a pinned ref that does not exist |
| [`github.skills-repo`](runner-context.md#skills-repository) | A skills repository that is not a GitHub repository, or one other than the project's own that is private or missing, which a run, cloning with a token for the project's repository alone, cannot install |
| [`github.review-process`](review-fix-rail.md) | Always *cannot verify* for a project whose Review process has an outside reviewer (`claude[bot]` for both Claude processes, `chatgpt-codex-connector[bot]` for Codex), naming it, since no App credential can see another App's installation on a repository; not applicable under the AI-Implement review. Its fix is conditional ("If running into issues, …"), since nothing shows the reviewer missing |

## Bootstrap mode before sign-in

Before an admin path is configured, unauthenticated `GET /` shows `setupChecks.failingOnAdminPath`: the ids of failing local checks that can block reaching an admin. It checks these afresh on each request, even while Restate is down, without contacting any network service. It never shows titles, details, fixes, projects or configured values. Use the ids to identify what needs attention before anyone can sign in.

This list stops appearing once a real access code is set, a kept SSO provider has its redirect URL and an admin address in the effective allowlist, or BuildDown has its redirect URL. An unreadable allowlist keeps bootstrap mode off, so an outage does not expose diagnostics. `setupChecks.checkedAt` and `failingCore` remain: they describe the last known setup run, restored after Restate registration on restart, or are both `null` before a run is known.

## Terms

The setup checks' code and this page use these words in one sense each. Where the rest of the orchestrator uses a word another way, the last column says so.

| Term | Means here | Elsewhere |
|---|---|---|
| check | one entry on the list (`SetupCheck`), with its `id` | |
| row | one check's answer for one project, or for none (`SetupCheckResult`) | the type keeps its name, `SetupCheckResult` |
| per-project, orchestrator-wide | a check that answers a row per project (`perProject`), or one whose rows no one project owns | "shared" is a Restate handler kind, not the opposite of per-project |
| the orchestrator group | the checks in `src/setup-checks/orchestrator-config.ts`, always said with *group* | not the same as orchestrator-wide: the tracker and GitHub groups hold orchestrator-wide checks too |
| project | a saved mapping, named by its key | the same key is `teamKey` on a mapping, `scopeKey` on issues and `mappingKey` in dispatch admissions |
| run, partial run, scope | one pass over some checks (`SetupCheckRun`); a run narrower than a full one; the checks and projects a partial run answers for (`SetupCheckScope`) | `scopeKey` is a project's key, unrelated |
| saved setup, its fingerprints | what the change detector compares between poll cycles (`SavedSetup`), holding the values themselves; the same parts each replaced by a hash (`fingerprintSavedSetup`), which tells a change apart without holding the setup | a fingerprint elsewhere also identifies inputs to tell whether they changed: a hash (`ownedRunReportFingerprint`), or the inputs themselves as text (`readStageInputsFingerprint`) |
| the change detector's record | what the detector writes for the next process: the saved setup's fingerprints and the runs still waiting (`ChangeDetectorRecord`, the `setup_checks_change_detector` settings row) | not the progress record, the run in progress this process holds |
| run kind | what the change detector sends: a full, an orchestrator-wide or a project run (`SetupCheckRunKind`) | |
| the stored run, the cache | the run the `SetupChecks` object keeps (`lastRun`); this process's copy of it, which `GET /` reads (`getCachedSetupCheckRun`) | |
| recheck, cause | one check run again for a runtime failure; the kind of failure that sent it (`SETUP_RECHECK_CAUSES`) | |
| ingress client | `createSetupChecksIngressClient()`, the one way code outside a Restate handler reaches the object, a method per handler | as SelfDeploy's and the other `create…IngressClient` clients |
