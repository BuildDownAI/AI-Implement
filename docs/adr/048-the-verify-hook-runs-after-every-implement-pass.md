# 048. The verify hook runs after every implement pass

**Status:** Accepted
**Date:** 2026-11-06
**References:** ADR 001 (custom path precedence), ADR 029 (install failure does not stop the run), [pipeline-architecture.md](../pipeline-architecture.md) § "The `verify` hook runs inside the loop"

## Context

A target repo's `WORKFLOW.md` can name a `verify:` hook script. Before this decision the hook ran once, as the `verify` pipeline step after `push`, and only when the feedback loop had approved. A non-zero exit threw. The agent never saw the output, and the change had already been pushed.

That order fails compiled languages such as .NET, Java and Go. In those repos the only reliable signal that the code builds is the build itself, and that build lives in the hook. The agent can run a build, but nothing makes it do so. The in-loop review reads a diff, not a compiler, so it can approve code that does not compile. The run then pushes that code, and only afterwards does the hook find the error. It reports the error to nobody who can fix it.

## Decision

1. **The hook runs inside the feedback loop.** `runFeedbackLoop` (`src/pipeline/feedback-loop-core.ts`) runs the hook after every implement pass that ends normally, before that pass's review. It does not run after a `max_turns` pass or a provider failure, and it does not run when the first dependency install failed.
2. **A failure goes back to the agent.** A non-zero exit skips that pass's review and counts as one iteration. The exit code and the last 200 lines of redacted output go into the next implement prompt as a "Verify hook failed" block. A missing script counts as a failure, not a crash.
3. **A hook cannot change what ships.** `push` stages with `git add -A`, and the hook now runs before `push`. So the loop snapshots the workspace into a throwaway git index before each hook run and restores it afterwards, pass or fail (`src/pipeline/workspace-guard.ts`). Files the hook changed or deleted come back, and non-ignored files it created are removed. Ignored build output (`bin/`, `obj/`, `dist/`) stays, so incremental builds stay fast. If the snapshot or the restore fails, the hook has run unguarded (fail-open), and the pass records `guarded: false` so the per-pass tables show it.
4. **`VERIFY_FAILED` is its own outcome.** If the hook still fails after the last iteration, the loop ends with `terminationReason: "verify_failed"`. That outcome follows the other unapproved outcomes. An initial run ships a draft PR, and the runner reports `failureCode: "VERIFY_FAILED"` with the hook output. A gap-fill or review-fix run does not push. The PR body, the run autopsy and the ticket comment describe a failing hook, not a review rejection, because the review never examined that pass.
5. **The post-push `verify` step stays as an extension point only.** It skips unless a `custom/steps/verify.ts` override resolves (workspace or `AI_IMPLEMENT_CUSTOM_ROOT`, the same rule as `resolveModuleImport`). When one does, the override runs after push on an approved run, as before. It gets no `scriptPath`, because the loop already ran the hook. An override that wants the hook again reads `context.data.hooks.verify` itself.

Hook output streams to the runner log as it arrives. Only a bounded tail is kept, and it is redacted by value (`redactionSecrets()`, `src/pipeline/redaction.ts`, which covers forwarded secrets whose names have no secret-looking suffix) before it reaches the prompt, the PR body or the ticket.

## Alternatives considered

- **Keep the post-push hook and feed its failure into a new run.** This pushes code that is known not to build, and it spends a whole dispatch on every compiler error.
- **Tell the agent to build in `WORKFLOW.md`.** Templates are seed-once, and an instruction is not a guarantee: the agent can skip the build or misread it, and the review cannot tell.
- **Run the hook without the workspace guard.** A hook that formats code, regenerates files or writes logs into tracked paths would then change what ships, with no review of those changes.

## Consequences

- A repo's hook now runs up to Max Iterations times per run, inside the job timeout. A slow hook costs wall time on every pass, so the template comment asks for a fast script.
- A `KEY=value` line the hook writes to `$GITHUB_ENV` now changes the env of the next implement pass, as `setup` does. The guard reverts files, not the environment.
- A hook that fails for reasons the agent cannot fix (a missing service, for example) now spends iterations and ends `VERIFY_FAILED` instead of failing after push. The ticket comment shows the hook output, so the cause is visible.
- `runHookScript` is now async, and a step's `skip` may return a promise. `runner.ts` awaits it.
