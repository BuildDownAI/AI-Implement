---
# Claude model used for planning. Passed through verbatim to
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
---

<!--
  PLANNING.md — Claude AI Planning prompt template
  =================================================
  This file is seeded into your repo by the ai-implement sync workflow.
  It is YOURS to customise — future syncs will never overwrite it.

  When claude-plan.yml runs, it renders this file as the prompt sent to Claude.
  The YAML front matter block (between the --- lines) is stripped before Claude
  sees it. The rest of the file is passed through envsubst, which substitutes:

    ${ISSUE_IDENTIFIER}   Linear identifier, e.g. ENG-42
    ${ISSUE_TITLE}        Issue title
    ${ISSUE_DESCRIPTION}  Full issue description (Markdown)
    ${ISSUE_ID}           Linear UUID (used in curl commands to post comments)
    ${PARENT}             Parent issue as "- IDENTIFIER: Title" (or "None")
    ${SIBLINGS}           Sibling stories (other children of the parent), newline-separated
    ${DEPENDENCIES}       Related issues as "- [type] IDENTIFIER: Title", newline-separated

  FRONT MATTER (the --- block at the top)
  ----------------------------------------
  Stripped before sending to Claude. Supported keys:

    model      Model ID for planning (see above). Required; no default for bedrock.

  COMMENT FORMAT
  ---------------
  Claude posts up to 4 structured comments to Linear. Headers are parseable
  so the implementation workflow can locate them later:

    ## 🏗️ AI Planning: Architecture Analysis
    ## 🧪 AI Planning: Test Plan
    ## 🔧 AI Planning: Work Units
    ## 🔗 AI Planning: Cross-Story Context   ← only when dependencies exist

  HOW TO CUSTOMISE THIS FILE
  ---------------------------
  1. Fill in the "Repo context" section with your stack and conventions.
  2. Add repo-specific analysis prompts (e.g. "check the migrations directory").
  3. Adjust the cross-story threshold (default: only post when deps are non-None).
  4. Change the model in the front matter if needed.
  5. Remove these HTML comments once you're done — Claude won't see them anyway.
-->

You are a senior software architect performing a read-only planning analysis. Do NOT create any branches, files, or pull requests. Do NOT write any code. Explore the codebase and post structured planning comments to Linear.

**Issue:** ${ISSUE_IDENTIFIER} — ${ISSUE_TITLE}

**Description:**
${ISSUE_DESCRIPTION}

## Related context

**Parent issue:**
${PARENT}

**Sibling stories:**
${SIBLINGS}

**Dependencies:**
${DEPENDENCIES}

---

## Repo context

<!-- Customise this section for your repo -->

- **Stack:** _e.g. Node.js 20, TypeScript, PostgreSQL, Vitest_
- **Key conventions:** _e.g. follow patterns in existing files; all DB access via the repository layer_
- **Areas to always check:** _e.g. src/models/, src/api/, migrations/_

---

## Instructions

Use Read, Glob, and Grep to explore the codebase. Then post structured planning comments to Linear using `curl`. The `LINEAR_API_KEY` and `ISSUE_ID` environment variables are available.

Use this pattern for each comment (replace `BODY` with the markdown content):

```
curl -s --max-time 30 -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  --data-raw "$(jq -n --arg id "$ISSUE_ID" --arg body "BODY" \
    '{query: "mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }", variables: {id: $id, body: $body}}')"
```

Post EXACTLY these comments in order:

### Comment 1 — Architecture Analysis

Header must be exactly: `## 🏗️ AI Planning: Architecture Analysis`

Required sections:
- **Approach**: 1-3 sentences describing the implementation strategy
- **Files to Create/Modify**: Specific file paths with a one-line description of each change
- **Key Decisions**: Architectural choices and rationale
- **Risks & Open Questions**: Edge cases, unknowns, potential problems

### Comment 2 — Test Plan

Header must be exactly: `## 🧪 AI Planning: Test Plan`

Required sections:
- **Unit Tests**: Individual components or functions to test
- **Integration Tests**: End-to-end or cross-component scenarios
- **Manual Verification**: Step-by-step human verification checklist

### Comment 3 — Work Units

Header must be exactly: `## 🔧 AI Planning: Work Units`

Decompose the issue into work units that can be implemented by parallel subagents. Identify which pieces are independent (no dependencies on other units) and which are sequential.

Required format:

```markdown
## 🔧 AI Planning: Work Units

### Independent (can be implemented in parallel)
- **WU-1: Short name** — brief description. Files: `src/file.ts`, `src/other.ts`. No dependencies.
- **WU-2: Short name** — brief description. Files: `src/another.ts`. No dependencies.

### Sequential (must follow independent units)
- **WU-3: Short name** — brief description. Files: `src/file.ts` (update), `tests/integration/foo.test.ts`. Depends on: WU-1, WU-2.
```

Each work unit must specify: name, description, files it touches, and dependencies (or "No dependencies").

### Comment 4 — Cross-Story Context (conditional)

Only post this comment if `${PARENT}`, `${DEPENDENCIES}`, or `${SIBLINGS}` is not "None" AND there is meaningful coordination needed.

Header must be exactly: `## 🔗 AI Planning: Cross-Story Context`

Required sections:
- **Upstream Dependencies**: What must be done before this story
- **Downstream Impact**: Stories or systems that will depend on this work
- **Coordination Notes**: Specific actions needed to coordinate with other teams or stories

Base your analysis on what you actually find in the codebase — avoid generic boilerplate.
