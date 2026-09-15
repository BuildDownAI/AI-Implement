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

Filesystem runs use the selected internal reviewers without waiting for an
external review by default. To exercise an external reviewer, select
`claude-review-summary` in the project or configure `reviewProviders` or
`reviewCheckNames` in the target repository's `.ai-implement/config.yml`.
For example, `reviewProviders: [github-claude-code-review]` enables the external
review wait; `reviewCheckNames: [my-review-job]` pins its check name. An explicit
`reviewProviders: []` disables external collection. Failed CI checks still block
an otherwise approved filesystem run when no external reviewer is configured.

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
The viewer requires an authenticated admin session. Failed tickets without an
existing PR or active run have a **Retry** action.

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

## Completed tickets and retries

The provider organizes ticket Markdown files under the configured directory:

- The top level contains active work, including tickets with an open PR.
- `completed/` contains tickets whose PR merged (or whose run finished with no
  work required). An approved review by itself does not complete a ticket.
- `failed/` contains terminal failures that need intervention, after automatic
  retries are exhausted or a phase fails without an automatic retry.

Status, plans, comments, and PR history stay at the original
`.state/<project-key>/<ticket-id>.json` path. Archived tickets remain accessible
through issue links, and late PR events can still update them. Existing completed
tickets are archived during discovery; failure reconciliation runs during job
monitoring. Temporary failures being retried stay active.

For a failed ticket, open its issue viewer and choose **Retry**. This restores its
Markdown file to the top level, clears retry counters and dispatch guards, and
queues it for the next eligible poll. Planning failures restart planning;
implementation failures retain their plan and restart implementation. A paused
project stays paused. Moving the file manually does not reset its failed status.

Retry is refused while a run is active or any PR is recorded for the ticket;
continue work through that PR instead. Archive and restore operations refuse
collisions and symlink destinations. Give each project its own ticket directory:
automatic moves are refused when another mapping shares the same physical root.
No ticket contents or history are deleted by archiving or retrying.

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

## Review limits and incomplete reviews

In **Projects**, edit the project's reviewer settings to set **Max turns** for
each internal reviewer. A blank value inherits the reviewer's own default, or
the global **Review Max Turns** under **Settings**. Both built-in reviewers
inherit that global limit (30 by default). These limits are separate from the
implementation's Max Turns.

If a reviewer reaches its limit or cannot return a valid report, the remaining
reviewers still run. The PR retains their reports and identifies the incomplete
reviewer, the reason, and any usable partial evidence. Partial evidence never
counts as approval. A required incomplete review blocks merge readiness;
an advisory review stays advisory. Review infrastructure failures do not trigger
an implementation pass to "fix" code.

Complete the missing review before merging. You can raise the reviewer's limit
for subsequent runs. There is currently no review-only retry action: the normal
PR iteration path also runs implementation, so it should be used only when you
intend to request work on the PR. The filesystem ticket's **Retry** action remains
for failed tickets without an existing PR.
