# AI-Implement

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**Turn your backlog into pull requests.** Label a Linear issue `AI-Implement` — or set a Jira issue's `AI-Implement Status` to `Ready` — and a PR appears in the right repo a few minutes later.

The goal is a team workflow, not a developer tool. Your ticketing system is the source of truth (Linear and Jira today, others pluggable) — not just for individual tickets, but for cross-issue context when planning. The PR is the work product. The team sees both in the tools they already use.

---

## What it does

You point this service at your Linear workspace or Jira project and one or more GitHub repos. It then:

1. Polls the tracker every 60 seconds for ready work — unblocked Linear issues with the `AI-Implement` label, or Jira issues with `AI-Implement Status = Ready` in the mapping's scope — respecting per-team concurrency limits.
2. For each one, dispatches a GitHub Actions workflow in the target repo — **or** boots a Fly Machine — that runs Claude Code against the issue.
3. The runner checks out the repo, follows your repo-local `WORKFLOW.md` prompt, opens a PR, and runs a second Claude pass that posts a gap analysis comparing the diff to the original ticket.
4. The ticket is updated to In Progress, then Ready for Review, with a link back to the PR.
5. Comment `/ai-implement` on the resulting PR to re-run Claude in gap-fill mode against the same branch.

The orchestrator is a small Node.js service backed by SQLite. It runs comfortably on a single Fly.io shared-cpu-1x machine.

## Why this exists

Most AI coding tools assume one developer, one task, one session. AI-Implement assumes a team, a backlog, and a ticketing workflow. A few consequences of that design:

- **The ticket is the prompt, and the backlog is the context.** Writing well-specified tickets is something teams already know how to do. We use that skill — and the cross-issue structure that already exists in your tracker — instead of asking product people to learn prompt engineering.
- **The work is legible.** Every run produces a PR, a gap analysis comment, and a ticket state change. Reviewers see exactly what was attempted and where it fell short of the spec.
- **It runs in your CI, with your secrets, against your provider.** Anthropic API, OAuth, or AWS Bedrock — pick per target repo. Nothing about your code or your tickets leaves your infrastructure.
- **One orchestrator, many repos, many GitHub orgs.** Designed from day one for teams running multiple codebases, not a single-repo prototype.

This is opinionated tooling for teams that have decided AI-assisted development is a workflow problem, not a tooling problem.

## Who it's for

You'll get value from this if:

- You already run tickets through Linear or Jira and want to skip the "open a PR yourself" step on small, well-specified issues.
- You want AI output to land in your existing review process, not in a parallel tool.
- You're comfortable operating a small Node service on Fly.io (or similar).
- You have at least some tickets that are focused enough for an LLM to land in one shot.

You should look elsewhere if:

- You want a hosted "press a button, get a PR" experience without operating any infrastructure.
- Your tickets tend to be sprawling or vague. Claude does well with focused, well-specified issues and poorly with everything else.

## Quick start (local dev)

You'll need a Linear workspace or Jira project, a GitHub App you control, and an Anthropic API key (or AWS Bedrock access).

```bash
git clone https://github.com/BuildDownAI/AI-Implement.git
cd AI-Implement
asdf install                 # installs the Node version pinned in .tool-versions
cp .env.example .env         # fill in GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY, plus
                             # LINEAR_API_KEY (Linear) or JIRA_TOKEN + JIRA_CLOUD_ID + JIRA_SITE_URL (Jira)
npm install
npm run dev                  # starts polling + HTTP server on :8080
```

The admin UI is at http://localhost:8080/admin (gated by `ADMIN_ACCESS_CODE`). To connect your first repo, see [Adding a new target repo](#adding-a-new-target-repo) below.

For local runner development, keep the orchestrator on your host and run implementation jobs in Docker:

```bash
npm run build:runner:local # builds Dockerfile.session as ai-implement-runner:local
npm run dev:local          # rebuilds the runner image, then starts RUNNER_MODE=local
```

Docker must be running. Local mode still opens real GitHub PRs; it just avoids deploying the orchestrator or publishing a runner image while you test changes.

AI-Implement uses `better-sqlite3`, which ships a native Node addon. Always run
`npm install`, `npm ci`, and `npm rebuild` with the Node major pinned in
`.tool-versions` / `.nvmrc`; otherwise `node_modules` can be compiled for one
Node ABI and fail when the service starts under another. If that happens after
switching runtimes, run `npm ci` or `npm rebuild better-sqlite3` from the
correct Node shell.

## Choosing the runner image

Every implementation job runs inside a runner image. Resolution is the same in both execution modes, highest priority first:

| Where | Scope | Use it for |
|---|---|---|
| `.ai-implement/image.yml` (committed in the target repo, default branch) | one repo | "this repo needs a special image" |
| `AI_IMPLEMENT_RUNNER_IMAGE` | org-wide or per-repo | "my org's default image" — a GitHub **org** variable in `github-actions` mode, or an orchestrator env var in `fly-machines` mode |
| *(nothing set)* | — | falls back to the published BuildDownAI image |

The first one set wins. A fork that publishes its own image typically sets `AI_IMPLEMENT_RUNNER_IMAGE` once at the org level — no workflow edits, and the allowlist trusts your org's `ghcr.io/<owner>/` namespace automatically. In `github-actions` mode, a manual `runner_image` dispatch input overrides everything for that single run; for orchestrator-dispatched runs, an explicit `.ai-implement/image.yml` override or runner-image env var is also forwarded as that input. `.ai-implement/image.yml` is always read from the default branch, so a pull request can't change the image its own run executes in.

`SESSION_IMAGE` is the deprecated former name of the orchestrator's `AI_IMPLEMENT_RUNNER_IMAGE` env var; it still works but logs a warning at startup.

The full architecture, env-var reference, SQLite schema, multi-client deploy model, and Bedrock setup live in [`CLAUDE.md`](CLAUDE.md).

## Adding a new target repo

### Step 1 — Ticketing setup (one-time per workspace/project)

**Linear**: create an `AI-Implement` label in your workspace. That label is the trigger.

**Jira**: add two custom fields to your Jira project. The orchestrator auto-discovers them by name, so use these exact names — or pick the field explicitly in the mapping (stored as a `customfield_XXXXX` override) if yours are named differently.

| Field name | Type | Purpose |
|---|---|---|
| `AI-Implement Status` | Select | Orchestrator-managed state transitions (Ready → In Progress → Ready for Review) |
| `AI-Implement Repo` | Select | Identifies which GitHub repo the issue belongs to — each option should be `owner/repo` |

### Step 2 — GitHub App

Install your GitHub App on the target repo. It needs **Contents** and **Workflows** permissions. Also enable **"Allow GitHub Actions to create and approve pull requests"** in the target repo's Settings → Actions → General.

The synced workflows allow the GitHub App bot that minted the workflow token by default. To allow a different bot or a comma-separated allow-list, set the `AI_IMPLEMENT_ALLOWED_BOTS` Actions variable on the target repo or org.

### Step 3 — Add the project in the admin UI

Go to the orchestrator's admin UI → **Projects** → **+ New project**. The stepper walks through:

- **Ticketing System** — `linear` or `jira`.
- **Ticketing Config** — Linear: the team key (e.g. `ENG`). Jira: a scope JQL (e.g. `project = MYPROJECT` — no status clauses; the orchestrator adds those), the status/repo fields (leave at auto-discover if you used the exact names above), and the Repo Field Value option matching this repo (e.g. `your-org/your-repo`).
- **Source** — GitHub owner, repo, and default branch. Click **Check installation**: the stepper probes whether the GitHub App is installed and can see the repo, and links straight to the fix when it can't (install the App, or add this repo to the installation). The check is advisory — you can still save without it.
- **Runner** — `github-actions` (zero infrastructure) or `fly-machines`.
- **Provider** — `anthropic` or `bedrock` (see [CLAUDE.md](CLAUDE.md) for Bedrock setup), plus planning toggles.
- **Capacity** — max parallel AI issues (default 3, keep low while evaluating).
- **Secrets** — optionally seed per-project secrets now (write-only; you can add more later from the Projects page).

**Save.** The mapping persists immediately and the workflow sync runs in the background: the project row shows **"Syncing…"**, then **"Workflows synced — PR opened ↗"** — or reverts with an alert naming the failure. Per-run caps (Max Turns, Max Iterations, Job Timeout) are editable later via **Edit** on the project row.

### Step 4 — Merge the sync PR

The sync opens a PR in the target repo containing:

- `.github/workflows/claude-implement.yml`
- `.github/workflows/comment-trigger.yml`
- `.github/workflows/claude-plan.yml`
- `WORKFLOW.md` — your Claude implementation prompt template (seeded once, never overwritten)
- `PLANNING.md` — your Claude planning prompt template (seeded once, never overwritten)

**Merge that PR** in the target repo. The **Sync workflows** button on the project row re-runs the sync any time workflow templates change upstream.

### Step 5 — Trigger a run

**Linear**: label any issue in the mapped team `AI-Implement`.

**Jira**: on any issue in scope of your JQL, set `AI-Implement Repo` to the matching option and `AI-Implement Status` to `Ready`.

The orchestrator picks it up within 60 seconds and dispatches a run. The resulting PR is linked back to the ticket, and commenting `/ai-implement` on that PR re-runs Claude in gap-fill mode.

## Layout

```
src/                  Polling loop, HTTP + admin server, Linear/GitHub clients, Fly Machines runner
workflows/            Templates synced to target repos (claude-implement.yml, claude-plan.yml,
                      comment-trigger.yml, WORKFLOW.md, PLANNING.md)
clients/              One <slug>.toml per deployed Fly app (multi-tenant deploy)
custom/               Fork-local step/provider/pipeline overrides (see custom/README.md
                      and docs/adr/001-custom-path-precedence.md)
scripts/              provision-client.sh (interactive onboarding for multi-tenant operators)
session/              Entrypoint scripts for the Fly Machines runner image
docs/                 Design notes, ADRs
.github/workflows/    deploy-clients.yml, sync-workflow.yml, build-runner.yml,
                      claude-review.yml
```

## PR reviews

Claude reviews PRs automatically via `.github/workflows/claude-review.yml`:

- **Same-repo PRs**: review runs once when the PR is opened or marked ready for review. To re-run after pushing changes, comment `/claude-review` on the PR.
- **Fork PRs**: a maintainer (owner, member, or collaborator) must comment `/claude-review` to trigger a review. GitHub's "Require approval for outside collaborators" setting (Settings → Actions → General → Fork pull request workflows) gates the workflow run on top of that.

The workflow checks out the PR head with `persist-credentials: false` and never executes PR-supplied scripts — only the diff is read. Authenticate by setting either `CLAUDE_CODE_OAUTH_TOKEN` (preferred) or `ANTHROPIC_API_KEY` as a repo secret; the workflow is a no-op without one of them.

## Status

`0.1.0` — usable but pre-1.0. The codebase is the upstream of a private fork that runs in production, and breaking changes happen as the design settles. Pin a tag if you're depending on it.

## Part of BuildDownAI

AI-Implement is the machinery. It's designed to work with [the BuildDownAI skills library](https://github.com/BuildDownAI) — opinionated Claude Code skills for working inside this pipeline as a team, not a solo developer. The tools and the skills are separate projects that compose.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and the `custom/` extension model. Security issues: see [SECURITY.md](SECURITY.md) — please don't file them in public.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
