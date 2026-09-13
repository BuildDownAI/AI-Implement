# 015. The terminal report is an idempotent signed fact keyed by dispatch id

**Status:** Proposed
**Date:** 2026-09-08
**References:** AII-567 (incident), PR #467, AII-572, ADR 014, `docs/runner-callbacks.md`, `docs/solutions/workflow-patterns/runner-test-suite-burned-the-run-token.md`

## Context

A dispatched run reports its terminal result once, to `POST /runner/result`, with a single-use token. `verifyRunToken(…, "result", { consume: true })` in `src/runner-tokens.ts` marks the token consumed on first use, and the handler in `src/runner-callback.ts` refuses a second post with `409 already_consumed`. The design treats the report as an event that must arrive exactly once, and enforces that by destroying the credential.

From 2026-09-04 to 2026-09-07 a test suite running inside dispatched runners posted to the live orchestrator before the run finished. The first post consumed the token. Every run's real report was then refused, and with it the outcome, the PR URL, the summary, the approval mark (ADR 014), and on GitHub Actions the tracker transition. Nothing crashed. The failure surfaced in other subsystems as held PRs, a full dispatch cap, and a fix that had nothing to stamp. Cost: about three days.

The credential fix (a disarmed test suite, AII-588, and the process boundary in ADR 016) makes the stray call unlikely. It does not make it harmless. Any future stray call, from any process that holds the token, still destroys the run's ability to report.

## Decision

The terminal report becomes a fact keyed by the run's identity, not an event guarded by a consumable credential.

- **Key.** The dispatch id. One report row per dispatch id in `dispatch_log` or a sibling table, written by one code path.
- **Signature.** The runner signs the report body with a per-run key: an HMAC (hash-based message authentication code) over the dispatch id, the outcome, and the PR URL. The orchestrator verifies the signature. It does not consume anything. The run token's `result` audience becomes verify-only.
- **Identical resubmission.** A report whose body matches the recorded report answers `200` with `already_recorded`. It is a no-op.
- **Conflicting resubmission.** A report whose outcome or PR URL differs from the recorded one answers `409 conflicting_report` and names both outcomes in the body. The first report stands. The conflict is logged and surfaced on the run.
- **Empty or partial resubmission.** A post with no outcome answers `400`. It records nothing and consumes nothing.
- **The monitors write "runner ended" only.** The GHA and Fly monitors keep writing the execution-layer conclusion. The approval mark and the runner's conclusion come only from the accepted report. The `CASE` guard in `updateJobStatus` stays.

Modules that change: `src/runner-callback.ts` (accept-by-key, conflict answer), `src/log.ts` (the report row and one writer per transition), `src/runner-tokens.ts` (verify without consume for `result`), and the runner's `postRunnerResult` in `src/runner-result.ts` (sign, and resend safely on a network error).

## Alternatives considered

- **Keep consume-on-first-use and rely on disarmed tests.** Rejected. The disarm protects one repository's suite (AII-588). Any other process that reaches the token, in any target repository, can still burn a run.
- **Idempotency keys at the HTTP layer only** (an `Idempotency-Key` header with a short cache). Rejected. It dedupes retries of one request; it does not define what a conflicting second report means, and it expires.
- **Keep the report an event and add a "re-open the report" admin action.** Rejected. It keeps the failure class and adds an operator step to every occurrence.
- **A new column for the runner's outcome.** Unnecessary. The conclusion column and the `CASE` guard already carry it (ADR 014).

## Consequences

Easier: a stray or duplicate post cannot destroy a run's report. The runner can retry a failed post safely. The failure class of AII-567 becomes a logged no-op.

Harder: the result token is no longer single-use, so its exposure window matters more. ADR 016 narrows that window. A captured report replayed identically is a no-op; a forged conflicting report needs the per-run key, which never leaves the pipeline process. The report row is a new write path in `src/log.ts` and must have exactly one writer.

Follow-on: the tests that prove the incident harmless (eight stray posts, then the real one) ship with the change, and fail on the current code.
