# 028. The fixing agent gives each finding a disposition and may defer out-of-scope ones

**Status:** Accepted
**Date:** 2026-09-23
**References:** ADR 019, ADR 020, ADR 027, AII-285, AII-1582, AII-1583, AII-1087, AII-1347, Answer9 ANS-966 (external review scope creep ran the issue out of cycles)

## Context

An external reviewer (Codex) does not know the issue a PR implements. It reports what it sees,
including improvements the issue never asked for. Two paths hand those findings to an agent with
an instruction to fix them all:

- The in-run fix pass in post-push review ("Fix every listed issue… Treat the list as a required
  repair plan").
- The review-fix run, whose task text is only "Address late review feedback on PR #N". The agent
  reads the PR thread and treats every comment as work.

On ANS-966 this spent the iteration budget on scope the issue did not contain, and the issue failed.
The ledger had no finding state other than `open` and `resolved`, so an out-of-scope finding gated
the merge until someone fixed it.

## Decision

1. Both fix paths receive the open ledger findings (with their ids) and the issue's acceptance
   criteria in a runner-appended prompt block. `WORKFLOW.md` is seeded once, so it cannot carry
   this.
2. The agent writes one disposition per finding id: `fixed`, `follow-up`, or `invalid`, each with a
   one-sentence reason, in a structured output file that the runner reports to the orchestrator.
3. The scope rule is stated in the prompt: **a finding that reports a defect in lines this PR
   changed is always in scope.** Only a request for behavior that the issue does not require may be
   a `follow-up`.
4. The runner acts on each `follow-up` in both fix paths: it replies on the review thread with the
   reason and resolves the thread. The runner already holds a PR token, and the orchestrator
   would need the thread ids that only the runner reads. The runner reports every disposition on
   the result callback. The orchestrator then sets the finding to `deferred` and posts one list of
   deferred findings on the issue. A `deferred` finding does not gate the merge, and a later report
   of the same finding does not reopen it. The runner's thread replies carry an
   `<!-- ai-implement` marker, so the webhook never treats them as a new review.
5. The deferral takes effect at once, on every PR, including an auto-merging child PR. The
   top-of-tree PR is human-reviewed and shows every deferral in the tree.
6. The orchestrator files no tracker issues. A human triages the list.

## Alternatives considered

- **The orchestrator classifies scope before it enqueues.** Rejected: that needs a model call in
  the orchestrator and the issue context at webhook time. The fixing agent already has both.
- **File a follow-up issue automatically for each deferral.** Rejected: it fills the backlog with
  issues that nobody triaged. The provider interface also has no create method today.
- **Hold an auto-merging child PR until a human accepts each deferral.** Rejected: it restores a
  human stop on every child, which grouping exists to remove.

## Consequences

- Easier: an external reviewer's scope no longer spends the issue's iteration budget. A deferral is
  visible in three places: the thread reply, the ledger, and the issue comment.
- Harder: the agent now judges its own scope. The defect-on-changed-lines rule is the guard, and it
  is enforced only by the prompt. A wrong deferral on a child PR reaches the feature branch, and a
  human sees it only at the top-of-tree review.
- Follow-on: the `deferred` state is one piece of AII-285's findings-accounting loop.

## Amendment (2026-10-28): deferral also applies at the verdict level

Decision points 4 and 5 say a `deferred` finding does not gate the merge, but the verdict-level checks
did not follow them. On PR #1328 (AII-1580) the fix pass deferred the only external finding. The head
did not move, so the external `claude-review` did not run again and its `changes_requested` verdict
stayed. The run ended `invalid_review` with no approval mark, and the PR waited for a human.

- **Rule:** a `changes_requested` external verdict whose listed findings are all `deferred` in the
  ledger does not hold the merge. An external verdict still counts only for its own PR head (AII-1087,
  AII-1347); this amendment does not change that.
- **Owner:** the Restate `LateExternalReview` workflow (`src/restate/late-external-review.ts`,
  `newestReviewRejectsHead`) decides and writes the approval mark. When the internal review is clean
  but the external verdict blocks, the in-run gate (`src/pipeline/steps/post-push-review.ts`) does not
  approve; it hands the PR to `LateExternalReview` and waits.
- **Fail closed:** every listed finding needs a ledger row (`getReviewFindingsByKeys`) and every row
  must be `deferred`. A missing row means the deferral was never recorded, so the verdict still holds
  the merge. So does a `changes_requested` verdict that lists no findings (`changes_requested-empty`).

The alternatives rejected above still hold; none relied on the verdict-level behavior.
