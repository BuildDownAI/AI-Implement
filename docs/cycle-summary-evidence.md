# Cycle-summary evidence (AII-801)

Reference for `src/pipeline/cycle-summary.ts` and its two producers,
`src/pipeline/steps/feedback-loop.ts` and `src/pipeline/steps/post-push-review.ts`,
plus the forwarding path that makes a cycle durable: `src/run-autonomous.ts`,
`src/runner-result.ts`, and `src/runner-callback.ts`.

## What it is

One record per inner review/fix cycle — a feedback-loop implement/review pass,
or a post-push-review fix pass — carrying the input/output commit, finding
dispositions, inferred test results, verdict, and token/cost usage for that
cycle. Records are appended (upserted) to a declared file under `ai-output/`
as the cycle completes, independently of any run-level report, then forwarded
off the runner workspace and recorded durably before the run ends.

This is the bounded slice AII-801 delivers on the Restate review-fix pilot
feature branch: it emits the evidence contract for cycles that still run
in-process and makes them durable through `/runner/cycle-summary` before
terminal result intake, including runs with no output commit. It does not move
those cycles to Restate, and it does not touch
retention, tombstones, or the 10 MiB per-attempt activity cap those separate
issues (AII-786, AII-779) own.

## Why a standalone file, not `PipelineContext.activitySink`

`src/pipeline/types.ts` already declares a pure protocol for this —
`ActivitySink.cycleSummary(identity, summary: CycleActivitySummary)`, keyed by
`ActivityIdentity` (`attemptId`, `producerId`, `sequence`) — but nothing
attaches a concrete `ActivitySink` to `PipelineContext`/`PipelineContextData`
yet, so no pipeline step (including `feedback-loop.ts`/`post-push-review.ts`)
has one to call. `RunnerActivitySink` (`src/run-autonomous.ts`) exists and
delivers `toolStart`/`toolResult` events through `/runner/activity` (AII-798),
but its `cycleSummary` method is still an explicit no-op, and `/runner/activity`
itself has no wired consumer that would call `recordReviewFixCycleSummary` —
building that live streaming path is real, separate work (AII-790's "apply
attempt outcomes under one authority"), not something this issue does by
piggybacking on `/runner/activity`.

Instead, `cycle-summary.ts` persists via a declared append-only JSON Lines
file, the same convention `finding-dispositions.ts` uses for
`DISPOSITIONS_FILE`. The runner sends each pilot cycle to a dedicated callback
using the prepared attempt's progress token, before the terminal result.
When a concrete `ActivitySink` lands on
`PipelineContext` and its `cycleSummary` delivery is wired end-to-end, this
file-and-forward path can be replaced with a live `activitySink.cycleSummary(...)`
call — the `CycleSummary` shape here is deliberately close to
`CycleActivitySummary` (same commit/disposition/test/verdict/usage fields) so
that swap is a call-site change, not a reshape.

### Durability path (read before relying on this file)

`ai-output/cycle-summaries.jsonl` itself still lives under the runner
workspace, which `scratch-exclude.ts` excludes from git — it does not survive
past the runner container's teardown on its own. What makes a cycle durable
is the forwarding chain that runs before the container exits:

1. `feedback-loop.ts`/`post-push-review.ts` call `writeCycleSummary`, which
   appends to the declared file as each cycle completes.
2. Before terminal result delivery, `run-autonomous.ts` reads the file and
   posts each pilot cycle to `/runner/cycle-summary` with the prepared attempt's
   progress token. The callback verifies live attempt authority and commits one
   record to `review_fix_cycles` before acknowledging it. Identical retries are
   idempotent; conflicting content is rejected. The runner retries transient
   failures with a byte-identical payload. This works when the terminal result
   cannot attach because no output commit was published.
3. When a terminal result can attach a `reviewFix` marker, it also forwards
   `cycleSummaries` as a redundant replay. A Legacy run has no pilot attempt
   identity, so its workspace file is not forwarded. Durable records are
   independent of the runner workspace and the tool-activity attempt cap.

Two format translations happen at that last step, both evidence-only (neither
feeds `applyApproval`, which reads `findingDispositions` from a separate
path):

- **Cycle numbering.** `review_fix_cycles` predates this issue and keys
  evidence on `(attemptId, cycle)` alone (AII-786), with no column for which
  stage produced it — a feedback-loop pass and a post-push-review fix pass on
  the same attempt could otherwise both write `cycle: 1` and collide.
  `runner-callback.ts` offsets a `post-push-review-fix` cycle by
  `POST_PUSH_REVIEW_FIX_CYCLE_BAND` (100,000) before recording it, keeping
  the two streams disjoint without a schema change. A proper stage column is
  follow-on work for whichever issue next touches that table's schema.
- **Disposition vocabulary.** `CycleSummary.dispositions` uses the fix
  agent's own `fixed`/`invalid`/`follow-up` vocabulary
  (`Disposition`, `pipeline/finding-dispositions.ts`); `review_fix_cycles`'
  disposition column predates it and uses `addressed`/`dismissed`/`deferred`
  instead. `runner-callback.ts` maps `fixed → addressed`,
  `invalid → dismissed`, `follow-up → deferred` before recording; an
  unrecognised value is dropped from that one record rather than failing it.

`completedAt` (epoch ms) is stamped once by `writeCycleSummary` at write time
and carried verbatim through every hop — it is never recomputed on read or
on delivery retry — because `recordReviewFixCycleSummary` hashes it as part
of a cycle's identity/payload idempotency check (see "Write semantics"
below); a value that changed on each retry would turn an idempotent replay
into a spurious conflict.

## File contract

| | |
|---|---|
| Path | `ai-output/cycle-summaries.jsonl`, relative to the run's workspace (`CYCLE_SUMMARY_FILE`) |
| Format | JSON Lines — one `CycleSummary` object per line, no trailing commas or wrapping array |
| Write semantics | **Insert once per `id`; idempotent on retry, rejected on conflict.** No existing record for `id` → appended. An existing record for `id` with byte-identical content → no-op (the file is not rewritten). An existing record for `id` with *different* content → rejected: `console.warn`, the first-recorded summary is left untouched, and the new write is discarded. Every call site writes a given cycle id exactly once per run (each is a terminal branch of a mutually exclusive per-iteration outcome), so a same-id conflict here signals an anomaly rather than a normal state transition |
| Read | `readCycleSummaries(workspaceDir)` — tolerant: a missing file returns `[]`, and a line that isn't valid JSON or fails the `CycleSummary` shape check is skipped rather than failing the read (mirrors `readFindingDispositions`) |
| Failure mode | `writeCycleSummary` never throws. A write failure (e.g. an unwritable workspace) is logged (`console.warn`) and swallowed — a cycle-summary write can never fail the run it is reporting on |

## Cycle identity

`id` is the stable per-cycle identity, matching the existing step-id
convention so a cycle summary can be cross-referenced against the step
report:

- `feedback-loop.<iteration>` — one implement+review pass. `feedback-loop.ts`
  writes this id from exactly one of several mutually exclusive terminal
  branches per iteration (an implement provider-unavailable stop, a
  max-turns stop, a review verdict, or a non-transient review failure) — the
  loop breaks or advances to the next iteration immediately after, so a
  given iteration's id is written exactly once per run.
- `post-push-review.fix-<iteration>` — one fix pass within post-push review,
  written exactly once per iteration for the same reason (`fix_failed`,
  `dispositioned_no_changes`, `no_changes`, or `fixed` are mutually
  exclusive terminal branches).

Re-emitting the same `id` with the same content (e.g. a retried write after a
transient I/O error) is idempotent by construction — a no-op, not a
duplicate. Re-emitting the same `id` with *different* content is a rejected
conflict, not a silent overwrite: the first-recorded summary for that id wins,
and the rejection is logged. This is what makes the contract's "same
identity, same payload → no-op; conflicting payload is rejected" requirement
hold at the file layer without a separate dedup service.

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
  completedAt: number;                           // epoch ms, stamped once at write time
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
- **`completedAt`** — epoch-ms, set once by `writeCycleSummary` and never
  recomputed; see "Durability path" above for why this must stay stable
  across a delivery retry.

## Test-status inference (`inferTestResults`)

`extractTelemetry` correlates Bash `tool_use` IDs with structured `tool_result`
events. A recognised test command with a matching result is `passed` when
`is_error` is false and `failed` when true. Command-only traces and the fix
agent's free-text `testing[]` notes remain unobserved:

- No recognisable test-command mention (`npm test`, `npm run typecheck`,
  `vitest`, `jest`, `pytest`, `go test`, `yarn test`, `pnpm test`, `tsc`) in
  any source line → one explicit `"missing"` entry, never an empty list.
- A recognisable command without a matching structured result → `"unobserved"`,
  regardless of pass/fail-looking words on the same line.

## Redaction and per-record cap

`writeCycleSummary` redacts and bounds before writing, reusing
`failure-classification.ts`'s existing `redactAndCap`/`redactEvidence` helpers
(the same secret-scrubbing used for failure evidence) rather than a second
implementation:

1. Every free-text field is individually capped, not just counted: each
   test's `name` and each disposition's `key`/`disposition` is redacted and
   capped to 200 characters (`MAX_TEST_NAME_CHARS`, `MAX_DISPOSITION_FIELD_CHARS`),
   and `verdict.summary`, if present, is capped to 2000 characters
   (`VERDICT_SUMMARY_MAX_CHARS`). A capped field ends in `…` and sets
   `truncated = true`. This runs before the array-length caps below, so
   capping the *number* of surviving entries can never be defeated by an
   unbounded string on one of them.
2. `tests` and `dispositions` are then capped to 50 and 200 entries
   respectively (`MAX_TEST_ENTRIES`, `MAX_DISPOSITION_ENTRIES`); exceeding
   either sets `truncated = true`.
3. The serialized record's byte size is checked — not assumed — against
   `CYCLE_SUMMARY_MAX_BYTES` (16 KiB — `ACTIVITY_MAX_EVENT_BYTES` from
   `src/pipeline/types.ts`, reused as a single source of truth rather than a
   second magic number). If it still exceeds the cap, the record drops
   `verdict.summary` entirely and caps `tests`/`dispositions` to 10 entries
   each (`OVERFLOW_ENTRY_CAP`), and sets both `truncated` and `limitReached`.
4. The size is checked again. In the pathological case where even the
   ten-entry, per-field-capped record still overflows, `tests` collapses to
   one explicit placeholder entry (`"test evidence omitted (cycle-summary
   size limit)"`, status `unobserved`) and `dispositions` to `[]` — the
   smallest valid shape. If even that exceeds the cap, the writer logs and
   omits the record rather than writing an oversized one. The callback rejects
   externally supplied records above the same 16 KiB cap.

A capped field is always still present in some bounded form — capping never
silently drops a whole field to empty/absent, only shortens or truncates its
contents and flags that it happened.

## Relationship to retention, tombstones, and the 10 MiB attempt cap

Retention (the issue's seven-day floor) and identity tombstones are enforced
by `review-fix-evidence.ts`/AII-786's store, not by this module — a durably
recorded cycle summary lives in `review_fix_cycles` independently of the
runner workspace and outlives it. The 10 MiB per-attempt tool-activity cap
(`ACTIVITY_MAX_ATTEMPT_BYTES`) is a separate budget entirely: this slice only
enforces the per-record 16 KiB cap on what it writes, and `CycleSummary`'s
commit/disposition/test/verdict/usage fields are deliberately **not** counted
against the tool-activity attempt cap (mirroring `CycleActivitySummary`'s own
doc comment in `types.ts`), so a chatty tool-trace never competes with cycle
evidence for the same byte budget, and a cycle summary is never dropped or
truncated because unrelated tool activity has already used up an attempt's
byte allowance.
