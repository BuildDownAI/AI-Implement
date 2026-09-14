---
model: claude-sonnet-5
---

<!--
  This repo's implementation prompt is separate from workflows/WORKFLOW.md,
  which seeds target repositories. The runner strips front matter and HTML
  comments, then substitutes issue fields and PR_NUMBER. Planning context is
  appended by the pipeline; keep it out of this template's substitutions.
-->

Read `CLAUDE.md` for repository conventions and pitfalls.

Implement the issue in the current checkout. The pipeline owns publication for
both new implementations and gap-fill runs: leave changes unstaged and
uncommitted. Do not create or switch branches, commit, push, or open a PR.

This is a **gap-fill** when a PR number appears between these quotes:
"${PR_NUMBER}". Otherwise, it is a **new implementation**.

## New implementation

Implement the issue's acceptance criteria using existing code patterns and the
supplied planning context. Keep the change focused on the requested behavior
and its tests and documentation. Follow the issue's requirements if a planning
suggestion would expand the scope; report any material conflict in the summary.

Write a brief summary to `ai-output/comments/01-summary.md`: what changed,
material decisions, verification commands and results, and any unmet acceptance
criterion. A short paragraph and checklist are enough for a routine change.

## Gap-fill

For existing PR #${PR_NUMBER}, address the supplied gap-analysis or review
feedback. Read the relevant PR discussion when needed to understand the finding.
Verify the fix and check for regressions caused by the change. Record unrelated
improvements as follow-up observations rather than expanding this repair.

Write the findings addressed, verification results, and any remaining blocker
to `ai-output/comments/01-gap-fill-summary.md`.

Follow only the matching run section. The orchestrator posts the summary to the
issue; do not post to Linear yourself. Files under `ai-output/` are excluded from
commits. The pipeline commits and pushes the reviewed changes to the appropriate
branch and opens the PR for a new implementation.

## Issue

**Identifier:** ${ISSUE_IDENTIFIER}
**Title:** ${ISSUE_TITLE}

${ISSUE_DESCRIPTION}

## Verification and completion

Use Node 24. Run targeted checks while editing, then run both before finishing:

```bash
npm run typecheck
npm test
```

Both must pass before reporting the implementation complete. Fix failures caused
by the change; if verification is blocked, name the blocker in the summary.

`tsconfig.json` excludes `src/__tests__`, so type-check new test files explicitly.
There is no lint script; use the repository's existing checks. Report the commands
actually run and their outcomes, including any validation gap. Preflight records
check results but does not replace your verification.

Batch independent file reads and searches. Prefer Read, Grep, and Glob for
inspection, and sequence calls only when an earlier result is needed. If the
turn cap approaches, preserve the work and state exactly what remains in the
summary. Finish with the changes uncommitted and the appropriate summary written.
