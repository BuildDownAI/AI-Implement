# 038. A project review process is one definition: who reviews and who fixes

**Status:** Accepted
**Date:** 2026-10-09
**References:** ADR 020, [AII-1175](https://linear.app/eudoxus/issue/AII-1175/add-a-per-project-review-process-with-claude-code-review-as-the-first), [AII-1177](https://linear.app/eudoxus/issue/AII-1177)

## Context

The orchestrator has no named definition of who reviews a PR and who fixes it. Two fixed trusted-author constants (one in `src/webhook.ts`, one in `src/pipeline/review-ledger.ts`, since deleted) and one fixed set of check names (`DEFAULT_REVIEW_CHECK_NAMES` in `src/pipeline/steps/post-push-review.ts`) stand in for one. Nothing ties them together as one process, so a project cannot select another.

Two reviewers matter now:

- **`anthropics/claude-code-action@v1` in a repository's own workflow** posts as `claude[bot]`: a COMMENTED review with inline comments and one tracking comment, plus a check run named by the job (`review`) from app `github-actions`. It emits no severity markers, no severity line, and no findings block.
- **The hosted Claude Code Review service** posts a check run `Claude Code Review` from app `claude`, always `neutral`, whose Details end with `<!-- bughunter-severity: {"normal":N,"nit":N,"pre_existing":N} -->`, and inline comments marked 🔴 Important, 🟡 Nit, 🟣 Pre-existing.

## Decision

**1. A review process is one definition in one table.** `src/review-process.ts` exports `REVIEW_PROCESSES`, keyed by `ReviewProcessId` (`ai-implement`, `claude-code-review`, `claude-code-review-repository-fix`). Each entry names its trusted authors, its check pairs, a verdict reader, and its fixer. The functions are plain: no `ctx`, no store writes, no I/O. The table has the shape of `src/restate/kg-refresh-senders.ts`.

**2. A check pair is a name set plus the app that posts it.** A run matches a pair only when its `app.slug` and its name (case-insensitive) both match. The marker `project-review-check-names` stands for the project's `reviewCheckNames`, or `DEFAULT_REVIEW_CHECK_NAMES` when none are set; the module holds a copy of the defaults because it has no project settings. So `Claude Code Review` from `github-actions` is not the `claude` pair, and its severity line is not read. The marker resolves to the literal list only: the heuristic fallback in `isExternalReviewCheckName` (any name containing both `claude` and `review`) is not reproduced, on purpose, so a check such as `Claude PR Review` is not matched here. A consumer that wants that heuristic (AII-822) must add it when it wires the module.

**3. The verdict is read from the strongest source present.** For `claude-code-review`:

| Order | Source | Result |
| -- | -- | -- |
| 1 | A findings block (ADR 020) from a trusted comment | its verdict and findings, `review-contract`; a block with no verdict is `incomplete` |
| 2 | A completed `claude` check whose Details parse as a bughunter line | `normal > 0` is `changes_requested`, else `approve`; `bughunter-severity`. The check's `neutral` conclusion is not read |
| 3 | A completed `github-actions` pair check | `success` and no `blocking` inline finding on the head is `approve`; a `blocking` finding is `changes_requested`; any other conclusion is `no-real-verdict`; `check-and-comments` |
| 4 | No matching completed check | `incomplete` |

`ai-implement` reads only the newest block; no block is `no-real-verdict`.

**4. Inline comments count only from a trusted bot on the head.** The author must be trusted, `authorType` must be `Bot`, and `commitId` must equal the head SHA or be absent. 🔴 is `blocking`, 🟡 is `minor`, 🟣 is no finding, and an untagged comment is recorded as `minor`. The webhook already stores an inline comment as non-blocking, and a process must not turn every nit into a merge block.

**4a. A 🔴 heading in a trusted Claude summary comment blocks too (AII-1251).** `claudeCodeReviewVerdict` still never reads the summary, so a green check with no inline comments is `approve` at the verdict. The block comes through the external-findings path instead: the ledger records a heading that starts with 🔴 as `blocking` (🟡 as `minor`, using the same marker mapping as item 4), and under this process a `blocking` `claude-review-summary` finding gates the approval. A summary with only 🟡 and 🟣 sections still approves.

**5. An unknown id resolves to `ai-implement`, silently.** A stored value from a newer orchestrator must not stop every review on an older one.

**6. Trust is spelled out.** The definition can approve a PR, so every entry's author list and `appSlug` are asserted in `src/__tests__/review-process.test.ts`. A project can add authors through `isTrustedReviewAuthor`'s `extra` list; it cannot remove built-in ones. `ai-implement` trusts `github-actions[bot]`, which the ledger's current set does not; consumers widen what that author can approve when they adopt this table.

**7. The fixer is a field.** `ReviewFixer` is `ai-implement` or `repository`. `ai-implement` and `claude-code-review` use `ai-implement`; `claude-code-review-repository-fix` uses `repository`. The webhook, the ledger, and the in-run gate read the definition's `claudeInlineMarkers` and `summaryBlockingGates` fields, never the id.

**8. A third process: `claude-code-review-repository-fix` (AII-1252).** "Claude Code Review, repository auto-fix" is `claude-code-review` (same authors, check pairs, and verdict reader) with `fixer: "repository"`, for a repository whose own workflow (Topia's `claude-fix-review-comments.yml`, started on `workflow_run` after each successful review) fixes Claude's findings. The repository is the only fixer for them, and approval waits for the commit it pushes. It is a third process rather than a checkbox, so "who fixes" stays one decision.

- **In-run rule.** Once Claude's review of the current commit has completed: Claude blocking and the internal review clean ends the run `external_review_pending` with `reviewedHeadSha`, with no fix pass; the internal review blocking and Claude clean runs the fix pass as before; both blocking ends the run unapproved (`REVIEW_UNAPPROVED`) for a person, so two fixers never push at once; neither approves. A failing CI check counts as an internal finding.
- **LateExternalReview follows the head.** The input carries an optional `followHead` (the orchestrator sets it from the project's process when it submits; optional so an in-flight workflow still parses). With it, a head change does not end the workflow. Each tick reads the current head, and a head whose review check run has not completed with `success` reads as `pending` (a `skipped` or otherwise non-success conclusion, as from a workflow that skips bot-authored pushes, does not count), so a commit pushed a moment ago cannot read as clean. Auto-merge applies the same per-head test (`headReviewedClean`) at merge time. It approves when that head's checks pass and no blocking finding was seen at or after its commit time (the AII-1233 rule); a head whose review still has a 🔴 keeps it waiting (it never ends `findings` in this mode), because the auto-fix may push again. It ends `superseded` only when the PR closes; the 30-minute deadline is unchanged. The review check is matched with the process's check pairs and the default check names, not the project's `reviewCheckNames`; an unmatched name times out rather than approving.

## Consequences

- The consumers have landed: the project setting (AII-1179), the webhook and ledger (AII-1181), `post-push-review` (AII-822), and the fix hand-off (AII-1188). The fixed author constants are deleted; trusted authors come from the review process plus the project's Trusted Review Authors. The process applies to every project; only the forward to `ReviewFixPR.feedback` needs the Restate lifecycle.
- A repository can add the ADR 020 block to its review prompt to reach source 1. That is optional.
- Rollback is a revert.
