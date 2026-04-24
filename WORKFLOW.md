---
# Claude model used for implementation. Passed through verbatim to
# `claude-code --model`, so any ID your configured provider accepts is fine.
# Examples:
#   Anthropic API / OAuth: claude-sonnet-4-6, claude-opus-4-7, claude-haiku-4-5-20251001
#   AWS Bedrock:           anthropic.claude-sonnet-4-6-20250805-v1:0
#                          or an inference-profile ARN (arn:aws:bedrock:...)
# The default below works for the Anthropic provider. If this repo's mapping
# is switched to provider=bedrock in the orchestrator admin UI, replace this
# with a Bedrock model ID — the workflow will hard-fail otherwise, since
# Bedrock IDs are account- and region-specific and have no safe default.
model: claude-sonnet-4-6

# Optional: model used for the post-PR gap-analysis step. Pass through as above.
# Default (if omitted): claude-haiku-4-5-20251001 for anthropic, same as `model`
# above for bedrock (override if you want a cheaper model for gap analysis).
# gap_analysis_model: claude-haiku-4-5-20251001
---

<!--
  WORKFLOW.md — Claude AI Implementation prompt template
  =======================================================
  This file is seeded into your repo by the ai-implement sync workflow.
  It is YOURS to customise — future syncs will never overwrite it.

  When claude-implement.yml runs, it renders this file as the prompt sent to
  Claude Code. The YAML front matter block (between the --- lines) is stripped
  before Claude sees it. The rest of the file is passed through envsubst, which
  substitutes the following variables:

    ${ISSUE_IDENTIFIER}   Linear identifier, e.g. ENG-42
    ${ISSUE_TITLE}        Issue title
    ${ISSUE_DESCRIPTION}  Full issue description (Markdown)
    ${ISSUE_ID}           Linear UUID (useful if you want Claude to call the Linear API)
    ${PR_NUMBER}          Set on gap-fill re-runs; empty on first run

  FRONT MATTER (the --- block at the top)
  ----------------------------------------
  Stripped before sending to Claude. Supported keys:

    model                Model ID for implementation (see above).
    gap_analysis_model   Model ID for the post-PR gap-analysis step (see above).

  NEW IMPLEMENTATION vs GAP-FILL RUNS
  -------------------------------------
  When ${PR_NUMBER} is empty  → Claude creates a new branch and PR.
  When ${PR_NUMBER} is set    → Claude pushes gap-fill commits to the existing PR.
  Both scenarios use this same file. The conditional sections below handle both.

  HOW TO CUSTOMISE THIS FILE
  ---------------------------
  1. Fill in the "Repo context" section with your stack, test commands, conventions.
  2. Adjust the quality checklist to match your standards.
  3. Add any repo-specific constraints (e.g. "never modify migration files directly").
  4. Change the model in the front matter if this repo needs more (opus) or less (haiku).
  5. Remove these HTML comments once you're done — Claude won't see them anyway.
-->

Read CLAUDE.md if it exists for repo-specific context and conventions.

---

If `${PR_NUMBER}` is set (value: "${PR_NUMBER}"), skip to the **Gap-fill instructions**
section below and ignore New implementation.

---

## New implementation

Create a branch named `${ISSUE_IDENTIFIER}/short-description`, implement the
feature described in the issue below, then open a pull request with:

- **Title:** `${ISSUE_IDENTIFIER}: ${ISSUE_TITLE}`
- **Body:** must include `Fixes ${ISSUE_IDENTIFIER}` so Linear automatically
  closes the issue when the PR is merged.

---

## Gap-fill instructions _(only when PR_NUMBER is set)_

You are adding missing work to existing PR #${PR_NUMBER}.
**Do NOT create a new branch or PR.** Commit your changes to the current
branch and push. Review the gap analysis comment on the PR to understand
what is still missing.

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

Before opening or updating the PR, verify:

- [ ] Tests pass
- [ ] No lint errors. Build completes successfully
- [ ] No debug output, `console.log`, or commented-out code left in
- [ ] PR description explains the approach, not just the what
- [ ] No unrelated files changed
