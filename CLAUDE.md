# AI-Implement — Codebase Guide

## Branching

**All PRs target `testing`, not `main`.** `testing` is the integration branch; `main` is downstream and updated separately. When you branch for new work, base off `testing` and open the PR against `testing`. Comparison URLs and `gh pr create --base` should both use `testing`.

## What this is

A Node.js service that polls Linear for issues labeled "AI-Implement" and dispatches GitHub Actions workflows that run Claude Code to implement them. It also provides an admin UI and manages workflow templates synced to target repos.

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

clients/            — one .toml per deployed client
  example-client.toml  — copy this to onboard a new client

scripts/
  provision-client.sh  — interactive client onboarding helper

.github/workflows/
  deploy-clients.yml — matrix deploy to all clients on push to main
  sync-workflow.yml  — sync workflow templates to target repos
  claude-review.yml  — Claude reviews PRs (auto for same-repo, /claude-review for forks)
  build-runner.yml   — build and push the session runner image to GHCR
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
| `AGENTICA_API_KEY` | No | Symbolica agentica API key. Plumbed through to the runner so target-repo code can `from agentica import spawn`. See [docs/AGENTICA.md](docs/AGENTICA.md). |
| `NOTIFY_TYPE` | No | `slack` (default) or `teams` |
| `NOTIFY_WEBHOOK_URL` | No | Webhook URL; notifications skipped if unset |
| `ADMIN_ACCESS_CODE` | No | Admin UI password; UI disabled if unset |
| `DEDUP_DB_PATH` | No | SQLite path (default `/data/dedup.sqlite`) |
| `POLL_INTERVAL_MS` | No | Poll interval ms (default `60000`) |
| `PORT` | No | HTTP port (default `8080`) |

## Adding a new target repo

1. Add the team→repo mapping in the admin UI at `/admin`
2. Install the GitHub App on the target repo
3. Click **Sync workflows** on that project row — the orchestrator opens or updates a PR in the target repo with workflow files and starter prompt templates
4. Merge the PR in the target repo
5. Enable "Allow GitHub Actions to create and approve pull requests" in the target repo settings

The GitHub App must have **workflows** permission in addition to **contents** permission. GitHub rejects writes under `.github/workflows/` without it, so the Sync workflows action will fail before opening or updating the target-repo PR.

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
- **Comment trigger** — `/ai-implement` on a PR kicks off a gap-fill run
- **Triple auth** — bedrock (when orchestrator sets `provider=bedrock`), OAuth (`CLAUDE_CODE_OAUTH_TOKEN`), or API key (`ANTHROPIC_API_KEY`)

`workflows/claude-plan.yml` is the planning workflow synced to target repos. It runs read-only codebase analysis and posts structured planning comments to Linear when dispatched. It supports:
- **PLANNING.md** — per-repo Claude prompt template; front matter carries `model:` (same rules as WORKFLOW.md)

The Projects page **Sync workflows** action always syncs `claude-implement.yml`, `comment-trigger.yml`, and `claude-plan.yml` into the target repo. It seeds `WORKFLOW.md` and `PLANNING.md` once and never overwrites them (each repo owns its own prompt templates after initial setup). `.github/workflows/sync-workflow.yml` remains as a manual fallback, but normal distribution should happen from the orchestrator.

### Model IDs are passed through verbatim

Neither workflow validates model IDs — whatever `model:` says in front matter goes directly to `claude-code --model`. This lets new Anthropic releases and Bedrock IDs (`anthropic.<name>-<date>-v1:0` or inference-profile ARNs) flow without a workflow template edit. Typos fail fast at Claude invocation time with a clear error. The seed `WORKFLOW.md` / `PLANNING.md` ship with `model: claude-sonnet-4-6`, so fresh target repos work out of the box on the Anthropic provider.

### Using AWS Bedrock

To run a target repo against AWS Bedrock instead of the Anthropic API:

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

The workflow re-runs `aws-actions/configure-aws-credentials` before each Bedrock action step (once before the main implementation run, once before gap analysis) so the STS session token doesn't expire during long runs. Only OIDC is supported — there is no static-key path.

## Custom extensions

Client forks can override built-in behaviour without touching upstream code by placing files under `custom/`. A file at `custom/<path>` takes precedence over the corresponding built-in.

Resolution is handled by two functions in `src/pipeline/resolve-module.ts`:

| Function | Use case | Return value |
|----------|----------|--------------|
| `resolveModule(path)` | YAML and template files | Absolute filesystem path |
| `resolveModuleImport<T>(path)` | TypeScript/JavaScript modules | `default` export, or `null` if no override |

Both check `custom/<path>` (relative to `process.cwd()`) first, then fall back to the built-in package root. There is no per-type discovery logic — the same two functions cover all extension points.

### Extension points

**`custom/pipelines/`** — Override a pipeline YAML definition. Example: place `custom/pipelines/autonomous.yml` to replace the built-in autonomous loop.

**`custom/steps/`** — Override a built-in step module. A file `custom/steps/<id>.ts` replaces the step registered under that key. It must export a `StepModule` as its default export. Built-in step keys: `clone`, `install`, `feedback-loop`, `preflight`, `push`.

**`custom/providers/`** — Reserved for provider overrides (TicketingProvider interface). Provider loading will call `resolveModuleImport("providers/<id>")`.

### Rules

- The orchestrator **never** overwrites any file under `custom/` except `custom/README.md`.
- A CI check (`protect-custom.yml`) rejects upstream PRs that touch other `custom/` files.
- When implementing client-specific behaviour, **always place new files in `custom/`** rather than modifying built-in modules — this keeps the fork rebasing cleanly on upstream changes.
- A `custom/` file that exists but has no `default` export produces a warning and falls back to the built-in rather than silently misbehaving.

## Per-repo runner image override

A target repo can boot its Fly Machine session on a custom runner image by committing `.ai-implement/image.yml` at the default branch:

```yaml
image: ghcr.io/your-org/your-runner:v1
```

The image must be publicly pullable. The customer owns building and publishing it. If the file is absent, malformed, or points at an unreachable reference, the orchestrator falls back to the default runner (`SESSION_IMAGE` env var, or `ghcr.io/builddownai/ai-implement-runner:latest`).

The default runner image itself must also be public on GHCR — Fly pulls anonymously, so a private package surfaces as `failed to get manifest ... unauthorized` at machine-create time. New GHCR packages default to Private and the org must allow public container packages first (Org Settings → Packages). See the comment at the top of `.github/workflows/build-runner.yml`.

Typical use: your repo needs a language runtime or tool that isn't in the base image (e.g. terraform, ruby, go). Build an image `FROM` the published base `ghcr.io/builddownai/ai-implement-runner:latest`, add your tools, push, and point `image.yml` at it.

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
