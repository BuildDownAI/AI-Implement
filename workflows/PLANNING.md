---
# Set a model ID accepted by this repository's configured provider.
model: claude-sonnet-5
---

<!--
  Seeded as PLANNING.md in target repositories. Existing files are preserved by
  sync, so maintainers apply later template changes deliberately.

  Customise repository guidance and model selection, keeping the three output
  filenames and exact headers: the runner routes the map to implementation and
  the acceptance bar to review. This file replaces the built-in planning prompt.

  The runner strips front matter and HTML comments before substituting
  ISSUE_IDENTIFIER, ISSUE_TITLE, ISSUE_DESCRIPTION, ISSUE_ID, PARENT, SIBLINGS,
  and DEPENDENCIES in braced dollar tokens. Unrecognised uppercase tokens become
  empty strings. Machine-comment delimiters are described in parts below so
  stripping does not erase the instructions given to the planner.
-->

Read `CLAUDE.md` if present and the repository's contribution guidance for
conventions. Inspect the relevant code and tests, then write the three planning
files below. This is a read-only analysis of the source tree: create only these
files under `ai-output/comments/`. The orchestrator posts them to the issue;
do not post to the issue tracker or create branches, commits, or PRs.

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
  - Modify: `src/example.ext`
  - Test: `tests/example_test.ext`
  ```
  Supported verbs are Create, Modify, Test, and Delete.
- **Constraints:** include dependency ordering or shared-file overlap only when
  relevant. Keep coordination here rather than creating a separate work-unit plan.

End this file with a machine-readable HTML comment. Its opening line is `<`
followed immediately by `!-- ai-implement-planning`; its closing line is `--`
followed immediately by `>`. Between those lines, write:

```yaml
v: 1
files: ["src/example.ext", "tests/example_test.ext"]
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
