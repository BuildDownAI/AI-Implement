# custom/

Repo-local overrides that take precedence over files shipped with the orchestrator. A file at `custom/<path>` is used in place of the corresponding built-in when both exist.

Resolution is implemented by two functions in `src/pipeline/resolve-module.ts`:

- `resolveModule(path)` — synchronous, returns a file-system path. Used for YAML, template files, and runtime step discovery by the runner.
- `resolveModuleImport<T>(path, options?)` — async, dynamically imports the module and returns its `default` export. Used for TypeScript/JavaScript step and provider overrides loaded at runner construction. Returns `null` when no custom override is present so the caller can fall back to the built-in.

Both functions check `custom/<path>` (relative to `process.cwd()`) before the built-in. This is the **single utility** — there is no per-module-type discovery logic.

## What's wired up today

### `custom/pipelines/` — shadow a built-in pipeline YAML

Place `custom/pipelines/autonomous.yml` at the workspace root to override `pipelines/autonomous.yml` (the autonomous loop definition loaded by `default-pipeline.ts`).

Pipeline YAML schema (see `src/pipeline/pipeline-loader.ts`):

```yaml
id: <pipeline-id>
steps:
  - id: <step-id>
    type: <StepType>          # one of the types in src/pipeline/types.ts
    moduleId: <registry-key>  # optional; defaults to `type`
```

Step input wiring and `skip` predicates for the known autonomous-loop step IDs (`install`, `feedback-loop`, `preflight`, `push`) are applied automatically by `applyWiring()` in the loader — YAML only declares `id`, `type`, and optional `moduleId`.

### `custom/steps/` — override a built-in step or add a new one

Two loading paths both resolve from `custom/steps/` first:

1. **Override a built-in.** `createDefaultRunner()` (in `src/pipeline/default-pipeline.ts`) calls `resolveModuleImport("steps/<id>")` for each built-in step key. If a custom override is found it replaces the built-in; otherwise the built-in is used. Supported built-in keys: `clone`, `install`, `feedback-loop`, `preflight`, `push`.

2. **Add a new step.** When the runner encounters a `moduleId` that is not pre-registered, it calls `resolveModule('steps/<moduleId>.js')` (and `.ts` as a fallback for tsx dev environments) to locate the file and load it on demand.

Either way, the file **must** export a `StepModule` as its default export:

```ts
// custom/steps/hello.ts
import type { StepModule } from "../../src/pipeline/types.js";

export default {
  async run(_context, _inputs, _reporter) {
    return { message: "hello from custom step" };
  },
} satisfies StepModule;
```

Reference it from a pipeline:

```yaml
# custom/pipelines/autonomous.yml
steps:
  - id: my-step
    type: custom
    moduleId: hello        # loads custom/steps/hello.js (or .ts in dev)
```

See `custom/steps/hello.ts` for a working example.

### `custom/providers/` — override a provider module

Reserved for provider overrides introduced by AII-75 (TicketingProvider interface). Provider loading will call `resolveModuleImport("providers/<id>")` using the same resolver.

## Step module contract

```ts
export interface StepModule<
  I extends Record<string, unknown> = Record<string, unknown>,
  O extends Record<string, unknown> = Record<string, unknown>,
> {
  run(context: PipelineContext, inputs: I, reporter: StepReporter): Promise<O>;
}
```

## Files committed here survive upgrades

The orchestrator never overwrites `custom/`. Anything you put here is yours to maintain. Upstream commits only touch `custom/README.md`; a CI check (`protect-custom.yml`) rejects PRs that modify any other file under `custom/`.
