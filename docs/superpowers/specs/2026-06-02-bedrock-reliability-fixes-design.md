# Bedrock reliability fixes — design

**Date:** 2026-06-02
**Status:** Approved for planning
**Branch:** `bedrock-reliability-fixes`

## Context

One client runs implementations against AWS Bedrock through the GitHub Actions
execution mode. Its runs take ~1h and die at the job timeout even on trivial
single-file tickets. Bedrock makes roughly 3x the tool calls/turns of the direct
Anthropic API (anthropics/claude-code issue #51064), which amplifies every
uncapped loop in the pipeline. Investigation traced the slowness to four
independent causes plus one missing feature.

This spec covers five fixes. Each lands as its own commit. The original
investigation proposed a sixth fix (a per-issue re-dispatch attempt cap); it has
been **dropped** — see Non-goals.

## Goals

- Stop Bedrock runs from re-sending uncached context every turn.
- Bound the work a single run can do (turns and implement/review iterations) so a
  stuck run fails in minutes, not at the wall.
- Let DB-dependent repos prepare their environment via the already-documented
  `setup` / `verify` / `teardown` hooks.
- Make turn count, iteration count, and job timeout tunable **per project** from
  the orchestrator admin UI.

## Non-goals

- **Per-issue re-dispatch attempt cap (original "Fix 4") — dropped.** On the GHA
  execution mode the failure path (`monitorGitHubActionsJob` in `src/index.ts`)
  only calls `updateJobStatus(..., "failed")`; it does **not** call `resetTicket`
  and does **not** clear the dedup row. So a failed Bedrock run stays deduped and
  does not auto-re-dispatch. The reconcile loop (`src/index.ts` ~183–208) can
  clear dedup, but only when Linear reports the issue terminal/cancelled or no
  provider recognizes it — not on a plain failure that leaves the issue active.
  The unconditional `resetTicket()` → `deleteDispatched()` re-dispatch loop is
  specific to the **Fly / local-docker** monitors, which this client does not
  use. The manual escape hatch (remove the `AI-Implement` label in Linear) is
  sufficient for the rare case. Revisit only if a client moves onto Fly/local,
  where the cleaner fix is "stop unconditionally deleting dedup in `resetTicket`"
  rather than a counter + pause state machine.
- No change to model-ID validation (still passed through verbatim).
- No new global-env default layer for the caps (see "Defaults" below).

## Per-project configuration mechanism

Three new nullable fields are added to the orchestrator's `mappings` table and
the `/admin` Projects edit form. Null means "omit the dispatch input and let the
consumer's built-in default apply" — existing rows and un-touched repos behave
exactly as today.

| Field | Mapping column | Consumed by | Built-in default when null |
|---|---|---|---|
| `maxTurns` | `max_turns` | runner (feedback-loop → executor `--max-turns`) | `50` |
| `maxIterations` | `max_iterations` | runner (feedback-loop) | provider-aware: bedrock `2`, anthropic `3` |
| `maxJobMinutes` | `max_job_minutes` | GHA job `timeout-minutes`; Fly/local monitors | template's `90` |

Delivery differs by **where each value is consumed**:

- `maxTurns` / `maxIterations` run **inside the runner**. They need new
  `workflow_dispatch` inputs on `claude-implement.yml`, mapped into the
  "Run pipeline" step env, plus new fields on `DispatchInputs` in
  `src/github.ts`. They are only forwarded when set on the mapping (the same
  pattern as `provider`/`aws_region`), so default repos keep dispatching to
  not-yet-resynced workflows. For Fly/local execution modes the same env vars
  ride the machine/container env alongside `extraEnv`.
- `maxJobMinutes` is consumed by the **GHA job itself** (and the Fly/local
  monitors), via a `job_timeout_minutes` dispatch input feeding `timeout-minutes`.

### Backward compatibility / rollout

GitHub rejects a `workflow_dispatch` with inputs the target workflow does not
declare. The new inputs (`max_turns`, `max_iterations`, `job_timeout_minutes`)
are therefore **only sent when the corresponding mapping field is set**. Setting
any of them on a project requires that project's target repo to have re-synced
`claude-implement.yml` first. Re-syncing is already part of Fix 6's rollout.

### Defaults

Defaults live in the **consumer**, not in an orchestrator env layer:

- `maxTurns` default `50` is applied in `feedback-loop.ts` (`maxTurns ?? 50`).
  This bounds **both** providers — anthropic runs are currently unbounded too.
- `maxIterations` default is computed in `feedback-loop.ts` from the provider on
  `ctx.data`: `maxIterations ?? (provider === "bedrock" ? 2 : 3)`.
- `maxJobMinutes` default is the static `timeout-minutes: 90` already in the
  workflow template; when no `job_timeout_minutes` input is sent the template
  keeps that value.

Env var names threaded to the runner: `AI_IMPLEMENT_MAX_TURNS`,
`AI_IMPLEMENT_MAX_ITERATIONS` (prefixed to avoid collisions). `job_timeout_minutes`
is consumed directly in the workflow expression, not as a runner env var.

## Fix 1 — Disable experimental betas on Bedrock

**Why:** the runner pins `@anthropic-ai/claude-code@2.1.114`. Since v2.1.24 Claude
Code sends a `cache_control.ephemeral.scope` beta field that Bedrock rejects
(`system.1.cache_control.scope: Extra inputs are not permitted`). When that
errors, prompt caching fails and every turn re-sends the full, growing context
uncached — the primary slowdown, amplified by Bedrock's higher turn count. Claude
Code ≥2.1.81 honors `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`.

**Change:** in `session/entrypoint.sh`, the `bedrock)` branch of the provider
`case`, also `export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`. Leave the
`anthropic)` branch untouched.

**Acceptance:** a Bedrock run's logs no longer contain
`cache_control.scope` / `Extra inputs are not permitted`; cache-read tokens
appear and wall-clock drops.

## Fix 2 + 3 — Cap turns + provider-aware iterations

These share one delivery rail, so they are designed together (and may be one or
two commits at implementation time).

**Why:** `ClaudeCliExecutor.invoke` (`src/pipeline/executor.ts`) only appends
`--max-turns` when `maxTurns != null`, and `feedback-loop.ts` never sets it, so
each implement pass runs unbounded turns. The loop runs up to
`DEFAULT_MAX_ITERATIONS = 3` implement→review cycles. On Bedrock, unbounded turns
× 3 iterations × 3x turn inflation is what blows past the timeout.

**Changes:**

- `src/run-autonomous.ts`: read `process.env.PROVIDER` (entrypoint already
  defaults it to `anthropic`) onto `ctx.data.provider`. Read
  `AI_IMPLEMENT_MAX_TURNS` / `AI_IMPLEMENT_MAX_ITERATIONS` env → parsed ints onto
  `ctx.data.maxTurns` / `ctx.data.maxIterations` (`undefined` when absent).
- `src/pipeline/pipeline-loader.ts`, feedback-loop case: thread `provider`,
  `maxTurns`, `maxIterations` from `ctx.data` into the step inputs.
- `src/pipeline/steps/feedback-loop.ts`: add `maxTurns` (and `provider`) to
  `FeedbackLoopInputs`; pass `maxTurns` into `implementStep.run(...)` and into the
  reported sub-step inputs. Effective values:
  `maxTurns ?? 50`; `maxIterations ?? (provider === "bedrock" ? 2 : 3)`.
- `src/pipeline/steps/implement.ts` / `src/pipeline/executor.ts`: no change
  (already accept/forward/append `maxTurns`).
- `workflows/claude-implement.yml`: add `max_turns` and `max_iterations`
  `workflow_dispatch` inputs; map them into the "Run pipeline" step env as
  `AI_IMPLEMENT_MAX_TURNS` / `AI_IMPLEMENT_MAX_ITERATIONS`.
- `src/github.ts`: add `max_turns` / `max_iterations` to `DispatchInputs`; extend
  the dispatch-field builder to include them only when the mapping sets them.
- Fly/local dispatch paths in `src/index.ts`: include the same env vars in the
  machine/container env when set on the mapping.

**Acceptance:** `claude` is invoked with `--max-turns 50` (or the configured
value) on both providers. Bedrock repos run ≤2 implement/review cycles by
default; anthropic repos stay at 3. A deliberately-looping ticket fails in
minutes with a clear "max turns reached" error instead of at the timeout.
`.ai-implement/config.yml` is **not** used for these caps — they come from the
mapping (admin UI) only.

## Fix 5 — Execute setup / verify / teardown hooks

**Why:** `src/workflow-md.ts` already parses `setup`, `verify`, `teardown`
front-matter keys, and `WORKFLOW.md` documents them, but `src/run-autonomous.ts`
only consumes `model` and `body`. The hook scripts are never run, so DB-dependent
repos (e.g. one that must `pnpm db:sync` against a live MySQL DB) cannot prepare
their environment and the agent flails. The `setup_complete` / `verify_running` /
`verify_passed` / `verify_failed` status events already exist
(`src/status-events.ts`, `src/session-api.ts`) but are only exercised by tests.

**Changes:**

- `src/run-autonomous.ts`: after parsing `WORKFLOW.md`, capture
  `parsed.frontMatter.setup` / `.verify` / `.teardown` onto `ctx.data.hooks`.
- `pipelines/autonomous.yml` + `src/pipeline/pipeline-loader.ts`: add a **setup**
  step that runs before `feedback-loop`, and a **verify** step that runs after a
  successful `push`. Run **teardown** in a `finally` in `run-autonomous` so it
  executes even when the pipeline throws or times out (best-effort) — this is
  simpler and more robust than adding `alwaysRun` semantics to the executor.
- Each hook resolves relative to the repo root, runs via the executor shell-out
  pattern with `set -euo pipefail`, cwd = repo root, output streamed.
- **Env passing:** for each hook the runner points `GITHUB_ENV` at a managed temp
  file, runs the hook, then parses `KEY=value` lines from that file and merges
  them into the env handed to subsequent claude invocations and to verify/teardown.
  This makes `WORKFLOW.md`'s documented `echo "DATABASE_URL=… >> $GITHUB_ENV`
  convention work across **all** execution modes, not just GHA.
- Emit `setup_complete` after setup; `verify_running` / `verify_passed` /
  `verify_failed` around verify.
- **Setup failure** aborts the run early (before the feedback loop) with a clear
  comment; teardown still runs. **Verify failure** emits `verify_failed` and is
  surfaced, but the PR already exists from the successful push; teardown still
  runs. Repos with no hooks behave exactly as before.

**Acceptance:** a repo with `setup:` / `verify:` / `teardown:` front matter runs
all three at the right times; setup failure aborts early with a clear comment and
teardown still runs; repos with no hooks are unchanged.

## Fix 6 — Per-project job timeout + re-sync

**Why:** `workflows/claude-implement.yml` is `timeout-minutes: 90` in this repo,
but the Bedrock client's target repo still runs the old 60 (its runs die at
~1h00m). With the caps above in place, a shorter, per-project timeout makes
failures surface fast.

**Changes:**

- `maxJobMinutes` mapping field + `/admin` field (see "Per-project configuration").
- `workflows/claude-implement.yml`: add a `job_timeout_minutes` dispatch input and
  consume it in the job:
  `timeout-minutes: ${{ inputs.job_timeout_minutes && fromJSON(inputs.job_timeout_minutes) || 90 }}`.
  **Implementation note (verify during planning):** GitHub's support for
  expressions in job-level `timeout-minutes` is finicky. If the expression form
  does not take, fall back to **orchestrator-monitor enforcement** — have
  `monitorGitHubActionsJob` cancel the run once it exceeds `maxJobMinutes` — which
  also unifies behavior with Fly/local.
- Fly/local monitors already time out; feed `maxJobMinutes` into their timeout
  bounds when set.
- Template default stays 90.
- **Rollout:** after the above land, re-run **Sync workflows** for the Bedrock
  project from `/admin` so the target repo picks up the current template (this
  also clears the stale-60 problem). New inputs are only sent when the mapping
  sets them, so un-resynced repos keep working.

**Acceptance:** the Bedrock repo can run a tighter timeout (e.g. 30–45) while
other repos stay at 90; re-synced target repos pick up the new template.

## Testing

- `feedback-loop.ts`: provider-aware `maxIterations` default (bedrock 2 /
  anthropic 3) and `maxTurns` default (50) when inputs are absent; explicit
  values override.
- `src/github.ts`: dispatch-field builder includes `max_turns` /
  `max_iterations` / `job_timeout_minutes` only when the mapping sets them, and
  omits them otherwise (backward-compat).
- `src/config.ts`: round-trip of the three new mapping columns (read/write,
  null-safe).
- Hook env-merge: parsing `KEY=value` lines from the managed `GITHUB_ENV` file
  and merging into the executor env.
- Existing dedup/dispatch tests stay green (no behavior change there — Fix 4
  dropped).

## Commit plan

1. Fix 1 — entrypoint betas flag.
2. Per-project mapping fields + admin UI (foundation for 2/3/6).
3. Fix 2 + 3 — caps wired runner-side and through dispatch.
4. Fix 5 — setup/verify/teardown hooks.
5. Fix 6 — per-project timeout + template input.

(Rollout step — re-sync the Bedrock target repo from `/admin` — is operational,
done after merge/deploy, not a commit.)

## Risks

- **GHA `timeout-minutes` expression support** (Fix 6) — mitigated by the
  orchestrator-monitor fallback.
- **Forgotten re-sync** — setting a per-project cap before the target repo
  re-syncs would make dispatch fail with "unexpected inputs." Mitigated by only
  sending inputs when set and documenting the re-sync requirement; consider an
  admin-UI guard that warns when a mapping sets caps but the target template is
  stale (the Projects page already classifies template staleness).
- **Hook env leakage** — secrets exported to `$GITHUB_ENV` by setup are merged
  into the agent env by design; ensure the managed temp file is per-run and not
  logged.
