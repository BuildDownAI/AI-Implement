# 014. Child-PR auto-merge requires the runner's approval mark on the run record

**Status:** Accepted
**Date:** 2026-09-06
**References:** AII-560 (merge-ordering umbrella), AII-460 (gate consolidation), AII-553 (in-flight window), AII-471, AII-453 (benign terminals), `docs/feature-branch-grouping.md`, `docs/review-fix-rail.md`

## Context

Feature-branch grouping auto-merges a child PR into its grouping branch (`src/auto-merge.ts`).
The gate reads GitHub-side signals: the PR is not a draft, the combined checks are green, and no
reviewer has requested changes. AII-471 added an in-flight guard joined on `dispatch_log.pr_url`;
AII-553 added a second guard keyed on the issue identifier, because `pr_url` is written at the
end of an initial run and the first guard was blind for the whole review cycle.

None of those signals can carry the runner's verdict. GitHub rejects `APPROVE` and
`REQUEST_CHANGES` on a self-authored PR, so the runner's post-push review can only submit
`COMMENT` reviews, and the gate skips `COMMENTED` reviews by design. A post-push review that
ends `REVIEW_UNAPPROVED` does not convert the PR to draft. And the run record does not hold the
verdict either: the result callback records the PR URL on success and nothing on a coded
failure, so the execution-layer monitor terminalizes the row later with its own conclusion —
`success` for a green GitHub Actions job, the machine conclusion on Fly, `exit_<code>` locally.
An approved run and an unapproved run leave the same row. Once the run ends, the gate merges an
unapproved child PR. That is AII-460, and no in-flight guard closes it.

The one mechanism that already lets a runner-written conclusion survive the monitor's later
write is the `CASE` guard in `updateJobStatus` (`src/log.ts`), added by AII-453 for
`operator_cancelled`.

## Decision

The runner's result callback writes the conclusion `runner_approved` on the dispatch row when a
successful implementation run reports a PR, and the `CASE` guard preserves that value. The
auto-merge gate merges a child PR only when the run record allows it: no run for the child issue
is non-terminal, and the latest run for the issue is terminal with the approval mark. A PR with
no run record is held. The gate keys on the issue identifier, which exists on the row from
dispatch; the `pr_url` join and the runner's early `pr_url` progress write are removed.

The GitHub-side vetoes stay as vetoes: a draft PR, red checks, or a human's changes-requested
review still block a merge. They never authorize one.

The gate does not compare the approved head to the current head. The checks on the current head
already gate a post-approval push, which is today's behavior.

## Alternatives considered

- **A failure mark on unapproved runs, merge when absent** — fails open. A runner that dies after
  the push never sends a result; the monitor writes `success`, and the gate merges an unreviewed
  PR. Rejected because a missing callback must hold, not merge.
- **A new column for the runner's outcome** — a migration and its own issue, for one value the
  existing conclusion column and its guard already carry. Rejected as surface without benefit.
- **A GitHub-side signal** — impossible for the verdict: GitHub returns 422 for a blocking review
  on a self-authored PR, and a draft conversion after the push would hide the PR from reviewers
  who expect a ready PR.
- **Keep the `pr_url` join and make the early write reliable** — the join keys on data that does
  not exist when the guard first runs; ADR 013 records why guards key on data present at dispatch.
- **Carry the approved head SHA** — needs a runner contract change and a column, to prevent a case
  the CI checks already cover.

## Consequences

Easier: one predicate decides merge readiness, and it fails closed. A row terminalized by the
stuck watchdog, the reaper, or a machine sweep never merges anything. The review-fix rail can
apply the same PR-state read to skip a merged PR instead of dispatching a fix run against it.

Harder: a human-opened PR into a grouping branch no longer auto-merges; a person merges it. An
unapproved child is held rather than landed, so a capped child stalls its cascade on purpose;
AII-263 remains the issue for automating that recovery. Every new benign terminal on the runner
side must be reported through the result callback, and the runner's own PR writes must go through
one guarded path so a merge mid-review becomes `pr_merged` rather than a failed run (the AII-453
pattern, extended under AII-560).
