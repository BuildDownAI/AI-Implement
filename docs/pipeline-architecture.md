# Pipeline architecture

How the containerized runner executes an issue: the step contract, the built-in pipeline, how steps are wired, and how a fork overrides any of it.

This is the reference for `src/pipeline/`. `CLAUDE.md` carries the one-paragraph summary and points here.

## Where the pipeline runs

Every execution mode — GitHub Actions, Fly Machines, and local Docker — runs the same runner image and enters through `session/entrypoint.sh`. That script validates the environment, prepares `/workspace` (a clone, or a bind mount under the local dev harness), drops to a non-root user, and only then executes the phase-appropriate TypeScript entry point: `run-planning.js` for planning runs, `run-autonomous.js` for everything else.

The practical consequence: by the time any pipeline code runs, the target repo is already on disk. `WORKFLOW.md`, its hook scripts, and any `custom/` overrides the repo ships are all readable from the first step onward, in every mode.

## The step contract

A step is any module with a `run` method, defined in `src/pipeline/types.ts`:

```typescript
export interface StepModule<
  I extends Record<string, unknown> = Record<string, unknown>,
  O extends Record<string, unknown> = Record<string, unknown>,
> {
  run(context: PipelineContext, inputs: I, reporter: StepReporter): Promise<O>;
}
```

Both type parameters must extend `Record<string, unknown>`. This is a real constraint, not a formality: outputs are stored in an untyped map keyed by step id and read back by other steps, so an interface that does not satisfy the index signature will not compile as a `StepModule`.

The `context` argument carries `PipelineContextData` — the issue fields, workspace path, resolved model, caps, and the parsed `hooks` paths — plus `getOutputs`/`setOutputs` and the `llmExecutor`. The `reporter` receives a `Step` record as each step starts and finishes; that is what surfaces progress to the orchestrator.

## The built-in pipeline

`pipelines/autonomous.yml` declares the steps below. They run in file order, and each is registered under a key in `BUILTIN_STEPS` (`src/pipeline/default-pipeline.ts`).

| # | Step id | Skipped when |
|---|---------|--------------|
| 1 | `clone` | never |
| 2 | `reference-repos` | the envelope declares no `referenceRepos` entries |
| 3 | `install-skills` | no `skillsRepo` configured |
| 4 | `dependency-auth` | the mapping has no Dependency Token Scope set |
| 5 | `install` | never (internally no-ops for a mounted workspace or a repo with no `package.json`) |
| 6 | `setup` | no `setup:` hook in `WORKFLOW.md` front matter |
| 7 | `feedback-loop` | never |
| 8 | `preflight` | the feedback loop did not approve |
| 9 | `push` | never (initial runs create the branch and PR; gap-fill runs commit remaining changes and force-push to the existing PR branch) |
| 10 | `verify` | no `verify:` hook, or the feedback loop did not approve |
| 11 | `post-push-review` | not approved, or nothing was pushed, or no PR number |

`reference-repos` runs immediately after `clone` to populate the workspace with any declared reference repositories before any hook or install step runs. It fetches per-owner installation tokens from the orchestrator's `/api/runner/reference-token` endpoint (gated on the mapping's `referenceRepos` field), then clones each entry shallow. The credential is passed via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` environment variables — the only form that does not persist the token into the clone's `.git/config` or `remote.origin.url`. After each clone, the path is appended to `.git/info/exclude` so `git add -A` can never stage it. A clone failure is logged and reported in the step outputs but never fails the run.

`dependency-auth` sits deliberately before `install`: it fetches a read-only, installation-wide token and installs it as a git credential helper plus `COMPOSER_AUTH`, so the dependency install that follows can resolve private sibling repositories. Its inputs are also a worked example of a real constraint — the run's progress token is **not** passed through `inputs`, because inputs are persisted to the step log and surfaced through the admin API. The step reads that secret from `process.env` directly. Anything secret belongs in the environment, not in a step's inputs.

**Benign terminals.** `post-push-review` recognises two exits that are not failures: `pr_merged` and `operator_cancelled`. Both resolve inside `assertPrWritable` (`src/pipeline/steps/post-push-review.ts`), which is called as the first statement of every write function (`postPrComment`, `submitPrReview`) and immediately before the fix-pass `git push`. A merged PR throws `PrMergedError`; a closed-and-not-merged PR throws `OperatorCancelledError`. The boundary catch at the end of the step returns `{ approved: true, terminationReason: "pr_merged" }` or rethrows `OperatorCancelledError` as `operator_cancelled`, whichever applies. One rule governs both: if a genuine LLM failure set `priorLlmFailure` before the benign event, the genuine failure surfaces instead — the benign event does not mask a real error.

`feedback-loop` is where Claude actually runs — it drives the implement/review cycle up to `maxIterations`. Everything before it prepares the workspace; everything after it reacts to the result.

Two consequences worth internalising:

**`preflight` does not gate the push.** It is skipped unless the review already approved, and `push` runs regardless of what it found. It records `typecheck`/`lint`/`test` results; it does not block a pull request on them. Work that fails preflight still ships.

**The pipeline owns all repository writes.** `push` runs for both initial and gap-fill runs: an initial run creates the implementation branch and opens a PR, while a gap-fill run commits any remaining uncommitted changes and force-pushes to the existing PR branch. `WORKFLOW.md` must instruct the agent to leave changes uncommitted in both modes — the pipeline always handles the commit and push.

## Review result contract

The built-in implementation review and post-push review request a JSON Schema through the executor. Claude Code still emits `stream-json` events for progress and telemetry; the verdict comes from the terminal result's `structured_output` field, not JSON extracted from assistant prose. Review consumers validate the required fields and their types before applying the verdict. Outstanding issues prevent approval even if the reviewer sets `approved` to true.

An unsuccessful or missing terminal result, missing structured output, or invalid review payload is an incomplete review, not actionable implementation feedback. The feedback loop stops rather than running another implementation pass on a formatting error. Post-push review preserves the PR and reports that automated review did not complete. Custom executors used with these built-in review steps must implement the structured-result contract in `src/pipeline/types.ts`.

The runner pins Claude Code in `Dockerfile.session`. Built-in model fallbacks and newly seeded workflow templates use `claude-sonnet-5`. Explicit model settings retain their existing precedence; already-seeded target-repo `WORKFLOW.md` and `PLANNING.md` files are not overwritten by template sync, so projects that pin an older model keep that model until their configuration changes. Bedrock projects still need a model ID accepted by their configured provider.

Repositories that pin a runner image with `.ai-implement/image.yml` must update that image to include this executor and a Claude Code CLI supporting `--json-schema` and terminal `structured_output` (the bundled runner pins 2.1.263). Updating the orchestrator alone does not update a pinned runner image; an older CLI or executor can leave automated reviews incomplete.

Claude Code documents schema-based output in [programmatic usage](https://code.claude.com/docs/en/headless#get-structured-output). Sonnet 5 migration details, including the changed tokenizer and thinking defaults, are in the [official migration guide](https://platform.claude.com/docs/en/models/sonnet-5/migration-guide).

## Hook environment and forwarded secrets

The dispatch side declares which secrets are present by naming them in `AI_IMPLEMENT_FORWARDED_SECRETS` (a comma-separated list of environment variable names). `setup`, `verify`, `teardown`, and `dependency-auth` all run as repo-owned processes that inherit the full runner env and therefore see those values. `modelProcessEnv()` in `src/pipeline/process-env.ts` strips each named key — and the `AI_IMPLEMENT_FORWARDED_SECRETS` list variable itself — before starting Claude Code, so the model and any processes it spawns never see them.

Two producers set `AI_IMPLEMENT_FORWARDED_SECRETS`:

- **GHA**: the "Forward repository secrets" step in `workflows/claude-implement.yml` (and `claude-plan.yml`) reads **one** repository secret, `AI_IMPLEMENT_FORWARDED_ENV`, as `KEY=VALUE` lines. It validates each name (format, a reserved-name list that covers every secret the template itself reads, and the `RUN_`/`AI_IMPLEMENT_` prefixes), masks each value, exposes each pair into the runner env, and writes the confirmed names to `AI_IMPLEMENT_FORWARDED_SECRETS` for the remainder of the job. It reads a single literal secret on purpose: the previous design, `${{ toJSON(secrets) }}`, trips GitHub's malicious-workflow scanner, which then gates every dispatch behind manual approval (AII-502).
- **Fly**: the orchestrator passes `AI_IMPLEMENT_TEAM_SECRET_PREFIX` and `AI_IMPLEMENT_FOREIGN_SECRET_NAMES` in the machine env (`buildSessionMachineConfig` in `src/fly-machines.ts`). The runner entrypoint (`remap_team_secrets` in `session/lib.sh`, run before the `su -p coder` hand-off) remaps this team's `<TEAM>_<NAME>` secrets to their bare names, unsets other teams' names, and exports `AI_IMPLEMENT_FORWARDED_SECRETS`. Fly injects classic app secrets app-wide under their stored names, so this entrypoint pass is the isolation boundary — see `docs/deployment.md` § "Per-project secrets (Fly)".

One consumer: `src/pipeline/process-env.ts`. `parseForwardedSecrets()` reads the list; `modelProcessEnv()` deletes each named key before Claude Code starts. `repoProcessEnv()` — used for hooks and dependency install — leaves forwarded secrets in place.

## How steps get their inputs

This is the least obvious part of the design, and the easiest thing to get wrong when extending it.

The YAML declares only three things per step: `id`, `type`, and an optional `moduleId`. It declares **no inputs and no skip conditions**. Those live in `applyWiring()` — a `switch` on **step id** in `src/pipeline/pipeline-loader.ts` — which attaches an `inputs` function and an optional `skip` predicate to each known id as the YAML is loaded.

```yaml
  - id: preflight
    type: preflight
```

```typescript
    case "preflight":
      return {
        ...step,
        inputs: (ctx) => ({
          workspaceDir: ctx.getOutputs("clone").workspaceDir,
          packageManager: ctx.getOutputs("install").packageManager,
        }),
        skip: (ctx) => ctx.getOutputs("feedback-loop").approved !== true,
      };
```

**The footgun:** `applyWiring`'s `default` branch returns the step unchanged, with no `inputs` function. `resolveInputs` returns `{}` for an undefined definition. So **a step added to the YAML without a matching `case` receives an empty inputs object** — no error, no warning, just a step that runs with nothing. If a new step behaves as though it were handed no configuration, this is why.

Adding a step therefore means two edits, not one: the YAML entry and the `applyWiring` case.

## Steps are coupled by step id

Steps communicate through `context.getOutputs("<step id>")`. The ids in that call are string literals scattered across `applyWiring` and the step modules — `clone` supplies `workspaceDir` and `githubToken` to nearly everything, `install` supplies `packageManager` and `repoModels`, `feedback-loop` supplies `approved` and the termination reason, `push` supplies `prNumber` and `branchPushed`.

**Renaming a step id in the YAML breaks every reader of its outputs**, and does so silently: `getOutputs` on an unknown id returns an empty object rather than throwing. Treat step ids as a published interface.

## Overriding the pipeline in a fork

Resolution is handled by two functions in `src/pipeline/resolve-module.ts`, which search two custom roots in order before falling back to the built-in package root:

1. **Workspace root** — `custom/<path>` relative to `process.cwd()`. This is how orchestrator-side loading picks up a fork's `custom/`.
2. **Baked root** — `<AI_IMPLEMENT_CUSTOM_ROOT>/custom/<path>`. `Dockerfile.session` copies the repo's `custom/` to `/app/custom/` and sets `AI_IMPLEMENT_CUSTOM_ROOT=/app`, which is how the runner picks up overrides — its cwd is `/workspace`, so the workspace root never matches there.

### Replacing a step

Place `custom/steps/<id>.ts` exporting a `StepModule` as its **default export**. It replaces the built-in registered under that key. A file that exists but has no default export logs a warning and falls back to the built-in, rather than failing the run or silently misbehaving.

The lookup tries `.ts`, then `.js`, then `.mjs`, so the same override works under `tsx` in development and in a compiled image.

Two resolvers exist and their extension orders differ, which matters only if you are reading the code. Overrides of a **registered** step — every built-in — go through `resolveModuleImport` in `src/pipeline/resolve-module.ts`, the `.ts`-first order above. `PipelineRunner.loadModule` uses `.js` first and has no `.mjs`, but it is only reached for a step id absent from the registry, so it never handles a built-in override.

### Replacing the pipeline

Place `custom/pipelines/autonomous.yml`. It replaces the built-in definition wholesale. `applyWiring` still runs against it, so step ids that match built-in ids keep their standard wiring — and ids that do not match get nothing, per the footgun above.

Only these `type` values are accepted: `clone`, `install`, `implement`, `review`, `preflight`, `push`, `await_ci`, `custom`. Any other value fails at load time with the offending step id named. Note that several built-in steps use `type: custom` with an explicit `moduleId` — the type is a coarse category, and `moduleId` (falling back to `type`) is what actually selects the module.

### Timing

Both the pipeline definition and the step modules resolve **before the clone step runs** — the definition at module import time, the modules eagerly in `createDefaultRunner()`. Overrides therefore have to be baked into the runner image; a `custom/` directory that only exists in the target repo's checkout arrives too late to be honored for these two extension points.

## Failure record

Every failed step's outputs carry a `failure: FailureRecord` alongside the existing `error: string` (`src/pipeline/failure-classification.ts`). `error` is kept as-is — it is what the admin UI and the existing test suite already read — `failure` adds a structured classification on top:

```typescript
export type FailureCategory =
  | "transient" | "auth" | "config" | "conflict"
  | "invalid_output" | "cancelled" | "crash" | "unknown";

export interface FailureRecord {
  category: FailureCategory;
  code: string;           // open-ended machine code, e.g. PROVIDER_OVERLOADED
  stage: string;          // step id or sub-step id
  attempt: number;        // request attempt within the stage (see "Request-level retries" below)
  retryable: boolean;     // category === "transient"
  exitCode?: number | null;
  signal?: string | null;
  message: string;        // redacted one-liner
  evidence: {
    stdoutTail?: string;  // redacted, <= EVIDENCE_TAIL_BYTES (8 KiB)
    stderrTail?: string;
    truncated: boolean;
    llmSubtype?: string | null;
    llmIsError?: boolean | null;
    llmOutcome?: RunTelemetry["outcome"] | null;
    /** Set only when evidence capture itself failed (best-effort). */
    captureError?: string;
  };
}
```

`classifyLlmResult`'s `ctx.expectsStructuredOutput` gates the terminal-event, missing-structured-output, and outcome-mismatch branches: review sets it `true` (it always requests a JSON verdict), implement leaves it `false` (it never requests structured output, so a plain crash there isn't misclassified as `invalid_output`). Checks run structural-first: a non-null `result.signal` is checked ahead of everything else and always classifies `cancelled`/`PROCESS_SIGNALLED`; then, for `exitCode === 0`, the structural branches run in order — a missing terminal event (`LLM_NO_TERMINAL_EVENT`), a failing terminal event (`LLM_TERMINAL_ERROR`), a `telemetry.outcome` that disagrees with a nominally-successful terminal status (`LLM_OUTCOME_MISMATCH`), then missing structured output (`LLM_NO_STRUCTURED_OUTPUT`) — before falling back to `unknown`. `PROVIDER_SIGNATURES` (the text-based table) is consulted **only when `exitCode !== 0`**: once the exit is clean, the model's own final text is part of the match input, so a dropped verdict that happens to discuss a transport error in its prose must classify by its actual structural defect, not by a lexical coincidence in stdout.

**`category` is closed, `code` is open.** The retry rails this record is the foundation for switch on `category`; an open string there would let a new call site invent a category the retry policy silently never matches. `code` has no such constraint — a new step can add a code without touching this module. **`unknown`/`UNKNOWN` is a first-class result, not a fallback that guesses.** A classifier that cannot match a signature returns it rather than picking the closest-looking category — retaining that uncertainty is the point, not a gap to be filled in later.

Three classifiers build a record from three different failure shapes: `classifyLlmResult` (a completed-but-failing or structurally invalid `LLMResult`), `classifyGitFailure` (a failed git invocation's stderr and exit status), and `classifyThrown` (an arbitrary thrown error — the generic fallback used by `PipelineRunner`'s own catch). `classifyThrown` passes through an already-attached `err.failure` unchanged rather than re-deriving a classification from the stringified message, so `implement.ts`/`review.ts`/`push.ts`/`clone.ts` attaching a record at the throw site is authoritative over any later generic reclassification. Failing that, `classifyThrown` runs `GIT_SIGNATURES` ahead of `PROVIDER_SIGNATURES` when the message looks like git's own output (a `fatal:`/`remote:` line, a "failed to push", or a `git `-prefixed label) — otherwise a git-side 403 collides with `PROVIDER_SIGNATURES`' own 401/403 pattern and reports `PROVIDER_AUTH` instead of `GIT_AUTH`.

The feedback loop's per-iteration sub-steps (`feedback-loop.ts`) re-stamp `stage` to the iteration-qualified id (e.g. `feedback-loop/implement-2`) on a record `classifyThrown` merely passed through unchanged from an inner classifier — otherwise the sub-step's own iteration context would never make it onto the record.

Evidence capture (tailing and redaction) is best-effort: if it throws, the classify function still returns a record — `category: "unknown"`, `evidence.truncated: true`, `evidence.captureError` set, and `message` holding the original, unclassified error text. A failure inside the classifier must never replace the failure it was classifying.

The completion callback (`src/run-autonomous.ts` → `src/runner-callback.ts`) carries the terminal record as `failure` alongside the existing `failureReason`/`failureCode`, persisted on the job as `failure_json`. The orchestrator validates only the record's shape and never trusts `code` for anything but display — the closed `category` union is what any future retry logic is allowed to depend on. An unrecognised `failure` shape (e.g. a `category` this orchestrator predates) is **dropped with a warning, not rejected** — the rest of the callback (comments, the tracker transition, remediation) still runs, since the callback's token is already consumed by this point and the runner has no retry path. `listLog` strips the evidence tails from list rows (and forces `evidence.truncated: true` on them); a single-job read keeps the full record. Nothing renders the record yet — no tracker comment or admin view reads it — this is deliberately just the shared taxonomy and evidence record the retry rails and the failure comment build on next.

## Retry policy

`RetryPolicy` and `DEFAULT_RETRY_POLICY` live in `src/pipeline/retry-backoff.ts` — runner-safe, no database import — alongside `computeBackoffMs` (exponential backoff, one-directional jitter below the cap so `backoffMaxMs` is a true ceiling) and `normalizeRetryPolicy`. The orchestrator stores an operator-edited policy under the `retry_policy` settings row (`getRetryPolicy`/`setRetryPolicy` in `src/orchestrator-settings.ts`, the Retry Policy card on the admin Settings page) and stamps it into the envelope's `retryPolicy` on every implementation and gap-analysis dispatch; the runner resolves it into `context.data.retryPolicy`. `decodeRunConfig` type-asserts the envelope's shape but validates nothing at runtime, so `normalizeRetryPolicy` is the runner-side guard: an out-of-range or malformed field degrades silently to `DEFAULT_RETRY_POLICY`'s value for that field alone, never the whole policy, and an unknown key is dropped rather than thrown. `getRetryPolicy` runs the stored row through the same guard, so a hand-edited row can never reach the admin form or a dispatch out of range. The request-level retry rail below is the first consumer: `implement.ts` and `review.ts` hand `context.data.retryPolicy` to the executor as `retry.policy`, which reads `requestRetries` and the backoff fields (`backoffBaseMs`, `backoffMaxMs`, `backoffJitter`, via `computeBackoffMs`). `stageRetries` is not consumed yet — it is the contract surface the whole-stage retry rail reads once it exists.

## Request-level retries

`ClaudeCliExecutor.invoke`'s signature is `invoke({ prompt, model, stage, expectsStructuredOutput, retry?: { policy, toolUseIsSafe } })` (`InvokeParams`, `src/pipeline/types.ts`; `RetryPolicy`/`computeBackoffMs` in `src/pipeline/retry-backoff.ts`). `stage` and `expectsStructuredOutput` are top-level `InvokeParams` fields, not nested under `retry` — they're read independently of it so a bare `invoke()` call with no retry policy configured (the dev harness, or any custom `LLMExecutor`) still gets a correctly-staged, correctly-gated `failure` record. Omitting `retry` keeps single-attempt behaviour — this is the only retry rail request-level failures go through; a whole-stage retry (re-running implement or review from scratch) is a separate concern layered on top by BAC-27115.

The executor is the **single classifier**: `implement.ts` and `review.ts` read `result.failure`, already stamped with the correct `stage`/`attempt`/`elapsedMs`, and only fall back to calling `classifyLlmResult` themselves when a custom `LLMExecutor` settled a failure without attaching one. A settled attempt is classified whenever `isLlmResultFailure(result, expectsStructuredOutput)` says it's a failure — that check exists because `classifyLlmResult` cannot be called unconditionally: once `exitCode === 0` its structural branches fall back to `unknown`, which is indistinguishable from a genuine success unless the caller already knows a failure occurred. This is also why an `exitCode === 0` structural review failure (missing structured output, a failing terminal event) now gets `result.failure` populated even though it's never retried — invalid_output is not `transient`. A verdict that parses but is malformed (the parser's own message, or `approved=false` with no blocking issues) is the one review failure classified by the step rather than the executor: `invalidVerdictError` builds an `invalid_output`/`INVALID_STRUCTURED_OUTPUT` record from the concrete reason, because `classifyLlmResult` would only see an exit-0, schema-valid result and fall back to `unknown` with the reviewer's prose as the message.

The executor re-spawns a classified failure only when **all three** hold:

- `category === "transient"`,
- no `assistant` event of the attempt carried a `tool_use` block that counts as unsafe for this session — for a non-`toolUseIsSafe` session (implement) that means any `tool_use` at all (`sawToolUse`); for a `toolUseIsSafe` session (review) it narrows to a `Bash`-prefixed `tool_use`, e.g. `Bash(curl *)`, which despite the read-only allowlist can still write files or POST (`sawUnsafeToolUse`) — both in `src/pipeline/claude-stream.ts`, guarding `content` with `Array.isArray` since a string payload must not throw the `close` handler, and
- `attempt <= policy.requestRetries`, **and** the next backoff sleep would not push the total slept in this `invoke` call past `policy.backoffMaxMs * 2` (`requestRetries` up to 10 at a 300s cap could otherwise sleep for tens of minutes inside a bounded job; hitting the budget logs the reason and gives up early rather than exhausting `requestRetries`).

`toolUseIsSafe` does not skip the tool-use gate outright — it only narrows which tool calls count as unsafe. A re-spawn starts a brand-new session with no memory of the first attempt, so a workspace already mutated by a tool call could be duplicated or undone by a retry starting from scratch; for review's read-only session that risk is real only for a `Bash`-prefixed `tool_use`, so an ordinary Read/Glob/Grep tool use doesn't block review's retry the way it blocks implement's, but a `Bash(curl *)` still does. `implement.ts` sets `toolUseIsSafe: false` (any tool use blocks); `review.ts` sets it `true` since it runs under `READ_ONLY_ALLOWED_TOOLS` (only the unsafe subset blocks). Anything that isn't `transient` (auth, config, conflict, invalid_output, cancelled, crash, unknown) is never retried at this level either.

A rejection from spawning the CLI process itself — `proc.on("error")` (ENOENT, EAGAIN, ENOMEM) or the stdin error handler (EPIPE means the child stopped reading stdin; it may still be alive, which is why the handler signals its whole process group — the CLI is spawned `detached: true` so `process.kill(-pid, …)` reaches any subprocess it forked — and waits for `close` rather than rejecting immediately, escalating SIGTERM → SIGKILL after 5 s) — never produced an `LLMResult`, but is by construction a pre-tool-use failure, so `invoke` catches it and classifies it with `classifySpawnError` (`ENOENT` → `config`/`PROCESS_SPAWN_FAILED`, not retried; `EAGAIN`/`ENOMEM`/`EPIPE` → `transient`/`PROCESS_SPAWN_FAILED`, retried under the same budget) rather than letting it bypass the rail entirely. A `close` whose signal matches one the executor itself sent is the executor's own kill and is not reported as `cancelled`; any other signal still classifies `cancelled`/`PROCESS_SIGNALLED`. A close that never arrives within 5 s of the SIGKILL escalation settles instead as `crash`/`PROCESS_UNRESPONSIVE`, never retried — the process may be stuck in uninterruptible I/O, and `invoke` must not spawn a second `claude` into the same workspace while the first one might still be running. The one exception is the credential-suspend/restore step around each spawn (`suspendOriginWriteCredential`) — a failure there never started the CLI and is excluded from this rail.

Between attempts the executor waits `computeBackoffMs(attempt, policy)` and logs one line: `[claude] transient failure ({code}) on attempt {n}; retrying in {ms} ms`. `restoreProtectedOrigin()` (the credential suspend/restore around each spawn) runs once per attempt, not once per `invoke` call — every settle path restores the protected origin **except** `PROCESS_UNRESPONSIVE` and a failed `kill()` while the child may still be alive, which leave it protected because a possibly-live agent process must never regain push access, and the container's exit performs cleanup. `push.ts` and `post-push-review.ts` re-establish their own tokenised URL before pushing, so the withheld restore is harmless downstream.

`LLMResult` gains three fields to support this: `attempts` (spawn count for this invocation; optional on the type so a custom `LLMExecutor` may omit it — `ClaudeCliExecutor` always sets it, and consumers (`implement.ts`, `review.ts`) fall back to `result.attempts ?? 1` when it's absent), `signal` (the close event's termination signal, populated on every attempt regardless of whether `retry` was supplied), and `failure` — set only on the last attempt when giving up, carrying that attempt's classified record with `attempt` already stamped. When an `invoke` call makes more than one attempt, `telemetry.tokensIn`/`tokensOut`/`costUsd`/`numTurns`/cache counters are summed across every attempt (so a retried spawn's cost isn't dropped from `PassStat` or the PR body's per-pass stats) and `telemetry.durationMs` is replaced with the whole `invoke` call's wall clock rather than the final attempt's own reported duration; a single-attempt call is untouched. Every give-up rejection (a spawn failure on the only attempt, every attempt EPIPE'd, an unresponsive child) carries the accumulated telemetry as `err.telemetry`, and `implement.ts`/`review.ts` stamp the same field on a settled-but-failing result's thrown error, so `feedback-loop.ts` can surface it on the failed sub-step report. `implement.ts` and `review.ts` pass `retry` from `context.data.retryPolicy` (absent means no retry, matching a context built without one) and surface `attempts` in their step outputs so the step log shows how many spawns an invocation took; `feedback-loop.ts` carries it into each `PassStat` as `attempts`/`reviewAttempts`.

The CLI may perform its own internal retries before ever exiting (a `retrying`/`attempt N of M` line in its stderr) — the executor does not parse for this and must not: it always counts one exit as one attempt, regardless of what the CLI's own stderr says it did internally.

## Execution semantics

`PipelineRunner.run` iterates steps in order. A step that throws is reported as `failed`, has its error stored in its outputs, and the exception propagates — the pipeline stops there. A skipped step is reported as `skipped` and its outputs are set to `{}`, so downstream `getOutputs` calls return an empty object rather than undefined.

The runner accepts a `stopAfterStep` option, used by the local dev harness's `--until` flag. An unknown step name throws **before any step executes**, rather than running the whole pipeline and then failing to find the boundary. The stop applies to skipped steps too — `--until setup` halts after `setup` whether the hook ran or was skipped for want of a `setup:` entry.

Because `feedback-loop` is step 5, `--until` with any earlier step is a token-free run: no Claude invocation happens.

## kg-refresh phase

The kg-refresh pipeline (`pipelines/kg-refresh.yml`) uses different step wiring from the autonomous pipeline. Its steps, in order: `clone` → `dependency-auth` → `clone-code-repo` → `clone-secondary-repos` → `kg-tracker-data` → `kg-ingest` → `feedback-loop` → `kg-snapshot-push`. The entry point is `src/pipeline/kg-refresh-run.ts` rather than `run-autonomous.js`.

**`dryRun` input on `kg-snapshot-push`.** The step accepts an optional `dryRun?: boolean` input. When true, all regression guards and snapshot validation still run — a tracker regression or missing snapshot still throws — but the commit and push are skipped. The per-part line-count table (printed at the regression guard check) and a dry-run verdict line are the only output. The step returns `{ snapshotPushed: false, commitSha: null }`. This path is used by the dev-harness kg-refresh phase (see below) and is wired in `pipeline-loader.ts` via `dryRun: ctx.data.kgDryRun === true`.

**`file://` clone for local dev.** When `AI_IMPLEMENT_DEP_TOKEN_OVERRIDE` is set (injected by the dev harness), `kg-refresh-run.ts` swaps the standard `clone` step for `devHarnessKgCloneStep`. That step clones from `file:///kg-source` — the path where the harness bind-mounts the operator's KG source checkout read-only — rather than from GitHub. The clone carries full history, so `sources.yml` in the operator's working tree (including uncommitted edits) is what runs. A stub `dependency-auth` step marks `acquired=true` using the override token, satisfying the `clone-secondary-repos` skip condition without contacting the orchestrator.

**Local dev entry point.** `--phase kg-refresh` in the dev harness sets `AI_IMPLEMENT_KG_DRY_RUN=true` and `AI_IMPLEMENT_DEP_TOKEN_OVERRIDE` (from the operator's `GH_TOKEN`), binds the workspace at `/kg-source:ro`, and binds the `--tracker-data` file at `/dev-tracker-data.json:ro`. The `kg-tracker-data` step reads `KG_TRACKER_DATA_FILE=/dev-tracker-data.json` and uses the pre-fetched file rather than calling the orchestrator. `--until` and `--shell` both work for this phase.
