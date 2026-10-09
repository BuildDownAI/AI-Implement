# 038. A project review process is one definition: who reviews and who fixes

**Status:** Accepted
**Date:** 2026-10-09
**References:** ADR 020, [AII-1175](https://linear.app/eudoxus/issue/AII-1175/add-a-per-project-review-process-with-claude-code-review-as-the-first), [AII-1177](https://linear.app/eudoxus/issue/AII-1177)

## Context

The orchestrator has no named definition of who reviews a PR and who fixes it. Two fixed author lists (`TRUSTED_REVIEW_COMMENT_AUTHORS` in `src/webhook.ts` and in `src/pipeline/review-ledger.ts`) and one fixed set of check names (`DEFAULT_REVIEW_CHECK_NAMES` in `src/pipeline/steps/post-push-review.ts`) stand in for one. Nothing ties them together as one process, so a project cannot select another.

Two reviewers matter now:

- **`anthropics/claude-code-action@v1` in a repository's own workflow** posts as `claude[bot]`: a COMMENTED review with inline comments and one tracking comment, plus a check run named by the job (`review`) from app `github-actions`. It emits no severity markers, no severity line, and no findings block.
- **The hosted Claude Code Review service** posts a check run `Claude Code Review` from app `claude`, always `neutral`, whose Details end with `<!-- bughunter-severity: {"normal":N,"nit":N,"pre_existing":N} -->`, and inline comments marked 🔴 Important, 🟡 Nit, 🟣 Pre-existing.

## Decision

**1. A review process is one definition in one table.** `src/review-process.ts` exports `REVIEW_PROCESSES`, keyed by `ReviewProcessId` (`ai-implement`, `claude-code-review`). Each entry names its trusted authors, its check pairs, a verdict reader, and its fixer. The functions are plain: no `ctx`, no store writes, no I/O. The table has the shape of `src/restate/kg-refresh-senders.ts`.

**2. A check pair is a name set plus the app that posts it.** A run matches a pair only when its `app.slug` and its name (case-insensitive) both match. The marker `project-review-check-names` stands for the project's `reviewCheckNames`, or `DEFAULT_REVIEW_CHECK_NAMES` when none are set; the module holds a copy of the defaults because it has no project settings. So `Claude Code Review` from `github-actions` is not the `claude` pair, and its severity line is not read.

**3. The verdict is read from the strongest source present.** For `claude-code-review`:

| Order | Source | Result |
| -- | -- | -- |
| 1 | A findings block (ADR 020) from a trusted comment | its verdict and findings, `review-contract`; a block with no verdict is `incomplete` |
| 2 | A completed `claude` check whose Details parse as a bughunter line | `normal > 0` is `changes_requested`, else `approve`; `bughunter-severity`. The check's `neutral` conclusion is not read |
| 3 | A completed `github-actions` pair check | `success` and no `blocking` inline finding on the head is `approve`; a `blocking` finding is `changes_requested`; any other conclusion is `no-real-verdict`; `check-and-comments` |
| 4 | No matching completed check | `incomplete` |

`ai-implement` reads only the newest block; no block is `no-real-verdict`.

**4. Inline comments count only from a trusted bot on the head.** The author must be trusted, `authorType` must be `Bot`, and `commitId` must equal the head SHA or be absent. 🔴 is `blocking`, 🟡 is `minor`, 🟣 is no finding, and an untagged comment is recorded as `minor`. The webhook already stores an inline comment as non-blocking, and a process must not turn every nit into a merge block.

**5. An unknown id resolves to `ai-implement`, silently.** A stored value from a newer orchestrator must not stop every review on an older one.

**6. Trust is spelled out.** The definition can approve a PR, so every entry's author list and `appSlug` are asserted in `src/__tests__/review-process.test.ts`. A project can add authors through `isTrustedReviewAuthor`'s `extra` list; it cannot remove built-in ones. `ai-implement` trusts `github-actions[bot]`, which the ledger's current set does not; consumers widen what that author can approve when they adopt this table.

**7. The fixer is a field.** `ReviewFixer` is `ai-implement` or `repository`. Both built-in entries use `ai-implement`; `repository` is reserved for a process whose own workflow fixes the PR.

## Consequences

- Nothing reads the table yet. The consumers are the project setting (AII-1179), the webhook and ledger (AII-1181), `post-push-review` (AII-822), and the fix hand-off (AII-1188). `TRUSTED_REVIEW_COMMENT_AUTHORS` stays where it is until then.
- A repository can add the ADR 020 block to its review prompt to reach source 1. That is optional.
- Rollback is a revert.
