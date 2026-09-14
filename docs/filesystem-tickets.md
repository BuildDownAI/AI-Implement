# Filesystem tickets with real PRs

Filesystem ticketing runs Markdown tasks through the local orchestrator and Docker
runner. It uses the normal GitHub PR, review, and repair process. Linear and Jira
are not involved. The separate `dev:run --task` harness still leaves changes in a
mounted checkout and does not create PRs.

## Start a local test project

Use Node 24 and Docker. In the AI-Implement checkout, configure `.env` with:

- `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` for an App installed on your test repository.
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.
- `ADMIN_ACCESS_CODE` and `RUNNER_TOKEN_SECRET` (choose separate random values).
- `DEDUP_DB_PATH` pointing to a dedicated local test database, such as `./local-test.sqlite`.
- `GITHUB_WEBHOOK_SECRET` if testing follow-up PR comments or late review events.

Leave Linear and Jira credentials empty. Keep the ticket directory outside the
target repository so test instructions and runtime state do not enter its PRs.

```bash
npm ci
mkdir -p "$HOME/ai-test-tickets"
npm run dev:local
```

`dev:local` builds `ai-implement-runner:local` and starts the orchestrator with
`RUNNER_MODE=local`. Runners reach it through `host.docker.internal` by default;
set `LOCAL_RUNNER_ORCHESTRATOR_URL` and `RUNNER_CALLBACK_BASE_URL` if your Docker
network needs different addresses. Keep the same database and `RUNNER_TOKEN_SECRET`
across restarts so in-flight jobs can finish reporting.

At `http://localhost:8080/admin`, create a project for the test GitHub repository.
Choose **Filesystem** for ticketing and enter the absolute ticket directory
(expand `$HOME` yourself in this field). Use an autonomous session for the full
PR review/fix loop. Configure the base branch, planning, reviewer selections, and
run limits as for any other project. Start with a concurrency limit of one.

The filesystem provider is only available in local runner mode. It does not
require a Fly app or a published runner image. Your test repository still needs
the checks and external review workflow you intend to exercise.

## Write a ticket

Save `REVIEW-001.md` in the configured directory:

```markdown
---
id: REVIEW-001
title: Add a version endpoint
limits:
  maxTurns: 30
  maxIterations: 3
---

Add GET /version returning a JSON object with the application's version.

Acceptance criteria:
- Return HTTP 200 and application/json.
- Add a test for the response shape.
- Preserve existing endpoints.
```

The format reuses the local harness's portable task documents: `title`, `id`,
optional `base`, `profiles`, and `limits`, followed by the task's Markdown body.
Use an explicit stable identifier such as `REVIEW-001`. The project mapping
selects the GitHub repository; the task does not contain credentials or a repo
path. Filesystem tickets are independent tasks; tracker-style parent/child
grouping is not supported.

The orchestrator discovers top-level `.md` files on its next poll. If planning is
enabled, it saves the plan and then advances to implementation. Per-ticket limits
apply to the initial planning and implementation dispatches; later PR-comment
iterations use the project's current limits.

## Inspect results and iterate

Task Markdown remains unchanged. The provider writes status, comments, planning
output, and PR links to `.state/<project-key>/<ticket-id>.json` in the ticket directory. The admin
UI shows the ordinary jobs, steps, reviewer reports, and PR links.

Click the filesystem issue link in the job's **Context** section to open its
local issue viewer. **Ticket Markdown** shows the original task file, including
front matter. **State JSON** shows the saved status, planning comments, and PR
links from `.state/`. Use **Refresh** to reload both files as the run progresses.
The viewer is read-only and requires an authenticated admin session.

Local Docker jobs also have a **View local logs** button in the job panel.
It shows recent container output with a refresh action. Recent output is saved
before container cleanup so it remains available afterward. Containers removed
before log saving was enabled may no longer have logs available.

A ticket with an open PR is not dispatched again merely because the task file
still exists. Completed status survives restarts. Preserve `.state/` and the
local database between runs; use a new ticket identifier for an independent test.
Malformed tickets, duplicate IDs within a project, and corrupt state are excluded
from dispatch and reported in the orchestrator log. Correct the affected file
before retrying; corrupt state is never treated as a new ticket.

For follow-up comments, GitHub must be able to reach the local orchestrator's
`/api/github/webhook` endpoint through your development tunnel or webhook
forwarder. Configure the matching `GITHUB_WEBHOOK_SECRET`. Subscribe to
`issue_comment`, `pull_request`, `pull_request_review`, and
`pull_request_review_comment` for the iteration scenarios. Use the current
orchestrator-mediated comment workflow contract on the target repository.
The legacy `/trigger/gap-fill` endpoint is refused for filesystem projects because
it dispatches GitHub Actions; use the webhook path above.

Post `/ai-implement` with a concrete follow-up instruction on the PR. The
orchestrator launches another local Docker run against that PR. Late review
feedback also uses the local runner. Both paths preserve the project's reviewer
selection; they do not fall back to GitHub Actions in local mode.

For the trusted-versus-advisory reviewer test, define and select a custom reviewer
on the test repository's default branch. Have a ticket change its prompt on the
PR branch. Confirm the default-branch reviewer still gates and the changed
reviewer appears as an advisory preview. Test both directions of disagreement.
