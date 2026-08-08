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
    ↓ /ai-implement comment → orchestrator webhook (POST /api/github/webhook)
Gap-fill run dispatched via orchestrator poll loop
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
  mcp.ts            — OAuth-authenticated MCP proxy to KG sidecar
  mcp-oauth.ts      — RFC 6749 authorization server for /mcp (client reg, PKCE, token exchange)
  oauth/            — OIDC engine + shared admin-UI and MCP login routes
  __tests__/        — Vitest unit tests

workflows/          — templates synced to target repos
  claude-implement.yml
  comment-trigger.yml    — legacy comment trigger (kept for legacy-generation repos; removed from envelope repos by sync)
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

docker-entrypoint.sh  — container entrypoint: starts KG sidecar on loopback before Node
kg/                   — KG sidecar artifacts (manually populated pre-build; see "KG sidecar")
  .gitkeep            — placeholder; replaced with actual server code + snapshot artifacts
```

## Running locally

```bash
cp .env.example .env   # fill in LINEAR_CLIENT_ID + LINEAR_CLIENT_SECRET, GITHUB_PAT
npm install
npm run dev            # runs src/index.ts via tsx
npm run dev:local      # rebuilds local session image, then runs local Docker jobs
```

Health check: `curl http://localhost:8080/`
Admin UI: `http://localhost:8080/admin` (requires an OAuth provider configured **or** ADMIN_ACCESS_CODE set)

## Local dev harness

`npm run dev:run` launches a single runner container directly against a local target-repo checkout — no orchestrator, no poll loop, no tracker. Ideal for iterating on `WORKFLOW.md` and `setup:` hook scripts.

```bash
npm run dev:run -- --workspace ../target-repo --task task.md
```

**Task file format** (`task.md`):
```markdown
---
identifier: PROJ-123   # optional; defaults to DEV-<timestamp>
title: Add login        # required
maxTurns: 30            # optional
maxIterations: 2        # optional
repo: owner/repo        # optional; auto-detected from git remote
branch: main            # optional; auto-detected from current HEAD
---

Issue description / implementation instructions go here.
```

**How it works:**
- `--workspace <dir>` bind-mounts the local checkout at `/workspace` inside the container.
- The clone step detects `AI_IMPLEMENT_WORKSPACE_MODE=mounted` and skips `git fetch/reset` entirely, so uncommitted edits to `WORKFLOW.md` and hook scripts take effect immediately.
- Mounted mode **never pushes** — the push step is a no-op whenever `AI_IMPLEMENT_WORKSPACE_MODE=mounted`. The mount is your live checkout, dirty by design (the uncommitted `WORKFLOW.md`/hook edits under test), so a push would sweep in-progress work into the commit. The mutated working tree is left in the mount for inspection with `git diff`; commit/push the parts you want to keep yourself.
- Logs are streamed to the terminal in real time. Per-run artifacts (log, diff, telemetry) are saved to `.dev-runs/<timestamp>/` (gitignored).

**Library API** (for programmatic use or a future MCP wrapper — `src/dev-harness/`):
```typescript
import { startDevRun, streamLogs, getRunResult, collectRunArtifacts } from "./src/dev-harness/index.js";
const handle = await startDevRun({ workspace, task });
await streamLogs(handle, console.log);
const result = await getRunResult(handle);
await collectRunArtifacts(handle, result.exitCode);
```

**Artifacts per run** (`.dev-runs/<timestamp>/`):
- `run.log` — full container output
- `changes.diff` — `git diff` of the mounted workspace after the run
- `diffstat.txt` — `git diff --stat` summary
- `telemetry.json` — exit code, timing, issue metadata

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
| `settings` | Key-value store — runner mode, Fly session config, deploy-notification state |
| `mcp_clients` | MCP OAuth — registered clients (RFC 7591 dynamic registration) |
| `mcp_oauth_states` | MCP OAuth — in-flight OIDC transactions (10-minute TTL) |
| `mcp_auth_codes` | MCP OAuth — short-lived authorization codes (5-minute TTL) |
| `mcp_tokens` | MCP OAuth — issued Bearer access tokens (1-hour TTL) |

`dedup.ts` owns the DB singleton (`getDb()`). All other modules import `getDb` from `dedup.ts`.

## Key environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_CLIENT_ID` | Yes | Linear OAuth app client ID (client-credentials grant) |
| `LINEAR_CLIENT_SECRET` | Yes | Linear OAuth app client secret |
| `GITHUB_APP_ID` | Yes | GitHub App numeric ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes | GitHub App RSA private key (PEM, `\n`-escaped) |
| `NOTIFY_TYPE` | No | `slack` (default) or `teams` |
| `NOTIFY_WEBHOOK_URL` | No | Webhook URL; notifications skipped if unset |
| `ADMIN_ACCESS_CODE` | No | **Deprecated** admin-UI password fallback (prefer SSO below). UI is enabled if this **or** any OAuth provider is set. |
| `OAUTH_REDIRECT_BASE_URL` | No | Base URL for OAuth redirect URIs (`https://<app>.fly.dev`; `http://localhost:8080` locally) |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | No | Google OIDC credentials — enables the Google SSO button |
| `MICROSOFT_OAUTH_CLIENT_ID` / `MICROSOFT_OAUTH_CLIENT_SECRET` / `MICROSOFT_OAUTH_TENANT` | No | Microsoft (Entra) OIDC credentials; `_TENANT` is the directory (tenant) ID |
| `OAUTH_ALLOWED_DOMAINS` / `OAUTH_ALLOWED_EMAILS` | No | Comma-separated allowlist; a verified identity must match a domain or email (fail-closed) |
| `KG_SIDECAR_URL` | No | URL of the private KG sidecar (streamable-HTTP MCP transport), e.g. `http://127.0.0.1:8765/mcp`. Unset → 503 on `/mcp`. The sidecar should be reachable only from loopback; the orchestrator proxies auth-verified requests verbatim and strips the `Authorization` header before forwarding. |
| `DEDUP_DB_PATH` | No | SQLite path (default `/data/dedup.sqlite`) |
| `POLL_INTERVAL_MS` | No | Poll interval ms (default `60000`) |
| `PORT` | No | HTTP port (default `8080`) |
| `AI_IMPLEMENT_LOG_LEVEL` | No | Runner log verbosity: `summary` (default) or `stream`. `stream` tees per-turn tool activity to the log. Telemetry (turns/cost/tokens/outcome) is captured at both levels. |

## KG sidecar and MCP endpoint

The orchestrator bundles a Python-based KG (knowledge-graph) sidecar that serves `kg_*` tools. MCP clients (e.g. Claude Code) reach those tools via the orchestrator's `/mcp` endpoint — an OAuth-authenticated proxy implemented in `src/mcp.ts`. The sidecar is started by `docker-entrypoint.sh` on `127.0.0.1:8765` before Node, then `KG_SIDECAR_URL` is exported so `src/index.ts` picks it up automatically. Sidecar failure (crash, timeout, absent artifacts) is **non-fatal**: the orchestrator boots normally and `/mcp` returns 503; all other routes are unaffected.

### Single-machine deploy shape

The sidecar runs **inside** the orchestrator container on loopback — no separate service, no public port. `docker-entrypoint.sh` starts the sidecar, polls `http://127.0.0.1:8765/mcp` for up to 30 s, and exports `KG_SIDECAR_URL=http://127.0.0.1:8765/mcp` if it becomes ready. Node then starts with that variable already set. For local dev (`npm run dev`), start the sidecar manually and set `KG_SIDECAR_URL` in `.env`; or leave it blank (no `/mcp`).

### MCP OAuth flow

The `/mcp` endpoint returns 401 with `WWW-Authenticate` pointing to `/.well-known/oauth-protected-resource`. A compliant MCP client discovers the authorization server from there and completes the RFC 6749 authorization code + PKCE flow implemented in `src/mcp-oauth.ts`:

| Endpoint | Purpose |
|----------|---------|
| `POST /mcp/register` | RFC 7591 dynamic client registration — returns `client_id` |
| `GET /mcp/authorize` | Start PKCE auth flow → delegates to configured OIDC provider |
| `GET /mcp/callback/{provider}` | OIDC callback — applies allowlist, mints 5-min auth code |
| `POST /mcp/token` | Exchange auth code + PKCE verifier for a 1-hour Bearer token |
| `GET /.well-known/oauth-protected-resource` | RFC resource metadata — points clients to the AS |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 AS metadata |

Authorization is **fail-closed**: a verified identity must pass the same `OAUTH_ALLOWED_DOMAINS` / `OAUTH_ALLOWED_EMAILS` allowlist as the admin UI. Tokens live 1 hour; the client re-authenticates after expiry.

**Configuring MCP OAuth** — register two additional redirect URIs in the OIDC provider consoles (alongside the admin-UI redirect URIs):
- `${OAUTH_REDIRECT_BASE_URL}/mcp/callback/google`
- `${OAUTH_REDIRECT_BASE_URL}/mcp/callback/microsoft`

`OAUTH_REDIRECT_BASE_URL` and at least one OIDC provider must be configured; `/mcp/authorize` returns 503 when neither is set.

### Decision (a) — base image

`Dockerfile` uses `node:24-slim` (Debian bookworm) instead of `node:24-alpine`. fastembed and onnxruntime ship pre-built glibc wheels; Alpine's musl libc makes those wheels fail to install without a full from-source build. Slim costs ~30 MB more but makes the sidecar viable without cross-compilation.

### Decision (b) — KG artifact acquisition via BuildKit build secret (fail-soft)

The KG repository is private. A **BuildKit `--build-secret` mount** clones it at build time. The token is only readable inside the mounted `RUN` layer and is never written to `ARG`, `ENV`, or image history.

**Build with the KG sidecar enabled** (requires a GitHub token with read access to `BuildDownAI/knowledge-graph-ai-implement`):

```bash
# Local Docker build:
docker build --secret id=kg_token,env=GH_TOKEN .

# Fly deploy (the standard command for testing/production):
#   --no-cache is REQUIRED: a --build-secret is NOT part of the layer cache key,
#   so without it a repeat deploy silently reuses a stale (possibly sidecar-less)
#   image and the clone/materialize RUN never re-executes.
#   Also: export GH_TOKEN first — `GH_TOKEN=... fly deploy ... "$GH_TOKEN"` does
#   NOT work (the inline prefix doesn't affect same-line expansion → empty secret).
export GH_TOKEN="$(gh auth token)"
fly deploy --remote-only --no-cache --build-secret kg_token="$GH_TOKEN"
```

The sidecar clone copies the KG's `sources.yml` (which pins the IRI `namespace:`)
alongside the code — without it the server falls back to the placeholder
namespace and every type-filtered `kg_*` tool silently returns empty (the graph
loads, but queries match nothing). Verify a deploy with a real query
(`kg_search` returns non-empty), not just that `/mcp` answers.

**Build without the KG sidecar** (sidecar-less / degraded — `/mcp` returns 503, all other routes remain healthy):

```bash
docker build .
fly deploy --remote-only
```

When the `kg_token` secret is absent or empty the build succeeds and logs `[kg] sidecar-less build`. The entrypoint skips sidecar startup and the orchestrator boots normally.

**When testing moves to Fly native auto-deploy (AII-256):** the build secret must be configured in that deploy path (e.g. as a Fly build secret or CI secret) so automated deployments continue to produce sidecar-enabled images.

`kg/` is excluded from workflow sync and never copied to target repos. The `kg/.gitkeep` placeholder remains in git; the actual KG code and snapshot are cloned at build time and never committed. After the venv install, the Dockerfile performs three distinct build steps:

1. **Model bake** — warms the fastembed model (`BAAI/bge-small-en-v1.5`) into a baked cache at `FASTEMBED_CACHE_PATH=/app/kg/.fastembed-cache`. This eliminates network fetches at runtime: the query-embedding path reads the baked cache from the image. If this step fails, the build prints `[kg] WARNING: EMBEDDINGS BUILD FAILED` and continues graph-only; the sidecar starts in lexical-only mode.
2. **Graph materialize** — runs `kg_ingest.materialize --no-embed` to produce `out/graph.trig`. This step is a hard failure: a broken graph is not usable.
3. **Embed** — runs `kg_ingest.materialize` (full) using the same `FASTEMBED_CACHE_PATH`. If this step fails, the build prints `[kg] WARNING: EMBEDDINGS BUILD FAILED` and continues graph-only. A successful embed step produces `out/graph.trig` with semantic vectors; lexical-only search is the fallback if the embed step fails.

The `start.sh` script generated at build time exports `FASTEMBED_CACHE_PATH=/app/kg/.fastembed-cache` so the running sidecar also reads the baked cache rather than downloading the model on first query. `kg_hybrid_search` returns results immediately on boot without a separate data-load step. Verify a sidecar-enabled deploy by asserting `degraded:false` in a `kg_hybrid_search` response (not just that `/mcp` answers).

### Memory sizing

Fastembed embedding models load into process memory at startup. A typical small model (e.g. BAAI/bge-small-en-v1.5, ~130 MB on disk) expands to ~300–400 MB resident once loaded. Combined with the orchestrator's Node.js footprint (~100–150 MB), **256 MB Fly machines are too small** and will OOM-kill the sidecar or the orchestrator.

**Recommended minimum: 512 MB.** For comfortable headroom (larger models, concurrent requests): **1 GB.**

Update `fly.toml` before deploying a sidecar-enabled image:

```toml
[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"   # minimum with KG sidecar; 1024mb recommended
```

The `fly.toml` in this repository shows `512mb` as the base default (sufficient for sidecar-enabled deployments; sidecar-less deployments could use 256mb but 512mb is harmless). Adjust per-client in `clients/<slug>.toml`.

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

## Admin authentication

The admin UI supports **SSO via OIDC** (Google + Microsoft) with a **deprecated shared access-code** fallback. The UI is enabled when at least one is configured, and returns 503 when neither is.

- **SSO (preferred):** configure one or more providers (`GOOGLE_OAUTH_*` / `MICROSOFT_OAUTH_*`) plus `OAUTH_REDIRECT_BASE_URL`, and an allowlist (`OAUTH_ALLOWED_DOMAINS` / `OAUTH_ALLOWED_EMAILS`). Sign-in yields an httpOnly session cookie; authorization is **fail-closed** against the email/domain allowlist — a verified `email` must match `OAUTH_ALLOWED_EMAILS`, or its domain must match `OAUTH_ALLOWED_DOMAINS`. The session stores the provider's stable `sub` as its identity reference (email is mutable). Claims are normalized across providers in `src/oauth/oidc.ts`.
- **Access code (deprecated):** `ADMIN_ACCESS_CODE` remains for local dev/bootstrapping. It uses a timing-safe compare and logs a deprecation warning on each use.

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

Six routes (`channels`, `policies`, `secrets`, `mcp`, `webhooks`, `updates`) are still stubbed in `src/admin-ui/pages/stubs.ts` with "Coming soon" placeholders (badged "Not implemented yet" or "Partially implemented") that explain what exists today and link to the related built pages.

## Backend outage playbook (runner-mode failover)

When GitHub Actions (or Fly) is degraded, the global **runner mode** is the failover lever: `/admin#runners` (or `POST /api/runner-mode`) with `fly` forces every new dispatch onto Fly Machines; `gha` forces GitHub Actions; `default` restores per-project modes. In-flight runs keep their monitors — only new dispatches reroute.

- **Prerequisite for `fly`:** the orchestrator must have a Fly session backend (`FLY_SESSIONS_APP` + Fly API token) and the mapping must be Fly-capable. **Ineligible mappings are skipped at dispatch** (provider=`bedrock` is GHA-only; no sessions app configured) — they stay queued, dedup untouched, with one log line per poll, and are listed in the Runners-page override banner and the `GET /api/runner-mode` response (`ineligible`).
- Every mode change is logged (`old → new`) and fires a plain-text notification when `NOTIFY_WEBHOOK_URL` is set.
- Flip back to `default` after the outage; skipped issues dispatch normally on the next poll.

## Notification adapter

`src/notify.ts` exports a single `notify(type, webhookUrl, notification)` function. Set `NOTIFY_TYPE=slack` or `NOTIFY_TYPE=teams` to switch providers. Adding a new provider means adding a private function in `notify.ts` and a new case in the switch.

The orchestrator also announces its own deploys. On shutdown it posts an `@channel` heads-up that dispatches are pausing; on the next boot it compares `FLY_IMAGE_REF` against the value it stored in the `settings` table and posts either "redeployed" (the image changed) or "restarted" (it did not), with how long it was down. A first boot on a fresh volume records the reference silently.

Both notices are gated on `FLY_IMAGE_REF`, which only exists inside a Fly Machine — local runs never post. Failures are logged and swallowed, and the shutdown notice is bounded to a fraction of the shutdown budget so it cannot outlive `kill_timeout`.

## Workflow templates

`workflows/claude-implement.yml` is the main implementation workflow synced to target repos. It supports:
- **WORKFLOW.md** — per-repo Claude prompt template; front matter carries `model:` (required for bedrock, defaults to `claude-sonnet-4-6` for anthropic) and optional `gap_analysis_model:`
- **Gap analysis** — secondary Claude invocation after each PR
- **Unapproved runs → draft PR** — when the implement/review feedback loop exhausts its iterations (or a pass hits the hard `max_turns` cap) without reviewer approval, the pipeline still pushes the working tree and opens a **draft PR** whose body carries the reviewer's final feedback, per-pass turn/cost stats, and (on `max_turns`) a read-only post-mortem. The runner reports the run as a coded failure (`REVIEW_UNAPPROVED` or `MAX_TURNS_EXHAUSTED`, with the draft-PR URL) so the ticket is updated and notifications fire; a run-autopsy comment is posted to the ticket; the GHA job stays green with a `::warning::` annotation. If the repo plan rejects draft PRs (422), the PR is opened normally with the title prefix `[NEEDS REVIEW — unapproved]`.
- **Comment trigger** — a PR comment that **starts with** `/ai-implement` on an envelope-generation repo is handled by the orchestrator webhook (`POST /api/github/webhook`). The orchestrator verifies the commenter has write/maintain/admin permission on the repo, posts a 👀 reaction as acknowledgement, and enqueues a gap-fill dispatch that runs through the same unified dispatch path as orchestrator-initiated runs. Any text after the `/ai-implement` token is forwarded as an operator instruction (rides `run_config.commentInstruction`). `/ai-implementfoo` and comments that merely contain the token mid-text do not fire. Legacy repos (whose `claude-implement.yml` does not have a `run_config:` input) are silently ignored by the webhook; they continue to use `comment-trigger.yml` if it is still present in the target repo.
- **Triple auth** — bedrock (when orchestrator sets `provider=bedrock`), OAuth (`CLAUDE_CODE_OAUTH_TOKEN`), or API key (`ANTHROPIC_API_KEY`)
- **setup / verify / teardown hooks** — `WORKFLOW.md` front-matter keys `setup:` / `verify:` / `teardown:` are paths (relative to repo root) to shell scripts that the runner now executes: `setup` before the implement loop (its failure aborts the run early), `verify` after a successful push, and `teardown` always (even on failure, via a `finally` in the runner). Scripts run with `set -euo pipefail`; env vars a setup script appends via `echo "VAR=value" >> "$GITHUB_ENV"` are visible to Claude and to the verify/teardown scripts (the runner manages `$GITHUB_ENV` across all execution modes). Repos with no hooks behave exactly as before.

### Operational prerequisites (webhook-based /ai-implement)

The orchestrator handles `/ai-implement` PR comments directly via `POST /api/github/webhook`. Three prerequisites must be met before comment-triggered gap-fill runs work for a repo:

- **GitHub App subscribed to `issue_comment`** — add `issue_comment` to the App's webhook event subscriptions (GitHub App settings). Without this, comment events are never delivered.
- **`GITHUB_WEBHOOK_SECRET` set** — the orchestrator verifies HMAC-SHA256 signatures on every delivery; set the same secret value in both the App webhook configuration and the orchestrator's environment. Deliveries with an invalid or missing signature are rejected 401.
- **Orchestrator publicly reachable** — Fly deployments expose a public HTTPS endpoint by default. For local development, a tunnel is required (see [AII-115](https://linear.app/eudoxus/issue/AII-115)); the orchestrator must be reachable from GitHub's webhook IPs.
- **Envelope-generation target repo** — only repos whose `claude-implement.yml` has a `run_config:` input receive orchestrator-dispatched gap-fill runs. Legacy repos are silently ignored; they still use `comment-trigger.yml` if present.

### Workflow envelope (run_config)

`claude-implement.yml` exposes 7 top-level `workflow_dispatch` inputs. All issue fields, caps, branchPrefix, skillsRepo, sensitiveFiles, profiles, and planningContext ride inside the single `run_config` JSON blob (base64-encoded `RunConfigV1`); the remaining six inputs stay top-level because the workflow must `::add-mask::` or evaluate them before unpacking the envelope.

| Input | Required | Notes |
|-------|----------|-------|
| `run_config` | Yes | Base64-encoded `RunConfigV1` JSON envelope |
| `runner_image` | No | Container image override (allowlist-validated) |
| `job_timeout_minutes` | No | GHA job timeout in minutes (empty = 90) |
| `provider` | No | `anthropic` (default) or `bedrock` |
| `aws_region` | No | Required when `provider=bedrock` |
| `run_token` | No | HMAC bearer token for result callback; empty skips callback |
| `run_progress_token` | No | HMAC bearer token for progress callbacks |

**`RunConfigV1` schema** — fields carried inside the envelope:

| Field | Type | Notes |
|-------|------|-------|
| `v` | `1` | Version discriminant (must be 1) |
| `issue` | `{ id, identifier, title, description }` | Required; description capped at 40,000 chars |
| `prNumber` | string? | PR number for gap-fill or review passes |
| `baseBranch` | string? | Feature-branch parent or repo default |
| `runnerPhase` | `"implementation" \| "gap-analysis" \| "planning"` | Dispatch phase |
| `branchPrefix` | string? | Optional path-segment prefix for the implementation branch |
| `skillsRepo` | string? | Owner/repo or git URL for per-project skills |
| `runnerCallbackUrl` | string? | Orchestrator callback URL for result posts |
| `maxTurns` | number? | Claude turn cap |
| `maxIterations` | number? | Implement/review cycle cap |
| `commentInstruction` | string? | Operator instruction from `/ai-implement` comment |
| `sensitiveFiles` | `{ add?: string[], allow?: string[] }` | Envelope-only guardrail config |
| `profiles` | string[]? | Jira AI-Implement Profiles values |
| `planningContext` | `{ parent?, siblings?, dependencies? }` | Planning context for child issues |

**Dual-mode probe** — before every dispatch the orchestrator fetches the target repo's `claude-implement.yml` from the default branch and checks for a `run_config:` input declaration. If found, it uses the 7-input envelope contract; if not (or on any fetch error), it falls back to legacy per-field inputs. The probe result is cached per repo/workflow for 5 minutes (`CACHE_TTL_MS = 300_000`).

**Migration (re-sync once, then never again)** — a target repo migrates from the legacy contract to the envelope by running **Sync workflows** once. After the sync PR merges, all subsequent dispatches use the 7-input envelope automatically. No orchestrator restart or config change is needed.

For the existing per-feature "must re-sync first" caveats: **legacy repos** continue to receive caps, branchPrefix, skillsRepo, and profiles as individual dispatch inputs (unchanged behavior); **envelope repos** carry all of these inside `run_config` and never see them as separate inputs.

### Per-project run caps (admin UI)

Each project's mapping carries three optional caps, editable in the `/admin` Projects edit dialog (blank = use the default):

| Field | Default when blank | Applies to |
|-------|--------------------|------------|
| **Max Turns** | `50` | Claude turns per implement pass (both providers) |
| **Max Iterations** | bedrock `2`, anthropic `3` | implement/review cycles in the feedback loop |
| **Job Timeout (min)** | `90` | GitHub Actions job `timeout-minutes` (GHA mode only) |

`maxTurns`/`maxIterations` ride in `run_config` for envelope repos, or reach the runner as individual `workflow_dispatch` inputs for legacy repos (GHA) / runner env (Fly/local). `maxJobMinutes` is always a separate GHA `job_timeout_minutes` dispatch input. Caps apply to gap-fill and review-feedback re-dispatches, not just the initial run. For envelope repos, `/ai-implement` webhook-triggered gap-fill runs go through the orchestrator and inherit the same mapping caps automatically.

> **Deprecated (legacy repos only):** `AI_IMPLEMENT_MAX_TURNS`, `AI_IMPLEMENT_MAX_ITERATIONS`, `AI_IMPLEMENT_MAX_JOB_MINUTES` — repo variables read by `comment-trigger.yml` to cap comment-triggered gap-fill runs on legacy-generation repos. Still honored where `comment-trigger.yml` is present. Not needed for envelope repos.
>
> **Deprecated (legacy repos only):** `AI_IMPLEMENT_SKILLS_REPO` — repo variable that mirrored the per-project skills field for legacy `comment-trigger.yml` runs. Skills repo rides `run_config.skillsRepo` for envelope repos.

### Per-project branch prefix (admin UI)

Each project's mapping carries an optional **Branch Prefix** (blank = none, the default). When set, it is prepended as a path segment to the implementation branch name: with prefix `pr`, a branch that would be `ai-implement/PROJ-123-add-login` becomes `pr/ai-implement/PROJ-123-add-login`. Each `/`-separated segment of the prefix must start with a letter or digit and may otherwise contain only letters, digits, `.`, `_`, `-` (no `..` or `//`, ≤ 64 chars); the admin API rejects anything else.

The prefix only affects the **initial orchestrator-driven run** — `/ai-implement` webhook-triggered gap-fill runs commit to the existing PR branch and are unaffected. For envelope repos, the prefix rides `run_config.branchPrefix`; for legacy repos, it is sent as a separate `branch_prefix` dispatch input (only when set — a legacy repo must have re-synced `claude-implement.yml` before setting a prefix, or GitHub rejects the dispatch with "unexpected inputs").

### Jira: AI-Implement Profiles field (multi-select)

When using the Jira provider, the orchestrator reads a multi-select custom field to populate `TicketIssue.profiles` on each dispatched issue. The field is discovered by name at runtime — **it must be named exactly `AI-Implement Profiles`** in your Jira instance for auto-discovery to work. If the field is absent the orchestrator logs a warning and continues without populating profiles (it does not fail).

If the field exists under a different name, or if multiple fields share the same name, set `profilesFieldOverride` to the explicit `customfield_NNNNN` ID — via the **Profiles Field** dropdown in the `/admin` Projects edit dialog or the add-project wizard's Jira step, or directly on the mapping's `ticketingConfig` through the API. When all three overrides (`statusFieldOverride`, `repoFieldOverride`, `profilesFieldOverride`) are set, the orchestrator skips the `listFields` call entirely.

At implementation-dispatch time the orchestrator embeds the issue's profiles (comma-joined) in `run_config.profiles` for envelope repos, or as a `profiles` workflow_dispatch input for legacy repos (only sent when non-empty; a legacy repo must have re-synced before setting profiles, or GitHub rejects the dispatch). Profile option names must not contain commas — the forwarding contract is a comma-joined list. The runner parses the value into `ctx.data.profiles`; **no built-in pipeline step consumes it** — it is the contract surface for image-baked `custom/` steps which branch their setup on the selected profiles. Profiles are per-issue: `/ai-implement` webhook-triggered gap-fill runs and review-feedback re-dispatches run without profiles (the initial profile-aware run already produced the PR they amend).

### Runner log verbosity

`AI_IMPLEMENT_LOG_LEVEL` controls how much the runner logs during an implement pass:
- `summary` (default): logs a single result line per Claude invocation — outcome (incl. `max_turns`), turns, duration, cost (when reported), tokens.
- `stream`: additionally tees each per-turn tool call (name + truncated input; not tool output) to the log.

Set it as a repository or organization **variable** (Settings → Secrets and variables → Actions → Variables), mirroring `AI_IMPLEMENT_PROVIDER`. It is read inside the runner container, so it applies to both orchestrator-initiated and `/ai-implement` comment-triggered runs **after the target repo has re-synced `claude-implement.yml`**. It is not a per-project admin field and not a dispatch input.

### Runner label (GHA mode)

`AI_IMPLEMENT_RUNNER_LABEL` overrides the `runs-on` label for the `implement` job, defaulting to `ubuntu-latest`. Default GitHub-hosted runners are 2 vCPU; the test suites Claude runs during implement (and the verify-hook gauntlet) are CPU-bound and scale ~linearly with cores, so pointing this at a larger-runner label (e.g. `ubuntu-latest-4-cores`) roughly halves the implement job's wall-clock.

Set it as a repository or organization **variable** (Settings → Secrets and variables → Actions → Variables), like `AI_IMPLEMENT_LOG_LEVEL`. It only affects the GitHub Actions execution mode and only after the target repo has re-synced `claude-implement.yml`. It takes a single label string, not a label array. Granting write access to this variable lets the holder retarget the job to an arbitrary (e.g. self-hosted) runner that would see the job's secrets — the same threat model as any org-variable-controlled `runs-on`.

### Sensitive files (admin UI)

Each project's mapping carries two optional glob-list fields, editable in the `/admin` Projects edit dialog:

| Field | Effect |
|-------|--------|
| **Sensitive Add Globs** | Extends the built-in sensitive-file blocklist with additional picomatch glob patterns. Files matching these patterns cause the push step to abort with a `SENSITIVE_FILES_BLOCKED` error. |
| **Sensitive Allow Globs** | Explicitly un-blocks files that would otherwise match. Allow wins over both the built-in list and any Add glob — if a file matches an allow glob, the push step never blocks it regardless of other patterns. |

These globs are delivered **exclusively via the `run_config` envelope** (`sensitiveFiles.add` / `sensitiveFiles.allow`). They are not sent as legacy dispatch inputs. A project using sensitive file globs must therefore have re-synced `claude-implement.yml` to envelope generation before setting these fields.

`workflows/claude-plan.yml` is the planning workflow synced to target repos. It runs read-only codebase analysis and posts structured planning comments to Linear when dispatched. It supports:
- **PLANNING.md** — per-repo Claude prompt template; front matter carries `model:` (same rules as WORKFLOW.md)

The Projects page **Sync workflows** action syncs `claude-implement.yml` (envelope generation) and `claude-plan.yml` into the target repo, and **removes** `comment-trigger.yml` from the target repo (the orchestrator webhook now handles `/ai-implement` comments for envelope repos). It seeds `WORKFLOW.md` and `PLANNING.md` once and never overwrites them. The `custom/` directory is an AI-Implement fork-local extension point; workflow sync never creates or modifies it in a target repository. `.github/workflows/sync-workflow.yml` remains as a manual fallback, but normal distribution should happen from the orchestrator.

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

A Linear **parent issue** tagged `AI-Implement` that has `AI-Implement` children becomes a **feature node**: it owns a long-running branch `ai-implement/feature/<issue-key>` (or `ai-implement/multi-issue/<issue-key>` — selectable via an `ai-implement.yml` block in the parent's description), its labelled children PR **into that branch** (not the repo base), and the tree cascades recursively. A parent's own work is deferred until its children finish, then runs onto its own branch; completed feature branches **roll up** into their parent automatically (internal levels via a direct merge, the top of the tree as a human-reviewed `feature → base` PR).

Key labels: `AI-Implement` (trigger) → `AI-Planning` (planning in flight) → `Plan-Complete` (ready to implement) → `AI-Working` (implementing) → `Ready for Review` (PR open); the orchestrator moves the issue to Done when the PR merges (via poll detector and optional webhook; this complements any native Linear/Jira GitHub integration). A parent labelled before its children is left alone until a child is labelled (race guard).

Parts: classification + roll-up discovery in `src/providers/linear.ts`; `TicketIssue.featureBranchChain` / `FeatureNodeRollUp` in `src/providers/types.ts`; per-issue config (`ai-implement.yml` mode selector) in `src/issue-config.ts`; cascade branch creation in `src/feature-branch.ts` (`resolveBaseBranch`); roll-up in `src/merge-up.ts`; GitHub helpers in `src/github.ts`; `Plan-Complete` via `src/runner-callback.ts`; wired into the poll loop in `src/index.ts`. Jira support lives in `src/providers/jira.ts` + `src/providers/jira-hierarchy.ts` (native parent with classic Epic Link fallback; roll-up completion = native Done **or** AI-Implement Status `Merged`). **Full reference: [docs/feature-branch-grouping.md](docs/feature-branch-grouping.md).**

Operational requirements: re-sync `claude-implement.yml` to the target repo (for the `base_branch` input); a **publicly reachable** runner callback (`RUNNER_CALLBACK_BASE_URL` + `RUNNER_TOKEN_SECRET`) so planning auto-advances and the cascade self-drives; and pair the runner image with the orchestrator channel (testing → `SESSION_IMAGE=…:next`).

**Conflict recovery:** When a child PR lands dirty (merge conflicts) on its grouping branch, the cascade self-heals automatically. The orchestrator re-queues the issue through the comment-gapfill rail (a synthetic negative-`comment_id` entry, capped at 2 attempts per issue via queue accounting). On exhaustion it logs, fires the `notify` hook, and leaves the PR for a human. The conflict-classification seam is `classifyStalledChild` — it already classifies `conflict`/`blocked` merge results as recoverable conflicts; AII-263 will later extend the seam with additional stall kinds (max_turns / draft-PR stalls).

**Roll-up hold:** A grouping parent whose top-of-tree roll-up PR is open is held from dispatch (dedup untouched) until that PR merges or closes — re-dispatching such parents produced junk closing PRs / pr_not_found churn loops. Upstream of the hold, a grouping parent's closing run that exits cleanly with **no changes** is finalized (`markMerged` → merge-up opens the roll-up PR) rather than classified `pr_not_found` — the monitors mirror the runner-callback `noWork` path via the job's `grouping_parent` flag. Non-parent jobs that exit cleanly without a visible PR get a bounded grace re-check before `pr_not_found` is declared.

**Dispatch guard:** Before dispatching a same-feature-node sibling, the orchestrator checks whether its declared `Files:` paths (from the issue description) overlap with a currently in-flight sibling's paths; if they do, dispatch is deferred until the in-flight sibling completes. The check fails open — if path data is unavailable or the check errors, the sibling dispatches normally.

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

- `custom/` belongs to an AI-Implement fork, not a target repository: workflow sync never creates or overwrites it in target repos.
- Upstream changes preserve fork-owned files under `custom/`; only `custom/README.md` may be maintained upstream.
- A CI check (`protect-custom.yml`) rejects upstream PRs that touch other `custom/` files.
- When implementing client-specific behaviour, **always place new files in `custom/`** rather than modifying built-in modules — this keeps the fork rebasing cleanly on upstream changes.
- A `custom/` file that exists but has no `default` export produces a warning and falls back to the built-in rather than silently misbehaving.

## Runner image resolution

Both execution modes resolve the runner image with the same ladder, highest priority first:

1. **`.ai-implement/image.yml`** at the target repo's default branch — per-repo override:

   ```yaml
   image: ghcr.io/your-org/your-runner:v1
   ```

   In `fly-machines` mode the orchestrator reads it via the GitHub contents API (`src/repo-image.ts`); in `github-actions` mode `claude-implement.yml` reads it with `gh api` from the **default branch only** (never a PR head, so a PR can't choose its own privileged image).

2. **`AI_IMPLEMENT_RUNNER_IMAGE`** — the operator/org default. A GitHub repo/org **variable** in `github-actions` mode (org-level applies to every repo); an orchestrator **env var** in `fly-machines` mode. `SESSION_IMAGE` is the deprecated former name of the env var — still honored, but the orchestrator logs a deprecation warning at startup.

3. **Upstream fallback** — `ghcr.io/builddownai/ai-implement-runner:latest` (orchestrator / comment-trigger) or `:next` (claude-implement). In `github-actions` mode a manual `runner_image` dispatch input overrides everything for that one run.

The `github-actions` allowlist auto-trusts `ghcr.io/builddownai/` and the repo owner's own `ghcr.io/<owner>/` namespace, so a fork using its own published image needs no extra config; `AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES` is only for third-party registries. The `fly-machines` path validates image-reference format but has no allowlist.

The image should be publicly pullable for the broadest compatibility (a private image restricts you to the GitHub Actions execution mode — see "Private runner images" below). The customer owns building and publishing it. If `.ai-implement/image.yml` is absent, malformed, or points at an unreachable reference, resolution falls through to the next ladder rung.

This resolution applies to **both** execution modes. On the Fly Machines path the orchestrator boots the session machine on the resolved image directly. On the GitHub Actions path the orchestrator forwards the resolved image as the `runner_image` workflow_dispatch input to `claude-implement.yml` (which runs it as the job's `container.image`) — but only when the choice is explicit: a per-repo `.ai-implement/image.yml` override, or an explicitly-set `SESSION_IMAGE`. When neither is set the orchestrator sends no `runner_image`, so the workflow keeps its own resolution order (the `AI_IMPLEMENT_RUNNER_IMAGE` repo/org variable, then its built-in `:latest` default) and repos that pin via that variable are not overridden.

Planning runs (`claude-plan.yml`) now run on the same runner container and honor the **same** resolution: the orchestrator forwards the resolved image as the `runner_image` workflow_dispatch input to `claude-plan.yml` under the identical "only when explicit" rule, so a testing orchestrator pinned to `:next` steers planning to `:next` and a per-repo `.ai-implement/image.yml` pin is honored for planning too. (Unlike `claude-implement.yml`, `claude-plan.yml`'s own validate step does not read `image.yml`, so orchestrator-forwarding is the only path by which GHA planning picks up either — and a target repo must have **re-synced `claude-plan.yml`** before the orchestrator will forward `runner_image` to it, otherwise GitHub rejects the dispatch with "unexpected inputs", the same caveat as the run-caps and branch-prefix inputs.)

The default runner image itself must also be public on GHCR — Fly pulls anonymously, so a private package surfaces as `failed to get manifest ... unauthorized` at machine-create time. New GHCR packages default to Private and the org must allow public container packages first (Org Settings → Packages). See the comment at the top of `.github/workflows/build-runner.yml`.

### Private runner images

A private GHCR runner image is only usable in the **GitHub Actions execution mode**. The Fly Machines and local Docker backends pull the image anonymously (no credential mechanism), so a private image fails at machine-create time with `failed to get manifest ... unauthorized`. There is no workaround on those backends — choosing a private image is effectively choosing GHA mode.

On the GitHub Actions path, `claude-implement.yml` and `claude-plan.yml` authenticate the container pull with the job's `GITHUB_TOKEN`: each requests `packages: read` and passes the token through the container `credentials:` block. A bare `packages: read` is **not** enough on its own — GitHub Actions does not auto-authenticate a job-container image pull, so the `credentials:` block is what actually performs the authenticated pull.

`GITHUB_TOKEN` can only read private packages owned by the **same org/account as the target repo**. So a private runner image must live in the target repo's own org — the realistic case is a customer pinning their own private image via `.ai-implement/image.yml` (the GHA allowlist auto-trusts the owner's `ghcr.io/<owner>/` namespace, so no extra prefix variable is needed) and linking that GHCR package to the repo. The default `ghcr.io/builddownai/ai-implement-runner` image stays public precisely because a cross-org `GITHUB_TOKEN` cannot pull it; making it private would break every customer repo. A private image hosted in a *different* org requires swapping a PAT (with `read:packages` on that org) into the workflow's `credentials.password` in place of `GITHUB_TOKEN`.

Runner image channels:

- `.github/workflows/build-runner.yml` publishes the runner image to `ghcr.io/<owner>/ai-implement-runner` (the lowercased owner of the repo it runs in), so a fork's builds land in its own namespace automatically — a namespace the `github-actions` allowlist already trusts. The built-in fallback in the code and synced workflows stays `ghcr.io/builddownai/ai-implement-runner` regardless; a fork that wants its own image used must pin it via `AI_IMPLEMENT_RUNNER_IMAGE` or `.ai-implement/image.yml` rather than editing the fallback.
- The `:latest` channel is published from `main` and is the stable default for production orchestrators and synced target-repo workflows.
- The `:next` channel is published from `testing` and is intended for staging/testing orchestrators. Set the orchestrator's runner-image env var to your namespace's `:next` tag (e.g. `AI_IMPLEMENT_RUNNER_IMAGE=ghcr.io/builddownai/ai-implement-runner:next`) to keep that environment paired with the testing runner.
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
fly secrets set LINEAR_CLIENT_ID=... LINEAR_CLIENT_SECRET=... GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY=... --app <app_name>
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
