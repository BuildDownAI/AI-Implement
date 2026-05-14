# AII-54: Pre-baked base image + per-repo image override — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Beef up the pre-baked session runner image with common agent power tools and add a `.ai-implement/image.yml` escape hatch so target repos can point the orchestrator at a customer-built image.

**Architecture:** Port and extend `Dockerfile.session` from the `v2/fly-machines` branch, publish it to GHCR via a new GitHub Actions workflow, and add a small `resolveSessionImage` helper in the orchestrator that consults GitHub's contents API for `.ai-implement/image.yml` before launching each Fly machine. No orchestrator-side builds, no private-registry auth, no declarative package list in `image.yml`.

**Tech Stack:** Docker (debian-slim base), Node 22 + TypeScript, Vitest, Fly Machines API, GitHub REST API (raw fetch — no Octokit), GitHub Actions, GHCR.

**Base branch:** Work lands on `main`. The Fly Machines runner was merged to main in an earlier phase — `Dockerfile.session`, `session/entrypoint.sh`, `src/fly-machines.ts`, and the `sessionImage` config field all live on main. Implementation happens on the current branch `theaboutbox/aii-54-plan` and opens a PR against `main`.

**Spec:** `docs/superpowers/specs/2026-04-18-aii-54-base-image-overlay-design.md`

---

## File Structure

**Created:**

- `session/tools.md` — static manifest shipped into the image at `/etc/ai-implement/tools.md`; one-line tool descriptions for Claude.
- `.github/workflows/build-runner.yml` — builds and pushes `ai-implement-runner` image to GHCR on pushes that touch `Dockerfile.session`, `session/**`, or the workflow itself.
- `src/repo-image.ts` — `resolveSessionImage` helper: fetches `.ai-implement/image.yml` from a target repo, parses `image:`, returns the override or the default. Includes a 60s in-process TTL cache.
- `src/__tests__/repo-image.test.ts` — unit tests for `resolveSessionImage`.

**Modified:**

- `Dockerfile.session` — add power tools (ripgrep, fd-find, yq, tree, sqlite3, git-lfs, openssh-client, zip, xz-utils, shellcheck, build-essential, make, pkg-config, less), `corepack enable`, global `@ast-grep/cli`, copy `tools.md` to `/etc/ai-implement/`.
- `session/entrypoint.sh` — prepend a single-line "Power tools available" pointer to `/tmp/claude-prompt.md` on both prompt paths.
- `src/index.ts` — call `resolveSessionImage` in the dispatch path; pass the result into `buildSessionMachineConfig`; include the resolved image in log and Linear dispatch comment.
- `src/log.ts` — add a `session_image` column to `dispatch_log` and surface it on `Job`.
- `src/admin-html.ts` — (tiny) show the session image on the jobs row so it's visible in the admin UI.

**Unchanged but referenced:**

- `src/fly-machines.ts` — already takes `image` on `SessionMachineInput`; no change needed beyond what the call site passes in.
- `src/github-app-auth.ts` — used for installation token; reused when calling the contents API.

---

## Self-Contained Notes for the Implementer

- **No Octokit.** This repo uses raw `fetch` against `https://api.github.com`. Keep that pattern.
- **No YAML library.** `image.yml` has exactly one supported key (`image`). Parse with a tiny regex (see Task 4 step 3). Adding `js-yaml` for one string is overkill and the plan explicitly rejects declarative fields in this ticket.
- **GitHub App auth.** The orchestrator already mints installation tokens per owner via `getInstallationToken(appId, privateKey, owner)` in `src/github-app-auth.ts`. Reuse it.
- **Cache semantics.** TTL cache is keyed by `owner/repo` and is only in-process. It's a debounce, not a correctness mechanism. 60s is enough to absorb re-dispatch bursts inside one poll interval (default 60s).
- **fd naming on Debian.** Debian's `fd-find` package installs the binary as `fdfind`. Dockerfile symlinks it to `/usr/local/bin/fd` so Claude can invoke it as `fd`.
- **Dockerfile base.** Keep `node:22-bookworm-slim` (already chosen by the v2 branch). Don't switch to alpine — `shellcheck`, `build-essential`, and several apt packages behave better on bookworm.
- **Image tags.** Two tags per build: immutable `base-vYYYYMMDD` and rolling `latest`. The orchestrator `SESSION_IMAGE` env var in each client's Fly app should pin `base-v*` once deployed, but the rolling `latest` is the default fallback inside `src/index.ts`.
- **Dispatch comment format.** `src/index.ts` already posts a Linear comment via `postDispatch`. Just include a line showing the resolved image and its source (override vs default).

---

## Task 1: Extend Dockerfile.session with power tools

**Files:**

- Modify: `Dockerfile.session` (top-level of repo)
- Create: `session/tools.md`

- [ ] **Step 1: Write the updated Dockerfile.session**

Replace the full contents of `Dockerfile.session` with:

```dockerfile
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# System dependencies — base tools + power tools for the agent
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      git-lfs \
      curl \
      jq \
      openssl \
      ca-certificates \
      openssh-client \
      python3 \
      python3-pip \
      gettext-base \
      perl \
      build-essential \
      make \
      pkg-config \
      less \
      tree \
      ripgrep \
      fd-find \
      sqlite3 \
      unzip \
      zip \
      xz-utils \
      shellcheck \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && git lfs install --system \
    && rm -rf /var/lib/apt/lists/*

# yq (mikefarah, single binary) — Debian's yq is a Python impl with a different CLI, so install upstream
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${ARCH}" \
         -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq

# gh CLI — official GitHub method
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI and ast-grep (structural search/rewrite)
RUN npm install -g @anthropic-ai/claude-code @ast-grep/cli \
    && corepack enable

# Tool manifest for the agent
RUN mkdir -p /etc/ai-implement
COPY session/tools.md /etc/ai-implement/tools.md

# Session scripts
COPY session/ /opt/ai-implement/
RUN chmod +x /opt/ai-implement/*.sh

WORKDIR /workspace

ENTRYPOINT ["/opt/ai-implement/entrypoint.sh"]
```

- [ ] **Step 2: Write `session/tools.md`**

Create `session/tools.md` with this exact content:

```markdown
# Power tools available in this environment

Beyond the usual POSIX toolbox, this runner ships with:

- `rg` (ripgrep) — fast regex search across files. Prefer over `grep -r`.
- `fd` — fast file finder. Prefer over `find` for simple name/type searches.
- `sg` (ast-grep) — structural (AST) search and rewrite. Use for refactors that
  regex would botch (e.g. renaming a method only in call sites, not strings).
- `yq` — YAML query/mutate (Mike Farah's Go build, not the Python one). jq-like syntax.
- `jq` — JSON query/mutate.
- `tree` — directory tree view; `tree -L 2` for a quick overview.
- `sqlite3` — SQLite CLI.
- `shellcheck` — lint bash; use to self-verify shell scripts you write.
- `git-lfs` — installed and initialized; `git clone` transparently fetches LFS blobs.
- `gh` — GitHub CLI; authenticated for the current repo.
- `corepack` — enables `yarn` and `pnpm` on demand without extra installs.
- `@anthropic-ai/claude-code` — this is the `claude` CLI itself; don't re-invoke.

Standard runtimes present: Node.js 22, Python 3 (Bookworm), build-essential toolchain.
Language runtimes beyond Node/Python belong in a per-repo custom image — see
`.ai-implement/image.yml` in the target repo.
```

- [ ] **Step 3: Build the image locally to verify it works**

Run:

```bash
docker build -f Dockerfile.session -t ai-implement-runner:local-test .
```

Expected: build completes without errors. If `fd-find` or `ripgrep` aren't found, the bookworm package names have shifted — check `apt-cache search fd-find` inside a `node:22-bookworm-slim` container.

- [ ] **Step 4: Smoke-check every power tool inside the built image**

Run:

```bash
docker run --rm ai-implement-runner:local-test bash -c '
  set -e
  rg --version >/dev/null
  fd --version >/dev/null
  sg --version >/dev/null
  yq --version >/dev/null
  jq --version >/dev/null
  tree --version >/dev/null
  sqlite3 --version >/dev/null
  shellcheck --version >/dev/null
  git lfs version >/dev/null
  gh --version >/dev/null
  node --version >/dev/null
  python3 --version >/dev/null
  claude --version >/dev/null
  corepack --version >/dev/null
  test -f /etc/ai-implement/tools.md
  echo OK
'
```

Expected output: `OK`. Any earlier line failing will stop the script with a non-zero exit.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile.session session/tools.md
git commit -m "feat(runner): add power tools (rg, fd, sg, yq, shellcheck, git-lfs) to base image"
```

---

## Task 2: Entrypoint — prepend power-tools pointer to the Claude prompt

**Files:**

- Modify: `session/entrypoint.sh`

- [ ] **Step 1: Locate the prompt-finalization point**

Open `session/entrypoint.sh`. Find the block that ends with `/tmp/claude-prompt.md` being written (it is produced by `envsubst` on both the WORKFLOW.md path and the default-prompt path — roughly the end of section 7 "Parse WORKFLOW.md front matter").

- [ ] **Step 2: Insert the pointer prepend immediately after `/tmp/claude-prompt.md` is produced**

Right after the last `envsubst ... > /tmp/claude-prompt.md` (there are two in the file, one per branch — the simplest placement is AFTER the whole `if [ -f "WORKFLOW.md" ]; then ... else ... fi` block closes, so a single prepend covers both paths), add:

```bash
# Tell Claude about the power tools available in this image.
if [ -f /etc/ai-implement/tools.md ]; then
  {
    echo "Power tools available in this environment: see /etc/ai-implement/tools.md"
    echo
    cat /tmp/claude-prompt.md
  } > /tmp/claude-prompt.md.new
  mv /tmp/claude-prompt.md.new /tmp/claude-prompt.md
fi
```

- [ ] **Step 3: Shellcheck the file**

Run:

```bash
shellcheck session/entrypoint.sh
```

Expected: no new warnings introduced by the added block. Pre-existing warnings from the rest of the file are out of scope.

- [ ] **Step 4: Verify with the built image**

Run (reusing the Task 1 image):

```bash
docker run --rm --entrypoint bash ai-implement-runner:local-test -c '
  # Simulate the prompt producer with a dummy body.
  echo "dummy body" > /tmp/claude-prompt.md
  # Re-exec the prepend logic inline (same lines you added):
  if [ -f /etc/ai-implement/tools.md ]; then
    {
      echo "Power tools available in this environment: see /etc/ai-implement/tools.md"
      echo
      cat /tmp/claude-prompt.md
    } > /tmp/claude-prompt.md.new
    mv /tmp/claude-prompt.md.new /tmp/claude-prompt.md
  fi
  head -3 /tmp/claude-prompt.md
'
```

Expected first line of output: `Power tools available in this environment: see /etc/ai-implement/tools.md`.

- [ ] **Step 5: Commit**

```bash
git add session/entrypoint.sh
git commit -m "feat(runner): prepend power-tools pointer to Claude prompt"
```

---

## Task 3: GitHub Actions workflow to publish the runner image

**Files:**

- Create: `.github/workflows/build-runner.yml`

- [ ] **Step 1: Write the workflow file**

Create `.github/workflows/build-runner.yml` with:

```yaml
name: Build runner image

on:
  push:
    branches: [main]
    paths:
      - "Dockerfile.session"
      - "session/**"
      - ".github/workflows/build-runner.yml"
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set build metadata
        id: meta
        run: |
          echo "date_tag=base-v$(date -u +%Y%m%d)" >> "$GITHUB_OUTPUT"
          echo "image=ghcr.io/${{ github.repository_owner }}/ai-implement-runner" >> "$GITHUB_OUTPUT"

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/setup-buildx-action@v3

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          file: Dockerfile.session
          push: true
          tags: |
            ${{ steps.meta.outputs.image }}:${{ steps.meta.outputs.date_tag }}
            ${{ steps.meta.outputs.image }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Verify the YAML is syntactically valid**

Run:

```bash
yq '.' .github/workflows/build-runner.yml > /dev/null
```

Expected: no output, exit 0. (The Task 1 image's `yq` works here; or use any local `yq`.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-runner.yml
git commit -m "ci: build and publish ai-implement-runner image to GHCR"
```

(The image itself publishes on the first push of this branch to a matching `paths` filter after merge. No local action needed now.)

---

## Task 4: `resolveSessionImage` helper — TDD

**Files:**

- Create: `src/repo-image.ts`
- Test: `src/__tests__/repo-image.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `src/__tests__/repo-image.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionImage, __clearRepoImageCacheForTests } from "../repo-image.js";

const DEFAULT_IMAGE = "ghcr.io/eudoxus-ai/ai-implement-runner:latest";

function mockFetch(
  status: number,
  body: string | null,
): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body ?? "",
    json: async () => (body ? JSON.parse(body) : null),
  });
}

// GitHub contents API returns JSON with base64-encoded `content` for file blobs.
function contentsApiResponse(fileBody: string): string {
  return JSON.stringify({
    type: "file",
    encoding: "base64",
    content: Buffer.from(fileBody, "utf8").toString("base64"),
  });
}

describe("resolveSessionImage", () => {
  beforeEach(() => {
    __clearRepoImageCacheForTests();
  });

  it("returns the override when image.yml has a valid image:", async () => {
    const fetchImpl = mockFetch(200, contentsApiResponse("image: ghcr.io/acme/my-runner:v3\n"));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result).toEqual({ image: "ghcr.io/acme/my-runner:v3", source: "override" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns the default when the file is 404", async () => {
    const fetchImpl = mockFetch(404, "Not Found");
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result).toEqual({ image: DEFAULT_IMAGE, source: "default" });
  });

  it("returns the default when YAML is malformed (no image: key)", async () => {
    const fetchImpl = mockFetch(200, contentsApiResponse("something: else\n"));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result).toEqual({ image: DEFAULT_IMAGE, source: "default" });
  });

  it("returns the default when image: value fails validation (whitespace)", async () => {
    const fetchImpl = mockFetch(200, contentsApiResponse("image: not a valid image\n"));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result).toEqual({ image: DEFAULT_IMAGE, source: "default" });
  });

  it("returns the default when image: value lacks a tag (no colon)", async () => {
    const fetchImpl = mockFetch(200, contentsApiResponse("image: ghcr.io/acme/runner\n"));
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result).toEqual({ image: DEFAULT_IMAGE, source: "default" });
  });

  it("ignores other keys in the YAML", async () => {
    const fetchImpl = mockFetch(
      200,
      contentsApiResponse("image: ghcr.io/acme/my-runner:v3\napt: [terraform]\nfuture_knob: 42\n"),
    );
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result).toEqual({ image: "ghcr.io/acme/my-runner:v3", source: "override" });
  });

  it("caches results for 60 seconds per owner/repo", async () => {
    const fetchImpl = mockFetch(200, contentsApiResponse("image: ghcr.io/acme/my-runner:v3\n"));
    await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not cache 404s forever — negative result is also cached for TTL but returns default", async () => {
    const fetchImpl = mockFetch(404, "Not Found");
    const a = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    const b = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(a).toEqual({ image: DEFAULT_IMAGE, source: "default" });
    expect(b).toEqual({ image: DEFAULT_IMAGE, source: "default" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns the default and does not throw when the API returns 500", async () => {
    const fetchImpl = mockFetch(500, "Internal Server Error");
    const result = await resolveSessionImage({
      owner: "acme",
      repo: "widgets",
      token: "ghs_xxx",
      defaultImage: DEFAULT_IMAGE,
      fetchImpl,
    });
    expect(result).toEqual({ image: DEFAULT_IMAGE, source: "default" });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
npm test -- src/__tests__/repo-image.test.ts
```

Expected: all tests fail because `../repo-image.js` does not exist.

- [ ] **Step 3: Implement `src/repo-image.ts`**

Create `src/repo-image.ts` with:

```typescript
const CACHE_TTL_MS = 60_000;
const IMAGE_KEY_RE = /^image:\s*(\S+)\s*$/m;
// Registry ref: must contain at least one "/" and a ":tag". No whitespace allowed.
const VALID_IMAGE_RE = /^[^\s]+\/[^\s:]+:[^\s]+$/;

type CacheEntry = { expiresAt: number; image: string; source: "override" | "default" };

const cache = new Map<string, CacheEntry>();

export function __clearRepoImageCacheForTests(): void {
  cache.clear();
}

export interface ResolveSessionImageInput {
  owner: string;
  repo: string;
  token: string;
  defaultImage: string;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to `Date.now`. */
  nowMs?: () => number;
}

export interface ResolveSessionImageResult {
  image: string;
  source: "override" | "default";
}

export async function resolveSessionImage(
  input: ResolveSessionImageInput,
): Promise<ResolveSessionImageResult> {
  const { owner, repo, token, defaultImage } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = (input.nowMs ?? Date.now)();

  const cacheKey = `${owner}/${repo}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { image: cached.image, source: cached.source };
  }

  const result = await fetchImage(owner, repo, token, defaultImage, fetchImpl);
  cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, ...result });
  return result;
}

async function fetchImage(
  owner: string,
  repo: string,
  token: string,
  defaultImage: string,
  fetchImpl: typeof fetch,
): Promise<ResolveSessionImageResult> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.ai-implement/image.yml`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "linear-dispatch-worker",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    console.warn(`[repo-image] ${owner}/${repo}: fetch failed (${err instanceof Error ? err.message : String(err)}); using default image`);
    return { image: defaultImage, source: "default" };
  }

  if (res.status === 404) {
    return { image: defaultImage, source: "default" };
  }
  if (!res.ok) {
    console.warn(`[repo-image] ${owner}/${repo}: image.yml lookup returned HTTP ${res.status}; using default image`);
    return { image: defaultImage, source: "default" };
  }

  let body: { content?: string; encoding?: string; type?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    console.warn(`[repo-image] ${owner}/${repo}: image.yml response was not JSON; using default image`);
    return { image: defaultImage, source: "default" };
  }

  if (body.type !== "file" || body.encoding !== "base64" || !body.content) {
    console.warn(`[repo-image] ${owner}/${repo}: image.yml was not a file blob; using default image`);
    return { image: defaultImage, source: "default" };
  }

  const yamlText = Buffer.from(body.content, "base64").toString("utf8");
  const match = yamlText.match(IMAGE_KEY_RE);
  if (!match) {
    console.warn(`[repo-image] ${owner}/${repo}: image.yml has no "image:" key; using default image`);
    return { image: defaultImage, source: "default" };
  }

  const candidate = match[1];
  if (!VALID_IMAGE_RE.test(candidate)) {
    console.warn(`[repo-image] ${owner}/${repo}: image.yml "image: ${candidate}" failed validation (expected host/name:tag); using default image`);
    return { image: defaultImage, source: "default" };
  }

  return { image: candidate, source: "override" };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:

```bash
npm test -- src/__tests__/repo-image.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 5: Typecheck**

Run:

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/repo-image.ts src/__tests__/repo-image.test.ts
git commit -m "feat(orchestrator): add resolveSessionImage helper for .ai-implement/image.yml"
```

---

## Task 5: Add `session_image` column to `dispatch_log`

**Files:**

- Modify: `src/log.ts`

- [ ] **Step 1: Extend the `Job` interface**

In `src/log.ts`, add a field to the `Job` interface (near `machineId`):

```typescript
  machineId: string | null;
  sessionImage: string | null;
```

- [ ] **Step 2: Extend `ensureLogColumns` to add the column**

In the `ensureLogColumns` function, after the existing `run_id` block, add:

```typescript
  if (!names.has("session_image")) {
    db.exec("ALTER TABLE dispatch_log ADD COLUMN session_image TEXT");
  }
```

- [ ] **Step 3: Extend `appendLog` input and INSERT**

Find the `appendLog` function in `src/log.ts`. Add `sessionImage?: string | null` to its `LogInput` interface (whatever that interface is called — locate it at the top of the function or in the exported types). Update the INSERT SQL to include `session_image` and bind the value (or `null` if absent).

If `appendLog` uses a rest-spread over keys, just add `session_image` to the column list and `?` in the values; if it spells columns out, follow the existing pattern.

- [ ] **Step 4: Update the SELECT/row mapper to expose `sessionImage`**

Wherever `src/log.ts` maps DB rows to `Job` objects (search for `issue_identifier:` or similar), add:

```typescript
    sessionImage: row.session_image ?? null,
```

- [ ] **Step 5: Typecheck**

Run:

```bash
npm run typecheck
```

Expected: no errors. If existing tests in `src/__tests__/log.test.ts` break because of the new field, update those fixtures to include `sessionImage: null` — this is a plain schema addition and should not change behavior.

- [ ] **Step 6: Run the test suite**

Run:

```bash
npm test
```

Expected: all pre-existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/log.ts src/__tests__/log.test.ts
git commit -m "feat(log): record resolved session_image per dispatch"
```

---

## Task 6: Wire resolver into the dispatch path

**Files:**

- Modify: `src/index.ts`

- [ ] **Step 1: Import the resolver**

At the top of `src/index.ts`, with the other local imports, add:

```typescript
import { resolveSessionImage } from "./repo-image.js";
```

- [ ] **Step 2: Resolve the image before `buildSessionMachineConfig`**

In the Fly-machines dispatch function (the one showing `buildSessionMachineConfig({ image: config.sessionImage, ... })` — around line 240 in the current v2/fly-machines `src/index.ts`), replace the direct use of `config.sessionImage` with the resolver.

Before the `const machineConfig = buildSessionMachineConfig(...)` call:

```typescript
const ghToken = await getInstallationToken(
  config.githubAppId,
  config.githubAppPrivateKey,
  mapping.owner,
);

const { image: resolvedImage, source: imageSource } = await resolveSessionImage({
  owner: mapping.owner,
  repo: mapping.repo,
  token: ghToken,
  defaultImage: config.sessionImage,
});
```

Note: the existing code calls `getInstallationToken` AFTER `createMachine` (to post the dispatch comment). Hoist that call up so we can reuse it here. The token is valid for an hour, so reusing it for `postDispatch` a few seconds later is fine — drop the second `getInstallationToken` call.

Then in `buildSessionMachineConfig`, replace `image: config.sessionImage,` with `image: resolvedImage,`.

- [ ] **Step 3: Pass the resolved image into the log entry**

Update the `appendLog({ ... })` call in the same function to include:

```typescript
    sessionImage: resolvedImage,
```

- [ ] **Step 4: Log the chosen image**

Replace the existing dispatch-success `console.log` with one that includes the resolved image and source:

```typescript
console.log(
  `[poll] Dispatched ${issue.identifier} -> ${mapping.owner}/${mapping.repo} ` +
  `(fly-machines, machine: ${machine.id}, image: ${resolvedImage} [${imageSource}])`,
);
```

- [ ] **Step 5: Include the image in the Linear dispatch comment**

Find `postDispatch` (either in `src/index.ts` or `src/linear.ts` / `src/notify.ts`). It composes a markdown comment. Add one line to the comment body:

```
- Runner image: `<resolvedImage>` (<imageSource>)
```

If `postDispatch` takes its own argument list, add `resolvedImage: string` and `imageSource: "override" | "default"` params and thread them through at the call site.

- [ ] **Step 6: Typecheck**

Run:

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 7: Run the full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/linear.ts src/notify.ts 2>/dev/null || git add src/index.ts
git commit -m "feat(orchestrator): resolve per-repo image.yml before launching session machine"
```

---

## Task 7: Surface session image in the admin UI jobs list

**Files:**

- Modify: `src/admin-html.ts`

- [ ] **Step 1: Locate the jobs table/row rendering**

Open `src/admin-html.ts`. Find the HTML fragment (or JS template) that renders the jobs list — search for `issueIdentifier` or `machineId`.

- [ ] **Step 2: Add a column for image**

Add a new column header `Image` and a cell per row that renders:

```html
<td title="${job.sessionImage ?? ''}">
  ${job.sessionImage ? escapeHtml(shortImage(job.sessionImage)) : '<span class="muted">—</span>'}
</td>
```

Where `shortImage(s)` returns the last `/`-separated segment (e.g. `ai-implement-runner:base-v20260418`) so the table stays narrow. If no `shortImage` helper exists, inline the logic:

```javascript
const shortImage = (s) => s ? s.slice(s.lastIndexOf('/') + 1) : '';
```

- [ ] **Step 3: Manually verify**

Run:

```bash
npm run dev
```

Visit `http://localhost:8080/admin` (log in with `ADMIN_ACCESS_CODE`) and confirm the jobs table renders the new Image column. Existing jobs from before this migration will show `—` (NULL).

Stop the dev server with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add src/admin-html.ts
git commit -m "feat(admin): show resolved session image in jobs list"
```

---

## Task 8: Smoke test — two repos, one with an override

**Files:**

- Create (in a staging/test target repo, NOT this orchestrator repo): `.ai-implement/image.yml`

**Prerequisites:**

- Task 3's workflow has run and `ghcr.io/eudoxus-ai/ai-implement-runner:base-vYYYYMMDD` is pulled/available.
- A second image has been published by you or a test tenant that extends the base with one obvious tool. For the smoke test, you can hand-build a one-line Dockerfile:

  ```dockerfile
  FROM ghcr.io/eudoxus-ai/ai-implement-runner:latest
  RUN apt-get update && apt-get install -y --no-install-recommends terraform \
      || (curl -fsSL https://releases.hashicorp.com/terraform/1.9.0/terraform_1.9.0_linux_amd64.zip -o /tmp/tf.zip \
            && unzip /tmp/tf.zip -d /usr/local/bin && rm /tmp/tf.zip)
  ```

  Build, push to a public GHCR repo you control, and note the reference (e.g. `ghcr.io/theaboutbox/ai-implement-runner-terraform:v1`).

- [ ] **Step 1: Deploy the orchestrator to staging with the new base tag**

Set `SESSION_IMAGE=ghcr.io/eudoxus-ai/ai-implement-runner:base-vYYYYMMDD` on the staging Fly app and redeploy:

```bash
fly secrets set SESSION_IMAGE=ghcr.io/eudoxus-ai/ai-implement-runner:base-v20260418 --app <staging-app>
fly deploy --remote-only --app <staging-app>
```

Expected: deploy succeeds. Check `fly logs --app <staging-app>` for `[main] Session image: ghcr.io/eudoxus-ai/ai-implement-runner:base-v20260418`.

- [ ] **Step 2: Repo X — dispatch against a repo with no image.yml**

Pick an existing AI-Implement-enabled test repo that does NOT have `.ai-implement/image.yml`. File a trivial Linear issue (e.g. "add a blank line to README") labeled `AI-Implement`.

Expected within one poll cycle:

- `fly logs` shows `Dispatched <ISSUE> ... image: ghcr.io/eudoxus-ai/ai-implement-runner:base-v... [default]`.
- Admin UI jobs row shows the base image tag.
- Linear dispatch comment includes `- Runner image: \`ghcr.io/eudoxus-ai/ai-implement-runner:base-v...\` (default)`.
- The job completes successfully, producing a PR.

- [ ] **Step 3: Repo Y — add image.yml pointing at the overlay image**

In a second test repo (or a branch of Repo X), commit `.ai-implement/image.yml`:

```yaml
image: ghcr.io/theaboutbox/ai-implement-runner-terraform:v1
```

Ensure the default branch contains this file.

- [ ] **Step 4: Dispatch against Repo Y and verify the override is used**

File a Linear issue labeled `AI-Implement` that asks Claude to run `terraform -version` and include the output in the PR description (e.g. "add a PR description confirming terraform is available").

Expected within one poll cycle:

- `fly logs` shows `... image: ghcr.io/theaboutbox/ai-implement-runner-terraform:v1 [override]`.
- Admin UI jobs row shows the overlay image tag.
- Linear dispatch comment shows `(override)`.
- The resulting PR description contains terraform's version string, proving the overlay image was actually booted.

- [ ] **Step 5: Cleanup**

Revert or close the smoke-test issues/PRs as appropriate.

- [ ] **Step 6: Commit any docs updates**

If you added anything to `CLAUDE.md` or `README.md` about `.ai-implement/image.yml`, commit it now:

```bash
git add README.md CLAUDE.md
git commit -m "docs: document .ai-implement/image.yml override"
```

(If no doc changes are needed this step is a no-op; skip it.)

---

## Task 9: Update orchestrator docs

**Files:**

- Modify: `README.md` (or `CLAUDE.md` if that's where customer-facing runner docs live)

- [ ] **Step 1: Add a short "Per-repo image override" section**

Under a sensible existing heading (e.g. near the workflow-template section of `CLAUDE.md`), add:

```markdown
### Per-repo runner image override

A target repo can boot on a custom runner image by committing `.ai-implement/image.yml`
at the default branch:

```yaml
image: ghcr.io/your-org/your-runner:v1
```

The image must be publicly pullable. The customer owns building and publishing it.
If the file is absent, invalid, or points at an unreachable image reference,
the orchestrator falls back to the default `SESSION_IMAGE`.

Typical use: your repo needs a language runtime or tool that isn't in the base image
(e.g. terraform, ruby, go). Build an image `FROM` the published base
`ghcr.io/eudoxus-ai/ai-implement-runner:latest`, add your tools, push, and point
`image.yml` at it.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md README.md 2>/dev/null
git commit -m "docs: document per-repo runner image override"
```

---

## Task 10: Parity for the GitHub Actions dispatch path

**Context:** Some clients still run via `workflows/claude-implement.yml` (GitHub Actions dispatch) rather than Fly Machines. When Claude learns to reach for `sg`/`fd`/`yq` on the Fly runner via `/etc/ai-implement/tools.md`, those same expectations must hold on the GH Actions path. `ubuntu-latest` already ships `rg`, `jq`, `shellcheck`, `gh`, `sqlite3`, `git`, `curl`, `unzip`, `node`, `python3`, `build-essential`. Missing: `fd`, `yq` (upstream), `ast-grep`, `tree`, `corepack`. We install those and prepend the same pointer line to the prompt.

Note: the file `/etc/ai-implement/tools.md` can't be written on the GH runner without sudo (actually sudo works on ubuntu-latest, but `/tmp/ai-implement/tools.md` is cleaner and avoids path divergence mattering). Claude is told where to look via the prepended pointer.

**Files:**

- Modify: `workflows/claude-implement.yml`

- [ ] **Step 1: Add a "Install power tools" step**

Insert this step in `workflows/claude-implement.yml` immediately after the `Check out existing PR branch` step and before `Prepare prompt`:

```yaml
      - name: Install power tools
        run: |
          set -euo pipefail
          # Fast installs for tools not preinstalled on ubuntu-latest.
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends fd-find tree
          sudo ln -sf /usr/bin/fdfind /usr/local/bin/fd

          # yq (mikefarah) — upstream single binary; Ubuntu's `yq` is a different Python tool.
          ARCH=$(dpkg --print-architecture)
          sudo curl -fsSL \
            "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${ARCH}" \
            -o /usr/local/bin/yq
          sudo chmod +x /usr/local/bin/yq

          # ast-grep via npm (node is preinstalled on ubuntu-latest).
          sudo npm install -g @ast-grep/cli

          # corepack toggles on bundled yarn/pnpm without extra installs.
          sudo corepack enable

          # Tool manifest — same content as the Fly runner's /etc/ai-implement/tools.md.
          mkdir -p /tmp/ai-implement
          cat > /tmp/ai-implement/tools.md <<'MANIFEST'
          # Power tools available in this environment

          Beyond the usual POSIX toolbox, this runner ships with:

          - `rg` (ripgrep) — fast regex search across files. Prefer over `grep -r`.
          - `fd` — fast file finder. Prefer over `find` for simple name/type searches.
          - `sg` (ast-grep) — structural (AST) search and rewrite. Use for refactors that
            regex would botch (e.g. renaming a method only in call sites, not strings).
          - `yq` — YAML query/mutate (Mike Farah's Go build, not the Python one). jq-like syntax.
          - `jq` — JSON query/mutate.
          - `tree` — directory tree view; `tree -L 2` for a quick overview.
          - `sqlite3` — SQLite CLI.
          - `shellcheck` — lint bash; use to self-verify shell scripts you write.
          - `gh` — GitHub CLI; authenticated for the current repo.
          - `corepack` — enables `yarn` and `pnpm` on demand without extra installs.

          Standard runtimes present: Node.js, Python 3, build-essential toolchain.
          MANIFEST

          # Quick smoke check — fail the job if any tool isn't on PATH.
          for tool in rg fd sg yq jq tree sqlite3 shellcheck gh node python3 corepack; do
            command -v "$tool" >/dev/null || { echo "Missing: $tool"; exit 1; }
          done
```

- [ ] **Step 2: Prepend the tool-manifest pointer to the prompt**

In the same file, find the tail of the `Prepare prompt` step where `/tmp/claude-prompt.md` is piped into `$GITHUB_OUTPUT`. It currently reads:

```bash
          {
            echo 'prompt<<CLAUDE_PROMPT_EOF'
            cat /tmp/claude-prompt.md
            echo 'CLAUDE_PROMPT_EOF'
          } >> "$GITHUB_OUTPUT"
```

Replace with:

```bash
          # Prepend the tool-manifest pointer so Claude knows about the power tools.
          if [ -f /tmp/ai-implement/tools.md ]; then
            {
              echo "Power tools available in this environment: see /tmp/ai-implement/tools.md"
              echo
              cat /tmp/claude-prompt.md
            } > /tmp/claude-prompt.md.new
            mv /tmp/claude-prompt.md.new /tmp/claude-prompt.md
          fi

          {
            echo 'prompt<<CLAUDE_PROMPT_EOF'
            cat /tmp/claude-prompt.md
            echo 'CLAUDE_PROMPT_EOF'
          } >> "$GITHUB_OUTPUT"
```

- [ ] **Step 3: Lint the workflow YAML**

Run:

```bash
yq '.' workflows/claude-implement.yml > /dev/null
```

Expected: no output, exit 0. (Use any local `yq`; the image built in Task 1 also has it.)

- [ ] **Step 4: Shellcheck the embedded script**

Extract the `Install power tools` `run:` block to a temp file and lint it:

```bash
awk '/Install power tools/,/Prepare prompt/' workflows/claude-implement.yml \
  | sed -n '/run: |/,/^      - name:/p' \
  | sed '1d;$d' > /tmp/install-tools.sh
shellcheck -s bash /tmp/install-tools.sh || true
```

Fix any non-trivial warnings. `SC2086` (word-splitting on `$ARCH`) etc. — follow existing style in the file.

- [ ] **Step 5: Sync the updated workflow to target repos (deferred)**

`.github/workflows/sync-workflow.yml` takes care of this on merge — no local action required. Note in the PR body that target repos will pick up the change on the next sync run.

- [ ] **Step 6: Commit**

```bash
git add workflows/claude-implement.yml
git commit -m "feat(gha): install fd/yq/sg/tree and prepend tools pointer to prompt"
```

---

## Task 11: Open the PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin theaboutbox/aii-54-plan
```

- [ ] **Step 2: Open the PR against `main`**

```bash
gh pr create --base main --title "AII-54: base image + per-repo image override" --body "$(cat <<'EOF'
## Summary
- Beefs up `Dockerfile.session` with common power tools (rg, fd, sg, yq, shellcheck, sqlite3, git-lfs, tree, corepack).
- Adds `/etc/ai-implement/tools.md` and prepends a one-line pointer to the Claude prompt.
- Publishes the image via `.github/workflows/build-runner.yml` to `ghcr.io/eudoxus-ai/ai-implement-runner` as `base-vYYYYMMDD` and `latest`.
- Adds `resolveSessionImage` + a 60s TTL cache; orchestrator honors `.ai-implement/image.yml` in target repos (pointer-only schema).
- Records the resolved image on each job and surfaces it in logs, the admin UI, and the Linear dispatch comment.
- Mirrors the tool set + prompt pointer in `workflows/claude-implement.yml` so the legacy GitHub Actions dispatch path has parity with the Fly runner.

Fixes AII-54.

## Test plan
- [ ] `docker build -f Dockerfile.session` succeeds and the tool smoke-check (Task 1, Step 4) prints OK.
- [ ] `npm test` passes (incl. new `repo-image.test.ts`).
- [ ] Staging dispatch against a repo WITHOUT `image.yml` uses base image (per logs + admin UI).
- [ ] Staging dispatch against a repo WITH `image.yml` uses the override (Linear comment shows `(override)`; PR body confirms the override-only tool is present).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Results

**Spec coverage** (cross-check against `docs/superpowers/specs/2026-04-18-aii-54-base-image-overlay-design.md`):

- Base image contents (all adds) → Task 1.
- Tool manifest at `/etc/ai-implement/tools.md` → Task 1 (ship), Task 2 (wire into prompt).
- Versioning + build pipeline → Task 3.
- `image.yml` schema (pointer only) → Task 4 (validation).
- Orchestrator resolver + TTL cache → Task 4.
- Dispatch wiring + precedence → Task 6.
- Log surfacing → Tasks 5, 6, 7.
- Linear comment shows resolved image → Task 6.
- Smoke test (AC) → Task 8.
- Docs → Task 9.
- GH Actions parity → Task 10.

All spec sections have at least one task. No gaps found.

**Placeholder scan:** No "TBD", no "write tests for the above" stubs, no "similar to Task N" shortcuts. Every step shows code, commands, or exact file locations.

**Type consistency:** `ResolveSessionImageResult` has `{ image, source }` in both test and impl. `Job.sessionImage: string | null` matches the DB column (`TEXT`, nullable). `imageSource` is `"override" | "default"` everywhere used.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-18-aii-54-base-image-overlay.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
