# Feature-node top-of-tree completion — Implementation Plan

> **For AI-Implement:** Each task below maps to a tracker issue. Steps use checkbox syntax.
> The pipeline picks up each issue independently — task descriptions are self-contained.

**Goal:** Make top-of-tree feature-node completion detect the `feature → base` PR's **merged
state** (not git ancestry), delete the feature branch, and idempotently finalize the parent —
so a human squash/rebase/merge-commit merge never re-opens the PR or flips the parent to In
Progress.

**Architecture:** Two new `github.ts` helpers (`deleteBranch`, `findPullRequestByBranches`)
feed a reworked top-of-tree branch in `merge-up.ts` `rollUpOne`; on a merged top PR it deletes
the branch and calls `finalizeMerged` (wired in `index.ts` to the Linear provider's `markMerged`
from AII-166). `FeatureNodeRollUp` carries the parent's Linear UUID so no extra lookup is needed.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node, Vitest. REST for GitHub,
GraphQL for Linear.

**Tracker Container:** AII-189 (feature node) — children AII-188 (this fix), AII-187
(verification); parent closing work = docs (Task 3).

**Grouping:** parent AII-189 owns `ai-implement/feature/aii-189`; AII-188 + AII-187 PR into it;
Task 3 (docs) is AII-189's deferred closing work, `Blocked by` both children.

---

## Task 1 — AII-188: Merged-state top-of-tree completion (the fix)

**Shape:** deep-and-targeted (the reasoning is concentrated in `merge-up.ts`; the rest is
mechanical plumbing that exists only to serve it, so it lands as one coherent change).
**Migration / backfill?** no

**Files:**
- Modify: `src/github.ts` — add `deleteBranch`, `findPullRequestByBranches` (after
  `findOpenPullRequest`, ~`:406`)
- Modify: `src/providers/types.ts` — add `issueId` to `FeatureNodeRollUp` (`:48-60`)
- Modify: `src/providers/linear.ts` — select `id` in `fetchFeatureNodeRollUps` and set
  `issueId` (`:333-386`)
- Modify: `src/merge-up.ts` — add `finalizeMerged` to `MergeUpDeps`; rework the top-of-tree
  branch of `rollUpOne`
- Modify: `src/index.ts` — call `runMergeUps` per-provider, wiring
  `finalizeMerged: (id) => provider.markMerged(id)` (`:255-273`)
- Test: `src/__tests__/github.test.ts` — `deleteBranch` + `findPullRequestByBranches`
- Test: `src/__tests__/merge-up.test.ts` — merged/open/unmerged top-of-tree cases

**Parallel-safe with:** none in this tree (AII-187 is `Blocked by` this; Task 3 is `Blocked by`
this). External: AII-152 touches the same files — coordinate before labelling (see Notes).
**Blocked by:** none.

**Rubric:**
- Pattern anchor: `src/github.ts` `compareBranches`/`findOpenPullRequest` (same `fetch` +
  `ghHeaders` + `GitHubApiError` style); `src/merge-up.ts` `rollUpOne` itself.
- Test fixture: `src/__tests__/merge-up.test.ts` (`vi.mock("../github.js")`) and
  `src/__tests__/github.test.ts` (`vi.stubGlobal("fetch", …)`).
- Trust boundary: none new — orchestrator→GitHub App (authenticated). `deleteBranch` only ever
  targets orchestrator-owned `ai-implement/feature/*` branches.
- Rollback path: mechanical, no flag; revert PR. Operator workaround until deployed: merge
  grouped top-of-tree PRs with `--delete-branch`.
- Observability: `[merge-up]` logs — "Top-of-tree PR #N … merged; deleted … + finalized";
  `[github] deleteBranch(...) failed`.
- Parallel-safety verified: within the tree, no peer edits these files concurrently
  (AII-187 uses a *separate* test file and is `Blocked by` this).

- [ ] **Step 1: Write failing helper tests** (`src/__tests__/github.test.ts`)

Append (the file already `vi.stubGlobal("fetch", …)`; add these `describe`s):

```ts
import { deleteBranch, findPullRequestByBranches } from "../github.js";

describe("deleteBranch", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("returns true on 204 (deleted)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 204, ok: true })));
    expect(await deleteBranch("t", "o", "r", "ai-implement/feature/aii-1")).toBe(true);
  });
  it("returns true on 404 (already gone — idempotent)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 404, ok: false, text: async () => "" })));
    expect(await deleteBranch("t", "o", "r", "ai-implement/feature/aii-1")).toBe(true);
  });
  it("returns false on other errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 403, ok: false, text: async () => "no" })));
    expect(await deleteBranch("t", "o", "r", "ai-implement/feature/aii-1")).toBe(false);
  });
});

describe("findPullRequestByBranches", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reports a merged PR", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => [{ number: 5, html_url: "u", state: "closed", merged_at: "2026-07-01T00:00:00Z" }],
    })));
    expect(await findPullRequestByBranches("t", "o", "r", "feat", "base"))
      .toEqual({ number: 5, url: "u", state: "closed", merged: true });
  });
  it("prefers a merged PR when several exist for the pair", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => [
        { number: 9, html_url: "u9", state: "open", merged_at: null },
        { number: 5, html_url: "u5", state: "closed", merged_at: "2026-07-01T00:00:00Z" },
      ],
    })));
    expect((await findPullRequestByBranches("t", "o", "r", "feat", "base"))?.number).toBe(5);
  });
  it("reports an open unmerged PR", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => [{ number: 7, html_url: "u", state: "open", merged_at: null }],
    })));
    expect(await findPullRequestByBranches("t", "o", "r", "feat", "base"))
      .toEqual({ number: 7, url: "u", state: "open", merged: false });
  });
  it("returns null when no PR exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] })));
    expect(await findPullRequestByBranches("t", "o", "r", "feat", "base")).toBeNull();
  });
  it("returns null on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    expect(await findPullRequestByBranches("t", "o", "r", "feat", "base")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/__tests__/github.test.ts`
  → FAIL (`deleteBranch`/`findPullRequestByBranches` not exported).

- [ ] **Step 3: Implement the helpers** (`src/github.ts`, after `findOpenPullRequest`)

```ts
/**
 * Deletes a git ref (branch). Idempotent: 204 (deleted) and 404 (already gone) both return
 * true. Only ever called on orchestrator-owned `ai-implement/feature/*` branches.
 */
export async function deleteBranch(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<boolean> {
  const enc = branch.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${enc}`,
    { method: "DELETE", headers: ghHeaders(token) },
  );
  if (res.status === 204 || res.status === 404) return true;
  const body = await res.text().catch(() => "");
  console.error(`[github] deleteBranch(${branch}) failed: HTTP ${res.status}: ${body}`);
  return false;
}

/**
 * Finds the PR for the given head→base pair in ANY state, reporting whether it merged.
 * GitHub's pulls list returns `merged_at` (null unless merged). Prefers a merged PR when
 * several exist for the pair (e.g. a prior buggy re-open). Returns null when none exists
 * or on a non-OK response (callers fall back to existing behavior).
 */
export async function findPullRequestByBranches(
  token: string,
  owner: string,
  repo: string,
  head: string,
  base: string,
): Promise<{ number: number; url: string; state: "open" | "closed"; merged: boolean } | null> {
  const url =
    `https://api.github.com/repos/${owner}/${repo}/pulls` +
    `?head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}` +
    `&state=all&sort=updated&direction=desc&per_page=10`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) return null;
  const prs = (await res.json()) as Array<{
    number: number; html_url: string; state: string; merged_at: string | null;
  }>;
  if (prs.length === 0) return null;
  const chosen = prs.find((p) => p.merged_at !== null) ?? prs[0];
  return {
    number: chosen.number,
    url: chosen.html_url,
    state: chosen.state === "open" ? "open" : "closed",
    merged: chosen.merged_at !== null,
  };
}
```

- [ ] **Step 4: Run helper tests** — `npx vitest run src/__tests__/github.test.ts` → PASS.

- [ ] **Step 5: Carry the parent UUID** (`src/providers/types.ts`, in `FeatureNodeRollUp`)

```ts
  /** The feature node's Linear issue UUID — used to finalize (markMerged) without a
   *  second lookup when its top-of-tree PR merges. */
  issueId: string;
```

And in `src/providers/linear.ts` `fetchFeatureNodeRollUps`: add `id` to the node selection
and set it. Change the query's `nodes { identifier …` to `nodes { id identifier …` (add `id`
to the typed shape too), then:

```ts
      rollUps.push({
        identifier: node.identifier,
        issueId: node.id,
        scopeKey: node.team.key,
        parentIdentifier: parentIsFeatureNode ? node.parent!.identifier : null,
      });
```

(Update the local generic type `nodes: Array<{ identifier: string; … }>` to include
`id: string;`.)

- [ ] **Step 6: Rework `merge-up.ts`** — add the dep + import, restructure `rollUpOne`

Imports (extend the existing `./github.js` import):

```ts
import { compareBranches, createPullRequest, deleteBranch, findPullRequestByBranches, mergeBranch } from "./github.js";
```

`MergeUpDeps`:

```ts
export interface MergeUpDeps {
  githubAppId: string;
  githubAppPrivateKey: string;
  resolveMapping: (scopeKey: string) => RepoMapping | null;
  /** Finalize a feature node whose top-of-tree PR merged: idempotently mark its issue Done
   *  (drops Ready for Review). Wired to the Linear provider's markMerged (AII-166). */
  finalizeMerged: (issueId: string) => Promise<void>;
}
```

Replace `rollUpOne`'s body from the `compareBranches` line onward with:

```ts
  const branch = buildFeatureBranchName(rollUp.identifier);
  const target = rollUp.parentIdentifier
    ? buildFeatureBranchName(rollUp.parentIdentifier)
    : mapping.defaultBranch;

  if (rollUp.parentIdentifier !== null) {
    // Internal roll-up → direct merge, no PR (ancestry-gated; unchanged).
    const ahead = await compareBranches(ghToken, owner, repo, target, branch);
    if (ahead === null || ahead === 0) return; // branch missing, or already fully merged
    const result = await mergeBranch(
      ghToken,
      owner,
      repo,
      target,
      branch,
      "[ai-implement] Automated feature-branch roll-up",
    );
    if (result === "conflict") {
      console.warn(
        `[merge-up] Conflict rolling up ${branch} → ${target} (${rollUp.identifier}) — needs a manual merge`,
      );
    } else if (result === "merged") {
      console.log(`[merge-up] Rolled up ${branch} → ${target} (${rollUp.identifier})`);
    }
    return;
  }

  // Top of the tree. Detect completion by the feature → base PR's MERGED state (robust to
  // squash/rebase/merge-commit — git ancestry alone misreads squash/rebase as "unmerged").
  const pr = await findPullRequestByBranches(ghToken, owner, repo, branch, target);
  if (pr?.merged) {
    await deleteBranch(ghToken, owner, repo, branch);
    await deps.finalizeMerged(rollUp.issueId);
    console.log(
      `[merge-up] Top-of-tree PR #${pr.number} for ${rollUp.identifier} merged; deleted ${branch} + finalized`,
    );
    return;
  }
  if (pr?.state === "open") return; // awaiting human review

  // No PR yet (or a closed-unmerged one) — open it only if the branch has commits to offer.
  const ahead = await compareBranches(ghToken, owner, repo, target, branch);
  if (ahead === null || ahead === 0) return;
  const created = await createPullRequest(ghToken, owner, repo, {
    head: branch,
    base: target,
    title: "[ai-implement] Feature branch ready for review",
    body:
      "Automated feature-branch grouping: this feature branch's work is complete and ready " +
      "to merge into the base branch. Opened for human review.",
  });
  console.log(`[merge-up] Opened feature→base PR ${created.url} for ${rollUp.identifier} (awaiting human merge)`);
```

(Remove the now-unused `findOpenPullRequest` import if the compiler flags it.)

- [ ] **Step 7: Wire `finalizeMerged` per-provider** (`src/index.ts`, ~`:255-273`)

Replace the flatten-then-single-`runMergeUps` block with a per-provider loop so
`finalizeMerged` binds to the provider that produced the roll-ups:

```ts
    if (providers.length > 0) {
      for (const provider of providers) {
        try {
          const rollUps = await provider
            .fetchFeatureNodeRollUps()
            .catch((err) => {
              console.error("[merge-up] Provider fetchFeatureNodeRollUps failed:", err);
              return [] as FeatureNodeRollUp[];
            });
          if (rollUps.length > 0) {
            await runMergeUps(rollUps, {
              githubAppId: config.githubAppId,
              githubAppPrivateKey: config.githubAppPrivateKey,
              resolveMapping: (scopeKey) => teamRepoMap[scopeKey] ?? null,
              finalizeMerged: (issueId) => provider.markMerged(issueId),
            });
          }
        } catch (err) {
          console.error("[merge-up] roll-up step failed:", err);
        }
      }
    }
```

- [ ] **Step 8: Merge-up behavior tests** (`src/__tests__/merge-up.test.ts`)

Extend the `vi.mock("../github.js")` factory with `deleteBranch` + `findPullRequestByBranches`,
add `finalizeMerged: vi.fn()` to the `deps` helper, and add:

```ts
// in vi.mock("../github.js") factory:
//   deleteBranch: vi.fn(async () => true),
//   findPullRequestByBranches: vi.fn(async () => null),
import { deleteBranch, findPullRequestByBranches } from "../github.js";

const depsF = (resolve: (k: string) => RepoMapping | null, finalizeMerged = vi.fn(async () => {})) => ({
  githubAppId: "1", githubAppPrivateKey: "k", resolveMapping: resolve, finalizeMerged,
});

describe("runMergeUps — top-of-tree merged-state completion", () => {
  const topRollUp = () => rollUp({ identifier: "OOL-106", issueId: "uuid-106", parentIdentifier: null });

  it("deletes the branch and finalizes when the top PR merged (squash/rebase/merge-commit)", async () => {
    vi.mocked(findPullRequestByBranches).mockResolvedValue({ number: 8, url: "u", state: "closed", merged: true });
    const finalizeMerged = vi.fn(async () => {});
    await runMergeUps([topRollUp()], depsF(() => mapping(), finalizeMerged));
    expect(vi.mocked(deleteBranch)).toHaveBeenCalledWith("tok", "jodwyer", "alpacaWheel", "ai-implement/feature/ool-106");
    expect(finalizeMerged).toHaveBeenCalledWith("uuid-106");
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
  });

  it("does nothing when the top PR is still open", async () => {
    vi.mocked(findPullRequestByBranches).mockResolvedValue({ number: 8, url: "u", state: "open", merged: false });
    await runMergeUps([topRollUp()], depsF(() => mapping()));
    expect(vi.mocked(deleteBranch)).not.toHaveBeenCalled();
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
  });

  it("opens the PR when none exists and the branch is ahead", async () => {
    vi.mocked(findPullRequestByBranches).mockResolvedValue(null);
    vi.mocked(compareBranches).mockResolvedValue(3);
    await runMergeUps([topRollUp()], depsF(() => mapping()));
    expect(vi.mocked(createPullRequest)).toHaveBeenCalled();
  });

  it("is idempotent: once the branch is gone, compareBranches null → no re-open", async () => {
    vi.mocked(findPullRequestByBranches).mockResolvedValue(null);
    vi.mocked(compareBranches).mockResolvedValue(null); // branch deleted
    await runMergeUps([topRollUp()], depsF(() => mapping()));
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
  });
});
```

(Add `deleteBranch`/`findPullRequestByBranches` resets to the existing `beforeEach`:
`vi.mocked(findPullRequestByBranches).mockResolvedValue(null); vi.mocked(deleteBranch).mockResolvedValue(true);`)

- [ ] **Step 9: Full suite + typecheck** — `npm run typecheck && npm test` → PASS.

- [ ] **Step 10: Commit**

```bash
git add src/github.ts src/merge-up.ts src/providers/types.ts src/providers/linear.ts src/index.ts src/__tests__/github.test.ts src/__tests__/merge-up.test.ts
git commit -m "fix(merge-up): finalize top-of-tree by PR merged-state, delete branch (AII-188)"
```

## Acceptance Criteria (AII-188)
- [ ] A merged top-of-tree `feature → base` PR (squash, rebase, **and** merge-commit) causes
      the branch to be deleted and `finalizeMerged` (markMerged) called — no new PR opened.
- [ ] An open top-of-tree PR is left untouched (awaiting human review).
- [ ] With no PR and the branch ahead, the PR is opened as before.
- [ ] Once the branch is deleted, subsequent polls do not re-open a PR.
- [ ] `npm test` + `tsc --noEmit` pass.

---

## Task 2 — AII-187: Automated multi-level roll-up tests

**Shape:** deep-and-targeted (test logic).
**Migration / backfill?** no

**Files:**
- Create: `src/__tests__/merge-up-multilevel.test.ts` (sibling to
  `src/__tests__/merge-up.test.ts` — same `vi.mock("../github.js")` harness)

**Parallel-safe with:** Task 3 (different files).
**Blocked by:** AII-188 (asserts the post-fix top-of-tree behavior; uses a *separate* test
file to avoid colliding with AII-188's edits to `merge-up.test.ts`).

**Rubric:**
- Pattern anchor: `src/__tests__/merge-up.test.ts` (copy its mock factory + `mapping`/`rollUp`
  helpers verbatim into the new file).
- Test fixture: same file.
- Trust boundary: none.
- Rollback path: test-only.
- Observability: n/a.
- Parallel-safety verified: new dedicated file; no shared edits.

- [ ] **Step 1: Create the multi-level test file** — copy the mock factory and helpers from
  `merge-up.test.ts`, then assert the multi-level contract:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runMergeUps } from "../merge-up.js";
import type { RepoMapping } from "../config.js";
import type { FeatureNodeRollUp } from "../providers/types.js";

vi.mock("../github-app-auth.js", () => ({ getInstallationToken: vi.fn(async () => "tok") }));
vi.mock("../github.js", () => ({
  compareBranches: vi.fn(async () => 2),
  createPullRequest: vi.fn(async () => ({ number: 7, url: "u" })),
  mergeBranch: vi.fn(async () => "merged"),
  deleteBranch: vi.fn(async () => true),
  findPullRequestByBranches: vi.fn(async () => null),
}));
import { compareBranches, createPullRequest, mergeBranch, findPullRequestByBranches } from "../github.js";

function mapping(o: Partial<RepoMapping> = {}): RepoMapping {
  return { owner: "jodwyer", repo: "alpacaWheel", workflowFile: "claude-implement.yml",
    defaultBranch: "testing", maxInProgressAiIssues: 3, executionMode: "github-actions",
    sessionMode: "autonomous", machineCpus: 2, machineMemoryMb: 4096, planningEnabled: false,
    planningWorkflowFile: "", autoApprovePlans: true, extraEnv: {}, provider: "anthropic",
    ticketingProvider: "linear", ticketingConfig: { kind: "linear" }, awsRegion: null, paused: false, ...o };
}
const deps = (finalizeMerged = vi.fn(async () => {})) => ({
  githubAppId: "1", githubAppPrivateKey: "k", resolveMapping: () => mapping(), finalizeMerged });
const node = (o: Partial<FeatureNodeRollUp>): FeatureNodeRollUp =>
  ({ identifier: "OOL-107", issueId: "u-107", scopeKey: "OOL", parentIdentifier: "OOL-106", ...o });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(compareBranches).mockResolvedValue(2);
  vi.mocked(findPullRequestByBranches).mockResolvedValue(null);
});

describe("multi-level roll-up (AII-187)", () => {
  it("internal roll-up uses a direct git merge, never a PR", async () => {
    await runMergeUps([node({ identifier: "OOL-107", parentIdentifier: "OOL-106" })], deps());
    expect(vi.mocked(mergeBranch)).toHaveBeenCalledWith(
      "tok", "jodwyer", "alpacaWheel",
      "ai-implement/feature/ool-106", "ai-implement/feature/ool-107", expect.any(String));
    expect(vi.mocked(createPullRequest)).not.toHaveBeenCalled();
  });

  it("the internal roll-up commit carries no issue identifier (no Linear false-Done link)", async () => {
    await runMergeUps([node({ identifier: "OOL-107", parentIdentifier: "OOL-106" })], deps());
    const msg = vi.mocked(mergeBranch).mock.calls[0][5];
    expect(msg).not.toMatch(/OOL-10[67]/);
  });

  it("does NOT finalize (markMerged) an internal node — only the top of the tree finalizes", async () => {
    const finalizeMerged = vi.fn(async () => {});
    await runMergeUps([node({ identifier: "OOL-107", parentIdentifier: "OOL-106" })], deps(finalizeMerged));
    expect(finalizeMerged).not.toHaveBeenCalled();
  });

  it("only the top-of-tree (parentIdentifier null) opens a feature→base PR", async () => {
    await runMergeUps([node({ identifier: "OOL-106", parentIdentifier: null })], deps());
    expect(vi.mocked(createPullRequest)).toHaveBeenCalledWith(
      "tok", "jodwyer", "alpacaWheel",
      expect.objectContaining({ base: "testing", head: "ai-implement/feature/ool-106" }));
  });

  it("a two-level tree in one pass: internal merges + top opens exactly one PR", async () => {
    await runMergeUps([
      node({ identifier: "OOL-107", parentIdentifier: "OOL-106" }), // internal
      node({ identifier: "OOL-106", parentIdentifier: null }),      // top
    ], deps());
    expect(vi.mocked(mergeBranch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createPullRequest)).toHaveBeenCalledTimes(1);
  });

  it("internal roll-up skips when the branch is already merged (0 ahead) — idempotent", async () => {
    vi.mocked(compareBranches).mockResolvedValue(0);
    await runMergeUps([node({ identifier: "OOL-107", parentIdentifier: "OOL-106" })], deps());
    expect(vi.mocked(mergeBranch)).not.toHaveBeenCalled();
  });

  it("surfaces an internal conflict without throwing", async () => {
    vi.mocked(mergeBranch).mockResolvedValue("conflict");
    await expect(runMergeUps([node({ identifier: "OOL-107", parentIdentifier: "OOL-106" })], deps()))
      .resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run src/__tests__/merge-up-multilevel.test.ts` → PASS
  (behavior already implemented by AII-188 + the pre-existing internal roll-up).

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/merge-up-multilevel.test.ts
git commit -m "test(merge-up): lock in multi-level roll-up + no-false-Done contract (AII-187)"
```

## Acceptance Criteria (AII-187)
- [ ] Internal roll-ups assert direct git merge (no PR) with an identifier-free commit message.
- [ ] Internal nodes are not finalized; only the top of the tree opens a PR / finalizes.
- [ ] Idempotency (0 ahead → skip) and the conflict path are covered.
- [ ] `npm test` + `tsc --noEmit` pass.

## Notes (AII-187)
The live-sandbox verification in the original AII-187 body (build a real 2+ level tree, run
the orchestrator) remains a **manual operator step** post-merge — it can't be a pipeline PR.
This child codifies the *automatable* part. The manual run is captured in Task 3's notes.

---

## Task 3 — AII-189 closing work: Docs for merged-state completion

**Shape:** wide-and-shallow (docs only).
**Migration / backfill?** no

**Files:**
- Modify: `docs/feature-branch-grouping.md` — §5 (Roll-up) and §6 (lifecycle step 6) to
  describe merged-state top-of-tree completion + branch deletion + finalize; §7 table row for
  `deleteBranch`/`findPullRequestByBranches`.

**Parallel-safe with:** Task 2 (different files).
**Blocked by:** AII-188 **and** AII-187 (parent closing work defers until both children are
terminal — feature-node grouping rule).

**Rubric:**
- Pattern anchor: `docs/feature-branch-grouping.md` existing §5/§6/§7 prose + table style.
- Test fixture: n/a (docs).
- Trust boundary: none.
- Rollback path: revert.
- Observability: n/a.
- Parallel-safety verified: only doc file; no overlap.

- [ ] **Step 1: Update §5 (Roll-up).** Replace the "top of the tree → open a PR … never
  auto-merged" bullet's completion description: the top-of-tree node completes when its
  `feature → base` PR **merges** (any method — squash/rebase/merge-commit), detected via the
  PR's merged state (`findPullRequestByBranches`), on which the orchestrator **deletes the
  feature branch** and idempotently marks the node Done (`markMerged`). Note this replaces the
  old git-ancestry heuristic that misread squash/rebase merges and re-opened the PR (AII-188).

- [ ] **Step 2: Update §6 step 6** to state that a human merge of the final PR — by any merge
  method — finalizes the tree (branch deleted, node stays Done, no re-open).

- [ ] **Step 3: Update the §7 table** — add `deleteBranch` / `findPullRequestByBranches`
  (`src/github.ts`) and note `merge-up.ts` now detects top-of-tree completion by PR merged
  state. Add an operational note: until the fix is deployed to the running orchestrator, merge
  grouped top-of-tree PRs with `--delete-branch`.

- [ ] **Step 4: Commit**

```bash
git add docs/feature-branch-grouping.md
git commit -m "docs: merged-state top-of-tree completion + branch deletion (AII-189)"
```

## Acceptance Criteria (AII-189 closing work)
- [ ] §5/§6/§7 describe merged-state completion, branch deletion, and markMerged finalize.
- [ ] The ancestry-heuristic description is removed/replaced.
- [ ] Operator workaround noted for the pre-deploy window.

---

## Self-Review Notes

- **Decision coverage:** design doc → Task 1 (detection/delete/finalize + helpers + UUID +
  wiring), Task 2 (multi-level verification), Task 3 (docs). Deferred no-integration follow-up
  is out of this tree (separate Backlog issue).
- **Naming consistency:** `findPullRequestByBranches`, `deleteBranch`, `finalizeMerged`,
  `FeatureNodeRollUp.issueId` used identically across Task 1 code + Task 1/2 tests.
- **Shape check:** Task 1 concentrates reasoning in `merge-up.ts` (deep) with mechanical
  plumbing; Task 2 is isolated test logic; Task 3 is docs. No task is wide-and-deep.
- **Parallel-safety:** AII-187 uses a *new* test file and is `Blocked by` AII-188; Task 3 is
  `Blocked by` both. No two concurrently-runnable tasks share a file.
- **External overlap (AII-152):** same files (`merge-up.ts`, `linear.ts`); no GitHub code yet.
  Coordinate before labelling the tree `AI-Implement`.
- **Bootstrapping wrinkle:** the AII-189 tree's own top-of-tree PR is merged by a human while
  the *running* orchestrator may not yet have this fix — merge it with `--delete-branch` until
  the fix deploys.
