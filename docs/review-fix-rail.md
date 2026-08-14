# Review-fix rail

How review feedback on an AI-Implement pull request becomes another run. Covers the finding ledger, the four `review_*` tables, the webhook events that feed the queue, the drain loop, and how findings get resolved.

This is the reference for `src/review-ledger-store.ts`, `src/review-fix-queue.ts`, `src/pipeline/review-ledger.ts`, `src/pipeline/steps/post-push-review.ts`, and the review-handling half of `src/webhook.ts`. `CLAUDE.md` carries the summary and points here.

## What it does

An AI-Implement PR attracts review feedback from several places: the pipeline's own post-push review, a GitHub Code Review bot, and human reviewers leaving formal reviews or inline comments. The rail turns all of that into a single deduplicated ledger of findings per PR, and dispatches gap-fill runs to address them.

It has two halves that share the ledger:

- **In-run** — the `post-push-review` step, which reviews and fixes within the original run, before it ends.
- **Post-run** — webhook events arriving after the run finished, which enqueue a fresh dispatch.

The second half is the reason the rail exists. Without it, any review posted after the run completed lands on a PR nobody is watching.

## Prerequisites

The post-run half is **entirely webhook-driven**. Three GitHub event subscriptions feed it, and a repo subscribed to none of them silently gets no rail at all — no error, no log line, just a PR that never receives a fix run:

| Event | Gate | Recorded as |
|-------|------|-------------|
| `pull_request_review` | `action=submitted` **and** `state=CHANGES_REQUESTED` | `github-review`, severity `blocking` |
| `pull_request_review_comment` | `action=created` | `github-review-thread`, severity `medium` |
| `issue_comment` | author's `user.type == "Bot"` **and** the body contains a `<!-- claude-review-verdict {...} -->` marker | `claude-review-summary`, severity `blocking` or `minor` |

`GITHUB_WEBHOOK_SECRET` must be set, and deliveries are rejected 401 on an invalid signature. Note that `pull_request` and `issue_comment` are already needed for merge reconciliation and `/ai-implement` handling respectively — the two review events are the ones easily missed.

Every path additionally requires a **matching dispatch record**: the orchestrator looks up the PR against its own dispatch log, and ignores anything it did not create. Reviews on unrelated PRs in the same repo are not picked up.

## Finding identity

A finding's identity is a SHA-256 over its source, path, line, and **normalized** body — whitespace collapsed and lowercased (`stableReviewFindingKey`). The table is unique on `(repo, pr_number, finding_key)`.

Two consequences worth knowing:

- The same finding reported repeatedly collapses to one row, with `last_seen_at` advancing. Re-reporting a **resolved** finding reopens it — the upsert sets `status = 'open'` and clears `resolved_at`.
- A **reworded** finding is a new finding. A reviewer who rephrases the same objection produces a second row, because the hash covers the body.

Collection additionally dedupes in memory by normalized body before anything is stored, keeping the variant that carries a file and line over one that does not.

## The four tables

| Table | Grain | Purpose |
|-------|-------|---------|
| `review_findings` | one row per distinct finding per PR | The ledger. `status` is `open` or `resolved` |
| `review_fix_queue` | **one row per PR** (unique on `repo, pr_number`) | Work queue; `pending` → `dispatched` / `skipped` / `failed` |
| `review_fix_events` | append-only, one per enqueue | Audit trail of what triggered each enqueue, with actor and source URL |
| `review_fix_dispatches` | one per dispatch id | Snapshot of which finding ids a given dispatch is allowed to resolve |

The queue's one-row-per-PR grain is deliberate. Enqueuing coalesces: a second event for a PR already queued updates the existing row rather than adding another, and if the new reason differs from the stored one the reason becomes `multiple`. Three reviewers commenting in quick succession produce one fix run, not three. The `review_fix_events` table is what preserves the individual triggers, since the queue row itself is overwritten.

## Severity, and why an inline comment does not block

Severity is `blocking`, `medium`, or `minor`, and the rule for deciding it is the subtlest part of the rail.

**A reviewer's latest formal verdict is authoritative.** Only reviewers whose most recent actionable review is `CHANGES_REQUESTED` contribute blocking findings. Unresolved inline threads authored by someone who has since approved are recorded as `medium` — non-blocking context. Without that rule, a stale nit thread from an approving reviewer would keep the PR blocked forever.

The `pull_request_review_comment` webhook records `medium` for the same reason from the other direction: that event carries no parent review state, so an inline comment alone cannot be assumed to block. A genuine changes-requested verdict arrives separately via `pull_request_review` and records the blocking finding itself.

Unresolved threads are collected via GraphQL with pagination, and a thread is only collected when it is both **unresolved and not outdated**.

## The rail does not ingest its own output

Findings are collected from bot comments, and the rail itself posts bot comments — so it excludes its own. Two guards:

- Any comment body containing `<!-- ai-implement` is skipped during collection.
- A review whose body carries the native-review marker, or begins with `AI-Implement post-push review`, is ignored at the webhook.

Trusted comment authors are an explicit allowlist (`ai-implement`, `claude`, and their `[bot]` forms), so an arbitrary bot commenting on a PR cannot inject findings.

## In-run: the post-push-review step

The last step of the pipeline. It runs only when the feedback loop approved, something was actually pushed, and a PR number exists.

It runs its own LLM review, then **waits for the external review check** on the PR's current head SHA to reach a terminal state — polling every 5 seconds up to a 5-minute budget — before deciding merge readiness. The wait exists because the external review starts at roughly the same moment; reading findings immediately would read an empty snapshot.

**It fails closed.** If the internal review is clean but the external check has not finished within the budget, the step does *not* auto-approve. It posts a comment saying manual review is required and stops. The same applies when the reviewer returns structurally invalid output.

Internal issues are deduplicated against external findings so the same problem is not reported twice, and fix passes iterate up to the configured maximum. PR comments carry `<!-- ai-implement post-push iter=N ... -->` markers so repeated passes update rather than duplicate.

**External check name matching** uses an explicit name list, not a heuristic. The defaults are `review`, `code-review-plugin`, `claude-review`, and `claude code review`. When no check with one of those names exists for the head SHA, the gate logs a warning listing the names that *were* present and then fails open (so repos without an external review check are not blocked). Configure the exact name for a specific repo with `reviewCheckNames` in `.ai-implement/config.yml`:

```yaml
reviewCheckNames:
  - my-custom-review-check
```

External collection can be disabled per repo via `reviewProviders` in `.ai-implement/config.yml`; when it is, the step skips the wait entirely.

## Post-run: the drain loop

`processReviewFixQueue` runs once per poll tick. For each pending item, in FIFO order:

1. Find the mapping whose `owner/repo` matches. **No mapping → `skipped`.**
2. **Paused project → `skipped`.**
3. Mint result and progress tokens (only when a runner callback is configured).
4. **Snapshot the currently-open finding ids.** This is what the dispatch is permitted to resolve.
5. Dispatch a `gap-analysis` phase run against the existing PR.
6. Record the dispatch with its snapshot, then mark the queue row `dispatched`.

A dispatch failure marks the row `failed` and surfaces a notification; the loop continues to the next item rather than aborting.

**The drain loop dispatches through GitHub Actions specifically** — it calls `dispatchWorkflow` directly rather than going through runner-mode resolution. A project running on Fly Machines still gets its review-fix runs on GitHub Actions.

The synthesized issue title is `Review feedback fix for PR #<n>`, and the phase is reported as `gap-analysis` so the ticket's status does not regress to in-progress for what is a follow-up pass.

## Resolution

When a `gap-analysis` run reports success, the callback resolves findings — and *which* findings depends on whether a dispatch snapshot exists:

- **With a snapshot** — exactly the finding ids captured at dispatch time are resolved.
- **Without one** — everything for that PR last seen at or before the job's dispatch timestamp.

The snapshot is the important case. A finding that arrives *while* a fix run is in flight was never seen by that run, and resolving it would silently drop real feedback. Scoping resolution to the snapshot leaves it open for the next queue event instead.

## Gotchas

- **No webhook subscription means no rail, silently.** This is the single most common way for the post-run half to appear broken.
- **A reworded finding is a new finding.** Expect duplicates when a reviewer restates an objection differently.
- **The queue holds one row per PR**, so a burst of feedback produces one run. Read `review_fix_events` to see everything that contributed.
- **Findings from a review on a PR the orchestrator did not dispatch are ignored**, since every path requires a matching dispatch record.
- **`review_findings` has no retention policy.** Rows persist for merged and closed PRs alike.
- **`pull_request_target` resolves the workflow file from the PR base branch, not the PR head.** A rename of a job in a workflow triggered by `pull_request_target` (such as `claude-review.yml`) must land on the base branch (`main`) before it changes the check-run name visible to the gate. Renaming only on a feature branch renames the `pull_request`-triggered check but leaves the `pull_request_target` check name unchanged, causing the gate to see two differently-named checks and potentially match neither. When the gate logs "No external review check matched", compare the present names against what the base branch's workflow file declares.
- **Renaming a review job name is a silent gate change.** If no check matches the configured or default names, the gate fails open (logs a warning, then approves). Use `reviewCheckNames` in `.ai-implement/config.yml` to pin the expected name and make mismatches visible rather than silently bypassed.
