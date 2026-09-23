# 027. A bot review starts a fix run only for the current, unread head

**Status:** Accepted
**Date:** 2026-09-23
**References:** ADR 026, `docs/review-fix-rail.md`, Answer9 PR #1060 (push → Codex review → new run → push loop)

## Context

The review-fix rail enqueues a fix run for every `pull_request_review` with state
`CHANGES_REQUESTED`, every `pull_request_review_comment`, and every trusted-author summary comment.
It did not read the reviewer's identity or the review's `commit_id`. Codex reviews a PR on open and
on request, and each inline comment is its own webhook event.

This produced a loop. A review-fix run pushed, Codex reviewed that push, the review enqueued a new
run, and that run pushed again. The obvious fix, "ignore a review of a head the pipeline already
evaluated", does not work here, for two reasons:

- Post-push review waits only for **check runs**. Codex posts a PR review, not a check run, so the
  step never waits for it.
- Post-push review is skipped on every gap-fill run (`pipeline-loader.ts`). No run ever evaluates
  the head that a review-fix run pushes.

## Decision

Human reviews always enqueue. A review whose author has `user.type == "Bot"` enqueues only when
both of these hold:

1. Its `commit_id` equals the PR's current head SHA (from the webhook payload).
2. No run on the PR started after the review's `submitted_at`.

A bot review of an old head is stale: the head it describes no longer exists. A run that started
after the review reads the review itself when it reads the PR. So one Codex round on a head that a
run pushed and left produces exactly one fix run. The per-PR dispatch budget bounds the rounds.

We store no per-run head SHA to do this.

## Alternatives considered

- **A bot review never enqueues.** Rejected: Codex catches spec errors that the internal reviewer
  structurally cannot, and those findings would wait until something else started a run.
- **Gap-fill runs also run post-push review and wait for Codex.** Rejected for now: it adds a wait
  of about five minutes to every run, and it needs a new "wait for a bot review" path because Codex
  has no check run. It remains the more thorough option if the budget proves too loose.
- **Persist each run's final head SHA and compare it.** Rejected: the payload already carries the
  current head. A new column and a callback field buy nothing that rule 1 does not.

## Consequences

- Easier: the loop on a Codex-reviewed PR ends after one fix run per Codex round. Stale inline
  comments from an old head stop enqueueing.
- Harder: a bot that reviews and then pushes (a bot co-author) is treated as a reviewer, not as a
  human. Human reviews still enqueue without limit, bounded only by the per-PR budget.
- The rule depends on `commit_id` and `head.sha` in the webhook payload. A replayed or synthetic
  event without them does not enqueue for a bot author.
