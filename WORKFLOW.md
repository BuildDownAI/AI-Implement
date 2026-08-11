---
# Model for implementation and review passes. Passed to `claude --model`
# verbatim, so any ID this repo's provider accepts works. This repo's mapping
# runs on the Anthropic provider; replace with a Bedrock model ID if that changes.
model: claude-sonnet-4-6
---

<!--
  AI-Implement's OWN implementation prompt, used when the orchestrator dispatches a runner at this repository. The template distributed to target repos is a separate file — workflows/WORKFLOW.md — and edits here do not propagate to it.

  The runner strips this front matter and these comments, substitutes ${ISSUE_ID}, ${ISSUE_IDENTIFIER}, ${ISSUE_TITLE}, ${ISSUE_DESCRIPTION} and ${PR_NUMBER}, then sends the rest as the prompt. Any other ${UPPER_SNAKE} token is replaced with an empty string, so don't write shell examples containing one. CLAUDE.md is also loaded automatically on every invocation, so the pointer below is deliberate redundancy: that behaviour is documented but implicit, and an instruction resting on it fails silently if it ever changes. Repo conventions belong in CLAUDE.md, not here.
-->

Read `CLAUDE.md` before you begin. It carries this repository's architecture, the conventions that differ from tool defaults, and the pitfalls worth knowing before you touch the pipeline.

This run is a **gap-fill** if a pull-request number appears between these quotes: "${PR_NUMBER}". If it is empty, this is a **new implementation**. Follow only the matching section below.

---

## New implementation

Implement the issue in the current checkout. Do not create or switch branches, and do not commit, push, or open a pull request — leave your changes unstaged and uncommitted. The pipeline makes the commit, pushes an issue-scoped branch, and opens the pull request once the review pass approves the work.

Then write an implementation summary to `ai-output/comments/01-summary.md`. The orchestrator posts that file to the ticket verbatim, and it is the only account of your reasoning the issue ever receives — without it the ticket gets a bare pull-request link and nothing else. Cover what you changed and why, the judgement calls you made and what you rejected, and how you satisfied each acceptance criterion. Do not post to Linear yourself; the orchestrator owns every ticket write.

Anything under `ai-output/` is excluded from commits, so writing there never affects the pull request.

---

## Gap-fill instructions

You are adding missing work to existing pull request #${PR_NUMBER}. Do not create a new branch or pull request. Commit to the branch already checked out and push it yourself — this is the one path where the pipeline does not handle git for you. Read the review feedback on the pull request to see what is outstanding.

Write what you addressed to `ai-output/comments/01-gap-fill-summary.md`.

---

## Working efficiently

Each pass has a turn cap, and exploration is where caps are usually spent.

**Batch independent tool calls into a single message.** Reading three files and grepping for a symbol do not depend on each other — issue them together rather than one per turn. Surveying a change here typically means reading two to four source files plus their tests: one turn batched, five or more sequentially. Only sequence when one call's input genuinely depends on another's output.

**Prefer `Read`, `Grep`, and `Glob` over their shell equivalents.** A `Bash` pipeline ending in `head` or `tail` silently truncates its own output, and absence of a match in truncated output is not evidence of absence — that is how a confident wrong conclusion gets reached. Use `Grep` to locate and `Read` to read the surrounding context.

If you approach the cap before finishing, say what remains rather than quietly narrowing scope.

---

## Issue

**Identifier:** ${ISSUE_IDENTIFIER}
**Title:** ${ISSUE_TITLE}

${ISSUE_DESCRIPTION}

---

## Verifying your work

Run both before you consider the work finished:

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

The pipeline runs these again after the review pass, but **only records the result — it does not block the pull request on it.** A failure you don't catch ships anyway, so treat these as yours to pass, not as a safety net.

There is no lint script in this repository. Do not invent one or add a linter.

Two things make a green pair misleading:

- `tsconfig.json` excludes `src/__tests__`, so type errors in a test file are caught by neither command. Type-check any new test file explicitly.
- `noUnusedLocals` and `noUnusedParameters` are enabled, so a leftover import or an unused parameter fails `typecheck` even when the logic is correct.

---

## Before you finish

- [ ] `npm run typecheck` and `npm test` both pass
- [ ] Any new test file type-checks despite being outside `typecheck`'s scope
- [ ] Every acceptance criterion is met, or the summary says why it is not
- [ ] No debug output, `console.log`, or commented-out code left behind
- [ ] No unrelated files changed
- [ ] `ai-output/comments/01-summary.md` written (or the gap-fill equivalent)
