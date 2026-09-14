---
model: claude-sonnet-5
---

<!--
  This repo's planning prompt overrides the built-in prompt. Keep its output
  filenames and headers aligned with workflows/PLANNING.md: the runner splits
  the map and acceptance bar for their respective consumers.

  The runner strips HTML comments, then substitutes issue and related-context
  tokens. The machine-block delimiters below are described in parts so that
  comment stripping does not erase the instructions sent to the planner.
-->

Read `CLAUDE.md` for repository conventions. Inspect the relevant code and tests,
then write the three planning files below. This is a read-only analysis of the
source tree: create only these files under `ai-output/comments/`. The orchestrator
posts them to the issue; do not post to Linear or create branches, commits, or PRs.

Keep the plan proportional to the issue. For a routine change, aim for about
300 words across the three comments. Record discoveries that help implementation
or verification, rather than repeating the issue. Reuse existing patterns and
keep the issue's acceptance criteria as the scope. If the work needs a broader
decision, describe that specific uncertainty in the risks comment.

## Issue

**Identifier:** ${ISSUE_IDENTIFIER}
**Title:** ${ISSUE_TITLE}

${ISSUE_DESCRIPTION}

**Parent:** ${PARENT}
**Siblings:** ${SIBLINGS}
**Dependencies:** ${DEPENDENCIES}

## 1. Implementation Map

Write `ai-output/comments/01-implementation-map.md` with the exact header:

```markdown
## 🗺 AI Planning: Implementation Map
```

The implementer consumes this comment. Keep it within 60 lines:

- **Approach:** at most three sentences naming the existing pattern and the change.
- **Files:** use canonical verb bullets with backtick-quoted paths:
  ```markdown
  - Modify: `src/example.ts`
  - Test: `src/__tests__/example.test.ts`
  ```
  Supported verbs are Create, Modify, Test, and Delete.
- **Constraints:** include dependency ordering or shared-file overlap only when
  relevant. Keep coordination here rather than creating a separate work-unit plan.

End this file with a machine-readable HTML comment. Its opening line is `<`
followed immediately by `!-- ai-implement-planning`; its closing line is `--`
followed immediately by `>`. Between those lines, write:

```yaml
v: 1
files: ["src/example.ts", "src/__tests__/example.test.ts"]
risk: low
```

Replace the example paths with the complete planned file list and choose
`low`, `medium`, or `high` from the actual change. The files array must be valid JSON.

## 2. Acceptance Bar

Write `ai-output/comments/02-acceptance-bar.md` with the exact header:

```markdown
## ✅ AI Planning: Acceptance Bar
```

The reviewer consumes this comment. List numbered, falsifiable claims covering
the issue's acceptance criteria. For each, name the behavior and how to verify
it in code or with a specific test or command. Include material edge cases found
during inspection. Prefer a few concrete checks over a generic unit/integration/
manual test catalogue. Repository-wide validation already lives in `WORKFLOW.md`.

## 3. Risks & Open Questions

Write `ai-output/comments/03-risks.md` with the exact header:

```markdown
## ⚠️ AI Planning: Risks & Open Questions
```

Record material uncertainties, prerequisites, or easily missed data-flow details
with the relevant code location. If there are none, say so in one sentence.
