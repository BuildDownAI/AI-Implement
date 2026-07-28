# Unapproved runs: draft PR, honest outcomes, and post-mortem capture

**Date:** 2026-07-22
**Status:** Approved design, pending implementation plan

## Problem

An implementation run whose feedback loop exhausts all iterations without reviewer
approval currently produces a *silent success*: no PR, no callback, no ticket update,
green GHA job, and the reviewer's rejection feedback discarded. Verified root causes:

1. `src/pipeline/pipeline-loader.ts:148,164` — `preflight` and `push` skip whenever
   `feedback-loop.approved !== true`, dropping the entire back half of the pipeline.
2. `src/run-autonomous.ts:398-406` — reports `outcome: "success"` unconditionally
   after the pipeline completes; a skipped push just yields `prUrl: undefined`.
3. `src/runner-result.ts:60-63` — skips the callback on implementation success
   without a PR. Even if sent, the orchestrator rejects it: `src/runner-callback.ts:150-156`
   returns 400 `missing_prUrl`. The contract cannot express this state.
4. `feedback-loop.ts:254` — `finalFeedback` (the reviewer's rejection reason) is
   returned and consumed nowhere.
5. Latent bug: `feedback-loop.ts:235-251` — when the review step throws, the code
   sets `approved = false; break;` intending to "let the pipeline push the working
   tree", but push's skip condition defeats that intent. The comment describes
   behavior that has never happened.
6. `src/pipeline/timing.ts:137-140` — skipped steps are not recorded, so they
   vanish from the run summary.
7. `src/pipeline/steps/implement.ts:77-85` — the executor's `RunTelemetry`
   (including `numTurns` and the `max_turns` outcome, `claude-stream.ts:46-61`)
   is dropped; the feedback loop is structurally blind to turn-cap exhaustion.

Underlying issues: the outcome model is binary (`success | failure`) and cannot
express "completed but never approved"; approval gates publication instead of
shaping it; diagnostic artifacts are produced then thrown away.

## Goals

- A run that produces code but no approved PR must be **loud and explained**
  everywhere: GHA log, GHA annotations, orchestrator callback, ticket, notifications.
- Work product is never vaporized: if code exists, a **draft PR** is opened with
  the reviewer feedback and run stats, so a human can review 30+ minutes of work.
- Turn-cap exhaustion triggers a **post-mortem** instead of futile re-iteration.
- Every non-converging run leaves durable learning artifacts (draft PR body,
  ticket comment, step log) for later pattern analysis of poor issue scoping.

## Non-goals

- Failing the GHA job red on unapproved runs (warning annotation only — user decision).
- A near-cap turn heuristic (e.g. ≥95%); post-mortem fires only on the hard
  `max_turns` CLI outcome (user decision). Near-cap turn counts are still surfaced
  in stats.
- A new tracker state ("Needs Attention"); reuse the existing
  implementation-failed transition (user decision).
- Retrying/resuming over-budget runs.

## Design

### A. Draft PR on unapproved work

- Remove the approval condition from `push`'s skip in `pipeline-loader.ts`.
  Push always runs after the feedback loop (clone/install failures still abort
  earlier as today).
- `push` gains a `draft: boolean` input, wired to
  `ctx.getOutputs("feedback-loop").approved !== true`. When true:
  - The PR is created with `draft: true` in the `POST /pulls` body.
  - **Fallback:** if GitHub returns 422 for the draft flag (Free-plan private
    repos), retry as a normal PR with title prefix `[NEEDS REVIEW — unapproved]`.
  - The PR body gains an "⚠️ Automated review did not approve" section:
    reviewer's `finalFeedback` verbatim, iterations used (N/N), per-pass
    turns/cost/outcome stats, and the post-mortem (when present).
- If Claude produced no changes, push's existing "Nothing to commit" throw
  becomes the (correct, loud) failure path.
- `preflight` and `verify` remain approval-gated; the draft PR body states that
  preflight/verify were skipped.
- `post-push-review`'s skip is extended with `approved !== true` so no further
  review/force-push cycles run against an exhausted-budget draft.
- This makes the review-throw path in `feedback-loop.ts` (root cause 5) behave
  as its comment intends: the working tree is pushed as a draft.

### B. Telemetry propagation and max-turns post-mortem

- `implement.ts` includes `telemetry` (`RunTelemetry`) in its step outputs.
- The executor retains a compact tool-call trace (tool name + truncated input
  per call — already parsed in `claude-stream.ts`) in telemetry at **both** log
  levels, capped to a fixed entry budget to bound memory.
- `feedback-loop.ts` outputs grow richer:
  - `terminationReason: "approved" | "iterations_exhausted" | "review_error" | "max_turns"`
  - `passes: Array<{ iteration, implementTurns, implementOutcome, costUsd?, reviewApproved }>`
  - (existing `approved`, `iterations`, `finalFeedback` retained)
- When an implement pass ends with telemetry outcome `max_turns`:
  - Stop the loop immediately (no further iterations).
  - Run a **post-mortem sub-step** (`post-mortem.<iteration>`, reported like
    other sub-steps): a read-only Claude invocation with a small turn cap,
    prompted with the issue, the diff, per-pass stats, and the tool-call trace.
    It answers: where did the turns go, what is complete, what remains, why the
    task likely didn't converge (scope/context/missing prerequisites).
  - Post-mortem failure is non-fatal (logged; run proceeds without it).
  - Continue to the draft-PR path (A).

### C. Honest callback, always sent

- `run-autonomous.ts` derives the reported outcome after the pipeline runs:
  - feedback-loop approved **and** push produced a PR → `outcome: "success"` + `prUrl` (unchanged).
  - not approved (draft PR opened) → `outcome: "failure"` with:
    - `failureCode: "REVIEW_UNAPPROVED"` (iterations exhausted or review error)
      or `"MAX_TURNS_EXHAUSTED"` (hard max_turns stop),
    - `failureReason`: compact summary (termination reason, N/N iterations,
      first ~500 chars of `finalFeedback`),
    - `prUrl`: the draft PR URL (new: prUrl now allowed on failure).
  - pipeline threw → `outcome: "failure"` as today.
- `runner-result.ts`: delete the skip-callback branch (lines 60-63); the
  callback is sent whenever `callbackUrl` + `RUN_TOKEN` exist. Include `prUrl`
  on failures when available.
- Orchestrator (`runner-callback.ts`):
  - Accept optional `prUrl` on failure bodies; when present, record it on the
    job row (`updateJobPrUrl`) so the admin UI links the draft.
  - `formatFailureComment` gains cases for `REVIEW_UNAPPROVED` and
    `MAX_TURNS_EXHAUSTED` rendering: draft-PR link, reviewer feedback,
    iteration/turn stats, and a "likely causes" remediation hint (over-broad
    issue, missing prerequisites, thin context).
  - Ticket transition: reuse the existing `markImplementationFailed` path
    (user decision) — existing notifications (Slack/Teams) fire as for any
    implementation failure.
  - Keep the 400 `missing_prUrl` guard for implementation success (we never
    send success without a PR).
- Compatibility: an old orchestrator receiving an unknown `failureCode` already
  falls through to the generic summary; the extra `prUrl` field on failure is
  ignored. New runner + old orchestrator degrades gracefully.

### D. Loud local signals

- `feedback-loop.ts` emits `console.warn` on any non-approved exit, including
  `finalFeedback` and "exhausted N/N iterations" / "stopped: max_turns".
- The runner emits a GHA `::warning::` annotation (works from container steps)
  when the run ends unapproved: e.g.
  `::warning::Review did not approve after 3/3 iterations — draft PR #123 opened.`
- Timing summary (`timing.ts` / `formatSummary`):
  - Records skipped steps (listed as `skipped`).
  - Gains a disposition line, e.g.
    `outcome: draft PR #123 — review unapproved after 3/3 iterations` or
    `outcome: PR #124 (approved)`.

### E. Learning capture

- The autopsy document (feedback + per-pass stats + post-mortem markdown) is
  written to `ai-output/comments/90-run-autopsy.md`, so the existing
  `collectRunnerComments` → callback → `provider.postComment` plumbing posts it
  to the ticket with zero new transport.
- Durable artifacts per non-converging run: draft PR (body), ticket comment
  (autopsy), orchestrator step log (per-pass sub-steps incl. post-mortem).

## Error handling

- Draft-flag 422 → normal-PR fallback with title prefix (never lose the push).
- Post-mortem invocation failure → warn and continue; the draft PR still opens
  with feedback + stats.
- Autopsy file write failure → warn and continue (callback still carries
  failureReason).
- Sensitive-files guard is unchanged and still applies to draft pushes.
- Callback POST failures remain best-effort logged, as today.

## Testing

- `feedback-loop` unit tests: termination reasons (approved / exhausted /
  review-throw / max_turns), per-pass stats shape, post-mortem triggered only
  on hard `max_turns`, post-mortem failure non-fatal.
- `pipeline-loader` tests: push no longer approval-gated; `draft` input wiring;
  `post-push-review` skip extended.
- `push` tests: draft body field; 422 fallback path; unapproved PR-body section.
- `run-autonomous` tests: outcome derivation matrix (approved+PR, draft,
  no-changes throw); callback payloads incl. `failureCode`/`prUrl`.
- `runner-result` tests: callback always sent; prUrl-on-failure included.
- `runner-callback` tests: failure with prUrl records job PR URL; new
  failureCode rendering; unknown-code fallback unchanged.
- `timing` tests: skipped steps recorded; disposition line.

## Rollout

- All changes land in this repo (runner + orchestrator ship together per
  channel pairing; testing → `:next`). New runner against an old orchestrator
  degrades gracefully (generic failure comment, no draft link on job row).
- Implementation clusters into four contained pieces:
  1. Telemetry propagation + feedback-loop termination reasons + warnings.
  2. Draft-PR push path (+ post-push-review skip, PR body).
  3. Callback contract + orchestrator handling (failureCodes, prUrl on failure).
  4. Timing/annotation polish + autopsy comment file.
