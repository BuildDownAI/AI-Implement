# AI-Implement

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**Turn your Linear backlog into pull requests.** Label an issue `AI-Implement`, and a PR appears in the right repo a few minutes later.

The goal is a team workflow, not a developer tool. Your ticketing system is the source of truth (Linear today, others pluggable) — not just for individual tickets, but for cross-issue context when planning. The PR is the work product. The team sees both in the tools they already use.

---

## What it does

You point this service at your Linear workspace and one or more GitHub repos. It then:

1. Polls Linear every 60 seconds for unblocked issues with the `AI-Implement` label, respecting per-team concurrency limits.
2. For each one, dispatches a GitHub Actions workflow in the target repo — **or** boots a Fly Machine — that runs Claude Code against the issue.
3. The runner checks out the repo, follows your repo-local `WORKFLOW.md` prompt, opens a PR, and runs a second Claude pass that posts a gap analysis comparing the diff to the original ticket.
4. The Linear issue is updated to In Progress, then Ready for Review, with a link back to the PR.
5. Comment `/ai-implement` on the resulting PR to re-run Claude in gap-fill mode against the same branch.

The orchestrator is a small Node.js service backed by SQLite. It runs comfortably on a single Fly.io shared-cpu-1x machine.

## Why this exists

Most AI coding tools assume one developer, one task, one session. AI-Implement assumes a team, a backlog, and a ticketing workflow. A few consequences of that design:

- **The ticket is the prompt, and the backlog is the context.** Writing well-specified tickets is something teams already know how to do. We use that skill — and the cross-issue structure that already exists in Linear — instead of asking product people to learn prompt engineering.
- **The work is legible.** Every run produces a PR, a gap analysis comment, and a ticket state change. Reviewers see exactly what was attempted and where it fell short of the spec.
- **It runs in your CI, with your secrets, against your provider.** Anthropic API, OAuth, or AWS Bedrock — pick per target repo. Nothing about your code or your tickets leaves your infrastructure.
- **One orchestrator, many repos, many GitHub orgs.** Designed from day one for teams running multiple codebases, not a single-repo prototype.

This is opinionated tooling for teams that have decided AI-assisted development is a workflow problem, not a tooling problem.

## Who it's for

You'll get value from this if:

- You already run tickets through Linear and want to skip the "open a PR yourself" step on small, well-specified issues.
- You want AI output to land in your existing review process, not in a parallel tool.
- You're comfortable operating a small Node service on Fly.io (or similar).
- You have at least some tickets that are focused enough for an LLM to land in one shot.

You should look elsewhere if:

- You want a hosted "press a button, get a PR" experience without operating any infrastructure.
- Your tickets tend to be sprawling or vague. Claude does well with focused, well-specified issues and poorly with everything else.

## Quick start (single target repo)

You'll need a Linear workspace, a GitHub App you control, a Fly.io account, and an Anthropic API key (or AWS Bedrock access).

```bash
git clone https://github.com/BuildDownAI/AI-Implement.git
cd AI-Implement
cp .env.example .env       # fill in LINEAR_API_KEY + GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY
npm install
npm run dev                # starts polling + HTTP server on :8080
```

Then in your Linear workspace, create an `AI-Implement` label. Install the GitHub App on the target repo, then in the orchestrator's admin UI at http://localhost:8080/admin (gated by `ADMIN_ACCESS_CODE`), add a team → repo mapping. From the Projects page, click **Sync workflows** for that project; the orchestrator opens or updates a PR in the target repo with the workflow templates.

The synced workflows allow the GitHub App bot that minted the workflow token by
default. To allow a different bot or a comma-separated allow-list, set the
`AI_IMPLEMENT_ALLOWED_BOTS` Actions variable on the target repo or org.

Merge the resulting PR in the target repo, enable "Allow GitHub Actions to create and approve pull requests" in its settings, then label any Linear issue `AI-Implement` and watch.

For local runner development, keep the orchestrator on your host and run implementation jobs in Docker:

```bash
npm run build:runner:local # builds Dockerfile.session as ai-implement-runner:local
npm run dev:local          # rebuilds the runner image, then starts RUNNER_MODE=local
```

Docker must be running. Local mode still opens real GitHub PRs; it just avoids deploying the orchestrator or publishing a runner image while you test changes.

The full architecture, env-var reference, SQLite schema, multi-client deploy model, and Bedrock setup live in [`CLAUDE.md`](CLAUDE.md).

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
