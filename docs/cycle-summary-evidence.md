# Cycle-summary evidence (AII-801)

Reference for `src/pipeline/cycle-summary.ts`, and its two producers,
`src/pipeline/steps/feedback-loop.ts` and `src/pipeline/steps/post-push-review.ts`.

## What it is

One record per inner review/fix cycle — a feedback-loop implement/review pass,
or a post-push-review fix pass — carrying the input/output commit, finding
dispositions, inferred test results, verdict, and token/cost usage for that
cycle. Records are appended (upserted) to a declared file under `ai-output/`
as the cycle completes, independently of any run-level report.

This is the bounded slice AII-801 delivers on the Restate review-fix pilot
feature branch: it emits the evidence contract for cycles that still run
in-process. It does not move those cycles to Restate, and it is not the
bounded activity/attempt store those later issues (AII-786, AII-779) add.

## Why a standalone file, not `PipelineContext.activitySink`

`src/pipeline/types.ts` already declares a pure protocol for this —
`ActivitySink.cycleSummary(identity, summary: CycleActivitySummary)`, keyed by
`ActivityIdentity` (`attemptId`, `producerId`, `sequence`) — but nothing
constructs or wires a concrete `ActivitySink` yet (AII-788 is the contract,
AII-784/798 the concrete tool-activity reporter, both still pending on this
branch). Blocking this issue on that wiring would mean the approved cycle
contract ships with no producer.

Instead, `cycle-summary.ts` persists via a declared append-only JSON Lines
file, the same convention `finding-dispositions.ts` uses for
`DISPOSITIONS_FILE`. When a concrete `ActivitySink` lands on
`PipelineContext`, swapping `writeCycleSummary`'s file write for
`activitySink.cycleSummary(...)` is additive at the two call sites in
`feedback-loop.ts` and `post-push-review.ts` — the `CycleSummary` shape here
is deliberately close to `CycleActivitySummary` (same commit/disposition/test/
verdict/usage fields) so that swap is a call-site change, not a reshape.

## File contract

| | |
|---|---|
| Path | `ai-output/cycle-summaries.jsonl`, relative to the run's workspace (`CYCLE_SUMMARY_FILE`) |
| Format | JSON Lines — one `CycleSummary` object per line, no trailing commas or wrapping array |
| Write semantics | **Upsert by `id`.** `writeCycleSummary` reads every existing record, drops any whose `id` matches the new one, and rewrites the whole file with the new record appended. A retry that re-summarizes the same cycle identity replaces that cycle's record; every other cycle's record is untouched |
| Read | `readCycleSummaries(workspaceDir)` — tolerant: a missing file returns `[]`, and a line that isn't valid JSON or fails the `CycleSummary` shape check is skipped rather than failing the read (mirrors `readFindingDispositions`) |
| Failure mode | `writeCycleSummary` never throws. A write failure (e.g. an unwritable workspace) is logged (`console.warn`) and swallowed — a cycle-summary write can never fail the run it is reporting on |

## Cycle identity

`id` is the stable per-cycle identity, matching the existing step-id
convention so a cycle summary can be cross-referenced against the step
report:

- `feedback-loop.<iteration>` — one implement+review pass. Multiple
  `writeCycleSummary` calls can target the same iteration across an implement
  failure, a review failure, and a review verdict; each write for that `id`
  replaces the previous one for that iteration, so only the last outcome for
  a given iteration survives (the intermediate failure states below are
  terminal — the loop breaks after writing them).
- `post-push-review.fix-<iteration>` — one fix pass within post-push review.

Re-emitting the same `id` (e.g. a retried write after a transient I/O error)
is idempotent by construction: the upsert replaces, it does not duplicate —
this is what makes the contract's "same identity, same payload → no-op"
requirement hold at the file layer without a separate dedup step.

## Fields

```ts
interface CycleSummary {
  id: string;                                   // e.g. "feedback-loop.2", "post-push-review.fix-1"
  stage: "feedback-loop" | "post-push-review-fix";
  cycle: number;                                 // the iteration number
  inputCommit: string | null;
  outputCommit: string | null;
  outputCommitStatus: "committed" | "pending_push" | "not_applicable";
  dispositions: { key: string; disposition: string }[];
  tests: { name: string; status: "passed" | "failed" | "missing" | "skipped" | "unobserved" }[];
  verdict: { approved: boolean | null; reason: string; summary?: string };
  usage: { tokensIn: number | null; tokensOut: number | null; costUsd: number | null };
  truncated: boolean;
  limitReached: boolean;
}
```

- **`inputCommit` / `outputCommit` / `outputCommitStatus`** — a feedback-loop
  cycle's working tree is uncommitted until the pipeline's `push` step runs
  later, so every feedback-loop record carries the run's starting HEAD
  (`runStartHead`) as `inputCommit`, a `null` `outputCommit`, and
  `outputCommitStatus: "pending_push"`. A post-push-review fix pass commits
  and pushes for itself (via `leaseSha`/`rev-parse HEAD`), so a successful fix
  push carries a real `outputCommit` and `outputCommitStatus: "committed"`; a
  fix pass that fails or produces no changes carries `outputCommitStatus:
  "not_applicable"` instead, with `outputCommit: null`.
- **`dispositions`** — only a post-push-review fix pass with gating external
  findings produces these (via `finding-dispositions.ts`); a feedback-loop
  cycle always writes `[]`. Scoped to that single cycle's own dispositions —
  never the run-level cumulative `findingDispositions` the step ultimately
  returns — so an earlier cycle's already-written record is never rewritten
  by a later cycle resolving the same finding key differently.
- **`tests`** — inferred via `inferTestResults` (below), never empty: a
  cycle with no recognisable test-command evidence still carries one
  `{ name: "test execution", status: "missing" }` entry.
- **`verdict.approved`** is `null` whenever the cycle ended before a real
  verdict was reached (an LLM failure, a provider outage, a hard max-turns
  stop, "no changes pushed") — never coerced to `false`. `reason` is a short
  machine code reused across the codebase's existing termination-reason
  vocabulary (`approved`, `changes_requested`, `max_turns`,
  `provider_unavailable`, `review_error`, `fix_failed`,
  `dispositioned_no_changes`, `no_changes`, `fixed`); `summary` is an optional
  redacted, capped human-readable note.
- **`truncated`** — true when any field was capped, including a redacted
  verdict summary or an over-long `tests`/`dispositions` list.
- **`limitReached`** — true only when the *whole record* still exceeded
  `CYCLE_SUMMARY_MAX_BYTES` after per-field caps, and the overflow fallback
  (below) had to drop entries rather than merely shorten them.

## Test-status inference (`inferTestResults`)

There is no structured "which tests ran and did they pass" source yet — that
is AII-798's tool-activity contract, a separate and later piece. Until then,
`inferTestResults` scans tool-trace lines and/or the fix agent's free-text
`testing[]` notes for a recognisable test-command mention
(`npm test`, `npm run typecheck`, `vitest`, `jest`, `pytest`, `go test`,
`yarn test`, `pnpm test`, `tsc`) and classifies each match as `failed`,
`skipped`, `passed`, or `unobserved` from keyword matches on the same line.

Two rules are deliberate and load-bearing for the acceptance criterion that a
skipped or unobserved command must never read as passed:

- No recognisable test-command mention at all → one explicit `"missing"`
  entry, never an empty list.
- A recognised command whose outcome can't be read from the line → `
  "unobserved"`, never defaulted to `"passed"`. A clean process exit or plain
  silence is never treated as evidence of a pass.

## Redaction and per-record cap

`writeCycleSummary` redacts and bounds before writing, reusing
`failure-classification.ts`'s existing `redactAndCap`/`redactEvidence` helpers
(the same secret-scrubbing used for failure evidence) rather than a second
implementation:

1. `verdict.summary`, if present, is redacted and capped to 2000 characters
   (`VERDICT_SUMMARY_MAX_CHARS`); a capped summary ends in `…` and sets
   `truncated = true`.
2. `tests` and `dispositions` are capped to 50 and 200 entries respectively
   (`MAX_TEST_ENTRIES`, `MAX_DISPOSITION_ENTRIES`); exceeding either sets
   `truncated = true`.
3. As a last resort, if the whole serialized record still exceeds
   `CYCLE_SUMMARY_MAX_BYTES` (16 KiB — `ACTIVITY_MAX_EVENT_BYTES` from
   `src/pipeline/types.ts`, reused as a single source of truth rather than a
   second magic number), the record drops `verdict.summary` entirely and
   caps `tests`/`dispositions` to 10 entries each (`OVERFLOW_ENTRY_CAP`), and
   sets both `truncated` and `limitReached`.

A capped field is always still present in some bounded form — capping never
silently drops a whole field to empty/absent, only shortens or truncates its
contents and flags that it happened.

## Relationship to retention, tombstones, and the 10 MiB attempt cap

Retention, identity tombstones, and the 10 MiB per-attempt cap
(`ACTIVITY_MAX_ATTEMPT_BYTES`) are store-level concerns owned by AII-786/779,
out of scope here. This slice only enforces the per-record 16 KiB cap on what
it writes; `CycleSummary`'s commit/disposition/test/verdict/usage fields are
deliberately **not** counted against the tool-activity attempt cap (mirroring
`CycleActivitySummary`'s own doc comment in `types.ts`), so a chatty tool-trace
never competes with cycle evidence for the same byte budget.
