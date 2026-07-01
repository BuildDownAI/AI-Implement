# custom/

Repo-local overrides for this repository's AI-Implement runs. Any file under
`custom/` takes precedence over the runner's corresponding built-in, so you can
tailor how AI-Implement builds, tests, and ships this repo without forking the
runner image.

## How resolution works

When the runner executes, it checks for `custom/<path>` (relative to the repo
root) before falling back to its built-in. Overrides are discovered by **filename
match** at startup — there's nothing to register:

    custom/steps/install.ts          → overrides the built-in "install" step
    custom/pipelines/autonomous.yml  → overrides the autonomous loop definition
    (no custom file)                 → the built-in is used

## Extension points

### custom/steps/ — override or add a pipeline step

Name a file after a built-in step's ID to **replace** it (e.g.
`custom/steps/install.ts` overrides the `install` step), or use a new name to
**add** a step and reference it from a custom pipeline (below). The current list
of built-in step IDs lives in the docs.

Every step file must **`export default` an object satisfying the `StepModule`
interface** — an async `run` the runner invokes:

    run(context, inputs, reporter) => Promise<outputs>

Minimal example:

    // custom/steps/install.ts
    export default {
      async run(context, inputs, reporter) {
        // ...your logic...
        return { ok: true };   // this step's outputs
      },
    };

The `StepModule` type ships with the AI-Implement runner; at runtime the runner
only needs the default export to expose a matching `run`, so a step works without
any import. Add `satisfies StepModule` (importing the type from the runner) for
editor type-checking. A file that exists but has no default export logs a warning
and falls back to the built-in.

### custom/pipelines/ — override a pipeline definition

Place `custom/pipelines/<name>.yml` to replace a built-in pipeline (e.g. the
autonomous loop). Each step declares an `id`, a `type`, and an optional `moduleId`
(which points at `custom/steps/<moduleId>`). See the docs for the full schema and
a worked example.

### custom/providers/ — reserved (not yet wired)

A placeholder for upcoming ticketing-provider overrides. The interface isn't
stable, so **don't build against it yet** — files here have no effect today and
may change without notice. It exists so you know where provider overrides will go.

## Reference

Full step/pipeline contracts, the built-in step IDs, input/output wiring, and
worked examples:
https://docs.builddown.ai/latest/customize/custom-steps

## These files are yours

AI-Implement seeds this directory once and **never overwrites anything under
`custom/`** afterward. Everything you add here is yours to maintain and survives
future workflow syncs.
