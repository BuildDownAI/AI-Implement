# Review-fix rail

How review feedback on an AI-Implement pull request becomes another run. Covers the finding ledger, the four `review_*` tables, the webhook events that feed the queue, the dispatch gate that enforces one writer per PR, the drain loop, and how findings get resolved and dispositioned.

This is the reference for `src/review-ledger-store.ts`, `src/review-fix-queue.ts`, `src/pipeline/review-ledger.ts`, `src/pipeline/finding-dispositions.ts`, `src/pipeline/steps/post-push-review.ts`, `src/dispatch-gate.ts`, `src/dispatch-breaker.ts`, and the review-handling half of `src/webhook.ts` and `src/runner-callback.ts`. `CLAUDE.md` carries the summary and points here.

## What it does

An AI-Implement PR attracts review feedback from several places: the pipeline's own post-push review, a GitHub Code Review bot, and human reviewers leaving formal reviews or inline comments. The rail turns all of that into a single deduplicated ledger of findings per PR, and dispatches gap-fill runs to address them.

It has two halves that share the ledger:

- **In-run** — the `post-push-review` step, which reviews and fixes within the original run, before it ends.
- **Post-run** — webhook events arriving after the run finished, which enqueue a fresh dispatch.

The second half is the reason the rail exists. Without it, any review posted after the run completed lands on a PR nobody is watching.

## Prerequisites

The post-run half's finding-driven enqueues are **entirely webhook-driven**. Three GitHub event subscriptions feed it, and a repo subscribed to none of them silently gets no rail at all — no error, no log line, just a PR that never receives a fix run:

| Event | Gate | Recorded as |
|-------|------|-------------|
| `pull_request_review` | `action=submitted` **and** `state=CHANGES_REQUESTED` | `github-review`, severity `blocking` |
| `pull_request_review_comment` | `action=created` | `github-review-thread`, severity `medium` |
| `issue_comment` | commenter's login is in the trusted allowlist `TRUSTED_REVIEW_COMMENT_AUTHORS` (`ai-implement`, `ai-implement[bot]`, `claude`, `claude[bot]`, `claude-code[bot]`; `src/webhook.ts:401-407,916`) | `claude-review-summary`, severity per finding, via prose extraction (`extractClaudeSummaryFindings`, `src/webhook.ts:932`) |

The `issue_comment` gate above is a login allowlist, not an author-type check, and it never parses the fenced `review-findings` contract block — that parser (`extractReviewFindingsBlock`, "The review-findings contract" below) is used only by the in-run post-push-review step. A trusted-author comment on the post-run rail is always scanned as prose.

`GITHUB_WEBHOOK_SECRET` must be set, and deliveries are rejected 401 on an invalid signature. Note that `pull_request` and `issue_comment` are already needed for merge reconciliation and `/ai-implement` handling respectively — the two review events are the ones easily missed.

Every path additionally requires a **matching dispatch record**: the orchestrator looks up the PR against its own dispatch log, and ignores anything it did not create. Reviews on unrelated PRs in the same repo are not picked up.

### The bot-review rule

Past the matching-dispatch check, `shouldEnqueueReviewEvent` (`src/webhook.ts:998-1035`) gates all three events one more way. A **bot-authored** event (`user.type == "Bot"`) can loop — a bot reviewing the fix run's own push would otherwise enqueue another run — so it enqueues only when it describes the PR's *current* head and no run has started since:

| Condition | Result | Reason |
|---|---|---|
| Body contains `<!-- ai-implement` | never enqueues, any author | `self` |
| Author is not `Bot` | always enqueues | — |
| Bot author; `commitId` and `headSha` are both present and differ | does not enqueue | `stale_head` |
| Bot author; the event's timestamp is before the latest dispatch recorded for the PR | does not enqueue | `run_after_review` |
| Bot author; `commitId` and `headSha` are both undefined, and the event timestamp is also undefined | does not enqueue | `missing_fields` |
| Bot author; exactly one of `commitId` / `headSha` is defined and the other is undefined | does not enqueue | `missing_fields` |
| Bot author; none of the above | enqueues | — |

The `self` check runs first and applies regardless of author: any event body containing `<!-- ai-implement` is the rail's own output (see "The rail does not ingest its own output" below) and never re-enqueues, so the rail cannot feed on its own comments. See [ADR 027](adr/027-a-bot-review-starts-a-fix-run-only-for-the-current-unread-head.md).

`missing_fields` behaves differently per event type, because only two of the three callers pass real head data. `pull_request_review` and `pull_request_review_comment` events pass the review's/comment's `commit_id` and the PR's current `head.sha` (`src/webhook.ts:612-618`, `676-682`), so a partial pair — one present, one not — is the realistic way to land on the second `missing_fields` row. `issue_comment` events always pass `commitId: undefined, headSha: undefined` (`src/webhook.ts:950-951`), landing on the first row instead — and GitHub always supplies `comment.created_at`, so `eventAt` is normally defined and that row does not fire either. In practice, a trusted bot's `issue_comment` event is gated only by `self` and `run_after_review`; `missing_fields` is reachable there only if the comment timestamp itself fails to parse (`parseEventTimestamp` returns `undefined` on a malformed value).

## Finding identity

A finding's identity is a SHA-256 over its source, path, line, and **normalized** body — whitespace collapsed and lowercased (`stableReviewFindingKey`). The table is unique on `(repo, pr_number, finding_key)`.

Two consequences worth knowing:

- The same finding reported repeatedly collapses to one row, with `last_seen_at` advancing. Re-reporting a **resolved** finding reopens it — the upsert sets `status = 'open'` and clears `resolved_at`. Re-reporting a **deferred** finding does not: the upsert leaves `deferred` rows alone (status and `resolved_at` both), so a fixing agent's follow-up deferral survives a later run that reports the same finding again.
- A **reworded** finding is a new finding. A reviewer who rephrases the same objection produces a second row, because the hash covers the body.

Collection additionally dedupes in memory by normalized body before anything is stored, keeping the variant that carries a file and line over one that does not.

### Revisions

Every row also carries a `revision`, starting at 1 on insert (`upsertReviewFinding`, `src/review-ledger-store.ts`). Every re-report of an existing `(repo, pr_number, finding_key)` row reaches the `ON CONFLICT` branch, regardless of the row's current status, and that branch increments the revision by exactly 1 unconditionally — even when the key and body are byte-identical to the previous report, and even when the row is currently `deferred`. There is no "no-op" re-report that leaves the revision unchanged. Only the `status` and `resolved_at` columns are conditional on the current status (a separate `CASE WHEN` preserves `deferred` rather than reopening them); the revision bump is not gated by it. This is a change from the pre-revision behavior described above: the row still collapses to one, but its revision now moves on every accepted repeat, not just on a substantive edit.

The revision exists so a caller can hold a stale snapshot and detect that the finding moved under it. `markReviewFindingResolvedIfRevision` and `markReviewFindingDeferredIfRevision` (`src/review-ledger-store.ts`) each take an `(id, revision)` pair and update only when the row's current revision still matches — a disposition keyed by an older `(id, revision)` is a no-op against the row, and the newer open report (from the re-report that bumped the revision past the caller's snapshot) is left untouched, still `open`, for the next pass to see. This is what protects a fix run's disposition from silently resolving or deferring a finding that was re-reported after the run took its snapshot.

**These conditional helpers have no current caller.** The legacy disposition path (`markReviewFindingsDeferredByKeys`, used from `src/runner-callback.ts`) still dispositions by key alone, unaware of revisions, and is unchanged by their addition. `markReviewFindingResolvedIfRevision` and `markReviewFindingDeferredIfRevision` exist as the contract surface for a later revision-aware pilot consumer, not as something wired into today's resolution or disposition flow.

## The four tables

| Table | Grain | Purpose |
|-------|-------|---------|
| `review_findings` | one row per distinct finding per PR | The ledger. `status` is `open`, `resolved`, or `deferred`. A fixing agent that dispositions a finding `follow-up` (ADR 028) moves it from `open` to `deferred` — no longer counted as open, but distinct from `resolved` so it is not silently reopenable by a normal resolve call |
| `review_fix_queue` | **one row per PR** (unique on `repo, pr_number`) | Work queue; `pending` → `dispatched` / `skipped` / `failed` |
| `review_fix_events` | append-only, one per enqueue | Audit trail of what triggered each enqueue, with actor and source URL |
| `review_fix_dispatches` | one per dispatch id | Snapshot of which finding ids a given dispatch is allowed to resolve |

The queue's one-row-per-PR grain is deliberate. Enqueuing coalesces: a second event for a PR already queued updates the existing row rather than adding another, and if the new reason differs from the stored one the reason becomes `multiple`. Three reviewers commenting in quick succession produce one fix run, not three. The `review_fix_events` table is what preserves the individual triggers, since the queue row itself is overwritten.

## Webhook intake: atomic acceptance and redelivery (AII-792)

The three post-run webhook handlers (`handleReviewWebhook`, `handleReviewCommentWebhook`, and the `claude_review_summary` branch of `handleIssueCommentWebhook`, all in `src/webhook.ts`) do not call `upsertReviewFinding` and `enqueueReviewFix` directly. They go through `acceptReviewFixWebhookEvent` (`src/review-fix-queue.ts`), which wraps both in one `db.transaction()` and writes it to `review_fix_events.source_event_id` before the handler's `res.writeHead(200, ...)` runs — so a process restart between the durable write and the HTTP ACK loses no accepted feedback, and a caller that never sees the ACK (GitHub redelivers on timeout or 5xx) is safe to retry.

Identity is `(repo, source_event_id)`, computed by `resolveReviewFixEventId` in `src/webhook.ts`: GitHub's `x-github-delivery` header when present (`gh-delivery:<id>`), else the GitHub review/comment ID (`gh-object:<kind>:<id>`), else a SHA-256 over `[repo, prNumber, kind, actor, body, commitId, eventAt, path, line]` (`synthesized:<hex>`). `kind` is one of `pull_request_review` / `pull_request_review_comment` / `issue_comment`, so identically-worded feedback on different event types never collides. `acceptReviewFixWebhookEvent` checks this identity first, inside the transaction: a hit returns the originally accepted `findingIds`/`reviewFixId` without touching `review_findings.revision` or inserting a second `review_fix_events`/`review_fix_queue` row — a second delivery is a no-op, not a second fix run. A miss upserts the finding(s) (bumping `revision`, per "Revisions" above) and enqueues, then records the identity on the new `review_fix_events` row. The handler's JSON response carries `duplicate: outcome.status === "duplicate"` so a caller can tell the two cases apart. The unique index is `idx_review_fix_events_source_event` on `review_fix_events(repo, source_event_id) WHERE source_event_id IS NOT NULL` (`src/dedup.ts`) — scoped by repo, so the same id in two different repos is two distinct events.

The gate (`shouldEnqueueReviewEvent`, below) runs before this seam, not inside it: a bot event rejected by the gate (`self`, `stale_head`, `run_after_review`, `missing_fields`) never reaches `acceptReviewFixWebhookEvent` and so never occupies an identity slot. A thrown DB error (e.g. the sqlite handle is unavailable) propagates out of the handler uncaught — no `{ ignored: true }` 200 is written — and the endpoint's caller in `src/index.ts` turns that rejection into a 500, which is what tells GitHub the delivery failed and should be retried. GitHub does not automatically retry a failed delivery on its own; a human (or an operator script) must trigger redelivery from the repo's webhook settings, which reuses the original `x-github-delivery` GUID — this is what makes the delivery-id path effective for that path in particular.

The internal automatic producers use the same transactional acceptance seam with no findings: `guardOpenPrBeforeImplementationDispatch` (`open_pr`) identifies the PR and its most recent source dispatch, while `handleLeaseRejectedFailure` (`lease_rejected`) identifies the failed dispatch. Retrying the same source event does not reset a dispatched queue row; a later dispatch has a new identity and can requeue it. `/ai-implement` (`enqueueCommentGapfill`, `src/comment-gapfill-queue.ts`) uses a separate queue.

This is the "Restate review-fix pilot" wiring described in CLAUDE.md's issue-tracker bindings — durable webhook acceptance, without picking a lifecycle owner. No lifecycle selection (Legacy vs. Restate, AII-772/AII-804) happens here; every event enqueued this way still runs the pre-existing Legacy dispatch and drain path below.

## Source, severity, and why an inline comment does not block

Severity is `blocking`, `medium`, or `minor`, and the rule for deciding it is the subtlest part of the rail.

Merge gating is source-based, not severity-based:

| Source | Gates a merge? |
|---|---|
| `review-contract` | Yes |
| `github-review` | Yes |
| `github-review-thread` | Yes, when collected from a reviewer whose latest formal verdict is `CHANGES_REQUESTED` |
| `ai-implement-internal` | Yes |
| `claude-review-summary` | No by default — advisory only, unless the project reviewer selection includes `{ id: "claude-review-summary", gates: true }` |

A `minor` `review-contract` finding gates because it came from the structured contract. A `blocking` `claude-review-summary` finding is advisory by default because it came from scraped prose. PR comments split those lists: gating findings stay under "Unresolved external review findings", while prose-only findings are shown under an advisory heading that says they do not block the merge.

**A reviewer's latest formal verdict is authoritative.** Only reviewers whose most recent actionable review is `CHANGES_REQUESTED` contribute blocking findings. Unresolved inline threads authored by someone who has since approved are recorded as `medium` advisory context unless their reviewer still has a changes-requested verdict. Without that rule, a stale nit thread from an approving reviewer would keep the PR blocked forever.

The `pull_request_review_comment` webhook records `medium` for the same reason from the other direction: that event carries no parent review state, so an inline comment alone cannot be assumed to block. A genuine changes-requested verdict arrives separately via `pull_request_review` and records the blocking finding itself.

Unresolved threads are collected via GraphQL with pagination, and a thread is only collected when it is both **unresolved and not outdated**.

## The rail does not ingest its own output

Findings are collected from bot comments, and the rail itself posts bot comments — so it excludes its own. Two guards:

- Any comment body containing `<!-- ai-implement` is skipped during collection.
- A review whose body carries the native-review marker, or begins with `AI-Implement post-push review`, is ignored at the webhook.

Trusted comment authors are an explicit allowlist (`ai-implement`, `claude`, and their `[bot]` forms), so an arbitrary bot commenting on a PR cannot inject findings.

## The review-findings contract

`extractReviewFindingsBlock` (`src/pipeline/review-ledger.ts`) reads a machine-readable verdict from a reviewer comment. It has precedence over heading-based prose extraction and returns early when it finds a fenced block, so a comment that carries one is never also scanned for prose.

The contract is a fenced code block, not an HTML comment — `anthropics/claude-code-action` strips HTML comments (`stripHtmlComments()`) from every comment it posts before the comment is created, which is why the predecessor `<!-- claude-review-verdict {...} -->` marker never once arrived across PRs 543–557. A fenced block survives that transform:

````
```json review-findings
{
  "schema": "review-findings/v1",
  "verdict": "approve" | "changes_requested" | "incomplete",
  "findings": [
    { "severity": "blocking" | "minor", "body": "...", "path": "src/x.ts", "line": 12 }
  ]
}
```
````

`schema` and `verdict` are required; `findings` defaults to `[]`. In a finding, `body` is required, `path` and `line` are optional. `schema` must be exactly `review-findings/v1` — any other value (including a plausible-looking future version) is rejected rather than parsed as v1, so a field whose meaning changes between versions is never read under today's semantics. Every finding from this parser is tagged `source: "review-contract"`; `ReviewLedgerFinding` gets no new field for it. The collector returns the parsed `verdict` with `verdictSource: "review-contract"` so post-push review can fail closed on a structured non-approve verdict even when the block has no findings.

Every state the parser can be in, and its result:

| Comment state | Findings returned | `verdict` | `findingsUnavailable` |
|---|---|---|---|
| No block present | none | `undefined` | `false` — falls back to prose extraction |
| One valid block | its findings | its verdict | `false` |
| Block present, JSON does not parse | none | `"incomplete"` | `true` |
| Opening block fence present without a closing fence | none | `"incomplete"` | `true` |
| Block present, JSON parses but fails the schema | none | `"incomplete"` | `true` |
| `schema` is not `review-findings/v1` | none | `"incomplete"` | `true` |
| More than one block in one comment | the last block's findings | the last block's verdict | `false` |

A broken block, including an opened `review-findings` fence with no closing fence, sets `findingsUnavailable` and does **not** fall back to prose extraction — a reviewer that tried to emit the contract and failed is a broken reviewer, not a prose reviewer, and treating it as prose would hide the breakage.

The trust boundary is unchanged: only a comment from an already-trusted Claude author or the GitHub Actions bot (`isVerdictEligibleAuthor`) is even offered to this parser, so a lookalike block from another bot or a human commenter cannot supersede a real review.

**Migration overlap.** For one release, a comment with no fenced block falls back to scanning for the deprecated `<!-- claude-review-verdict {...} -->` marker, so a reviewer mid-migration is not silently dropped. The first comment seen using that legacy form logs a one-time deprecation warning (a module-level flag, not per-comment). Legacy marker findings keep their old `claude-review-summary` source and are advisory by default.

## In-run: the post-push-review step

The last step of the pipeline. It runs only when the feedback loop approved, something was actually pushed, and a PR number exists.

**It is skipped on gap-fill runs.** The step's `skip` predicate returns early when `ctx.data.prNumber` is already set (`src/pipeline/pipeline-loader.ts:294-296`) — a gap-fill run updates an existing PR and keeps that PR's already-established review flow rather than starting a second post-push review cycle. This is also why a bot review of a review-fix run's own push is never evaluated by this step (see "The bot-review rule" above and ADR 027).

Built-in reviewers return a short `summary` and a `checks` list alongside their
verdict and findings, including when they approve. Each check names what was
examined, its result (`passed`, `failed`, `not_verified`, or `not_applicable`),
and concrete evidence. Gap analysis maps acceptance criteria to implementation;
code review describes relevant behavior, risks, and validation. Reading a test
is distinguished from running it, and checks that were not performed are named
explicitly. These reports appear in the GitHub review and are saved in each
reviewer step's outputs. The final status comment links to that review instead
of repeating the checklist. If review publication fails or returns no usable
link, the status comment retains the full report.

Built-in reviewers must return both report fields; a checklist embedded in the
summary does not satisfy the structured contract. The report fields remain
optional for compatibility with existing custom reviewers.
They explain the verdict; actionable defects must still be in `findings` and
cannot be replaced by report prose. A `not_verified` check records a limitation,
not an automatic blocker; a required fix or validation gap belongs in findings.

It runs its own LLM review, then **waits for the external review check** on the PR's current head SHA to reach a terminal state — polling every 5 seconds up to a 5-minute budget — before deciding merge readiness. The wait exists because the external review starts at roughly the same moment; reading findings immediately would read an empty snapshot.

**It fails closed.** If the internal review is clean but the external check has not finished within the budget, the step does *not* auto-approve. It posts a comment saying manual review is required and stops. The same applies when the reviewer returns structurally invalid output. The internal reviewer itself runs under the retry policy's `reviewMaxTurns` cap (default 30, Settings-configurable; the in-loop reviewer is uncapped): a reviewer that runs out of turns is reported once as `reviewer_turns_exhausted` / `REVIEWER_TURNS_EXHAUSTED` — "the reviewer ran out of turns", never "did not approve" — and a reviewer that fails transiently is retried up to `stageRetries` times before being reported as `provider_unavailable` (see [pipeline-architecture.md](pipeline-architecture.md), "Reviewer turn cap" and "Stage-level retry and provider outages").

**It fails closed on evidence it never got, too.** A check-runs read that errors (`gh api` non-zero) is reported as *unreadable*, not as "no reviewer", and the loop keeps polling; the head-SHA read (`GET /pulls/{n}`) is retried inside the same loop rather than resolved once before it, since an installation token can expire during the review pass that precedes the wait. Exhausting the budget in either state fails closed. The check-runs read is paginated (`--paginate --slurp`) so a review check beyond the first page is not mistaken for absence. Both settling states — *absent* (fail open) and *no real verdict* (fail closed) — must be seen on two **consecutive** probes: absent because it is the one state that fails open, no-real-verdict because a `cancel-in-progress` run's replacement check appears a moment after the cancelled one. Once a matching check has been seen on a SHA, a later empty read is treated as a read artefact rather than as absence, because check runs are never removed from a SHA. Each distinct condition warns once per wait.

**Not every unreadable check-runs response retries to the timeout, though.** A 403 or a 404 (or the `gh` CLI's own "Resource not accessible by integration" / "(HTTP 404)" wording) means the GitHub App's token lacks **Checks: read**, or the installation hasn't accepted an updated permission set — a condition that will not clear on a later poll within the same run. A 404 is treated the same as a 403 here because every check-runs read is only reached once the same token has already read the owning repo/PR successfully this run, so it is "a repo the token can otherwise see" rather than a genuine not-found. That case skips the retry loop entirely and fails closed at once, reported as `checks_permission_denied` / `CHECKS_PERMISSION_DENIED` with a PR comment and tracker message naming the missing permission, rather than burning the wait budget as an ordinary timeout. A transient read failure (a 5xx, a network error) is unaffected and keeps retrying as described above. The same detector also gates the step's separate CI check-runs read (used to fail the gate on a red non-review check) and `getCombinedChecksState` (`src/github.ts`), used by auto-merge (`src/auto-merge.ts`) — a permission denial there holds the PR as `"pending"` instead of reading as `"success"`, and `getCombinedChecksState` fails closed the same way for *any* unreadable check-runs response (a transient 5xx included), not only a permission denial. Either read failing transiently (not on a permission denial) surfaces as a blocking "CI check status could not be verified" issue rather than being read as "no failing checks".

Internal issues are deduplicated against external findings so the same problem is not reported twice, and fix passes iterate up to the configured maximum. PR comments carry `<!-- ai-implement post-push iter=N ... -->` markers so repeated passes update rather than duplicate.

**External check name matching** uses an explicit name list, plus a heuristic fallback. `DEFAULT_REVIEW_CHECK_NAMES` (`src/pipeline/steps/post-push-review.ts:124`) lists five defaults: `review`, `code-review-plugin`, `claude-review`, `claude code review`, and `claude-code-review`. A check whose name isn't in the configured or default list still matches when it contains both `claude` and `review` (`src/pipeline/steps/post-push-review.ts:576-578`), which is what catches an unenumerated variant like a differently-cased `Claude Code Review`. When no check matches by either name or heuristic for the head SHA on two consecutive probes, the gate logs a warning listing the names that *were* present and then fails open (so repos without an external review check are not blocked). Configure the exact name for a specific repo with `reviewCheckNames` in `.ai-implement/config.yml`:

```yaml
reviewCheckNames:
  - my-custom-review-check
```

External collection can be disabled per repo via `reviewProviders` in `.ai-implement/config.yml`; when it is, the step skips the wait entirely.

The `claude-review`/`claude-code-review`/`claude` workflows pin `anthropics/claude-code-action` to v1.0.217 rather than floating `@v1` — a `@v1` build shipped 2026-09-08 that failed the native binary install on every run, silently starving this gate of a verdict. v1.0.217 is pinned rather than a later build because it's the last version upstream confirms works; move the pin forward only once a newer release is confirmed to fix the installer regression (tracked upstream as issue #1817).

## One writer per PR

Every dispatch path — the poll loop, the review-fix drain (`processReviewFixQueue`), and the comment gap-fill drain (`drainCommentGapfillQueue`) — asks one predicate before starting a run: `canDispatch` (`src/dispatch-gate.ts:24-64`). It is keyed by **issue id, not PR**: every gap-fill run record carries its issue's id, so "a run for this issue is in flight" already means "a run is writing to this issue's PR" (ADR 026).

`canDispatch` checks, in this order, stopping at the first match:

| Order | Reason | Meaning | Applies to |
|---|---|---|---|
| 1 | `in_flight` | a `dispatch_log` row for the issue is `dispatched`/`running` | every kind |
| 2 | `dedup` | a `dispatched` row already exists for the issue | `planning`/`implementation` only — skipped for `gap-fill` |
| 3 | `pr_budget` | the PR's gap-fill dispatches in the last rolling 24h reached the project's budget | `gap-fill` only, and only when not human-requested (see "PR dispatch budget" below) |
| 4 | `parked` | the dispatch breaker has parked this issue for the kind's phase | every kind, except a human-requested `gap-fill` |
| 5 | `team_capacity` | the team has no free in-progress slot (`maxInProgressAiIssues`, excluding `kg-refresh` jobs) | `gap-fill` only |

A blocked dispatch is a **deferral, not a failure**: the review-fix and comment gap-fill drains leave their queue row `pending` rather than marking it `failed` or `skipped`, so the next poll tick retries once the blocking condition clears (ADR 026, decision 1).

**Open-PR routing** is what gets a selected issue with an existing PR into a `gap-fill` dispatch in the first place, so it reaches `canDispatch` at all instead of racing a fresh implementation onto the same branch — see "A non-webhook enqueue source" just below, `reason: open_pr`.

**Lease rejection.** A push that loses its optimistic-concurrency lease fails as `GIT_LEASE_REJECTED`. `handleLeaseRejectedFailure` asks GitHub who authored the PR's current head commit: a **bot** head accepts one review-fix event for the failed dispatch (`reason: "lease_rejected"`); a **human** head — and an indeterminate/unknown author, since guessing "bot" would race a human mid-edit — instead posts a sticky comment saying a human pushed and that `/ai-implement` resumes the run, and the run stops without retrying.

**Time limit for in-flight records.** The `in_flight` reason blocks a dispatch for as long as the run record says `running`, so a run that died without reporting would otherwise block its PR forever. `jobTtlDecision` (`src/github-actions-watchdog.ts:56`) and `remediateStuckJob` (`src/stuck-watchdog.ts`) detect a job that has outlived its time limit and close it out with conclusion `ttl_expired` (`src/index.ts:2152-2176`). This is the general job watchdog, not machinery the rail owns — it matters here only because it is what keeps a stuck record from permanently defeating the `in_flight` check.

See [ADR 026](adr/026-one-writer-per-pr-and-an-open-pr-is-never-reimplemented.md).

## PR dispatch budget

Gap-fill dispatches on one PR are capped at `DEFAULT_PR_DISPATCH_BUDGET` (4) per rolling 24 hours, resolved per project by `resolvePrDispatchBudget` (`src/config.ts:18,122-124`); a project overrides it with the **PR Dispatch Budget** setting (blank means the default). [AII-757](https://linear.app/eudoxus/issue/AII-757/park-a-pr-at-its-dispatch-budget-and-ask-for-a-human) is the issue that turned this from a stored setting into an enforced one.

When `canDispatch` returns `pr_budget` for a gap-fill dispatch, the caller parks the issue with `parkIssue(issueId, "gap-analysis", "pr_budget")` (`src/index.ts:916` for the poll/review-fix path, `src/comment-gapfill-drain.ts:102` for the comment gap-fill drain). `parkIssue` returns `true` exactly once — on the transition into parked state — and that transition is what fires the one-time **Needs Human** notice: `prBudgetParkMessage` (`src/dispatch-breaker.ts:117-119`) is posted as both a PR comment and a tracker comment.

A human is not stuck once a PR is parked. A `/ai-implement` comment sets `humanRequested`, which bypasses both the budget check and the `parked` check in `canDispatch` (`src/dispatch-gate.ts:43` and `:50`) — so a human can always run one more pass, and that pass still counts against the budget. Parking otherwise persists until a human calls **Unpark** at `/admin` (`unpark`, `src/dispatch-breaker.ts:137-151`), which clears `parked_at` and resets the consecutive-failure counter so a fresh run of failures is required to re-park.

See the glossary's [PR dispatch budget](../CONTEXT.md#pr-dispatch-budget) entry.

## Reported capacity: reservations, not tracker labels or running-job displays

`GET /api/blockers` (`handleListBlockers`, `src/admin.ts`) reports `capacityByMapping`, one entry per mapping key: `{ used, cap, source: "reservations" }`. `used` is `count(mappingKey)` from `src/dispatch-admission.ts` — the unreleased, non-`kg-refresh` row count in `dispatch_admissions`, the exact same read `acquireDispatch` (`src/dispatch-gate.ts`) checks against `cap` before reserving a slot for a planning/implementation dispatch. `cap` is the mapping's own `maxInProgressAiIssues`. `selectBlockers` (`src/poll-selection.ts`) is fed this same per-team count for its `concurrency` reason, so the blocker preview's `used`/`cap` never drifts from the projection: both read `dispatch_admissions`, never a tracker-provider's business-status label.

This is a deliberate authority split, not an oversight:

- **Planning/implementation capacity** (this projection, and `acquireDispatch`'s own check) is reservation-backed: a slot is spent the instant `acquireDispatch`'s transaction commits — before the external launch call — and freed only by an explicit `release` once a launch is confirmed rejected, cancelled, or a run's termination is verified (see AII-783/AII-791). A reservation with no `dispatch_log` `run_id` yet (the launch call hasn't returned) still counts as used; a tracker label that hasn't advanced (or never will, because the provider write failed) never masks it.
- **`gap-fill`'s `team_capacity` reason** in `canDispatch` (`src/dispatch-gate.ts`, "One writer per PR" above) is a separate, older predicate over `dispatch_log`'s `dispatched`/`running` rows, excluding `kg-refresh` the same way. It is not sourced from `capacityByMapping` and is out of scope for this projection — gap-fill's own migration onto `dispatch_admissions` is a later issue (AII-787).
- **The Admin UI's own capacity display** (`src/admin-ui/pages/overview.ts`) still independently recomputes an in-progress count client-side from `/api/log` + `/api/mappings` — a *running-job* view, not this reservation authority. The two can disagree in the interim: a reservation is held (and shows in `capacityByMapping`) from the moment `acquireDispatch` commits, while a `dispatch_log` row (and so the overview's count) only exists once the dispatch is actually appended, and only reflects `dispatched`/`running` status, not "reserved". Wiring the overview and blocker views onto `capacityByMapping` is [AII-797](https://linear.app/eudoxus/issue/AII-797/show-reserved-capacity-in-admin-views); until it lands, treat the overview page's number as a display of recent activity, not the admission authority.

## A non-webhook enqueue source: an issue selected for dispatch that already has an open PR

Before the poll loop dispatches a fresh implementation for a selected issue, it looks up the
issue's newest recorded PR (`getLatestPrUrlForIssue`, `src/log.ts`) and checks its state
(`guardOpenPrBeforeImplementationDispatch`, `src/index.ts`). An **open** PR is never
re-implemented — a fresh run's push would force-overwrite the open PR's branch (see ADR 026,
decision 4). Instead the issue is routed into this same queue with reason `open_pr`, and
`markDispatched` is called so the issue is not re-selected and re-enqueued on the next poll tick.
A **merged** PR gets no dispatch and no queue row — merge reconciliation completes the issue. A
PR state lookup that fails (network/API error) blocks dispatch for that tick only, so the issue is
re-evaluated on the next poll rather than falling through to a fresh implementation. A **closed,
unmerged** PR still gets a fresh implementation, on the assumption a human closed it to start over.
This check only applies to implementation dispatches, never planning.

## Post-run: the drain loop

`processReviewFixQueue` runs once per poll tick. For each pending item, in FIFO order:

1. Find the mapping whose `owner/repo` matches. **No mapping → `skipped`.**
2. **Paused project → `skipped`.**
3. **Snapshot the currently-open finding ids.** This is what the dispatch is permitted to resolve.
4. Fetch an installation token, then call `getPullRequestState`. **PR merged or closed → `skipped`** with one `[review-fix]` log line; no dispatch is made (`shouldSkipReviewFix` in `src/review-fix-queue.ts`). **PR state unavailable (HTTP error, network failure, or timeout) → keep `pending`** and retry on a later poll. Only a confirmed open PR proceeds to dispatch.
5. Mint result and progress tokens (only when a runner callback is configured).
6. Dispatch a `gap-analysis` phase run against the existing PR.
7. Record the dispatch with its snapshot, then mark the queue row `dispatched`.

A dispatch failure marks the row `failed` and surfaces a notification; the loop continues to the next item rather than aborting.

**The drain loop dispatches through GitHub Actions specifically** — it calls `dispatchWorkflow` directly rather than going through runner-mode resolution. A project running on Fly Machines still gets its review-fix runs on GitHub Actions.

The synthesized issue title is `Review feedback fix for PR #<n>`, and the phase is reported as `gap-analysis` so the ticket's status does not regress to in-progress for what is a follow-up pass.

## Resolution

When a `gap-analysis` run reports success, the callback resolves findings — and *which* findings depends on whether a dispatch snapshot exists:

- **With a snapshot** — exactly the finding ids captured at dispatch time are resolved.
- **Without one** — everything for that PR last seen at or before the job's dispatch timestamp.

The snapshot is the important case. A finding that arrives *while* a fix run is in flight was never seen by that run, and resolving it would silently drop real feedback. Scoping resolution to the snapshot leaves it open for the next queue event instead.

## Finding dispositions

Both fix paths — the in-run fix pass and a review-fix run — receive the open ledger findings and are told to give each one exactly one **disposition** (`Disposition`, `src/pipeline/finding-dispositions.ts:20`): `fixed`, `follow-up`, or `invalid`, each with a one-sentence reason. This exists because an external reviewer does not know the issue's scope and reports improvements the issue never asked for; without a disposition, an out-of-scope finding gated the merge until someone fixed it (ADR 028).

**The scope rule:** a finding that reports a defect in lines the PR changed is always in scope and can only be `fixed` or `invalid` — never `follow-up`. Only a request for behavior the issue does not require may be deferred (ADR 028, decision 3). The rule is enforced solely by the prompt (`buildDispositionInstructions`, `src/pipeline/finding-dispositions.ts:65-77`); nothing in code rejects a wrong disposition.

The agent writes its dispositions to `ai-output/finding-dispositions.json` (`DISPOSITIONS_FILE`, `src/pipeline/finding-dispositions.ts:62`), one entry per finding with `findingKey`, `disposition`, and `reason`. The runner reports them on the result callback, which sanitizes the array (`sanitizeFindingDispositions`, same file) before acting on it.

For each `follow-up` disposition, the runner replies on the finding's review thread with the reason and resolves the thread (`replyToDispositionThreads` → `replyToThread` / `resolveThread`, `src/pipeline/finding-dispositions.ts:108-131,166-196`); the reply carries an `<!-- ai-implement finding-disposition -->` marker, so the webhook's self-guard never treats it as a new review. An `invalid` disposition gets the same thread reply but is not resolved.

The orchestrator then moves the finding from `open` to **`deferred`** (`markReviewFindingsDeferredByKeys`, `src/review-ledger-store.ts:127-137`). `deferred` no longer gates the merge, but unlike a `resolved` finding, it never reopens: the ledger's upsert leaves a `deferred` row's status alone even if the same finding is reported again later (see "Finding identity" above, and contrast with a `resolved` finding, which *does* reopen on re-report). This is deliberate — the fixing agent's follow-up call should survive a later reviewer pass restating the same objection.

The orchestrator posts one issue comment listing every finding deferred by a run (`renderDeferredFindingsComment`, `src/runner-callback.ts:698-718`, invoked from the callback's disposition handling at `src/runner-callback.ts:511-533`). No tracker issue is filed automatically — a human triages the list from that comment.

See [ADR 028](adr/028-the-fixing-agent-dispositions-each-finding-and-may-defer-out-of-scope-ones.md).

## Gotchas

- **No webhook subscription means no rail, silently.** This is the single most common way for the post-run half to appear broken.
- **A reworded finding is a new finding.** Expect duplicates when a reviewer restates an objection differently.
- **The queue holds one row per PR**, so a burst of feedback produces one run. Read `review_fix_events` to see everything that contributed.
- **Findings from a review on a PR the orchestrator did not dispatch are ignored**, since every path requires a matching dispatch record.
- **`review_findings` has no retention policy.** Rows persist for merged and closed PRs alike.
- **`pull_request_target` resolves the workflow file from the repository's default branch (`main`), not from the PR base branch or the PR head.** A rename of a job in a workflow triggered by `pull_request_target` (such as `claude-review.yml`) is not in force until it lands on the default branch — regardless of which branch the PR targets. For example, a PR targeting `testing` will still use the workflow as declared on `main`, so a rename committed only to `testing` does not change the check-run name the gate sees. When the gate logs "No external review check matched", compare the present names against what the **default branch** workflow file declares.
- **Renaming a review job name is a silent gate change.** If no check matches the configured or default names, the gate fails open (logs a warning, then approves). Use `reviewCheckNames` in `.ai-implement/config.yml` to pin the expected name and make mismatches visible rather than silently bypassed.
