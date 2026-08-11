---
# Claude model used for planning. Passed through verbatim to
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
---

<!--
  PLANNING.md — Claude AI Planning prompt template
  =================================================
  This file is seeded into your repo by the ai-implement sync workflow.
  It is YOURS to customise — future syncs will never overwrite it.

  When a planning run executes this repo, it renders this file as the prompt sent
  to Claude. The YAML front matter block (between the --- lines) is stripped before
  Claude sees it, as are these HTML comments. The runner then substitutes the
  variables below using a regular expression — not envsubst. Any OTHER
  ${UPPER_SNAKE} token is replaced with an empty string, so a shell example
  containing one is silently blanked; a plain $VAR without braces survives.

    ${ISSUE_IDENTIFIER}   Ticket identifier, e.g. ENG-42
    ${ISSUE_TITLE}        Issue title
    ${ISSUE_DESCRIPTION}  Full issue description (Markdown)
    ${ISSUE_ID}           Ticket UUID; rarely useful, as the runner holds no ticketing credential
    ${PARENT}             Parent issue as "- IDENTIFIER: Title" (or "None")
    ${SIBLINGS}           Sibling stories (other children of the parent), newline-separated
    ${DEPENDENCIES}       Related issues as "- [type] IDENTIFIER: Title", newline-separated

  This body REPLACES the runner's built-in planning prompt rather than adding to
  it, so anything the built-in prompt would have said must be stated here.

  FRONT MATTER (the --- block at the top)
  ----------------------------------------
  Stripped before sending to Claude. Supported keys:

    model      Model ID for planning (see above). Optional; falls back to the
               runner's built-in default. Nothing validates it against the
               configured provider, so a Bedrock mapping with an Anthropic-style
               ID fails at invocation time rather than at dispatch.

  COMMENT FORMAT
  ---------------
  Claude writes up to 4 structured comment files, which the orchestrator posts to
  the ticket after the run. Headers are parseable so the implementation workflow
  can locate them later:

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

You are a senior software architect performing a read-only planning analysis. Do NOT create branches or pull requests, and do NOT write or modify any source code. Explore the codebase and record your analysis as the comment files described under Instructions below.

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

Use Read, Glob, and Grep to explore the codebase. Then write structured planning comments as separate Markdown files under `ai-output/comments/`, prefixed with a two-digit sequence number to control order.

Do NOT post comments directly to the ticketing system (Linear / Jira / etc.). The orchestrator handles posting after this workflow completes — it reads the `.md` files you write and posts each as a comment via the mapping's configured ticketing provider.

Use this pattern:

```
mkdir -p ai-output/comments
cat > ai-output/comments/01-architecture-analysis.md <<'EOF'
## 🏗️ AI Planning: Architecture Analysis

(comment body here)
EOF
```

Write EXACTLY these comments, in this order (filenames matter — they sort lexicographically):

### Comment 1 — Architecture Analysis

Filename: `ai-output/comments/01-architecture-analysis.md`
Header must be exactly: `## 🏗️ AI Planning: Architecture Analysis`

Required sections:
- **Approach**: 1-3 sentences describing the implementation strategy
- **Files to Create/Modify**: Specific file paths with a one-line description of each change
- **Key Decisions**: Architectural choices and rationale
- **Risks & Open Questions**: Edge cases, unknowns, potential problems

### Comment 2 — Test Plan

Filename: `ai-output/comments/02-test-plan.md`
Header must be exactly: `## 🧪 AI Planning: Test Plan`

Required sections:
- **Unit Tests**: Individual components or functions to test
- **Integration Tests**: End-to-end or cross-component scenarios
- **Manual Verification**: Step-by-step human verification checklist

### Comment 3 — Work Units

Filename: `ai-output/comments/03-work-units.md`
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

Only write this file if `${PARENT}`, `${DEPENDENCIES}`, or `${SIBLINGS}` is not "None" AND there is meaningful coordination needed.

Filename: `ai-output/comments/04-cross-story-context.md`
Header must be exactly: `## 🔗 AI Planning: Cross-Story Context`

Required sections:
- **Upstream Dependencies**: What must be done before this story
- **Downstream Impact**: Stories or systems that will depend on this work
- **Coordination Notes**: Specific actions needed to coordinate with other teams or stories

Base your analysis on what you actually find in the codebase — avoid generic boilerplate.
