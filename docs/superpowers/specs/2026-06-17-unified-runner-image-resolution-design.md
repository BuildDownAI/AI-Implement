# Unified runner-image resolution across execution modes

**Status:** Design approved
**Date:** 2026-06-17
**Supersedes:** [PR #84](https://github.com/builddownai/AI-Implement/pull/84) (`ci: derive runner image org from repo owner instead of hardcoding`)
**Builds on:** [2026-04-18 AII-54](2026-04-18-aii-54-base-image-overlay-design.md) (`.ai-implement/image.yml` override + `SESSION_IMAGE`)
**Successor proposal (not implemented):** [2026-06-19 Orchestrator as the single runner-image resolver](2026-06-19-orchestrator-single-image-resolver-design.md) would drop the target-repo/org `AI_IMPLEMENT_RUNNER_IMAGE` variable and the in-workflow shell resolution. It has not shipped — **this document still describes the behaviour in the repo.**

## Summary

The orchestrator runs implementation jobs in two execution modes — `fly-machines` (boots a Fly Machine / local Docker session directly) and `github-actions` (dispatches `claude-implement.yml`, which runs the work in a `container:`). Today each mode resolves "what runner image does this repo use?" with a **different and inconsistent** config model: a repo file on Fly, a GitHub variable on Actions, an allowlist on one but not the other, and no shared precedence rule.

This change gives both modes the **same resolution ladder** under the **same variable name**, and makes the default safe so no fork ever boots into a missing image:

```
.ai-implement/image.yml  >  AI_IMPLEMENT_RUNNER_IMAGE  >  upstream BuildDownAI fallback
```

It also makes the `github-actions` allowlist auto-trust the repo owner's own GHCR namespace, so a fork that publishes its own image needs **one** setting (not two, and no workflow patching).

## Motivation

PR #84 set out to remove a real friction: a fork that publishes its own runner image had to **patch the workflow files** (or set two GitHub variables) to use it. PR #84 solved that by deriving the owner for *both* the default image and the allowlist. The default-image half is unsafe: it makes `ghcr.io/<owner>/ai-implement-runner:latest` the default, so any fork whose owner has not yet published that image boots into `manifest unknown` / `unauthorized` — a break-by-default. We want the friction gone *without* a default that can break.

Separately, the two execution modes drifted into inconsistent config:

| Concern | `fly-machines` today | `github-actions` today |
|---|---|---|
| Per-repo override | `.ai-implement/image.yml` (repo **file**) | `AI_IMPLEMENT_RUNNER_IMAGE` (repo **variable**) |
| Default image | `SESSION_IMAGE` env | hardcoded in workflow |
| Allowlist / safety | none (format-validated only) | `AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES` |

An operator who wants "this repo runs my image" must know which mode the repo runs on to know whether to edit a file or a variable, and the setting does not carry across if a repo switches modes.

## Goals

- One resolution ladder, expressed identically in both modes: **file overrides variable overrides upstream fallback.**
- One variable name across modes: `AI_IMPLEMENT_RUNNER_IMAGE`.
- A default that is always a known-good, publicly-pullable image (upstream BuildDownAI). No break-by-default.
- A fork using its own image needs exactly **one** setting and **zero** workflow patching.
- Preserve the "set the default once for everyone" capability (org-wide / operator-wide default).
- No breakage for currently-deployed Fly clients that set `SESSION_IMAGE`.

## Non-goals

- Adding an allowlist to the `fly-machines` path. It runs in the orchestrator's isolated machine and never had one; format validation stays.
- Auto-detecting whether the owner's image exists (a GHCR manifest probe). That reintroduces the flaky anonymous-pull surface and a break path; explicitly rejected.
- Folding `LOCAL_RUNNER_IMAGE` (local-dev Docker build tag) into this scheme — it names a locally-built tag, not a registry default, and stays as-is.
- Reworking provider/region or any non-image config.

## Architecture

### The unified ladder

Both modes resolve the runner image top-down, first match wins:

| Priority | `github-actions` mode | `fly-machines` mode |
|---|---|---|
| 1 | `runner_image` dispatch input *(per-run, manual only)* | — *(nothing dispatches a per-run override)* |
| 2 | `.ai-implement/image.yml` *(repo file)* | `.ai-implement/image.yml` *(repo file)* |
| 3 | `AI_IMPLEMENT_RUNNER_IMAGE` *(GitHub repo/org variable)* | `AI_IMPLEMENT_RUNNER_IMAGE` *(orchestrator env)* |
| 4 | upstream BuildDownAI fallback (`ghcr.io/builddownai/ai-implement-runner:next`) | upstream BuildDownAI fallback (`ghcr.io/builddownai/ai-implement-runner:latest`) |

> **Pre-existing wart, left as-is:** the two modes default to *different* tags today — `:next` on Actions, `:latest` on the orchestrator. This design does not unify the tag (out of scope); it only changes *which knobs* feed the ladder, not the literal fallback values. Flagging it so the discrepancy is a known, deliberate carry-over rather than a surprise.

The shared, one-sentence rule: **`.ai-implement/image.yml` overrides `AI_IMPLEMENT_RUNNER_IMAGE` overrides the upstream fallback.** The dispatch input sits above the file on Actions because an explicit per-run human choice should win for that one run; Fly has no such input.

### How the "default for everyone" case keeps working

Level 3 inherits the right scope for free from each mode's mechanism:

- **`github-actions`:** `AI_IMPLEMENT_RUNNER_IMAGE` as a GitHub **organization** variable applies to every repo in the org; a **repo-level** variable overrides it for one repo (GitHub resolves `vars.X` org → repo).
- **`fly-machines`:** the orchestrator env applies to every repo that orchestrator serves.

So an operator who wants all their repos on their own image sets one value at the org level (Actions) or one env var (Fly) — unchanged by this design, just renamed on the Fly side.

## Changes by component

### `fly-machines` mode — `src/index.ts`

- Read `AI_IMPLEMENT_RUNNER_IMAGE` for the default image, **falling back to `SESSION_IMAGE`** when the new var is unset, then to the hardcoded `ghcr.io/builddownai/ai-implement-runner:latest`.
- When `SESSION_IMAGE` is set (whether or not it is used), log a **one-time deprecation warning** at config load directing the operator to `AI_IMPLEMENT_RUNNER_IMAGE`. `SESSION_IMAGE` is removed in a later cleanup, not now.
- The existing `.ai-implement/image.yml` override in `src/repo-image.ts` is unchanged — it already sits above the default. The `defaultImage` it receives is now the `AI_IMPLEMENT_RUNNER_IMAGE`-or-`SESSION_IMAGE`-resolved value.

### `github-actions` mode — `workflows/claude-implement.yml` + `workflows/comment-trigger.yml`

The `validate-runner-image` job changes in three ways:

**Current state:** `.ai-implement/image.yml` is **silently ignored** in `github-actions` mode today. `DispatchInputs` (`src/github.ts`) has no `runner_image` field, the dispatch path never calls `resolveSessionImage`, and `validate-runner-image` only reads the `runner_image` input (always empty from the orchestrator) → `vars.AI_IMPLEMENT_RUNNER_IMAGE` → hardcoded default. The input *mechanism* exists and is validated; nothing populates it from the file. This change wires the file in.

1. **Default stays upstream.** The hardcoded fallback remains `ghcr.io/builddownai/ai-implement-runner:next` (unchanged from today). PR #84's owner-derived default is **not** adopted.
2. **Read `.ai-implement/image.yml` in the workflow itself.** Add a step in `validate-runner-image` that fetches the file via `gh api repos/<owner>/<repo>/contents/.ai-implement/image.yml` (with `Accept: application/vnd.github.raw+json`, so the raw body comes back directly — no base64 decode) and extracts the `image:` key with the same `^image:\s*(\S+)$` shape `src/repo-image.ts` uses. Slot the result **above** `AI_IMPLEMENT_RUNNER_IMAGE`, **below** the `runner_image` dispatch input. Note: the resolved image (from any rung) then passes through the workflow's existing *character* check (`*[!A-Za-z0-9._:/@-]*`) plus the allowlist — the Actions path does **not** apply the stricter structural `host/name:tag` regex (`VALID_IMAGE_RE`) that the `fly-machines` path uses, so a tagless value accepted here fails fast at container-pull time rather than falling back. The allowlist is the security boundary either way.
   - **Both workflows self-resolve** — `claude-implement.yml` *and* `comment-trigger.yml`. We do **not** have the orchestrator resolve-and-pass `runner_image`, because `comment-trigger.yml` is fired by a `/ai-implement` PR comment (not orchestrator-driven) and would otherwise ignore the file. Self-resolution in the workflow covers both triggers with one mechanism and needs no orchestrator/`DispatchInputs` change.
   - **Read from the default branch only — never the PR head.** A gap-fill run (`comment-trigger.yml`) operates on a PR branch with the repo's privileged secrets. Reading `image.yml` from the PR head would let a PR author choose the image their privileged run executes in. Always fetch from the repo's default branch (the contents API default ref); the allowlist is the secondary backstop, default-branch read is the primary defense.
3. **Allowlist auto-trusts the owner.** Seed `allowed_prefixes` with `ghcr.io/builddownai/` **and** `ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/` (this is the safe half of PR #84), plus `AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES` as before. The allowlist is applied to whatever image the ladder resolves — including the value read from `image.yml`.

Both the canonical `.github/workflows/` copies and the synced `workflows/` templates change together, preserving the byte-for-byte parity enforced by `workflow-shim-structure.test.ts`.

### Why the allowlist stays Actions-only (deliberate asymmetry)

The `github-actions` container runs in the target repo's privileged GitHub Actions context with its secrets, and `workflow_dispatch` exposes the `runner_image` input as an externally-settable vector. The allowlist is cheap insurance there. The `fly-machines` path runs in the orchestrator's isolated machine, has no dispatch input, and never had an allowlist — adding one risks breaking existing `.ai-implement/image.yml` setups that point at third-party registries. We document the difference rather than force false symmetry. With the owner prefix auto-trusted, the allowlist is invisible for the common case and only stops genuinely-foreign images.

## Resolution precedence — decisions baked in

1. **Dispatch input beats the repo file** (Actions). Explicit per-run human intent wins for that run.
2. **`SESSION_IMAGE` back-compat, with deprecation warning.** No deployed Fly client breaks on this release.
3. **Allowlist applies to the resolved image, defaulting to upstream + owner.** A trusted source (file or variable) pointing at the owner's namespace passes with no second setting.

## Guidance for fork operators (and PR #84's author)

A fork that publishes its own runner image and wants every repo to use it:

> Set a GitHub **organization** variable `AI_IMPLEMENT_RUNNER_IMAGE = ghcr.io/<your-org>/ai-implement-runner:<tag>`, scoped to the relevant repos. No workflow patching. No second variable — the allowlist auto-trusts your org's GHCR namespace.

Single-repo override (either mode): commit `.ai-implement/image.yml` with `image: ghcr.io/<your-org>/...`.

This makes PR #84 unnecessary; it can be closed in favor of this design.

## Documentation

Three doc surfaces change so the new model is discoverable and consistent:

1. **`README.md` — new short section "Choosing the runner image."** User-facing summary of the ladder and where to set each knob. Draft:

   > ### Choosing the runner image
   >
   > Every implementation job runs in a runner image. Resolution is the same in both execution modes, highest priority first:
   >
   > | Where | Scope | Use it for |
   > |---|---|---|
   > | `.ai-implement/image.yml` (committed in the target repo) | one repo | "this repo needs a special image" |
   > | `AI_IMPLEMENT_RUNNER_IMAGE` | org-wide or per-repo | "my org's default image" — set as a GitHub **org** variable (`github-actions` mode) or an orchestrator env var (`fly-machines` mode) |
   > | *(none set)* | — | falls back to the published BuildDownAI image |
   >
   > The first one set wins. A fork that publishes its own image typically sets `AI_IMPLEMENT_RUNNER_IMAGE` once at the org level — no workflow edits, and the allowlist trusts your org's `ghcr.io/<owner>/` namespace automatically. In `github-actions` mode a manual `runner_image` dispatch input overrides everything for that single run.

2. **`CLAUDE.md` — update the existing "Per-repo runner image override" section** to describe the full ladder (not just `.ai-implement/image.yml`), and update the **Key environment variables** table: add `AI_IMPLEMENT_RUNNER_IMAGE`, mark `SESSION_IMAGE` deprecated (back-compat alias).

3. **Workflow header comments** in `claude-implement.yml` / `comment-trigger.yml` and the `runner_image` input `description:` — reflect the owner-auto-trust and that `.ai-implement/image.yml` is now read.

## Testing

- `src/__tests__/workflow-shim-structure.test.ts` — assert the owner-augmented allowlist (`ghcr.io/builddownai/` + owner-derived) and that the **default** remains the `builddownai` literal; assert both workflows include the `.ai-implement/image.yml` fetch step and that the fetch targets the default branch (no PR-head ref). Holds for both the canonical `.github/workflows/` copies and the synced `workflows/` templates (parity).
- `src/__tests__/repo-image.test.ts` — unchanged behavior; add coverage that the Fly default now derives from `AI_IMPLEMENT_RUNNER_IMAGE` with `SESSION_IMAGE` fallback.
- New/extended orchestrator config test — `AI_IMPLEMENT_RUNNER_IMAGE` wins over `SESSION_IMAGE`; `SESSION_IMAGE`-only still works and emits the deprecation warning; neither set falls back to the `builddownai` literal.
- `npm run typecheck` + full `vitest` suite green.

## Rollout

1. Ship this change. Default behavior for `builddownai` is identical (owner resolves to `builddownai`; default unchanged).
2. Tell the PR #84 author to set the org-level `AI_IMPLEMENT_RUNNER_IMAGE` variable and close #84.
3. Later cleanup (separate change): remove `SESSION_IMAGE` once deployed clients have migrated, tracked by the deprecation warning.
