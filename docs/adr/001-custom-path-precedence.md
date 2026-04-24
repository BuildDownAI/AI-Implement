# ADR 001: custom/ path-precedence extension mechanism

**Status:** Accepted

**Date:** 2026-04-23

**References:** AII-76 (resolver implementation), AII-77 (custom/ directory creation)

---

## Context

The orchestrator ships as a shared runner image used by multiple client forks. Each client needs to customise pipeline behaviour (steps, providers, pipeline definitions) without modifying the built-in modules. Forks that edit built-in files accumulate merge conflicts with every upstream update, making upgrades expensive and error-prone.

The requirement is: clients can extend or replace any built-in behaviour locally, upstream never touches client-owned files, and the mechanism is simple enough that Claude Code sessions in client forks understand it without additional explanation.

---

## Decision

Introduce a `custom/` directory at the workspace root. Any file placed at `custom/<path>` takes precedence over the corresponding built-in file when that path is loaded.

Resolution is implemented in `src/pipeline/resolve-module.ts` by two functions:

- `resolveModule(path, options?)` — synchronous; used for YAML and template files. Checks `custom/<path>` first, falls back to the built-in package root.
- `resolveModuleImport<T>(path, options?)` — async; used for TypeScript/JavaScript modules. Checks `custom/<path>.{ts,js,mjs}`, returns the `default` export, or `null` if no override exists so the caller can use the built-in.

Both functions accept injectable `customRoot`, `builtinRoot`, `existsSyncImpl`, and `importFn` options so they are fully testable without touching the filesystem.

The three wired extension points are:

| Directory | What it overrides | Loader |
|-----------|-------------------|--------|
| `custom/pipelines/` | Pipeline YAML definitions | `resolveModule("pipelines/<name>.yml")` |
| `custom/steps/` | Built-in step modules | `resolveModuleImport("steps/<id>")` in `createDefaultRunner()` |
| `custom/providers/` | Provider modules | `resolveModuleImport("providers/<id>")` (reserved) |

A CI check (`protect-custom.yml`) rejects any upstream PR that modifies files under `custom/` other than `custom/README.md`, making the ownership boundary enforceable.

---

## Consequences

**Positive:**
- Forks upgrade cleanly — upstream never touches `custom/`, so there are no conflicts in the extension directory.
- Single resolution utility for all extension types; no per-module-type discovery logic to maintain.
- Testable without filesystem mocks — options-injection covers all edge cases.
- Claude Code sessions understand the mechanism from `CLAUDE.md` and `WORKFLOW.md` without extra prompting.

**Negative / trade-offs:**
- `resolveModuleImport` returns `null` on no-override, shifting fallback responsibility to callers. A missing `default` export in a custom file silently warns and falls back to built-in rather than hard-failing, which may hide typos.
- The extension points are wired manually — adding a new extension point requires editing the calling code, not just dropping a file.
- No hot-reload; a custom file change requires a process restart.

---

## Alternatives considered

### Plugin system (e.g. npm packages)
Clients would publish a private npm package and add it as a dependency. Rejected: too much ceremony for per-client overrides; requires a package registry; Claude Code sessions would need to understand the plugin API.

### Config-driven dependency injection
A YAML config file would map step/provider IDs to implementation modules. Rejected: adds a config schema to maintain and a loader that must be kept in sync with the module list; path-precedence is simpler and achieves the same result.

### Monorepo with packages
Split the orchestrator into a core package and per-client packages in a monorepo. Rejected: significantly more infrastructure (Turborepo/Nx, changesets, per-client CI); overkill for the number of extension points currently needed.
