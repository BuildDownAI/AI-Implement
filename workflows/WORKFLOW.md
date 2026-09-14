---
# Claude model used for implementation. Passed through verbatim to
# `claude --model`, so any ID your configured provider accepts is fine.
# Examples:
#   Anthropic API / OAuth: claude-sonnet-5, claude-opus-4-7, claude-haiku-4-5-20251001
#   AWS Bedrock:           anthropic.claude-sonnet-4-6-20250805-v1:0
#                          or an inference-profile ARN (arn:aws:bedrock:...)
# The default below works for the Anthropic provider. If this repo's mapping
# is switched to provider=bedrock in the orchestrator admin UI, replace this
# with a Bedrock model ID: nothing validates the pairing, so an Anthropic-style
# ID reaches Bedrock verbatim and fails at invocation time rather than early.
model: claude-sonnet-5

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
  1. Add repository-specific context, validation commands, and conventions.
  2. Adjust the quality checklist to match your standards.
  3. Add any repo-specific constraints (e.g. "never modify migration files directly").
  4. Change the model in the front matter if this repo needs more (opus) or less (haiku).
  5. Remove these HTML comments once you're done — Claude won't see them anyway.

-->

Read `CLAUDE.md` if present and the repository's contribution guidance for
conventions, runtime requirements, and validation commands.

This is a **gap-fill** when a PR number appears between these quotes:
"${PR_NUMBER}". Otherwise, it is a **new implementation**. Follow only the
matching run section below.

## New implementation

Implement the issue's acceptance criteria in the current checkout using existing
patterns and any supplied planning context. Keep changes focused on the requested
behavior, its tests, and necessary documentation. Report material conflicts
between the plan and issue rather than silently expanding scope.

Do NOT create or switch branches. Do NOT commit, push, or open a pull request.
Leave your file changes unstaged and uncommitted. The AI-Implement pipeline will
commit the reviewed changes, push an issue-scoped branch, and open the PR.

Write a brief summary to `ai-output/comments/01-summary.md`: what changed,
material decisions, validation commands and results, and any unmet acceptance
criterion. A short paragraph and checklist are enough for a routine change.

## Gap-fill instructions

For existing PR #${PR_NUMBER}, address the supplied gap-analysis or review
feedback. Read the relevant PR discussion when needed to understand a finding.
Verify each fix and check for regressions it could introduce. Keep unrelated
improvements as follow-up observations rather than expanding this repair.

Do NOT create or switch branches. Do NOT commit, push, or open a pull request.
Leave your file changes unstaged and uncommitted.
The AI-Implement pipeline will commit and push the reviewed changes to the existing PR branch.

Write the findings addressed, validation results, and any remaining blocker to
`ai-output/comments/01-gap-fill-summary.md`.

## Issue

**Identifier:** ${ISSUE_IDENTIFIER}
**Title:** ${ISSUE_TITLE}

${ISSUE_DESCRIPTION}

## Validation and completion

Use the repository's documented runtime and existing validation commands. Run
targeted checks while editing, then the required tests, typecheck, lint, and build
where those checks exist. Do not invent scripts or add tooling just to satisfy
this checklist. Fix failures caused by the change; if validation is blocked,
record the exact command, failure, and remaining uncertainty in the summary.

Batch independent reads and searches. Capture complete validation output once
and inspect that output instead of rerunning an unchanged expensive check.
If the turn cap approaches, preserve the work and state what remains.

The orchestrator posts the summary to the configured issue tracker. Do not post
to Linear or Jira yourself. Files under `ai-output/` are excluded from commits.

Before reporting completion:

- [ ] Acceptance criteria are met, or unmet criteria and blockers are named.
- [ ] Required repository checks pass; commands and outcomes are recorded.
- [ ] No temporary debugging code or unrelated edits remain.
- [ ] The matching summary file is written and changes remain uncommitted.
