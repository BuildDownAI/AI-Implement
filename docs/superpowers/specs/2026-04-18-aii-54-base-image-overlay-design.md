# AII-54: Pre-baked base image + per-repo image override

**Status:** Design approved
**Linear:** [AII-54](https://linear.app/eudoxus/issue/AII-54/pre-baked-base-image-per-repo-overlay-via-ai-implementimageyml)
**Date:** 2026-04-18

## Summary

Beef up the single pre-baked session runner image so most runs need no further install, and add a lightweight `.ai-implement/image.yml` escape hatch that lets a target repo point the orchestrator at a different (customer-built, publicly-pullable) image. No orchestrator-side image building. No declarative package list. Per-run quirks keep using the existing `setup:` hook in `WORKFLOW.md`.

## Goals

- Make common agent tooling available by default (ripgrep, fd, yq, shellcheck, sqlite3, git-lfs, corepack-enabled yarn/pnpm, etc.).
- Give customer repos a simple, codified way to override the runner image when the default doesn't fit.
- Avoid introducing a build-and-cache pipeline in the orchestrator.

## Non-goals

- Orchestrator-side builds of per-repo overlay images.
- Private registry pull credentials.
- Declarative `apt:` / `packages:` fields in `image.yml`.
- Content-hash caching. Customer owns their own tag discipline.

## Architecture

Two layers:

1. **Default base image** — one image published in the org's GHCR, versioned, used by every dispatch unless overridden. Orchestrator picks it via the existing `SESSION_IMAGE` env var.
2. **Per-repo override** — optional `.ai-implement/image.yml` at the default branch of the target repo naming a different image. Orchestrator reads it via the GitHub contents API right before `createMachine` and passes it through to the Fly machine config.

Per-run customization (install this branch's quirky dep, fetch a private artifact, etc.) continues to use the `setup:` hook in `WORKFLOW.md`. Nothing new for callers who don't need an override.

## Base image

### Source of truth

Port and extend `Dockerfile.session` from the `v2/fly-machines` branch into this repo's `Dockerfile.session`. Starting base: `node:22-bookworm-slim`.

### Contents

Keep from the current v2 image:

- `git`, `curl`, `jq`, `openssl`, `ca-certificates`
- `python3`, `python3-pip`
- `gettext-base`, `perl`
- `gh` CLI (official apt source)
- `@anthropic-ai/claude-code` (global npm)
- Session scripts copied to `/opt/ai-implement/`

Add:

- `ripgrep` — fast code search.
- `fd-find` — fast file search (Debian installs as `fdfind`; symlink or alias to `fd`).
- `yq` — YAML processor; agent needs it; orchestrator uses it too.
- `tree` — quick repo orientation.
- `sqlite3` CLI.
- `git-lfs` — some customer repos require it; silent degradation otherwise.
- `openssh-client` — for repos with SSH submodules or hooks.
- `unzip`, `zip`, `xz-utils` — archive handling.
- `shellcheck` — agent self-verification when it writes bash.
- `build-essential`, `make`, `pkg-config` — native builds for many npm/python packages.
- `less` — pager for `gh`/`git` output.
- `corepack enable` — zero-size switch to make `yarn` and `pnpm` work.
- `@ast-grep/cli` (installed globally via npm, exposes `sg`) — structural/AST-based search and rewrite; far more reliable than regex for refactors.

### Tool manifest

Image ships a static `/etc/ai-implement/tools.md` listing non-obvious tools (rg, fd, yq, shellcheck, sqlite3, git-lfs, corepack, tree, sg) with one-line descriptions. Entrypoint prepends the following line to the Claude prompt (both default and WORKFLOW.md-derived paths):

> Power tools available in this environment: see /etc/ai-implement/tools.md

Single line in `entrypoint.sh`, static file in the image; survives prompt rewrites.

### Versioning

Tags:

- `ghcr.io/eudoxus-ai/ai-implement-runner:base-vYYYYMMDD` — immutable per build.
- `ghcr.io/eudoxus-ai/ai-implement-runner:latest` — rolling.

Orchestrator deployments pin the `base-v*` tag via `SESSION_IMAGE`. Bumping the base is a one-line env change on the orchestrator Fly app (or per-client app), followed by redeploy.

### Build pipeline

A new `.github/workflows/build-runner.yml` in this repo:

- Triggers on push to `main` when `Dockerfile.session`, `session/**`, or the workflow itself changes.
- Builds the image, tags it `base-v$(date +%Y%m%d)` and `latest`, pushes to `ghcr.io/eudoxus-ai/ai-implement-runner`.
- Also supports `workflow_dispatch` for manual rebuilds.

## Per-repo override: `.ai-implement/image.yml`

Format:

```yaml
image: ghcr.io/acme/my-runner:v3
```

Semantics:

- `image` is the only recognized key. Any other keys are ignored (forward-compat).
- Value must be a publicly-pullable registry reference. Private registries are out of scope (see Non-goals).
- Customer owns the build and publish of this image, entirely outside this repo.

## Orchestrator changes

### Resolver

New helper `resolveSessionImage` (place in `src/repo-image.ts` or fold into `src/fly-machines.ts` if it stays tiny):

```ts
async function resolveSessionImage(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultImage: string,
): Promise<{ image: string; source: "override" | "default" }>;
```

Behavior:

- Fetches `.ai-implement/image.yml` from the default branch via GitHub contents API.
- **404 / missing file:** return `defaultImage` with `source: "default"`.
- **Found:** parse YAML, read `image:` string. Validate it looks like a registry reference (must contain `/` and `:`; no whitespace). Return it with `source: "override"`.
- **Parse error, malformed YAML, or validation failure:** log a warning including the reason, return `defaultImage` with `source: "default"`. Do not fail the dispatch.
- In-process TTL cache keyed by `owner/repo` with 60s TTL to absorb re-dispatch bursts within a single poll cycle.

### Call site

`src/index.ts` dispatch path, just before `createMachine`. Replace the current unconditional `config.sessionImage` with the resolver result. Log the chosen image and its source at INFO level.

Dispatch log (SQLite `dispatch_log` / jobs table) and the Linear dispatch comment both record the resolved image, so it's obvious when debugging whether an override was in play.

### Precedence

1. Per-repo `.ai-implement/image.yml` `image:` value (if valid).
2. Orchestrator `SESSION_IMAGE` env var (current behavior).
3. Hardcoded default `ghcr.io/eudoxus-ai/ai-implement-runner:latest`.

## Entrypoint changes

`session/entrypoint.sh`:

- After the prompt assembly step (both WORKFLOW.md-derived and default prompt paths), prepend the single-line tool-manifest pointer to `/tmp/claude-prompt.md`.
- No other behavioral changes required by this ticket.

## Testing

### Unit tests (`src/__tests__/`)

- `repo-image.test.ts` — mock Octokit `repos.getContent`:
  - Returns file with valid `image:` → resolver returns override + `source: "override"`.
  - 404 → resolver returns default + `source: "default"`.
  - Malformed YAML → returns default, logs warning.
  - `image:` value that fails validation (no `:`, whitespace) → returns default, logs warning.
  - Cache: two calls within 60s hit API once.

### Smoke test (AC)

Two target repos in the existing fixture/client set:

- **Repo X** — no `image.yml`. Dispatched run boots on base image. Verifies `rg --version`, `fd --version`, `yq --version`, `shellcheck --version`, `sqlite3 --version`, `tree --version`, `git lfs version`, `yarn --version` (via corepack), `sg --version` all report cleanly at session start (add one-liner verify in `session/entrypoint.sh` gated behind a debug env var, or add to a throwaway issue's `setup:` hook).
- **Repo Y** — `.ai-implement/image.yml` pointing at a published image that adds one obvious tool (e.g. `terraform`). Dispatched run verifies `terraform -version` succeeds on PATH.

Both dispatches succeed, the job log shows the resolved image per repo, and the Linear comment on dispatch reflects the same.

## Rollout

1. Merge the new `Dockerfile.session` + build workflow. First `base-vYYYYMMDD` tag publishes.
2. Update orchestrator `SESSION_IMAGE` in each client's Fly app to the new pinned tag.
3. Ship orchestrator code change (`resolveSessionImage` + dispatch wiring) in a follow-up PR so image changes can be verified before wiring the override.
4. Smoke test both repos.

## Open questions

None — all resolved during brainstorm:

- Overlay build location: **not built; customer publishes their own image.**
- `image.yml` shape: **pointer only, no declarative packages or knobs.**
- Private registry auth: **out of scope.**
- Orchestrator fetch strategy: **GitHub contents API with 60s TTL cache.**
