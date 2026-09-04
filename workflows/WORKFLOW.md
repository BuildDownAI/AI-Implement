---
# Claude model used for implementation. Passed through verbatim to
# `claude-code --model`, so any ID your configured provider accepts is fine.
# Examples:
#   Anthropic API / OAuth: claude-sonnet-4-6, claude-opus-4-7, claude-haiku-4-5-20251001
#   AWS Bedrock:           anthropic.claude-sonnet-4-6-20250805-v1:0
#                          or an inference-profile ARN (arn:aws:bedrock:...)
# The default below works for the Anthropic provider. If this repo's mapping
# is switched to provider=bedrock in the orchestrator admin UI, replace this
# with a Bedrock model ID: nothing validates the pairing, so an Anthropic-style
# ID reaches Bedrock verbatim and fails at invocation time rather than early.
model: claude-sonnet-4-6

# To run a cheaper model for the automated review pass than for implementation,
# set models.implement / models.review in .ai-implement/config.yml. Those take
# precedence over the model: above, and are the only supported way to split the
# two — there is no per-phase model key in this front matter.
---

<!--
  WORKFLOW.md — Claude AI Implementation prompt template
  =======================================================
  This file is seeded into your repo by the ai-implement sync workflow.
  It is YOURS to customise — future syncs will never overwrite it.

  When the runner executes this repo, it renders this file as the prompt sent to
  Claude Code. The YAML front matter block (between the --- lines) is stripped
  before Claude sees it, as are these HTML comments. The runner then substitutes
  the variables below using a regular expression — not envsubst. Any OTHER
  ${UPPER_SNAKE} token is replaced with an empty string, so a shell example
  containing one is silently blanked; a plain $VAR without braces survives.

    ${ISSUE_IDENTIFIER}   Ticket identifier, e.g. ENG-42
    ${ISSUE_TITLE}        Issue title
    ${ISSUE_DESCRIPTION}  Full issue description (Markdown)
    ${ISSUE_ID}           Ticket UUID; rarely useful, as the runner holds no ticketing credential
    ${PR_NUMBER}          Set on gap-fill re-runs; empty on first run

  Planning context is appended automatically when a planning run produced it.
  Do NOT put a ${PLANNING_CONTEXT} token in the body: the runner substitutes it
  AND the pipeline appends the same block, so the token emits it twice.

  FRONT MATTER (the --- block at the top)
  ----------------------------------------
  Stripped before sending to Claude. Supported keys:

    model                Model ID for implementation (see above).
    setup      Path (relative to repo root) to a shell script that runs BEFORE Claude.
               Use this to start services, install dependencies, and run migrations.
               Export env vars via `echo "VAR=value" >> "$GITHUB_ENV"` — they persist
               to Claude and all subsequent steps. Only the simple `VAR=value` form
               is supported; GitHub Actions' heredoc multiline syntax (`VAR<<EOF`) is
               NOT — such lines are ignored with a warning.
    verify     Path to a shell script that runs AFTER Claude, only on success.
               Use this to run tests or smoke checks.
    teardown   Path to a shell script that runs AFTER Claude, even on failure.
               Use this to stop containers or clean up resources.

    Hooks run in every execution mode — GitHub Actions, Fly Machines, and local
    Docker. All three start from the same container entrypoint, which prepares
    the workspace before the runner process starts, so WORKFLOW.md and the hook
    scripts are already on disk when they are read.

  SETUP AND TEARDOWN HOOKS
  ------------------------
  Repos that need a database or other services should define scripts instead of
  relying on the workflow-level `services:` block. GitHub-hosted runners have
  Docker available, so start containers with `docker run -d` in your setup script.

  Example front matter:
    setup:    scripts/ci/ai-setup.sh
    verify:   scripts/ci/ai-verify.sh
    teardown: scripts/ci/ai-teardown.sh

  Example setup script (Django + PostgreSQL):
    #!/usr/bin/env bash
    set -euo pipefail
    docker run -d --name postgres \
      -e POSTGRES_DB=app -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app \
      -p 5432:5432 postgres:16
    for i in $(seq 1 30); do
      docker exec postgres pg_isready -q && break
      [ "$i" -eq 30 ] && { docker logs postgres; exit 1; }
      sleep 1
    done
    echo "DATABASE_URL=postgresql://app:app@localhost:5432/app" >> "$GITHUB_ENV"
    echo "DJANGO_SETTINGS_MODULE=config.settings_ci" >> "$GITHUB_ENV"
    echo "DJANGO_SECRET_KEY=ci-secret-key-not-for-production" >> "$GITHUB_ENV"
    pip install -r django/requirements.txt
    cd django && python manage.py migrate_schemas --shared
    python manage.py create_public_tenant --domain_url=localhost

  Example teardown script:
    #!/usr/bin/env bash
    set -euo pipefail
    docker stop postgres && docker rm postgres || true

  NEW IMPLEMENTATION vs GAP-FILL RUNS
  -------------------------------------
  When ${PR_NUMBER} is empty  → Claude edits the checkout and leaves the changes uncommitted; the pipeline commits, pushes the branch, and opens the PR.
  When ${PR_NUMBER} is set    → Claude edits the existing PR checkout and leaves changes uncommitted; the pipeline commits and pushes to that PR branch.

  Both scenarios use this same file. The conditional sections below handle both.

  HOW TO CUSTOMISE THIS FILE
  ---------------------------
  1. Fill in the "Repo context" section with your stack, test commands, conventions.
  2. Adjust the quality checklist to match your standards.
  3. Add any repo-specific constraints (e.g. "never modify migration files directly").
  4. Change the model in the front matter if this repo needs more (opus) or less (haiku).
  5. Remove these HTML comments once you're done — Claude won't see them anyway.

  CLIENT-SPECIFIC CODE: USE custom/
  -----------------------------------
  This repo uses a path-precedence extension mechanism. When implementing
  client-specific behaviour, place new files under custom/ rather than
  modifying built-in modules:

    custom/steps/<id>.ts       — override a built-in pipeline step
    custom/pipelines/<name>.yml — override a built-in pipeline definition
    custom/providers/<id>.ts   — override a built-in provider module

  Files in custom/ are never overwritten by upstream syncs, so they survive
  upgrades. Editing built-in modules directly causes merge conflicts on every
  upstream update. See CLAUDE.md §"Custom extensions" for the full contract.
-->

Read CLAUDE.md if it exists for repo-specific context and conventions.

---

## New implementation

Implement the feature described in the issue below in the current checkout.
Do NOT create or switch branches. Do NOT commit, push, or open a pull request.
Leave your file changes unstaged and uncommitted. The AI-Implement pipeline
will create the implementation commit, push an issue-scoped branch, and open
the PR after review passes. The generated PR body includes
`Fixes ${ISSUE_IDENTIFIER}` so the ticketing system automatically closes the
issue when the PR is merged (Linear behaviour; Jira ignores it harmlessly).

After making the code changes, write a brief implementation summary to
`ai-output/comments/01-summary.md` (e.g. a paragraph describing what
changed plus a checklist of what was tested). The orchestrator reads this
file and posts it back to the ticketing issue via the configured provider.
Do NOT post comments directly to Linear or Jira from this workflow —
that pathway is handled by the orchestrator's runner-callback.

---

## Gap-fill instructions _(only when PR_NUMBER is set)_

You are adding missing work to existing PR #${PR_NUMBER}.
**Do NOT create a new branch or PR. Do NOT run `git push`.** Review the gap
analysis comment on the PR to understand what is still missing. Local commits
— including a merge commit when resolving conflicts with the base branch — are
fine; the pipeline pushes when the agent is done. Leave any remaining file
changes unstaged and uncommitted — the AI-Implement pipeline will commit and
push them to the existing PR branch after review passes.

After making the changes, write a short note about what you addressed to
`ai-output/comments/01-gap-fill-summary.md`. The orchestrator reads this
file and posts it back to the ticketing issue.

External review tools should communicate findings through native GitHub
review surfaces: submit `CHANGES_REQUESTED` for blocking feedback, use inline
PR review comments for file-specific issues, or post a structured PR review
summary comment. Do not ask Copilot or another bot to fix the PR in comments;
AI-Implement ingests GitHub review events and dispatches its own gap-fill run.

---

## Issue

**Identifier:** ${ISSUE_IDENTIFIER}
**Title:** ${ISSUE_TITLE}
**Description:**
${ISSUE_DESCRIPTION}

---

## Repo context

<!-- Customise this section for your repo -->

- **Stack:** _e.g. Node.js 20, TypeScript, PostgreSQL, Vitest_
- **Run tests:** _e.g. `npm test`_
- **Run linting / formatting:** _e.g. `npm run lint`_
- **Key conventions:** _e.g. follow patterns in existing files; no new dependencies without good reason_

---

## Quality checklist

Before you finish, verify:

- [ ] Tests pass
- [ ] No lint errors. Build completes successfully
- [ ] No debug output, `console.log`, or commented-out code left in
- [ ] PR description explains the approach, not just the what
- [ ] No unrelated files changed
