# AI-Implement — Codebase Guide

## What this is

A Node.js service that polls Linear for issues labeled "AI-Implement" and dispatches GitHub Actions workflows that run Claude Code to implement them. It also provides an admin UI and manages workflow templates synced to target repos.

## Issue tracker — Linear (BuildDown skills)

Bindings for the BuildDown skills (bd-build-up, bd-build-down, bd-summit-push, etc.):

- tracker.kind: linear
- MCP server: `linear-eudoxus` (project `.mcp.json`; pre-approved in `.claude/settings.json`)
- Workspace: `eudoxus` (bound at OAuth time)
- Team: `AII`  ← issues filed/listed/searched against this team
- Team URL: https://linear.app/eudoxus/team/AII/overview
- GitHub repo (PRs land here): `BuildDownAI/AI-Implement`
- Implement label: `AI-Implement` (orchestrator pickup trigger)
- Agent mention (PR comment re-trigger): `/ai-implement`

> Note: a separate global `claude.ai Linear` connector is authenticated to the **oolidata** workspace.
> `linear-eudoxus` is a distinctly-named project server with its own token on **eudoxus**, so the two
> never collide.

## Architecture

```
Linear (AI-Implement label)
    ↓ poll every 60s (src/index.ts)
Node.js service on Fly.io
    ↓ workflow_dispatch (src/github.ts)
GitHub Actions in target repos (.github/workflows/claude-implement.yml)
    ↓ anthropics/claude-code-action
PR created → gap analysis posted → Linear updated
    ↓ /ai-implement comment (comment-trigger.yml)
Gap-fill run on existing PR
```

## Project structure

```
src/
  index.ts          — main entry: polling loop + HTTP server
  linear.ts         — Linear GraphQL client
  github.ts         — GitHub workflow_dispatch
  notify.ts         — notification adapter (slack | teams)
  config.ts         — SQLite-backed team→repo mappings
  dedup.ts          — SQLite deduplication + DB singleton
  poll-selection.ts — per-team capacity selection logic
  log.ts            — dispatch audit log (SQLite)
  admin.ts          — admin HTTP API (auth + CRUD)
  admin-html.ts     — re-exports the assembled admin HTML from admin-ui/index.ts
  admin-ui/         — string-composed admin SPA (see "admin-ui" section below)
  __tests__/        — Vitest unit tests

workflows/          — templates synced to target repos
  claude-implement.yml
  comment-trigger.yml
  claude-plan.yml   — planning workflow template (always synced)
  WORKFLOW.md       — Claude implementation prompt template (seeded once)
  PLANNING.md       — Claude planning prompt template (seeded once)
  custom/           — repo-local override scaffold seeded once (README + .gitkeep placeholders)

clients/            — one .toml per deployed client
  example-client.toml  — copy this to onboard a new client

scripts/
  provision-client.sh  — interactive client onboarding helper

.github/workflows/
  deploy-clients.yml — matrix deploy to all clients on push to main
  sync-workflow.yml  — sync workflow templates to target repos
  claude-review.yml  — Claude reviews PRs (auto for same-repo, /claude-review for forks)
  build-runner.yml   — build and push the session runner image to GHCR

docs/
  plans/      — implementation plans (decision artifacts; progress derived from git)
  solutions/  — documented solutions to past problems (bugs, best practices, workflow
                patterns), by category with YAML frontmatter (module, tags, problem_type);
                relevant when implementing or debugging in documented areas
```

## Running locally

```bash
cp .env.example .env   # fill in LINEAR_API_KEY, GITHUB_PAT
npm install
npm run dev            # runs src/index.ts via tsx
npm run dev:local      # rebuilds local session image, then runs local Docker jobs
```

Health check: `curl http://localhost:8080/`
Admin UI: `http://localhost:8080/admin` (requires ADMIN_ACCESS_CODE)

## Running tests

```bash
npm test              # vitest run (all tests)
npm run test:watch    # watch mode
npm run typecheck     # tsc --noEmit
```

## SQLite databases

All tables live in a single SQLite file at `DEDUP_DB_PATH` (default `/data/dedup.sqlite` in production, `./dedup.sqlite` locally).

| Table | Purpose |
|-------|---------|
| `dispatched` | Dedup — issue IDs dispatched in the last 24h |
| `mappings` | Team key → GitHub repo config |
| `dispatch_log` | Audit log, last 500 dispatches |

`dedup.ts` owns the DB singleton (`getDb()`). All other modules import `getDb` from `dedup.ts`.

## Key environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_API_KEY` | Yes | Linear personal API key |
| `GITHUB_APP_ID` | Yes | GitHub App numeric ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes | GitHub App RSA private key (PEM, `\n`-escaped) |
| `NOTIFY_TYPE` | No | `slack` (default) or `teams` |
| `NOTIFY_WEBHOOK_URL` | No | Webhook URL; notifications skipped if unset |
| `ADMIN_ACCESS_CODE` | No | Admin UI password; UI disabled if unset |
| `DEDUP_DB_PATH` | No | SQLite path (default `/data/dedup.sqlite`) |
| `POLL_INTERVAL_MS` | No | Poll interval ms (default `60000`) |
| `PORT` | No | HTTP port (default `8080`) |
| `AI_IMPLEMENT_LOG_LEVEL` | No | Runner log verbosity: `summary` (default) or `stream`. `stream` tees per-turn tool activity to the log. Telemetry (turns/cost/tokens/outcome) is captured at both levels. |

## Adding a new target repo

1. Add the project mapping in the admin UI at `/admin` — the **New project** stepper (or **Edit** on an existing row). On the **Source** step, enter the owner/repo and click **Check installation**: the stepper probes whether the GitHub App is installed and can see the repo, and links straight to the fix when it can't —
   - **App not installed** → "Install the App" (GitHub's install flow; org members who aren't owners get GitHub's "request the owner to install" path),
   - **Repo not selected** → "Add this repo" (same install flow — adjusts the install's selected-repositories set),
   - **Ready** → green confirmation.

   Use **Re-check** after installing/adding in the opened tab. The check is advisory — you can still save without it.
2. **Save.** The mapping persists immediately, and the workflow sync runs in the background. The project row's Sync button shows **"Syncing…"**, then polls a status endpoint to a terminal state: **"Workflows synced — PR opened ↗"** (or a transient "Up to date"), or it reverts with an alert naming the failure (App not installed, permission denied, clock skew, …). The mapping is saved regardless of how the sync resolves.
3. Merge the sync PR in the target repo
4. Enable "Allow GitHub Actions to create and approve pull requests" in the target repo settings

The **Sync workflows** button on each project row re-runs the sync manually at any time, and `.github/workflows/sync-workflow.yml` remains as a manual/bulk fallback. If the orchestrator restarts mid-sync, the poll loop reclaims the orphaned job after a short stale window and finishes it.

The GitHub App must have **Workflows** permission in addition to **Contents** permission. GitHub rejects writes under `.github/workflows/` without it, so the sync will fail (surfaced as a "permission denied" message) before opening or updating the target-repo PR.


## admin-ui

The admin SPA at `/admin` is composed from string-exporting modules under `src/admin-ui/`. `src/admin-html.ts` is a thin re-export of `src/admin-ui/index.ts`. There is **no client-side build step** — all client JS is concatenated into a single inline `<script>` block at module load time.

| Module | Owns |
|---|---|
| `tokens.ts` | CSS custom properties (light + dark + accent + spacing + type + radius + shadow) |
| `components.ts` | All component classes (`.card`, `.tbl`, `.btn`, `.badge`, `.kpi`, `.alert`, `.drawer`, `.modal-card`, etc.) |
| `icons.ts` | SVG icon registry + `icon(name, size)` helper |
| `sidebar.ts` | Sidebar render + `SIDEBAR_ROUTES` |
| `router.ts` | Hash-based router; `window.registerPage(key, init)` runs an init once on first show |
| `theme.ts` | Reads/writes `data-theme` from localStorage; default `dark` |
| `auth.ts` | Shared auth: `window.api()`, `window.esc()`, `window.login()`, `window.logout()`, token storage |
| `pages/<name>.ts` | One per sidebar item — exports `<name>Html` and `<name>Script` strings |

Page conventions: each `<name>.ts` exports two strings. The HTML uses `data-page="<route>"` matching the sidebar's `data-route`. The script is an IIFE that defines page-specific functions, exposes any `onclick=`-referenced ones on `window`, and ends with `window.registerPage('<route>', () => { /* init */ });`. Page scripts call `window.api()` and `window.esc()` rather than referencing them as bare globals.

When adding a new page: create the page module, append both strings to the lists in `src/admin-ui/index.ts`, and add the route to `sidebar.ts`. When adding a new design token: extend `tokens.ts` and the `tokens.test.ts` spot-check. When adding a new icon: drop the SVG inner markup into `iconRegistry`.

The 14 not-yet-implemented routes (`overview`, `issues`, `pulls`, `blockers`, `pipelines`, `models`, `channels`, `policies`, `runners`, `secrets`, `mcp`, `webhooks`, `customizations`, `updates`) are stubbed in `src/admin-ui/pages/stubs.ts` with `RoadmapNote`-style placeholders pointing to the plan that ships them.

## Notification adapter

`src/notify.ts` exports a single `notify(type, webhookUrl, notification)` function. Set `NOTIFY_TYPE=slack` or `NOTIFY_TYPE=teams` to switch providers. Adding a new provider means adding a private function in `notify.ts` and a new case in the switch.

## Workflow templates

`workflows/claude-implement.yml` is the main implementation workflow synced to target repos. It supports:
- **WORKFLOW.md** — per-repo Claude prompt template; front matter carries `model:` (required for bedrock, defaults to `claude-sonnet-4-6` for anthropic) and optional `gap_analysis_model:`
- **Gap analysis** — secondary Claude invocation after each PR
- **Comment trigger** — a PR comment that **starts with** `/ai-implement` kicks off a gap-fill run. Any text after the token (single- or multi-line) is forwarded to the run as an **authoritative operator instruction**: it is base64-passed through a `comment_instruction` workflow output to `AI_IMPLEMENT_COMMENT_INSTRUCTION`, and the runner appends it to the gap-fill prompt as an "Operator instruction for this run" block that takes precedence over the default gap-fill behavior where they conflict. Bare `/ai-implement` behaves exactly as before. `/ai-implementfoo` and comments that merely contain the token mid-text do not fire. Takes effect only after the target repo re-syncs `comment-trigger.yml` and runs an updated runner image.
- **Triple auth** — bedrock (when orchestrator sets `provider=bedrock`), OAuth (`CLAUDE_CODE_OAUTH_TOKEN`), or API key (`ANTHROPIC_API_KEY`)
- **setup / verify / teardown hooks** — `WORKFLOW.md` front-matter keys `setup:` / `verify:` / `teardown:` are paths (relative to repo root) to shell scripts that the runner now executes: `setup` before the implement loop (its failure aborts the run early), `verify` after a successful push, and `teardown` always (even on failure, via a `finally` in the runner). Scripts run with `set -euo pipefail`; env vars a setup script appends via `echo "VAR=value" >> "$GITHUB_ENV"` are visible to Claude and to the verify/teardown scripts (the runner manages `$GITHUB_ENV` across all execution modes). Repos with no hooks behave exactly as before.

### Per-project run caps (admin UI)

Each project's mapping carries three optional caps, editable in the `/admin` Projects edit dialog (blank = use the default):

| Field | Default when blank | Applies to |
|-------|--------------------|------------|
| **Max Turns** | `50` | Claude turns per implement pass (both providers) |
| **Max Iterations** | bedrock `2`, anthropic `3` | implement/review cycles in the feedback loop |
| **Job Timeout (min)** | `90` | GitHub Actions job `timeout-minutes` (GHA mode only) |

`maxTurns`/`maxIterations` reach the runner as `workflow_dispatch` inputs (GHA) or runner env (Fly/local); `maxJobMinutes` is a GHA-only `job_timeout_minutes` dispatch input. The orchestrator only **sends** a cap input when it is set on the mapping, so a project's target repo must have **re-synced `claude-implement.yml`** before you set caps — otherwise GitHub rejects the dispatch with "unexpected inputs". Caps also apply to gap-fill and review-feedback re-dispatches, not just the initial run.

`/ai-implement` comment-triggered gap-fill runs bypass the orchestrator, so they read caps from target-repo **variables** instead (mirroring `AI_IMPLEMENT_PROVIDER`): set `AI_IMPLEMENT_MAX_TURNS`, `AI_IMPLEMENT_MAX_ITERATIONS`, and `AI_IMPLEMENT_MAX_JOB_MINUTES` (Settings → Secrets and variables → Actions → Variables) to cap those runs too. Set `AI_IMPLEMENT_SKILLS_REPO` (same location) to mirror the per-project admin UI skills field for `/ai-implement` gap-fill runs; takes effect only after the target repo re-syncs `comment-trigger.yml`.

### Per-project branch prefix (admin UI)

Each project's mapping carries an optional **Branch Prefix** (blank = none, the default). When set, it is prepended as a path segment to the implementation branch name: with prefix `pr`, a branch that would be `ai-implement/PROJ-123-add-login` becomes `pr/ai-implement/PROJ-123-add-login`. Each `/`-separated segment of the prefix must start with a letter or digit and may otherwise contain only letters, digits, `.`, `_`, `-` (no `..` or `//`, ≤ 64 chars); the admin API rejects anything else.

The prefix only affects the **initial orchestrator-driven run** — `/ai-implement` comment-triggered gap-fill runs commit to the existing PR branch and are unaffected. Like the run-caps, the prefix reaches the runner as the `branch_prefix` dispatch input (GitHub Actions) or `AI_IMPLEMENT_BRANCH_PREFIX` env var (Fly/local), and is only sent when set — so a project that sets a prefix must have **re-synced `claude-implement.yml`** to its target repo first, otherwise GitHub rejects the dispatch with "unexpected inputs".

### Jira: AI-Implement Profiles field (multi-select)

When using the Jira provider, the orchestrator reads a multi-select custom field to populate `TicketIssue.profiles` on each dispatched issue. The field is discovered by name at runtime — **it must be named exactly `AI-Implement Profiles`** in your Jira instance for auto-discovery to work. If the field is absent the orchestrator logs a warning and continues without populating profiles (it does not fail).

If the field exists under a different name, or if multiple fields share the same name, set `profilesFieldOverride` to the explicit `customfield_NNNNN` ID — via the **Profiles Field** dropdown in the `/admin` Projects edit dialog or the add-project wizard's Jira step, or directly on the mapping's `ticketingConfig` through the API. When all three overrides (`statusFieldOverride`, `repoFieldOverride`, `profilesFieldOverride`) are set, the orchestrator skips the `listFields` call entirely.

At implementation-dispatch time the orchestrator forwards the issue's profiles, comma-joined, as the `profiles` workflow_dispatch input (GitHub Actions) or `AI_IMPLEMENT_PROFILES` env var (Fly/local). Like the run-caps and branch prefix, it is only sent when non-empty — so an issue with profiles set dispatches to a target repo only after that repo has **re-synced `claude-implement.yml`**, otherwise GitHub rejects the dispatch with "unexpected inputs". The runner parses the env var (comma-split, trimmed, empties dropped) into `ctx.data.profiles`; **no built-in pipeline step consumes it** — it is deliberately the contract surface for image-baked `custom/` steps (loaded via `AI_IMPLEMENT_CUSTOM_ROOT` / `resolveModuleImport`), which branch their setup on the selected profiles. Profiles are per-issue, so unlike the mapping-scoped `skills_repo` there is no repo-variable mirror: `/ai-implement` comment-triggered gap-fill runs and orchestrator review-feedback re-dispatches run without profiles (the initial profile-aware run already produced the PR they amend).

### Runner log verbosity

`AI_IMPLEMENT_LOG_LEVEL` controls how much the runner logs during an implement pass:
- `summary` (default): logs a single result line per Claude invocation — outcome (incl. `max_turns`), turns, duration, cost (when reported), tokens.
- `stream`: additionally tees each per-turn tool call (name + truncated input; not tool output) to the log.

Set it as a repository or organization **variable** (Settings → Secrets and variables → Actions → Variables), mirroring `AI_IMPLEMENT_PROVIDER`. It is read inside the runner container, so it applies to both orchestrator-initiated and `/ai-implement` comment-triggered runs **after the target repo has re-synced `claude-implement.yml`**. It is not a per-project admin field and not a dispatch input.

### Runner label (GHA mode)

`AI_IMPLEMENT_RUNNER_LABEL` overrides the `runs-on` label for the `implement` job, defaulting to `ubuntu-latest`. Default GitHub-hosted runners are 2 vCPU; the test suites Claude runs during implement (and the verify-hook gauntlet) are CPU-bound and scale ~linearly with cores, so pointing this at a larger-runner label (e.g. `ubuntu-latest-4-cores`) roughly halves the implement job's wall-clock.

Set it as a repository or organization **variable** (Settings → Secrets and variables → Actions → Variables), like `AI_IMPLEMENT_LOG_LEVEL`. It only affects the GitHub Actions execution mode and only after the target repo has re-synced `claude-implement.yml`. It takes a single label string, not a label array. Granting write access to this variable lets the holder retarget the job to an arbitrary (e.g. self-hosted) runner that would see the job's secrets — the same threat model as any org-variable-controlled `runs-on`.

`workflows/claude-plan.yml` is the planning workflow synced to target repos. It runs read-only codebase analysis and posts structured planning comments to Linear when dispatched. It supports:
- **PLANNING.md** — per-repo Claude prompt template; front matter carries `model:` (same rules as WORKFLOW.md)

The Projects page **Sync workflows** action always syncs `claude-implement.yml`, `comment-trigger.yml`, and `claude-plan.yml` into the target repo. It seeds `WORKFLOW.md`, `PLANNING.md`, and the `custom/` scaffold (`custom/README.md` plus `.gitkeep` placeholders for `custom/steps/`, `custom/pipelines/`, `custom/providers/`) once, and never overwrites them (each repo owns its prompt templates and customizations after initial setup). `.github/workflows/sync-workflow.yml` remains as a manual fallback, but normal distribution should happen from the orchestrator.

### Model IDs are passed through verbatim

Neither workflow validates model IDs — whatever `model:` says in front matter goes directly to `claude-code --model`. This lets new Anthropic releases and Bedrock IDs (`anthropic.<name>-<date>-v1:0` or inference-profile ARNs) flow without a workflow template edit. Typos fail fast at Claude invocation time with a clear error. The seed `WORKFLOW.md` / `PLANNING.md` ship with `model: claude-sonnet-4-6`, so fresh target repos work out of the box on the Anthropic provider.

### Using AWS Bedrock

To run a target repo against AWS Bedrock instead of the Anthropic API, use the GitHub Actions execution mode. Bedrock is not supported on Fly Machines or local Docker because those backends do not have a role-assumption mechanism equivalent to GitHub OIDC.

1. **In the orchestrator admin UI (`/admin`)**, edit the repo's mapping:
   - Set **Provider** to `bedrock`
   - Set **AWS Region** to the region that hosts your Bedrock inference profile (e.g. `us-west-2`)
2. **In the target repo**, add a repository secret:
   - `AWS_BEDROCK_ROLE_ARN` — an IAM role ARN that trusts the GitHub OIDC provider for this repo and grants `bedrock:InvokeModel` on the inference profiles you need
3. **In the target repo**, add two repository *variables* (Settings → Secrets and variables → Actions → Variables) so `/ai-implement` comment-triggered gap-fill runs route to the same provider as the orchestrator-initiated runs:
   - `AI_IMPLEMENT_PROVIDER` = `bedrock`
   - `AI_IMPLEMENT_AWS_REGION` = the same region used in the admin UI mapping
4. **In the target repo's `WORKFLOW.md` (and `PLANNING.md` if planning is enabled)**, change `model:` from the Anthropic default (`claude-sonnet-4-6`) to a Bedrock model ID or inference-profile ARN. There is no safe default for Bedrock — the workflow will hard-fail if `model:` isn't set when `provider=bedrock`.

IAM trust policy shape (use the `sub` condition to restrict to this specific repo):

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
    "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:<owner>/<repo>:*" }
  }
}
```

The workflow runs `aws-actions/configure-aws-credentials` once before the containerized runner step with a 4-hour session duration, covering implementation and gap-analysis runs. Only GitHub OIDC is supported — there is no static-key path.

## Feature-branch grouping (parent/child issues)

A Linear **parent issue** tagged `AI-Implement` that has `AI-Implement` children becomes a **feature node**: it owns a long-running branch `ai-implement/feature/<issue-key>`, its labelled children PR **into that branch** (not the repo base), and the tree cascades recursively. A parent's own work is deferred until its children finish, then runs onto its own branch; completed feature branches **roll up** into their parent automatically (internal levels via a direct merge, the top of the tree as a human-reviewed `feature → base` PR).

Key labels: `AI-Implement` (trigger) → `AI-Planning` (planning in flight) → `Plan-Complete` (ready to implement) → `AI-Working` (implementing) → `Ready for Review` (PR open); the orchestrator moves the issue to Done when the PR merges (via poll detector and optional webhook; this complements any native Linear/Jira GitHub integration). A parent labelled before its children is left alone until a child is labelled (race guard).

Parts: classification + roll-up discovery in `src/providers/linear.ts`; `TicketIssue.featureBranchChain` / `FeatureNodeRollUp` in `src/providers/types.ts`; cascade branch creation in `src/feature-branch.ts` (`resolveBaseBranch`); roll-up in `src/merge-up.ts`; GitHub helpers in `src/github.ts`; `Plan-Complete` via `src/runner-callback.ts`; wired into the poll loop in `src/index.ts`. Jira support lives in `src/providers/jira.ts` + `src/providers/jira-hierarchy.ts` (native parent with classic Epic Link fallback; roll-up completion = native Done **or** AI-Implement Status `Merged`). **Full reference: [docs/feature-branch-grouping.md](docs/feature-branch-grouping.md).**

Operational requirements: re-sync `claude-implement.yml` to the target repo (for the `base_branch` input); a **publicly reachable** runner callback (`RUNNER_CALLBACK_BASE_URL` + `RUNNER_TOKEN_SECRET`) so planning auto-advances and the cascade self-drives; and pair the runner image with the orchestrator channel (testing → `SESSION_IMAGE=…:next`).

### Issue completion on PR merge

When an AI-Implement PR merges, the orchestrator moves the tracker issue to a completed state (Linear: the team's `Done` state, else the first completed-type state; Jira: the AI-Implement status field value `Merged`) and clears the `Ready for Review` label. This runs even for paused projects.

Two paths feed the same `reconciliation_queue` → `markMerged` worker:

- **Poll detector (guaranteed):** every tick the orchestrator checks recent dispatches whose PR is not yet reconciled and asks GitHub whether the PR merged. This requires no webhook configuration.
- **Webhook (optimization):** a `pull_request` `closed`+`merged` delivery to `POST /api/github/webhook` enqueues the same reconciliation immediately, reducing merge→Done latency. If the webhook is unconfigured or a delivery is dropped, the poll detector still completes the issue within one tick.

Jira target repos must add a `Merged` option to their AI-Implement status field.

## Custom extensions

Client forks can override built-in behaviour without touching upstream code by placing files under `custom/`. A file at `custom/<path>` takes precedence over the corresponding built-in.

Resolution is handled by two functions in `src/pipeline/resolve-module.ts`:

| Function | Use case | Return value |
|----------|----------|--------------|
| `resolveModule(path)` | YAML and template files | Absolute filesystem path |
| `resolveModuleImport<T>(path)` | TypeScript/JavaScript modules | `default` export, or `null` if no override |

Both functions search two custom roots in order, then fall back to the built-in package root. There is no per-type discovery logic — the same two functions cover all extension points.

1. **Workspace root** — `custom/<path>` relative to `process.cwd()`. This is how orchestrator-side loading picks up a fork's `custom/` (the orchestrator runs with cwd = app root).
2. **Baked root** — `<AI_IMPLEMENT_CUSTOM_ROOT>/custom/<path>`, where the `AI_IMPLEMENT_CUSTOM_ROOT` env var names a directory that *contains* a `custom/` subdirectory. This is how the session runner picks up overrides: its cwd is `/workspace` (the target-repo clone dir, empty at process start), so the workspace root never matches there. `Dockerfile.session` copies the repo's `custom/` to `/app/custom/` and sets `AI_IMPLEMENT_CUSTOM_ROOT=/app`, so a client fork that builds its own runner image gets its `custom/pipelines/` and `custom/steps/` honored inside the runner — including the import-time load of `pipelines/autonomous.yml` and the eager step resolution in `createDefaultRunner()`, both of which happen before the clone step runs. With the env var unset (local dev, tests) resolution behaves exactly as before.

### Extension points

**`custom/pipelines/`** — Override a pipeline YAML definition. Example: place `custom/pipelines/autonomous.yml` to replace the built-in autonomous loop.

**`custom/steps/`** — Override a built-in step module. A file `custom/steps/<id>.ts` replaces the step registered under that key. It must export a `StepModule` as its default export. Built-in step keys: `clone`, `install`, `feedback-loop`, `preflight`, `push`.

**`custom/providers/`** — Reserved for provider overrides (TicketingProvider interface). Provider loading will call `resolveModuleImport("providers/<id>")`.

### Rules

- The orchestrator **never** overwrites any file under `custom/` except `custom/README.md`.
- A CI check (`protect-custom.yml`) rejects upstream PRs that touch other `custom/` files.
- When implementing client-specific behaviour, **always place new files in `custom/`** rather than modifying built-in modules — this keeps the fork rebasing cleanly on upstream changes.
- A `custom/` file that exists but has no `default` export produces a warning and falls back to the built-in rather than silently misbehaving.

## Runner image resolution

Both execution modes resolve the runner image with the same ladder, highest priority first:

1. **`.ai-implement/image.yml`** at the target repo's default branch — per-repo override:

   ```yaml
   image: ghcr.io/your-org/your-runner:v1
   ```

   In `fly-machines` mode the orchestrator reads it via the GitHub contents API (`src/repo-image.ts`); in `github-actions` mode the `claude-implement.yml` / `comment-trigger.yml` workflows read it with `gh api` from the **default branch only** (never a PR head, so a PR can't choose its own privileged image).

2. **`AI_IMPLEMENT_RUNNER_IMAGE`** — the operator/org default. A GitHub repo/org **variable** in `github-actions` mode (org-level applies to every repo); an orchestrator **env var** in `fly-machines` mode. `SESSION_IMAGE` is the deprecated former name of the env var — still honored, but the orchestrator logs a deprecation warning at startup.

3. **Upstream fallback** — `ghcr.io/builddownai/ai-implement-runner:latest` (orchestrator / comment-trigger) or `:next` (claude-implement). In `github-actions` mode a manual `runner_image` dispatch input overrides everything for that one run.

The `github-actions` allowlist auto-trusts `ghcr.io/builddownai/` and the repo owner's own `ghcr.io/<owner>/` namespace, so a fork using its own published image needs no extra config; `AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES` is only for third-party registries. The `fly-machines` path validates image-reference format but has no allowlist.

The image must be publicly pullable. The customer owns building and publishing it. If `.ai-implement/image.yml` is absent, malformed, or points at an unreachable reference, resolution falls through to the next ladder rung.

This resolution applies to **both** execution modes. On the Fly Machines path the orchestrator boots the session machine on the resolved image directly. On the GitHub Actions path the orchestrator forwards the resolved image as the `runner_image` workflow_dispatch input to `claude-implement.yml` (which runs it as the job's `container.image`) — but only when the choice is explicit: a per-repo `.ai-implement/image.yml` override, or an explicitly-set `SESSION_IMAGE`. When neither is set the orchestrator sends no `runner_image`, so the workflow keeps its own resolution order (the `AI_IMPLEMENT_RUNNER_IMAGE` repo/org variable, then its built-in `:latest` default) and repos that pin via that variable are not overridden.

Planning runs (`claude-plan.yml`) now run on the same runner container and honor the **same** resolution: the orchestrator forwards the resolved image as the `runner_image` workflow_dispatch input to `claude-plan.yml` under the identical "only when explicit" rule, so a testing orchestrator pinned to `:next` steers planning to `:next` and a per-repo `.ai-implement/image.yml` pin is honored for planning too. (Unlike `claude-implement.yml`, `claude-plan.yml`'s own validate step does not read `image.yml`, so orchestrator-forwarding is the only path by which GHA planning picks up either — and a target repo must have **re-synced `claude-plan.yml`** before the orchestrator will forward `runner_image` to it, otherwise GitHub rejects the dispatch with "unexpected inputs", the same caveat as the run-caps and branch-prefix inputs.)

The default runner image itself must also be public on GHCR — Fly pulls anonymously, so a private package surfaces as `failed to get manifest ... unauthorized` at machine-create time. New GHCR packages default to Private and the org must allow public container packages first (Org Settings → Packages). See the comment at the top of `.github/workflows/build-runner.yml`.

Runner image channels:

- `ghcr.io/builddownai/ai-implement-runner:latest` is published from `main` and is the stable default for production orchestrators and synced target-repo workflows.
- `ghcr.io/builddownai/ai-implement-runner:next` is published from `testing` and is intended for staging/testing orchestrators. Set `SESSION_IMAGE=ghcr.io/builddownai/ai-implement-runner:next` in that orchestrator environment to keep it paired with the testing runner.
- Commit SHA tags are pushed first, then the build digest is smoke-tested before any mutable channel is promoted. Use the immutable digest for the strongest rollback pin; the SHA tag is a convenient lookup tag for the same build.
- Channel-scoped date/debug tags are promoted only after the digest image passes smoke testing. They use `base-<channel>-vYYYYMMDD-<12-char-sha>` (for example, `base-next-v20260526-abc123def456`) so `latest` and `next` builds do not collide and same-day builds do not overwrite each other.
- Cancelled or failed runs can leave SHA-only images with no channel pointer. That is intentional fail-closed behavior; clean old SHA-only images through GHCR retention/cleanup rather than relying on mutable channel tags for retention.

Typical custom-image use: your repo needs a language runtime or tool that isn't in the base image (e.g. terraform, ruby, go). Build an image `FROM` the channel that matches your orchestrator (`latest` for production, `next` for testing), add your tools, push, and point `image.yml` at it.

## Multi-client deploy

Each client is a separate Fly.io app, defined by a file in `clients/<slug>.toml`. The `deploy-clients.yml` workflow reads these files and deploys each app in a matrix on every push to `main`.

### Onboarding a new client

```bash
# Guided interactive setup:
./scripts/provision-client.sh <client-slug>

# Or manually:
cp clients/example-client.toml clients/<slug>.toml
# Edit the file, then:
fly apps create <app_name> --org <org>
fly volumes create dedup_data --size 1 --region iad --app <app_name>
fly secrets set LINEAR_API_KEY=... GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY=... --app <app_name>
```

Then commit `clients/<slug>.toml` and push — the workflow deploys all clients automatically using the single `FLY_API_TOKEN` org secret.

### Fly.io commands

```bash
fly deploy --remote-only --app <app_name>   # manual deploy
fly secrets set KEY=value --app <app_name>  # set secrets
fly logs --app <app_name>                   # tail logs
fly ssh console --app <app_name>            # shell into machine
```

The Fly volume `dedup_data` is mounted at `/data` for persistent SQLite storage.
