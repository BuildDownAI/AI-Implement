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
  Claude writes exactly 3 structured comment files, which the orchestrator posts to
  the ticket after the run. Headers are parseable so the implementation workflow
  can locate them later:

    ## 🗺 AI Planning: Implementation Map
    ## ✅ AI Planning: Acceptance Bar
    ## ⚠️ AI Planning: Risks & Open Questions

  Cross-Story coordination content folds into the Map's constraints section when
  dependencies exist — there is no separate cross-story comment.

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
cat > ai-output/comments/01-implementation-map.md <<'EOF'
## 🗺 AI Planning: Implementation Map

(comment body here)
EOF
```

Write EXACTLY these comments, in this order (filenames matter — they sort lexicographically):

### Comment 1 — Implementation Map

Filename: `ai-output/comments/01-implementation-map.md`
Header must be exactly: `## 🗺 AI Planning: Implementation Map`

**Consumer: the implementer.**

Required content (total comment must not exceed 60 lines):
- **Approach**: at most 3 sentences describing the implementation strategy
- **Files** section with canonical verb bullets — the implementer and the dispatch guard both parse this:
  ```
  ## Files
  - Create: `src/new-module.ts`
  - Modify: `src/existing.ts`
  - Test: `src/__tests__/existing.test.ts`
  - Delete: `src/old-module.ts`
  ```
  Use exactly one of `Create`, `Modify`, `Test`, or `Delete` per line, with the path backtick-quoted.
- **Constraints & Hazards**: repo-discovered load-bearing tests, generated files, migration order constraints, or integration seams the implementer must not break. If `${DEPENDENCIES}`, `${SIBLINGS}`, or `${PARENT}` is not "None", fold any cross-story coordination notes here rather than writing a separate comment.

Append this machine block as the very last lines of the comment (fill in the `files` array and `risk` value):

```
<!-- ai-implement-planning
v: 1
files: ["src/a.ts", "src/b.ts"]
risk: low|medium|high
-->
```

### Comment 2 — Acceptance Bar

Filename: `ai-output/comments/02-acceptance-bar.md`
Header must be exactly: `## ✅ AI Planning: Acceptance Bar`

**Consumer: the reviewer.**

A numbered list of falsifiable claims. Each claim must be directly checkable against the diff or by running a specific command — no generic test enumerations ("all tests pass" is not a claim). Example form:

```
1. `parseDeclaredFiles` returns a non-empty set for `- Modify: \`src/foo.ts\`` input.
2. `npm test -- --reporter=verbose 2>&1 | grep "linear-planning-fetch"` exits 0 with ≥ 6 passing cases.
3. `src/pipeline/steps/implement.ts` contains no reference to `WorkUnit` or `workUnits`.
```

### Comment 3 — Risks & Open Questions

Filename: `ai-output/comments/03-risks.md`
Header must be exactly: `## ⚠️ AI Planning: Risks & Open Questions`

**Consumer: the implementer and reviewer.**

Edge cases, unknowns, and potential problems discovered during codebase exploration. Base your analysis on what you actually find — avoid generic boilerplate.
