# Unified Runner-Image Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give both execution modes (`fly-machines`, `github-actions`) the same runner-image resolution ladder — `.ai-implement/image.yml` › `AI_IMPLEMENT_RUNNER_IMAGE` › upstream BuildDownAI fallback — with a safe default and an allowlist that auto-trusts the repo owner's GHCR namespace.

**Architecture:** The orchestrator (TypeScript) gains a pure default-image resolver that prefers `AI_IMPLEMENT_RUNNER_IMAGE`, falls back to `SESSION_IMAGE` (deprecated), then the hardcoded upstream image. The two GitHub Actions workflows learn to read `.ai-implement/image.yml` from the repo's default branch and to seed their allowlist with both `ghcr.io/builddownai/` and the owner's `ghcr.io/<owner>/` namespace. Defaults stay on the always-public BuildDownAI image so nothing breaks by default.

**Tech Stack:** TypeScript (Node 22, tsx), Vitest, GitHub Actions YAML + bash, `gh` CLI (preinstalled on `ubuntu-latest` runners).

## Global Constraints

- **Dual-copy invariant:** every workflow under `workflows/<name>.yml` has a byte-for-byte identical copy at `.github/workflows/<name>.yml`. Edit both; `workflow-shim-structure.test.ts` enforces parity.
- **Default tags differ by mode and stay as-is:** `claude-implement.yml` default is `ghcr.io/builddownai/ai-implement-runner:next`; `comment-trigger.yml` and the orchestrator default are `ghcr.io/builddownai/ai-implement-runner:latest`. This plan does not unify the tag.
- **`.ai-implement/image.yml` is read from the repo's default branch only — never a PR head.** A PR must not be able to choose the image its privileged run executes in.
- **No new env-var or workflow inputs beyond what's specified.** Keep `AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES` as the third-party escape hatch.
- **`image:` key parsing mirrors `src/repo-image.ts`:** a line `^image:\s*(\S+)\s*$`, value then passed through the existing image-reference character check.
- Run `npm run typecheck` and `npm test` green before every commit that touches `src/`.

---

### Task 1: Orchestrator default image — `AI_IMPLEMENT_RUNNER_IMAGE` with `SESSION_IMAGE` deprecation

**Files:**
- Modify: `src/repo-image.ts` (add exported pure resolver)
- Modify: `src/index.ts:136` (wire resolver into `loadConfig`) and the `main()` startup logging block (~`src/index.ts:1727`)
- Test: `src/__tests__/repo-image.test.ts`

**Interfaces:**
- Produces: `resolveDefaultRunnerImage(env: Pick<NodeJS.ProcessEnv, "AI_IMPLEMENT_RUNNER_IMAGE" | "SESSION_IMAGE">): { image: string; sessionImageDeprecated: boolean }` — exported from `src/repo-image.ts`. `image` is `AI_IMPLEMENT_RUNNER_IMAGE` || `SESSION_IMAGE` || `"ghcr.io/builddownai/ai-implement-runner:latest"`. `sessionImageDeprecated` is `true` whenever `SESSION_IMAGE` is set (even if unused).

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/repo-image.test.ts` (top-level, alongside the existing `describe` blocks):

```ts
import { resolveDefaultRunnerImage } from "../repo-image.js";

describe("resolveDefaultRunnerImage", () => {
  it("prefers AI_IMPLEMENT_RUNNER_IMAGE over SESSION_IMAGE", () => {
    const r = resolveDefaultRunnerImage({
      AI_IMPLEMENT_RUNNER_IMAGE: "ghcr.io/acme/ai-implement-runner:v3",
      SESSION_IMAGE: "ghcr.io/old/legacy:latest",
    });
    expect(r.image).toBe("ghcr.io/acme/ai-implement-runner:v3");
    expect(r.sessionImageDeprecated).toBe(true);
  });

  it("falls back to SESSION_IMAGE and flags it deprecated", () => {
    const r = resolveDefaultRunnerImage({ SESSION_IMAGE: "ghcr.io/acme/runner:1" });
    expect(r.image).toBe("ghcr.io/acme/runner:1");
    expect(r.sessionImageDeprecated).toBe(true);
  });

  it("falls back to the upstream image when neither is set", () => {
    const r = resolveDefaultRunnerImage({});
    expect(r.image).toBe("ghcr.io/builddownai/ai-implement-runner:latest");
    expect(r.sessionImageDeprecated).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- repo-image`
Expected: FAIL — `resolveDefaultRunnerImage is not a function` / import error.

- [ ] **Step 3: Add the resolver to `src/repo-image.ts`**

Append to `src/repo-image.ts`:

```ts
const DEFAULT_RUNNER_IMAGE = "ghcr.io/builddownai/ai-implement-runner:latest";

export interface DefaultRunnerImageResult {
  image: string;
  /** True whenever SESSION_IMAGE is set, even if AI_IMPLEMENT_RUNNER_IMAGE supersedes it. */
  sessionImageDeprecated: boolean;
}

/**
 * Resolves the orchestrator-wide default runner image, preferring the
 * mode-agnostic AI_IMPLEMENT_RUNNER_IMAGE and falling back to the legacy
 * (deprecated) SESSION_IMAGE, then the upstream BuildDownAI image.
 */
export function resolveDefaultRunnerImage(
  env: Pick<NodeJS.ProcessEnv, "AI_IMPLEMENT_RUNNER_IMAGE" | "SESSION_IMAGE">,
): DefaultRunnerImageResult {
  return {
    image: env.AI_IMPLEMENT_RUNNER_IMAGE || env.SESSION_IMAGE || DEFAULT_RUNNER_IMAGE,
    sessionImageDeprecated: Boolean(env.SESSION_IMAGE),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- repo-image`
Expected: PASS (all three new cases plus the existing repo-image suite).

- [ ] **Step 5: Wire the resolver into `loadConfig`**

In `src/index.ts`, the existing import on line 26 is `import { resolveSessionImage } from "./repo-image.js";`. Change it to also import the new resolver:

```ts
import { resolveSessionImage, resolveDefaultRunnerImage } from "./repo-image.js";
```

Replace `src/index.ts:136`:

```ts
    sessionImage: process.env.SESSION_IMAGE || "ghcr.io/builddownai/ai-implement-runner:latest",
```

with:

```ts
    sessionImage: resolveDefaultRunnerImage(process.env).image,
```

- [ ] **Step 6: Emit the deprecation warning at startup**

In `src/index.ts`, in the `main()` startup logging block, immediately after the line:

```ts
  console.log(`[main] Poll interval: ${config.pollIntervalMs}ms`);
```

insert:

```ts
  if (resolveDefaultRunnerImage(process.env).sessionImageDeprecated) {
    console.warn(
      "[main] SESSION_IMAGE is deprecated; rename it to AI_IMPLEMENT_RUNNER_IMAGE (same value). SESSION_IMAGE still works for now.",
    );
  }
```

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/repo-image.ts src/index.ts src/__tests__/repo-image.test.ts
git commit -m "feat: orchestrator default image via AI_IMPLEMENT_RUNNER_IMAGE; deprecate SESSION_IMAGE

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `claude-implement.yml` — read `.ai-implement/image.yml` + owner-derived allowlist

**Files:**
- Modify: `workflows/claude-implement.yml` (header comment lines 18-20, input description line 69, `validate-runner-image` job env + `run:` block lines 86-142)
- Modify: `.github/workflows/claude-implement.yml` (identical changes — keep byte-for-byte)
- Test: `src/__tests__/workflow-shim-structure.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `validate-runner-image` resolves the ladder `runner_image` input › `.ai-implement/image.yml` (default branch) › `vars.AI_IMPLEMENT_RUNNER_IMAGE` › `ghcr.io/builddownai/ai-implement-runner:next`; allowlist seeded with `ghcr.io/builddownai/` + `ghcr.io/${owner}/`.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/workflow-shim-structure.test.ts`, extend the existing `for (const f of IMPLEMENT_WORKFLOWS)` block (the test starting `validates the runner image before the container job starts`, line 78). Add these assertions inside that `it(...)`:

```ts
      // Owner-derived allowlist (safe half of PR #84): trusts the repo's own GHCR namespace.
      expect(yaml).toMatch(/GITHUB_REPOSITORY_OWNER/);
      expect(yaml).toMatch(/ghcr\.io\/\$\{owner\}\//);
      // Reads the per-repo override file from the default branch (no ?ref= → no PR-head read).
      expect(yaml).toMatch(/contents\/\.ai-implement\/image\.yml/);
      expect(yaml).not.toMatch(/image\.yml\?ref=/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- workflow-shim-structure`
Expected: FAIL — `GITHUB_REPOSITORY_OWNER` / `contents/.ai-implement/image.yml` not found in the current workflow text.

- [ ] **Step 3: Update the `validate-runner-image` job env block**

In `workflows/claude-implement.yml`, the env block at lines 88-91 currently reads:

```yaml
        env:
          REQUESTED_RUNNER_IMAGE: ${{ inputs.runner_image }}
          CONFIGURED_RUNNER_IMAGE: ${{ vars.AI_IMPLEMENT_RUNNER_IMAGE }}
          EXTRA_ALLOWED_PREFIXES: ${{ vars.AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES }}
```

Add `GH_TOKEN` (the `gh` CLI needs it to read repo contents):

```yaml
        env:
          REQUESTED_RUNNER_IMAGE: ${{ inputs.runner_image }}
          CONFIGURED_RUNNER_IMAGE: ${{ vars.AI_IMPLEMENT_RUNNER_IMAGE }}
          EXTRA_ALLOWED_PREFIXES: ${{ vars.AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES }}
          GH_TOKEN: ${{ github.token }}
```

- [ ] **Step 4: Replace the resolution preamble + allowlist seed in the `run:` block**

In the same `run:` block, replace the segment from `runner_image="${REQUESTED_RUNNER_IMAGE:-}"` through the `runner_image="ghcr.io/builddownai/ai-implement-runner:next"` fallback (current lines 95-101) with:

```bash
          owner="${GITHUB_REPOSITORY_OWNER,,}"

          # Resolution ladder: dispatch input > .ai-implement/image.yml > repo/org var > upstream default.
          runner_image="${REQUESTED_RUNNER_IMAGE:-}"

          # Read the per-repo override from the DEFAULT branch only — never a PR head — so a
          # pull request cannot choose the image its privileged run executes in. `gh api` with
          # no ?ref= resolves the default branch; mirrors src/repo-image.ts parsing.
          if [ -z "$runner_image" ]; then
            if raw="$(gh api "repos/${GITHUB_REPOSITORY}/contents/.ai-implement/image.yml" \
                  -H "Accept: application/vnd.github.raw+json" 2>/dev/null)"; then
              runner_image="$(printf '%s\n' "$raw" | sed -n 's/^image:[[:space:]]*\([^[:space:]][^[:space:]]*\)[[:space:]]*$/\1/p' | head -n1)"
            fi
          fi

          if [ -z "$runner_image" ]; then
            runner_image="${CONFIGURED_RUNNER_IMAGE:-}"
          fi
          if [ -z "$runner_image" ]; then
            runner_image="ghcr.io/builddownai/ai-implement-runner:next"
          fi
```

Then replace the allowlist seed line (current line 110):

```bash
          allowed_prefixes="ghcr.io/builddownai/"
```

with:

```bash
          allowed_prefixes="ghcr.io/builddownai/,ghcr.io/${owner}/"
```

Leave the character check, the `EXTRA_ALLOWED_PREFIXES` append, the allowlist loop, the error block, and the final `echo "runner_image=$runner_image" >> "$GITHUB_OUTPUT"` unchanged.

- [ ] **Step 5: Update the header comment and input description**

In `workflows/claude-implement.yml`, replace line 20:

```
#   AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES   - Comma-separated image prefixes allowed in addition to ghcr.io/builddownai/.
```

with:

```
#   AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES   - Extra image prefixes allowed in addition to ghcr.io/builddownai/ and the repo owner's own ghcr.io/<owner>/ namespace (auto-trusted).
```

And replace the `runner_image` input description (line 69):

```yaml
        description: "Override the default runner image (must match ghcr.io/builddownai/* or AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES)"
```

with:

```yaml
        description: "Override the runner image for this run (must match ghcr.io/builddownai/*, the repo owner's ghcr.io/<owner>/*, or AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES)"
```

- [ ] **Step 6: Mirror every change into `.github/workflows/claude-implement.yml`**

Apply the exact same edits from Steps 3-5 to `.github/workflows/claude-implement.yml` so the two files stay byte-for-byte identical. Verify:

Run: `diff workflows/claude-implement.yml .github/workflows/claude-implement.yml`
Expected: no output (files identical).

- [ ] **Step 7: Run the workflow tests**

Run: `npm test -- workflow-shim-structure`
Expected: PASS — including the parity test and the new owner/file assertions.

- [ ] **Step 8: Commit**

```bash
git add workflows/claude-implement.yml .github/workflows/claude-implement.yml src/__tests__/workflow-shim-structure.test.ts
git commit -m "feat(workflow): claude-implement reads .ai-implement/image.yml and auto-trusts owner namespace

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `comment-trigger.yml` — read `.ai-implement/image.yml` + owner-derived allowlist

**Files:**
- Modify: `workflows/comment-trigger.yml` (header comment line 15, the `Resolve and validate runner image` step env + `run:` block, lines 104-157)
- Modify: `.github/workflows/comment-trigger.yml` (identical changes)
- Test: `src/__tests__/workflow-shim-structure.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (the bash is repeated here intentionally — this workflow has no dispatch input and its own job structure).
- Produces: the `runner-image` step resolves `.ai-implement/image.yml` (default branch) › `vars.AI_IMPLEMENT_RUNNER_IMAGE` › `ghcr.io/builddownai/ai-implement-runner:latest`; allowlist seeded with `ghcr.io/builddownai/` + `ghcr.io/${owner}/`.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/workflow-shim-structure.test.ts`, extend the existing test `comment trigger validates repository configured runner images with an explicit override variable` (line 102). Add inside that `it(...)`:

```ts
    expect(yaml).toMatch(/GITHUB_REPOSITORY_OWNER/);
    expect(yaml).toMatch(/ghcr\.io\/\$\{owner\}\//);
    expect(yaml).toMatch(/contents\/\.ai-implement\/image\.yml/);
    expect(yaml).not.toMatch(/image\.yml\?ref=/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- workflow-shim-structure`
Expected: FAIL — owner/file assertions not present in `comment-trigger.yml`.

- [ ] **Step 3: Update the step env block**

In `workflows/comment-trigger.yml`, the env block at lines 107-109 currently reads:

```yaml
        env:
          CONFIGURED_RUNNER_IMAGE: ${{ vars.AI_IMPLEMENT_RUNNER_IMAGE }}
          EXTRA_ALLOWED_PREFIXES: ${{ vars.AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES }}
```

Add `GH_TOKEN`:

```yaml
        env:
          CONFIGURED_RUNNER_IMAGE: ${{ vars.AI_IMPLEMENT_RUNNER_IMAGE }}
          EXTRA_ALLOWED_PREFIXES: ${{ vars.AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES }}
          GH_TOKEN: ${{ github.token }}
```

- [ ] **Step 4: Replace the resolution preamble + allowlist seed in the `run:` block**

Replace the segment from `runner_image="${CONFIGURED_RUNNER_IMAGE:-}"` through the `runner_image="ghcr.io/builddownai/ai-implement-runner:latest"` fallback (current lines 113-116) with:

```bash
          owner="${GITHUB_REPOSITORY_OWNER,,}"

          # Resolution ladder: .ai-implement/image.yml > repo/org var > upstream default.
          # Read the override from the DEFAULT branch only — never the PR head — so a
          # comment-triggered gap-fill run cannot be pointed at an attacker-chosen image
          # via a PR edit. `gh api` with no ?ref= resolves the default branch.
          runner_image=""
          if raw="$(gh api "repos/${GITHUB_REPOSITORY}/contents/.ai-implement/image.yml" \
                -H "Accept: application/vnd.github.raw+json" 2>/dev/null)"; then
            runner_image="$(printf '%s\n' "$raw" | sed -n 's/^image:[[:space:]]*\([^[:space:]][^[:space:]]*\)[[:space:]]*$/\1/p' | head -n1)"
          fi

          if [ -z "$runner_image" ]; then
            runner_image="${CONFIGURED_RUNNER_IMAGE:-}"
          fi
          if [ -z "$runner_image" ]; then
            runner_image="ghcr.io/builddownai/ai-implement-runner:latest"
          fi
```

Then replace the allowlist seed line (current line 125):

```bash
          allowed_prefixes="ghcr.io/builddownai/"
```

with:

```bash
          allowed_prefixes="ghcr.io/builddownai/,ghcr.io/${owner}/"
```

Leave the character check, the `EXTRA_ALLOWED_PREFIXES` append, the allowlist loop, the error block, and the final `echo "runner_image=$runner_image" >> "$GITHUB_OUTPUT"` unchanged.

- [ ] **Step 5: Update the header comment**

In `workflows/comment-trigger.yml`, replace line 15:

```
#   AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES   - Comma-separated image prefixes allowed in addition to ghcr.io/builddownai/.
```

with:

```
#   AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES   - Extra image prefixes allowed in addition to ghcr.io/builddownai/ and the repo owner's own ghcr.io/<owner>/ namespace (auto-trusted).
```

- [ ] **Step 6: Mirror every change into `.github/workflows/comment-trigger.yml`**

Apply the exact same edits from Steps 3-5 to `.github/workflows/comment-trigger.yml`. Verify:

Run: `diff workflows/comment-trigger.yml .github/workflows/comment-trigger.yml`
Expected: no output (files identical).

- [ ] **Step 7: Run the workflow tests**

Run: `npm test -- workflow-shim-structure`
Expected: PASS — parity test plus the new comment-trigger assertions.

- [ ] **Step 8: Commit**

```bash
git add workflows/comment-trigger.yml .github/workflows/comment-trigger.yml src/__tests__/workflow-shim-structure.test.ts
git commit -m "feat(workflow): comment-trigger reads .ai-implement/image.yml and auto-trusts owner namespace

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Documentation — README + CLAUDE.md

**Files:**
- Modify: `README.md` (new "Choosing the runner image" subsection under the layout/quick-start area)
- Modify: `CLAUDE.md:214-226` ("Per-repo runner image override" section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the README section**

In `README.md`, add a new subsection. Place it immediately after the local-runner-development block (the paragraph ending `…while you test changes.` around line 75), before `## Layout`:

```markdown
## Choosing the runner image

Every implementation job runs inside a runner image. Resolution is the same in both execution modes, highest priority first:

| Where | Scope | Use it for |
|---|---|---|
| `.ai-implement/image.yml` (committed in the target repo, default branch) | one repo | "this repo needs a special image" |
| `AI_IMPLEMENT_RUNNER_IMAGE` | org-wide or per-repo | "my org's default image" — a GitHub **org** variable in `github-actions` mode, or an orchestrator env var in `fly-machines` mode |
| *(nothing set)* | — | falls back to the published BuildDownAI image |

The first one set wins. A fork that publishes its own image typically sets `AI_IMPLEMENT_RUNNER_IMAGE` once at the org level — no workflow edits, and the allowlist trusts your org's `ghcr.io/<owner>/` namespace automatically. In `github-actions` mode, a manual `runner_image` dispatch input overrides everything for that single run. `.ai-implement/image.yml` is always read from the default branch, so a pull request can't change the image its own run executes in.

`SESSION_IMAGE` is the deprecated former name of the orchestrator's `AI_IMPLEMENT_RUNNER_IMAGE` env var; it still works but logs a warning at startup.
```

- [ ] **Step 2: Rewrite the CLAUDE.md "Per-repo runner image override" section**

In `CLAUDE.md`, replace lines 214-226 (the whole `## Per-repo runner image override` section through the `…point `image.yml` at it.` paragraph) with:

```markdown
## Runner image resolution

Both execution modes resolve the runner image with the same ladder, highest priority first:

1. **`.ai-implement/image.yml`** at the target repo's default branch — per-repo override:

   ```yaml
   image: ghcr.io/your-org/your-runner:v1
   ```

   In `fly-machines` mode the orchestrator reads it via the GitHub contents API (`src/repo-image.ts`); in `github-actions` mode the `claude-implement.yml` / `comment-trigger.yml` workflows read it with `gh api` from the **default branch only** (never a PR head, so a PR can't choose its own privileged image).

2. **`AI_IMPLEMENT_RUNNER_IMAGE`** — the operator/org default. A GitHub repo/org **variable** in `github-actions` mode (org-level applies to every repo); an orchestrator **env var** in `fly-machines` mode. `SESSION_IMAGE` is the deprecated former name of the env var — still honored, but the orchestrator logs a deprecation warning at startup.

3. **Upstream fallback** — `ghcr.io/builddownai/ai-implement-runner:latest` (orchestrator / comment-trigger) or `:next` (claude-implement). In `github-actions` mode a manual `runner_image` dispatch input overrides everything for that one run.

The `github-actions` allowlist auto-trusts `ghcr.io/builddownai/` and the repo owner's own `ghcr.io/<owner>/` namespace, so a fork using its own published image needs no extra config; `AI_IMPLEMENT_ALLOWED_RUNNER_IMAGE_PREFIXES` is only for third-party registries. The `fly-machines` path validates image-reference format but has no allowlist.

The image must be publicly pullable. The customer owns building and publishing it. If `.ai-implement/image.yml` is absent, malformed, or points at an unreachable reference, resolution falls through to the next ladder rung.

The default runner image itself must also be public on GHCR — Fly pulls anonymously, so a private package surfaces as `failed to get manifest ... unauthorized` at machine-create time. New GHCR packages default to Private and the org must allow public container packages first (Org Settings → Packages). See the comment at the top of `.github/workflows/build-runner.yml`.

Typical use: your repo needs a language runtime or tool that isn't in the base image (e.g. terraform, ruby, go). Build an image `FROM` the published base `ghcr.io/builddownai/ai-implement-runner:latest`, add your tools, push, and point `image.yml` at it.
```

- [ ] **Step 3: Sanity-check the docs render**

Run: `git diff --stat README.md CLAUDE.md`
Expected: both files show as modified; eyeball the diffs for correct Markdown table/heading syntax.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document unified runner-image resolution ladder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: all green (1278+ tests).

- [ ] **Confirm dual-copy parity**

Run: `diff workflows/claude-implement.yml .github/workflows/claude-implement.yml && diff workflows/comment-trigger.yml .github/workflows/comment-trigger.yml && echo PARITY_OK`
Expected: `PARITY_OK`.

- [ ] **Confirm `builddownai` behavior is unchanged**

Inspect: in both workflows the default fallback literals are still `ghcr.io/builddownai/ai-implement-runner:next` (claude-implement) and `:latest` (comment-trigger); for `GITHUB_REPOSITORY_OWNER=builddownai` the allowlist resolves to `ghcr.io/builddownai/,ghcr.io/builddownai/` (a harmless duplicate). No behavior change for the upstream repo.
```
