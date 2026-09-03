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

`pipelines/autonomous.yml` declares ten steps. They run in file order, and each is registered under a key in `BUILTIN_STEPS` (`src/pipeline/default-pipeline.ts`).

| # | Step id | Skipped when |
|---|---------|--------------|
| 1 | `clone` | never |
| 2 | `install-skills` | no `skillsRepo` configured |
| 3 | `dependency-auth` | the mapping has no Dependency Token Scope set |
| 4 | `install` | never (internally no-ops for a mounted workspace or a repo with no `package.json`) |
| 5 | `setup` | no `setup:` hook in `WORKFLOW.md` front matter |
| 6 | `feedback-loop` | never |
| 7 | `preflight` | the feedback loop did not approve |
| 8 | `push` | the run is a gap-fill (`prNumber` set) |
| 9 | `verify` | no `verify:` hook, or the feedback loop did not approve |
| 10 | `post-push-review` | not approved, or nothing was pushed, or no PR number |

`dependency-auth` sits deliberately before `install`: it fetches a read-only, installation-wide token and installs it as a git credential helper plus `COMPOSER_AUTH`, so the dependency install that follows can resolve private sibling repositories. Its inputs are also a worked example of a real constraint — the run's progress token is **not** passed through `inputs`, because inputs are persisted to the step log and surfaced through the admin API. The step reads that secret from `process.env` directly. Anything secret belongs in the environment, not in a step's inputs.

`feedback-loop` is where Claude actually runs — it drives the implement/review cycle up to `maxIterations`. Everything before it prepares the workspace; everything after it reacts to the result.

Two consequences worth internalising:

**`preflight` does not gate the push.** It is skipped unless the review already approved, and `push` runs regardless of what it found. It records `typecheck`/`lint`/`test` results; it does not block a pull request on them. Work that fails preflight still ships.

**A gap-fill run never pushes from the pipeline.** `push` is skipped whenever `prNumber` is set, because the agent commits and pushes to the existing PR branch itself. This is why gap-fill and initial runs need different instructions in `WORKFLOW.md`.

## Hook environment and forwarded secrets

The dispatch side declares which secrets are present by naming them in `AI_IMPLEMENT_FORWARDED_SECRETS` (a comma-separated list of environment variable names). `setup`, `verify`, `teardown`, and `dependency-auth` all run as repo-owned processes that inherit the full runner env and therefore see those values. `modelProcessEnv()` in `src/pipeline/process-env.ts` strips each named key — and the `AI_IMPLEMENT_FORWARDED_SECRETS` list variable itself — before starting Claude Code, so the model and any processes it spawns never see them.

Two producers set `AI_IMPLEMENT_FORWARDED_SECRETS`:

- **GHA**: the "Forward repository secrets" step in `workflows/claude-implement.yml` reads the repository secret names listed in the `AI_IMPLEMENT_FORWARD_SECRETS` Actions variable, validates each name, exposes each secret value into the runner env, and writes the confirmed names to `AI_IMPLEMENT_FORWARDED_SECRETS` for the remainder of the job.
- **Fly**: `src/fly-machines.ts` maps per-project secrets stored in the Fly Secrets panel to environment variable names (stripping the per-team prefix) and sets `AI_IMPLEMENT_FORWARDED_SECRETS` in the machine launch config.

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

## Execution semantics

`PipelineRunner.run` iterates steps in order. A step that throws is reported as `failed`, has its error stored in its outputs, and the exception propagates — the pipeline stops there. A skipped step is reported as `skipped` and its outputs are set to `{}`, so downstream `getOutputs` calls return an empty object rather than undefined.

The runner accepts a `stopAfterStep` option, used by the local dev harness's `--until` flag. An unknown step name throws **before any step executes**, rather than running the whole pipeline and then failing to find the boundary. The stop applies to skipped steps too — `--until setup` halts after `setup` whether the hook ran or was skipped for want of a `setup:` entry.

Because `feedback-loop` is step 5, `--until` with any earlier step is a token-free run: no Claude invocation happens.
