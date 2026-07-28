# Sync PR Branch Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every "Sync workflows" re-sync force-reset the canonical sync branch to the current base, so the reused sync PR always shows a clean diff (base + current templates) instead of layering onto stale state.

**Architecture:** One function changes — `ensureSyncBranch` in `src/workflow-sync.ts`. When the sync branch already exists, it is force-reset to the current base SHA (dropping the `ahead_by === 0` guard that today leaves an ahead-of-base branch untouched). The branch-missing path (create from base) is unchanged. Downstream template application and PR reuse are unchanged.

**Tech Stack:** TypeScript, Vitest. The sync flow talks to the GitHub REST API; tests use an in-memory fake `fetch`.

---

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/workflow-sync.ts` | Orchestrator-side workflow template sync (branch + PR management) | `ensureSyncBranch`: always force-reset an existing sync branch to base; remove the `compare`/`ahead_by` check |
| `src/__tests__/workflow-sync.test.ts` | Sync flow unit tests (in-memory GitHub fake) | Replace the "preserves ahead branch" test with a "resets stale ahead branch" test |

---

## Task 1: Force-reset the sync branch to base on every sync

**Files:**
- Modify: `src/workflow-sync.ts` (`ensureSyncBranch`, currently lines ~227-258)
- Test: `src/__tests__/workflow-sync.test.ts`

### Context for the implementer

`ensureSyncBranch` runs at the start of `syncWorkflowTemplates`. Today:
- If the sync branch is missing → it's created from base.
- If it exists and is exactly even with base (`ahead_by === 0`) → it's force-reset to base.
- If it exists and is **ahead** of base → it's **left untouched** (this is the bug: stale state from a prior sync PR persists and new template writes layer on top).

The test harness in `workflow-sync.test.ts` models branches as `{ sha, aheadBy, files }`. Its fake `fetch`:
- `POST /git/refs` creates a branch.
- `PATCH /git/refs/heads/<branch>` resets the branch: sets its `files` to a copy of `branches.main.files` and `aheadBy` to 0.
- `GET /compare/base...head` returns `branches[head].aheadBy`.
- `PUT /contents/<path>` writes a file to the branch.
- `makeGithubFetch({ syncFiles })` pre-creates `branches["sync/ai-implement"]`; `syncAheadBy` sets its `aheadBy`; `existingPr` seeds an open PR.

Base (`main`) files default to `{}` (empty), so a reset clears any non-base files.

- [ ] **Step 1: Replace the obsolete test with the new behavior test**

In `src/__tests__/workflow-sync.test.ts`, find this existing test and DELETE it entirely:

```typescript
  it("preserves an existing sync branch that is ahead of base", async () => {
    const templatesRoot = makeTemplatesRoot();
    const fake = makeGithubFetch({
      syncFiles: {
        "operator-note.txt": "keep me\n",
      },
      syncAheadBy: 2,
    });

    await syncWorkflowTemplates({
      mapping,
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    });

    expect(fake.branches["sync/ai-implement"].files["operator-note.txt"]).toBe("keep me\n");
    expect(fake.calls.some((call) => call.method === "PATCH" && call.path.includes("/git/refs/heads/"))).toBe(false);
  });
```

In its place, add this test:

```typescript
  it("force-resets a stale sync branch that is ahead of base to produce a clean diff", async () => {
    const templatesRoot = makeTemplatesRoot();
    const fake = makeGithubFetch({
      syncFiles: {
        ".github/workflows/claude-implement.yml": "OLD-implement\n",
        "stale-leftover.txt": "stale\n",
      },
      syncAheadBy: 2,
      existingPr: {
        number: 55,
        html_url: "https://github.com/acme/app/pull/55",
        head: "sync/ai-implement",
        base: { ref: "main" },
      },
    });

    const result = await syncWorkflowTemplates({
      mapping,
      githubAppId: "app-id",
      githubAppPrivateKey: "private-key",
      templatesRoot,
      fetchImpl: fake.fetchImpl,
      getInstallationTokenImpl: async () => "token",
    });

    // The existing open PR is reused, not duplicated.
    expect(result.status).toBe("pr-updated");
    expect(result.prNumber).toBe(55);
    expect(fake.pulls).toHaveLength(1);

    // The branch was force-reset to the current base before templates were applied.
    expect(
      fake.calls.some(
        (call) =>
          call.method === "PATCH" &&
          call.path.includes("/git/refs/heads/") &&
          (call.body as { sha?: string; force?: boolean }).sha === "base-sha" &&
          (call.body as { sha?: string; force?: boolean }).force === true,
      ),
    ).toBe(true);

    // Stale non-template leftover is gone; current template content is present.
    expect(fake.branches["sync/ai-implement"].files["stale-leftover.txt"]).toBeUndefined();
    expect(fake.branches["sync/ai-implement"].files[".github/workflows/claude-implement.yml"]).toBe("implement-yml\n");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- workflow-sync`
Expected: the new `force-resets a stale sync branch...` test FAILS — with the current code the branch is left untouched (`ahead_by` is 2), so `stale-leftover.txt` is still present and no force-reset PATCH occurs. (All other workflow-sync tests should still pass.)

- [ ] **Step 3: Implement the change in `src/workflow-sync.ts`**

Replace the entire body of `ensureSyncBranch` with the version below. The only change from the current code is that the trailing `compare`/`ahead_by` block is replaced by an unconditional force-reset of the existing branch:

```typescript
async function ensureSyncBranch(params: {
  gh: GitHubClient;
  repo: string;
  baseBranch: string;
  syncBranch: string;
}): Promise<void> {
  const { gh, repo, baseBranch, syncBranch } = params;
  const base = await gh.request<{ object: { sha: string } }>(
    `/repos/${repo}/git/ref/heads/${encodeRefPath(baseBranch)}`,
  );
  const syncRef = await gh.maybeRequest<{ object: { sha: string } }>(
    `/repos/${repo}/git/ref/heads/${encodeRefPath(syncBranch)}`,
  );

  if (!syncRef) {
    await gh.request(`/repos/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${syncBranch}`, sha: base.object.sha }),
    });
    return;
  }

  // The sync branch is orchestrator-owned and disposable: always force-reset it to the
  // current base so each re-sync produces a clean diff (base + freshly regenerated
  // templates) and never layers onto stale state from a prior sync PR — whether that
  // branch is ahead of, behind, or lingering after a merge.
  await gh.request(`/repos/${repo}/git/refs/heads/${encodeRefPath(syncBranch)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: base.object.sha, force: true }),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- workflow-sync`
Expected: PASS — all workflow-sync tests, including the new `force-resets a stale sync branch...` test, and the unchanged ones (`returns up-to-date...`, `updates an existing sync PR when files change`, `returns pr-existing...`, the `pr/sync/ai-implement` prefix tests).

- [ ] **Step 5: Commit**

```bash
git add src/workflow-sync.ts src/__tests__/workflow-sync.test.ts
git commit -m "fix(sync): force-reset the sync branch to base on every re-sync"
```

---

## Task 2: Full verification

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests pass (0 failures).

---

## Delivery note

This change is on the `feat/pr-branch-prefix` branch and targets `testing` as its PR base. Unless told otherwise, it folds into the open PR #79 (which already modifies `src/workflow-sync.ts`).
