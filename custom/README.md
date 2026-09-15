# custom/

Repo-local overrides that take precedence over files shipped with the orchestrator. A file at `custom/<path>` is used in place of the corresponding built-in when both exist.

Resolution is implemented by two functions in `src/pipeline/resolve-module.ts`:

- `resolveModule(path)` — synchronous, returns a file-system path. Used for YAML, template files, and runtime step discovery by the runner.
- `resolveModuleImport<T>(path, options?)` — async, dynamically imports the module and returns its `default` export. Used for TypeScript/JavaScript step and provider overrides loaded at runner construction. Returns `null` when no custom override is present so the caller can fall back to the built-in.

Both functions check two roots for `custom/<path>` before the built-in. This is the **single utility** — there is no per-module-type discovery logic.

1. `custom/<path>` relative to `process.cwd()` — matches orchestrator-side loading (cwd = app root).
2. `<AI_IMPLEMENT_CUSTOM_ROOT>/custom/<path>` — the env var names a directory that *contains* a `custom/` subdirectory. `Dockerfile.session` copies this directory to `/app/custom/` and sets `AI_IMPLEMENT_CUSTOM_ROOT=/app`, which is what makes overrides work **inside the session runner**: the runner's cwd is `/workspace` (the target-repo clone dir, empty when the pipeline definition and step registry load), so root 1 never matches there.

So: to get your fork's `custom/` honored by the runner, build and publish your own runner image (see "Runner image resolution" in `CLAUDE.md`) — the image build bakes `custom/` in. `custom/steps/*.ts` files baked into the image are loaded by plain `node` (no tsx), which type-strips them on Node 24; keep them to erasable TypeScript syntax and `import type` for anything under `src/` (runtime imports of `src/` won't resolve in the image — only compiled `dist/` ships).

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

## Updating a fork from upstream

A fork takes upstream changes with a git merge. The orchestrator has no rail for this.

**Precondition.** The fork must share history with `BuildDownAI/AI-Implement`. Check with `git log --oneline | tail -3` and compare against upstream. A repo with no common ancestor cannot merge. Create a real fork instead.

Add the remote once:

```bash
git remote add upstream https://github.com/BuildDownAI/AI-Implement
```

For each update, merge into the branch the fork deploys from (the `SOURCE_BRANCH` stamp, or the **Watched source** ref on `/admin#deployments`):

```bash
git fetch upstream
git merge upstream/testing
```

`testing` is the development branch. `main` is the release line and lags it (see `docs/plans/2026-09-14-production-promotion-notes.md`). Merge the branch the fork tracks.

Rules:

- Expect conflicts on built-in modules the fork edited. Move that behavior into `custom/` and take the upstream side of the conflict. That is what keeps the next merge small.
- After the merge, run `npm ci`, `npm run typecheck`, and `npm test`. Check the Node major against `.tool-versions`.
- Diff `.env.example` against the app's secrets. A missing variable warns at boot and degrades a feature.
- Sync the fork before you configure a feature that shipped upstream. Older vintages do not have `/admin#deployments`, `/mcp`, or the KG refresh rail.

### Upstream-only files

These files belong to the public project. A private fork does not need them:

| File | Effect in a fork |
|---|---|
| `CONTRIBUTING.md` | None. Text only. |
| `legal/CCLA.md`, `legal/ICLA.md` | None. Text only. |
| `SECURITY.md` | None. Text only. Names the upstream disclosure contact. |
| `.github/workflows/cla.yml` | Runs on every PR in the fork and asks contributors to sign the upstream CLA against a `cla-signatures` branch the fork does not have. Remove it, or wait for the repository guard (AII-692). |

`.gitignore` cannot exclude them. It applies to untracked files only. A tracked file always takes part in a merge.

**First removal.** Run this once on the deploy branch after a merge:

```bash
git rm -q CONTRIBUTING.md legal/CCLA.md legal/ICLA.md .github/workflows/cla.yml
git commit -m "Drop contributor files (private fork)"
```

**Every later update.** Replace the two-command merge above with this line:

```bash
git fetch upstream && git merge upstream/testing; git rm -q --ignore-unmatch CONTRIBUTING.md legal/CCLA.md legal/ICLA.md .github/workflows/cla.yml && git commit --no-edit
```

What it does in each case:

- Upstream did not touch the removed files: the merge commits on its own. The trailing commit reports `nothing to commit`. That is expected.
- Upstream edited one of them: git reports `CONFLICT (modify/delete)` and leaves the upstream copy in the tree as an unmerged path. The `git rm` resolves it as deleted and the commit completes with the prepared merge message. The file never lands.
- A conflict elsewhere: the commit refuses with `Exiting because of an unresolved conflict`. Resolve that conflict by hand, then run `git commit --no-edit`.

A deleted file never returns on its own. Only an upstream edit brings it back, and then only as a conflict the line above resolves.

**A fork cut from `main` sees two conflicts on its first merge of `testing`** (`legal/CCLA.md` add/add and `CONTRIBUTING.md` content). Both come from commits that landed on `main` and `testing` separately (AII-691). Resolve them with the first-removal commands above. After AII-691 lands the first merge is clean.

**Alternative.** The Deployments page can watch upstream directly (`docs/deployment.md` § "Using a public source repository"). The image is then built from upstream code only, so it contains no `custom/` files. Use that path only for a fork with no `custom/` overrides.
