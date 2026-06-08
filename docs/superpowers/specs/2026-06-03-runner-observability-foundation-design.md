# Runner Observability Foundation — Design

**Date:** 2026-06-03
**Status:** Approved (design)
**Scope:** Goal 1 of 3 (stream-json foundation + live GHA trace + verbosity setting). Goals 2 (persist metrics) and 3 (customer-facing Linear progress) are filed as separate placeholder Linear issues and build on this foundation.

## Problem

When an implementation run misbehaves, the runner is a black box. A real failure on a Bedrock target repo (`Forecast-it/dark-factory-hello-world`, [run 26929090702](https://github.com/Forecast-it/dark-factory-hello-world/actions/runs/26929090702/job/79445108400)) spent **6m32s** with zero log output before failing — there was no way to see what Claude was doing, how many turns it took, whether it hit the turn cap, or what it cost.

Root cause is the executor (`src/pipeline/executor.ts`): `ClaudeCliExecutor` runs `claude -p <prompt>`, buffers stdout, and only reads it on process close. There is:
- No live streaming (hence the silence),
- No `--output-format stream-json --verbose`, so no per-turn / per-tool events,
- No telemetry — `tokensUsed` is hardcoded `0`, and `num_turns` / duration / cost / max-turns-outcome are never captured.

## Goals (this spec)

1. Make a running implementation observable **live** in the GitHub Actions log, gated by a verbosity setting.
2. Always capture structured run telemetry (turns, duration, cost, tokens, outcome) and expose it on the result object, regardless of verbosity.

## Non-goals (deferred to G2 / G3)

- Persisting telemetry to `dispatch_log` or rendering it in the admin UI (**G2**).
- Posting progress/telemetry to Linear for customer visibility (**G3**).

The foundation emits telemetry onto `LLMResult.telemetry` and logs it; the two consumers above read that seam later.

## Core principle

**Capture is decoupled from surface.** Telemetry is always captured and the one-line summary is always logged. The verbosity setting controls only how much *additional* per-event detail is streamed to the log. Low verbosity must never reintroduce the black box — the summary line (including a max-turns outcome) prints at every level.

## Dependency

Soft-depends on PR #72 (`fix/review-prompt-too-long-nonfatal`: non-fatal review + bounded review diff). Section "Error handling" references that non-fatal behavior. Implementation should land after #72 is merged to `testing`, or rebase onto it.

## Design

### 1. The verbosity setting

- **Name / values:** `AI_IMPLEMENT_LOG_LEVEL` ∈ { `summary` (default), `stream` }. Unrecognized or empty → `summary`.
- **Resolution:** read once as an environment variable in `run-autonomous.ts` and passed into `ClaudeCliExecutor` as a constructor argument. The executor does not reach into `process.env` itself (keeps it unit-testable).
- **Sources:**
  - Orchestrator-initiated runs (Fly / local / GHA): an `AI_IMPLEMENT_LOG_LEVEL` repo/org **variable** read by the workflow and passed into the runner container, mirroring how `AI_IMPLEMENT_PROVIDER` is plumbed. This gives a single consistent source across execution modes; the orchestrator sends nothing extra.
  - `/ai-implement` comment-triggered gap-fill runs: the same `AI_IMPLEMENT_LOG_LEVEL` repo variable.
- **Explicitly NOT:** a per-project admin-UI field, and NOT a `workflow_dispatch` input. A dispatch input would inherit the "re-sync `claude-implement.yml` or GitHub rejects with 'unexpected inputs'" tax documented in CLAUDE.md. This is an operator/debugging knob set at the environment/repo level.

### 2. Foundation: stream-json executor + parser

**Executor (`src/pipeline/executor.ts`):** add `--output-format stream-json --verbose` to the spawn args. (`--verbose` is required by the CLI for `stream-json` in `-p` mode.) stdout becomes JSONL — one event per line. The executor splits stdout on newlines, parses each line, feeds it to the parser module (below), logs the formatted line live when level is `stream`, and accumulates events for final telemetry extraction.

**New pure module `src/pipeline/claude-stream.ts`** (no I/O, fully unit-testable):
- `formatEvent(event): string | null` — render one parsed event as a compact human line, or `null` to skip. Handles `system/init`, `assistant` (tool_use → `tool <Name> <input>`, text → `turn N (assistant)`), `user` (tool_result), `result`.
- `extractTelemetry(events): RunTelemetry` — from the final `result` event, pull `num_turns`, `duration_ms`, `total_cost_usd`, token `usage` (input/output), and `subtype` mapped to an outcome (`success` | `max_turns` | `error` | `unknown`).
- `finalText(events): string` — the `result` event's `result` field (Claude's final assistant text), with a fallback to concatenated `assistant` text blocks if the result event is missing.

**Type change (`src/pipeline/types.ts`):**
```ts
export interface RunTelemetry {
  outcome: "success" | "max_turns" | "error" | "unknown";
  numTurns: number | null;
  durationMs: number | null;
  costUsd: number | null;      // often null on Bedrock
  tokensIn: number | null;
  tokensOut: number | null;
}
export interface LLMResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
  tokensUsed: number;
  telemetry?: RunTelemetry;    // new
}
```

**Compatibility (load-bearing):** existing consumers (`review.ts`'s JSON extraction; any reader of `result.stdout`) expect `stdout` to be Claude's final text answer. With stream-json, raw stdout is JSONL. The executor therefore returns `stdout = finalText(events)`, preserving every existing consumer unchanged. The JSONL is consumed internally for logging and telemetry only. `tokensUsed` is populated from `telemetry.tokensIn + tokensOut` (best-effort; `0` when unknown) — a free win the existing budget-tracking comment in the file asks for.

**Data flow:**
```
spawn claude --output-format stream-json --verbose -p <prompt>
  stdout → split lines → JSON.parse(line)
    if level === "stream": const l = formatEvent(event); if (l) console.log(l)
    events.push(event)
  on close:
    const t = extractTelemetry(events)
    console.log(summaryLine(t))                 // ALWAYS
    resolve({
      stdout: finalText(events),
      exitCode: code ?? 1,
      tokensUsed: (t.tokensIn ?? 0) + (t.tokensOut ?? 0),
      telemetry: t,
    })
```

### 3. Output format

**Summary line (always, both levels)** — one greppable line on close:
```
[claude] result=success turns=47 duration=6m12s cost=$0.83 tokens=182k/4.1k (in/out)
```
- `result=` is the outcome; `max_turns` makes a turn-cap exhaustion visible at the default level.
- `cost=` omitted when null or `0` (Bedrock typically does not report `total_cost_usd`).
- `tokens=` shown whenever `usage` is present; `duration=` humanized from `duration_ms`.

**Live stream lines (`stream` only)** — one compact, timestamped line per meaningful event:
```
[claude 12:03:41] init model=anthropic.claude-...:0 cwd=/workspace
[claude 12:03:44] tool Read forecast-ticketing-poc/schema/schema.sql
[claude 12:03:51] tool Bash pnpm -C forecast-ticketing-poc db:sync
[claude 12:06:10] turn 12 (assistant)
```
- Tool inputs truncated to ~160 chars so a large Edit payload can't flood the log.
- **Secret safety:** tool *outputs* (e.g. Bash stdout) are NOT streamed — only the tool name and (truncated) input. Streaming command text but not command output is the deliberate boundary; GHA secret masking applies on top. This is a second reason `summary` is the default.

### 4. Error handling

Observability code may degrade but must never break a run or swallow an exit code.
- A non-JSON line → skipped (optionally noted once as `[claude] (unparsed line)` at `stream` level), never throws.
- Missing/malformed `result` event (process killed/crashed) → telemetry fields best-effort/`null`; `stdout` falls back to concatenated `assistant` text; summary prints `result=unknown`. The run still resolves with the real `exitCode`.
- `exitCode` semantics unchanged: non-zero still surfaces to the step, where PR #72's non-fatal review handling continues to apply.

### 5. Testing (TDD)

- `claude-stream.test.ts` (pure, fixture-driven): `formatEvent` per event type, tool-input truncation, `extractTelemetry` (success, `error_max_turns`, missing-result, Bedrock-no-cost), `finalText` extraction + fallback.
- `executor.test.ts`: a temporary fake `claude` shell script on `PATH` emitting canned stream-json and a chosen exit code. Assert `stdout` equals unwrapped final text (compat), `telemetry` populated, summary printed at both levels, per-event lines only at `stream`, malformed-line tolerance, missing-result degradation.
- `run-autonomous` test: `AI_IMPLEMENT_LOG_LEVEL` resolves into the executor; default `summary` when unset or garbage.

## Open items validated during implementation

- Exact `claude` stream-json event field names / `result` subtypes against the runner image's CLI version (design is defensive: best-effort parse, unknown fields ignored).
- Whether the GHA workflow templates need an `AI_IMPLEMENT_LOG_LEVEL` env passthrough edit (and therefore a target-repo re-sync) — preferred resolution is the repo/org variable read inside the container, requiring no dispatch-input change.
