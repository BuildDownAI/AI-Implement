# Orchestrator as the single runner-image resolver

**Status:** Design approved — **not implemented**
**Date:** 2026-06-19
**Implementation status (verified 2026-09-03, branch `testing`):** none of this has shipped. `workflows/claude-implement.yml` and `claude-plan.yml` still carry the `validate-runner-image` job that resolves the ladder in shell, and all three synced workflows (those two plus the legacy `comment-trigger.yml`) still read the target-repo/org `vars.AI_IMPLEMENT_RUNNER_IMAGE`. The behaviour in the repo today is the [2026-06-17 design](2026-06-17-unified-runner-image-resolution-design.md); this document is a successor proposal, not a record of what the code does.
**Would supersede (in part):** [2026-06-17 Unified runner-image resolution](2026-06-17-unified-runner-image-resolution-design.md) — that design unified the *ladder* across modes but kept **two** "operator default" mechanisms (an orchestrator env var *and* a target-repo/org GitHub variable) and had **both workflows self-resolve** the image in shell. This design removes the GitHub variable and the duplicated shell resolution, making the orchestrator the one place an image is resolved.
**Builds on:** [2026-04-18 AII-54](2026-04-18-aii-54-base-image-overlay-design.md) (`.ai-implement/image.yml` + `SESSION_IMAGE`)

## Summary

Runner-image configuration has accreted four mechanisms — a per-repo file, an orchestrator env var, a *separate* target-repo/org GitHub variable, and the upstream fallback — plus a one-shot dispatch input and an allowlist, with the resolution logic duplicated in TypeScript (Fly path) and in shell inside two workflows (Actions path). The duplication and the two overlapping "default" knobs are the source of the confusion.

This design collapses the model to **three inputs resolved in exactly one place**:

```
.ai-implement/image.yml  >  AI_IMPLEMENT_RUNNER_IMAGE (orchestrator env)  >  upstream :latest
```

The **orchestrator** ([`src/repo-image.ts`](../../../src/repo-image.ts)) becomes the single resolver. Every execution path gets its image from it:

- **Fly machines** — already does this; unchanged.
- **GitHub Actions (orchestrator-initiated)** — the orchestrator always forwards the resolved image as the `runner_image` dispatch input; the workflow stops resolving anything.
- **`/ai-implement` comment-triggered gap-fill** — the workflow asks the orchestrator over an authenticated callback, with a minimal local fallback so it still works without a callback configured.

The target-repo/org `AI_IMPLEMENT_RUNNER_IMAGE` **variable** and the in-workflow resolution ladder are deleted. The `AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES` allowlist stays as a security boundary on whatever image lands as the container.

## Motivation

The 2026-06-17 change made both execution modes share one ladder, but to make the comment-trigger path (which the orchestrator does not dispatch) honor a custom default, it gave the *target repo/org* a GitHub variable **and** had both workflows re-implement the file→variable→fallback ladder in shell. The result:

- **Two places to set "the default image"** — the orchestrator env var *and* the repo/org GitHub variable — with no single answer to "where does this repo's image come from?".
- **Resolution logic duplicated** in `src/repo-image.ts` and in shell in `claude-implement.yml` + `comment-trigger.yml`, which must stay in sync.
- **Doc/code drift** — CLAUDE.md and the prior spec claim the Actions path defaults to `:next`; the shipped code defaults to `:latest` everywhere.

The three real-world use cases need only three things:

| Use case | Need | Mechanism |
|---|---|---|
| OSS install tracking `main`/`testing` | painless upstream image, zero config | upstream `:latest` fallback |
| CloudShare — downstream fork, private image, runs `main`-prod + `testing`-dev orchestrators | one default across all their repos, channel-paired | orchestrator env `AI_IMPLEMENT_RUNNER_IMAGE` (`…:next` on the testing orchestrator) |
| Accelo — one repo, custom-built image | per-repo override | `.ai-implement/image.yml` |

No use case requires the repo/org GitHub variable once the orchestrator resolves for every path.

## Goals

- **One resolver.** The image is resolved by the orchestrator's `src/repo-image.ts` for every path; no shell re-implementation of the ladder.
- **Three inputs, one precedence rule:** `.ai-implement/image.yml` > `AI_IMPLEMENT_RUNNER_IMAGE` (orchestrator env) > upstream `:latest`.
- **Painless default** for OSS installs: nothing set ⇒ upstream `:latest`.
- **Comment-triggered runs** resolve through the orchestrator, degrading gracefully (with a clear log message) to a minimal local fallback when no callback is configured.
- **Keep the allowlist** as the security boundary on the resolved container image.
- **No hard break** for orchestrators still setting `SESSION_IMAGE` (keep the deprecation warning).

## Non-goals

- **A per-project admin image field.** Considered and rejected — it would be a fourth mechanism covering no case the three inputs don't already cover.
- **Rerouting comment-trigger *execution* through the orchestrator.** Gap-fill still runs in GitHub Actions; only the image *decision* moves to the orchestrator. Re-plumbing where gap-fill executes is a much larger change than the image problem warrants.
- **Removing `SESSION_IMAGE`.** It stays as a deprecated alias with its existing warning (separate future cleanup).
- **Adding an allowlist to the Fly path** or folding in `LOCAL_RUNNER_IMAGE` — unchanged from prior designs.
- **OIDC-based callback auth.** Recorded as recommended future hardening; this change ships the shared-secret form.

## Architecture

### The three inputs (resolved by the orchestrator)

| Priority | Input | Lives where | Use case |
|---|---|---|---|
| 1 | `.ai-implement/image.yml` | target repo, **default branch only** | Accelo — per-repo override |
| 2 | `AI_IMPLEMENT_RUNNER_IMAGE` (+ deprecated `SESSION_IMAGE` alias) | orchestrator process env | CloudShare — operator/fork default; channel pairing via `…:next` |
| 3 | `ghcr.io/builddownai/ai-implement-runner:latest` | built-in | painless OSS default |

`resolveSessionImage` (reads image.yml via the GitHub contents API) layered over `resolveDefaultRunnerImage` (env → upstream) already implements exactly this. It becomes the single source of truth.

### Path-by-path

**Fly machines** — unchanged. Orchestrator resolves and boots the machine on the image directly ([`src/index.ts`](../../../src/index.ts) around line 759).

**GitHub Actions, orchestrator-initiated** (`claude-implement.yml`):
- The orchestrator **always** resolves and sends the `runner_image` dispatch input (today it only sends it "when explicit"). This deletes `selectRunnerImageInput` and the `runnerImageExplicit` plumbing — there is no longer any workflow-side resolution to avoid clobbering.
- `claude-implement.yml`'s `validate-runner-image` job is reduced to: take the `runner_image` input → if empty (manual UI dispatch with no input) default to `:latest` → **validate against the allowlist** → run. The `gh api` image.yml read and the `vars.AI_IMPLEMENT_RUNNER_IMAGE` read are **deleted**.

**GitHub Actions, comment-triggered** (`comment-trigger.yml`, fired by a `/ai-implement` PR comment — the orchestrator never dispatches it):
- **Primary path:** the workflow calls a new orchestrator endpoint **`GET /runner/resolve-image?owner=<owner>&repo=<repo>`**, authenticated with a shared bearer secret `AI_IMPLEMENT_CALLBACK_SECRET`. The orchestrator resolves via the same `src/repo-image.ts` function and returns `{ "image": "<ref>" }`.
- **Graceful degradation:** if `RUNNER_CALLBACK_BASE_URL` / `AI_IMPLEMENT_CALLBACK_SECRET` are not configured, or the call fails/times out, the workflow logs an actionable message and falls back to a **minimal** local resolution: read `.ai-implement/image.yml` (default branch) → else `:latest`. This is the **only** surviving in-workflow resolver, and it is far smaller than today's (no repo/org variable, no channel special-case). It keeps Accelo's comment-trigger runs working with zero callback setup.
- Either way the resulting image passes through the **allowlist** before being used as the container image.

### The resolve-image endpoint

- Route: `GET /runner/resolve-image` on the existing orchestrator HTTP server ([`src/index.ts`](../../../src/index.ts) `http.createServer`, alongside `/runner/result`, `/runner/progress`).
- **Auth:** `Authorization: Bearer <AI_IMPLEMENT_CALLBACK_SECRET>`, parsed with the existing `parseBearerToken` helper ([`src/runner-callback.ts`](../../../src/runner-callback.ts)). Constant-time compare against the configured secret. Distinct from the HMAC run-token secret (`RUNNER_TOKEN_SECRET`) — this is a standing shared secret, never the token-signing key.
- **Unconfigured ⇒ disabled:** if `AI_IMPLEMENT_CALLBACK_SECRET` is unset, the endpoint returns `503` and logs a one-line startup notice that comment-trigger custom-image resolution is unavailable. The workflow treats any non-200 as "degrade to local fallback."
- **Inputs:** `owner`, `repo` query params (validated against a conservative `^[A-Za-z0-9._-]+$`). Returns `{ image }` (200) or an error envelope mirroring the other callbacks.
- **Auth mechanism is pluggable in spirit:** the handler isolates "authenticate the caller" so a future OIDC verifier (validate the GitHub Actions JWT issuer/audience/`sub` against GitHub's JWKS) can replace the shared-secret check without touching resolution. Noted as recommended future hardening; not built now.

### Channels & the stale-doc fix

The shipped code already defaults to `:latest` on every path; the `:next`-on-Actions claim in CLAUDE.md and the prior spec is stale. We standardize on **`:latest` as the universal built-in fallback** and document that the **testing channel is selected solely by the orchestrator env** (`AI_IMPLEMENT_RUNNER_IMAGE=…:next` on a testing orchestrator, which CloudShare already does). No per-workflow `:next` special case is introduced; the stale docs are corrected.

## Changes by component

### `src/repo-image.ts`
- Delete `selectRunnerImageInput` and the `runnerImageExplicit` concept. `resolveDefaultRunnerImage` (env → upstream, with `SESSION_IMAGE` alias + status) and `resolveSessionImage` (image.yml override) stay.
- Add a thin `resolveRunnerImageForRepo({ owner, repo, token })` (or reuse the existing pair) that the new endpoint calls — image.yml over the env default over upstream.

### `src/index.ts`
- Orchestrator-initiated GHA dispatch (`resolveDispatchRunnerImage` callers around lines 446, 1645, 1740): always set `runner_image` to the resolved image; drop the `selectRunnerImageInput` gate.
- Add the `GET /runner/resolve-image` route to the HTTP server, reading `AI_IMPLEMENT_CALLBACK_SECRET`.
- Startup logging: keep the `SESSION_IMAGE` deprecation warning; add the "resolve-image endpoint disabled (AI_IMPLEMENT_CALLBACK_SECRET unset)" notice when applicable.

### `src/github.ts`
- `runner_image` stays a `DispatchInputs` field; update its comment now that it is always sent for orchestrator-initiated runs.

### `workflows/claude-implement.yml` (+ `.github/workflows/` twin)
- Reduce `validate-runner-image` to input-or-`:latest` → allowlist → output. Remove the image.yml `gh api` read and the `CONFIGURED_RUNNER_IMAGE`/`vars.AI_IMPLEMENT_RUNNER_IMAGE` read.

### `workflows/comment-trigger.yml` (+ `.github/workflows/` twin)
- Replace the shell ladder with: call `${RUNNER_CALLBACK_BASE_URL}/runner/resolve-image` (bearer `AI_IMPLEMENT_CALLBACK_SECRET`); on success use the returned image; on missing config / failure, log the actionable message and fall back to image.yml → `:latest`. Keep the allowlist validation on the final image.
- These secrets reach the workflow as repo/org **GitHub Actions secrets** (`RUNNER_CALLBACK_BASE_URL` may be a variable; `AI_IMPLEMENT_CALLBACK_SECRET` is a secret).

Both the synced `workflows/` templates and the canonical `.github/workflows/` copies change together (byte-for-byte parity enforced by `workflow-shim-structure.test.ts`).

## Security

- The **allowlist** (`ghcr.io/builddownai/` + the repo owner's own `ghcr.io/<owner>/`, plus `AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES`) remains and is applied to the final container image in both workflows. It is the boundary that stops a repo-writer from dispatching `claude-implement.yml` with a malicious `runner_image` that would see the job's secrets — independent of who dispatches.
- `.ai-implement/image.yml` is read from the **default branch only**, never a PR head, on every path (orchestrator API read and the comment-trigger fallback), so a PR cannot choose the image its privileged run executes in.
- The resolve-image endpoint is authenticated; unconfigured ⇒ disabled (fail-closed to the local fallback, never an open endpoint).

## Migration / rollout

1. Ship orchestrator + workflow changes together. For `builddownai`'s own repos, behavior is unchanged (nothing set ⇒ `:latest`).
2. **Drop the repo/org `AI_IMPLEMENT_RUNNER_IMAGE` variable.** Audit confirms its only consumer was in-workflow resolution; Accelo uses image.yml, CloudShare uses the orchestrator env — neither relies on the variable. No migration action expected; document the removal.
3. To enable comment-trigger custom images, an operator sets `RUNNER_CALLBACK_BASE_URL` + `AI_IMPLEMENT_CALLBACK_SECRET` (orchestrator env + matching GH Actions secret). Without it, comment-trigger degrades to image.yml → `:latest` with a logged hint.
4. `SESSION_IMAGE` continues to work with its deprecation warning; removal stays a separate future cleanup.

## Testing

- **`src/__tests__/repo-image.test.ts`** — drop `selectRunnerImageInput` coverage; keep/extend `resolveDefaultRunnerImage` (env wins, `SESSION_IMAGE` fallback + warning status, upstream default) and `resolveSessionImage` (image.yml override, default-branch read, malformed/missing fallback).
- **New endpoint tests** — `/runner/resolve-image`: 200 with correct image for (image.yml present | env default | upstream); 401 on missing/wrong bearer; 503 when `AI_IMPLEMENT_CALLBACK_SECRET` unset; owner/repo param validation.
- **`src/__tests__/github.test.ts`** — orchestrator now always forwards `runner_image`; assert the dispatch inputs carry the resolved image (no more "explicit-only" gating).
- **`src/__tests__/workflow-shim-structure.test.ts`** — `claude-implement.yml` no longer reads image.yml or `vars.AI_IMPLEMENT_RUNNER_IMAGE`; `comment-trigger.yml` calls `/runner/resolve-image` and retains the minimal image.yml → `:latest` fallback + allowlist; default literal is `:latest`; canonical/synced parity holds.
- `npm run typecheck` + full `vitest` suite green.

## Documentation

- **CLAUDE.md** — rewrite the "Runner image resolution" section to the three-input model and one precedence rule; correct the stale `:next`-on-Actions claim; document the resolve-image callback (`RUNNER_CALLBACK_BASE_URL` + `AI_IMPLEMENT_CALLBACK_SECRET`) and graceful degradation; note the repo/org variable removal; add `AI_IMPLEMENT_CALLBACK_SECRET` to the env table.
- **README.md** — update the "Choosing the runner image" section to the three inputs (drop the repo/org variable row).
- **Workflow header comments** — reflect that `claude-implement.yml` takes the image from the orchestrator and `comment-trigger.yml` resolves via callback with a local fallback.
