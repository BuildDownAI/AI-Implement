# 026. One writer per PR, and an issue with an open PR is never re-implemented

**Status:** Accepted
**Date:** 2026-09-23
**References:** ADR 017, ADR 018, AII-651, Answer9 incidents ANS-966 (dispatches 834, 836, 837) and PR #1073 (lost attribution fix)

## Context

Several independent triggers dispatch runs onto the same PR branch: the poll loop, the review-fix
drain (`processReviewFixQueue`), the comment gap-fill drain (`drainCommentGapfillQueue`), and the
legacy `POST /trigger/gap-fill` route. Only the poll loop checked for a run in flight. The two
drains dispatched a second run onto a PR that already had one running, and the legacy route wrote
no run record at all, so no check could see its run.

A second path overwrote work. When a run with an open PR failed and its dedup row cleared, the poll
loop started a fresh implementation. The branch name comes from the issue key and title
(`src/pipeline/branch-name.ts`), and an initial run's push leases against the remote SHA it reads
just before pushing. The fresh run therefore force-overwrote the open PR's branch, including
review fixes that another run had pushed.

ADR 018 plans a Restate Virtual Object for one-at-a-time execution, with a conditional insert of
the dispatch row as the fallback. The main pipeline migrates only after ADR 018's evaluation gate,
which is at least two migrations away.

## Decision

1. **One predicate gates every dispatch.** One exported function decides whether a run may start
   for an issue. The poll loop, the review-fix drain, and the comment gap-fill drain all call it.
   It is keyed by the issue, not the PR: every gap-fill run record carries its issue's id, so
   "a run for this issue is in flight" (`getInFlightIssueIds`) already means "a run is writing to
   this issue's PR". A drain that finds the issue in flight leaves its queue row pending. The
   queue already merges repeated events into one row per PR, so one later run handles all of them.
2. **We build it now, in SQLite.** The later Restate migration replaces the predicate's body and
   keeps its callers.
3. **We delete `POST /trigger/gap-fill`.** A dispatch path that writes no run record defeats every
   guard. Envelope repos use the webhook comment rail instead.
4. **An issue with an open PR gets gap-fill runs only.** When the poll selects an issue whose run
   record names an open PR, it dispatches a gap-fill run on that PR, never a fresh
   implementation. A human who wants a fresh start closes the PR first.
5. **A push that loses its lease fails with `GIT_LEASE_REJECTED`, and the orchestrator re-enqueues
   a review-fix for the PR only when the bot identity wrote the new head commit.** When a human
   pushed, the orchestrator stops and comments that a human pushed to the branch and that
   `/ai-implement` resumes the run. A human push means a human is working, and the bot must not
   race them. The runner does not rebase onto the new head, because that silently combines two
   runs' changes that nobody reviewed together.
6. **Gap-fill runs respect the team's capacity cap** (`maxInProgressAiIssues`). A queue row waits
   while the team is at capacity. Without this, one burst of external reviews starts one run per
   PR at the same time.

## Alternatives considered

- **A new lock keyed on repo + PR number.** Rejected: it needs a new column and a new write on
  every path. The issue key already covers it once decision 4 removes the "one issue, two PRs"
  case.
- **Wait for the Restate migration.** Rejected: Answer9 loses work today, and the migration is not
  scheduled.
- **Rebase and retry on a lease rejection.** Rejected: it merges unreviewed concurrent work.
- **Hold an issue with an open PR for a human.** Rejected: the work exists, and only its review is
  incomplete. A gap-fill run is the cheaper, correct next step.

## Consequences

- Easier: a lost update becomes a visible, coded failure followed by one retry, not silently lost work.
  One predicate answers "may this run start".
- Harder: a review that arrives while a run is in flight waits for that run to end. A record that
  stays "running" without cause now blocks its PR, so dead-run reconciliation becomes a
  prerequisite, not a nice-to-have.
- Follow-on: the per-PR dispatch budget bounds retries from decision 5. Legacy repos that still
  call `/trigger/gap-fill` lose that trigger.
