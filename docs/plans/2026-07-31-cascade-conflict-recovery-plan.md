# Cascade Conflict Recovery Implementation Plan

> **For AI-Implement:** Each task below maps to a tracker issue (Phase 4). Steps use checkbox syntax. The pipeline picks up each issue independently — task descriptions are self-contained.

**Goal:** A DIRTY child PR in a grouping cascade gets an automated, agent-driven conflict resolution (capped, alerted), and a fail-open dispatch guard defers same-feature-node siblings whose declared files overlap.

**Architecture:** Detection lives where the failure is already observed — `auto-merge.ts`'s non-`merged` merge result — behind a named classification seam. Recovery rides the existing `comment_gapfill_queue` via synthetic (negative-ID) entries carrying a conflict-resolution instruction; the gap-fill run pushes to the PR branch and the next auto-merge tick completes. Prevention is a pure function in `poll-selection.ts` intersecting declared `Files:` paths across same-grouping-branch siblings.

**Tech Stack:** TypeScript (Node), better-sqlite3, Vitest.

**Tracker Container:** AII-264 as grouping parent (feature-node; children below).

## Global Constraints

- No new tables. Synthetic queue rows use `comment_id < 0` (real webhook IDs are positive); `comment_id` is globally `UNIQUE` so the synthetic key must hash owner/repo/pr/attempt.
- Attempt cap **2** per PR, counted from the queue (`comment_id < 0` rows for that owner/repo/pr).
- Never blind-merge. Cap exhaustion → `notify` + leave for human.
- Prevention is **fail-open**: unparseable/absent `Files:` section ⇒ no deferral.
- All existing tests stay green: `npm test`, `npm run typecheck`.
- Commenter for synthetic rows: `"ai-implement-orchestrator"` (internal marker; webhook permission checks don't apply — they run at enqueue time for real comments only).

---

### Task 1: Conflict detection + synthetic gap-fill recovery (auto-merge)

**Shape:** deep-and-targeted · **Migration/backfill?** no
**Files:** Modify `src/comment-gapfill-queue.ts`, `src/auto-merge.ts` · Test `src/__tests__/comment-gapfill-queue.test.ts`, `src/__tests__/auto-merge.test.ts`
**Parallel-safe with:** Task 2 (no shared files) · **Blocked by:** none
**Rubric:** anchor `src/auto-merge.ts` skip-paths + `enqueueCommentGapfill`; fixtures in both existing test files; trust boundary: internal-origin instruction (no user input); rollback: revert PR (pure addition); observability: log lines + notify on cap.

- [ ] **Step 1: Failing tests.** In `comment-gapfill-queue.test.ts`:

```ts
describe("conflict-resolution synthetic entries", () => {
  it("synthetic ids are negative, deterministic, distinct per attempt", () => {
    const a1 = syntheticConflictCommentId("o", "r", 42, 1);
    expect(a1).toBeLessThan(0);
    expect(a1).toBe(syntheticConflictCommentId("o", "r", 42, 1));
    expect(a1).not.toBe(syntheticConflictCommentId("o", "r", 42, 2));
    expect(a1).not.toBe(syntheticConflictCommentId("o", "x", 42, 1));
  });
  it("counts attempts and detects pending rows per PR", () => {
    enqueueConflictResolution({ owner: "o", repo: "r", prNumber: 7, featureBranch: "ai-implement/feature/p-1" });
    expect(countConflictAttempts("o", "r", 7)).toBe(1);
    expect(hasPendingConflictResolution("o", "r", 7)).toBe(true);
    // second enqueue while pending is ignored (same attempt key)
    enqueueConflictResolution({ owner: "o", repo: "r", prNumber: 7, featureBranch: "ai-implement/feature/p-1" });
    expect(countConflictAttempts("o", "r", 7)).toBe(1);
  });
});
```

In `auto-merge.test.ts` (mirror existing mocked-deps style): a grouping-branch PR whose `mergePullRequest` resolves `"not_mergeable"` → `enqueueConflictResolution` called once; with 2 prior attempts → not called, `notify` called with PR number; a pending resolution → not called.

- [ ] **Step 2: Run to verify FAIL** — `npm test -- comment-gapfill-queue auto-merge` → missing exports.

- [ ] **Step 3: Implement queue helpers** in `src/comment-gapfill-queue.ts`:

```ts
export const CONFLICT_COMMENTER = "ai-implement-orchestrator";

/** FNV-1a 32-bit; negated so synthetic ids never collide with real (positive) comment ids. */
export function syntheticConflictCommentId(owner: string, repo: string, prNumber: number, attempt: number): number {
  const s = `${owner}/${repo}#${prNumber}#conflict#${attempt}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return -(((h >>> 0) % 2_000_000_000) + 1);
}

export function countConflictAttempts(owner: string, repo: string, prNumber: number): number {
  const row = getDb().prepare(
    "SELECT COUNT(*) AS n FROM comment_gapfill_queue WHERE owner=? AND repo=? AND pr_number=? AND comment_id<0",
  ).get(owner, repo, prNumber) as { n: number };
  return row.n;
}

export function hasPendingConflictResolution(owner: string, repo: string, prNumber: number): boolean {
  const row = getDb().prepare(
    "SELECT 1 FROM comment_gapfill_queue WHERE owner=? AND repo=? AND pr_number=? AND comment_id<0 AND status IN ('pending','dispatched') LIMIT 1",
  ).get(owner, repo, prNumber);
  return !!row;
}

export function conflictResolutionInstruction(featureBranch: string): string {
  return [
    `This PR conflicts with its grouping branch \`${featureBranch}\` (sibling changes merged first).`,
    `Run \`git fetch origin && git merge origin/${featureBranch}\` on this PR branch, resolve every conflict`,
    `by keeping BOTH sides' intent (the sibling changes already on \`${featureBranch}\` AND this PR's changes),`,
    `re-run the repo's tests, and push the merge commit to this branch. Do not force-push, do not revert sibling work.`,
  ].join(" ");
}

export function enqueueConflictResolution(input: { owner: string; repo: string; prNumber: number; featureBranch: string }): number {
  const attempt = countConflictAttempts(input.owner, input.repo, input.prNumber) + 1;
  return enqueueCommentGapfill({
    owner: input.owner, repo: input.repo, prNumber: input.prNumber,
    commentId: syntheticConflictCommentId(input.owner, input.repo, input.prNumber, attempt),
    commenter: CONFLICT_COMMENTER,
    instruction: conflictResolutionInstruction(input.featureBranch),
  });
}
```

- [ ] **Step 4: Wire detection** in `src/auto-merge.ts` — replace the final `else` ("leaving for a human") with the seam:

```ts
export const MAX_CONFLICT_RESOLUTION_ATTEMPTS = 2;
export type StalledChildKind = "conflict" | "other";
/** Named seam: AII-263 will extend this classification (drafts/max_turns). */
export function classifyStalledChild(mergeResult: string): StalledChildKind {
  return mergeResult === "not_mergeable" || mergeResult === "conflict" ? "conflict" : "other";
}
```

…and in `autoMergeRepo`'s non-merged branch: `classifyStalledChild(result)`; on `"conflict"` — skip if `hasPendingConflictResolution` (log `[auto-merge] resolution in flight`); if `countConflictAttempts >= MAX_CONFLICT_RESOLUTION_ATTEMPTS` → `deps.notify?.("Cascade stalled: PR #… → … conflicts after N automated attempts — needs a human")` (log either way); else `enqueueConflictResolution({ owner, repo, prNumber: pr.number, featureBranch: pr.base })` + log `[auto-merge] enqueued conflict resolution (attempt N)`. Verify `mergePullRequest`'s actual non-merged return values in `src/github.ts` first and match `classifyStalledChild` to them (405/`not mergeable` → `"conflict"` classification).

- [ ] **Step 5: Run tests to PASS** — `npm test -- comment-gapfill-queue auto-merge`; then full `npm test` + `npm run typecheck`.
- [ ] **Step 6: Commit** — `feat: auto-recover DIRTY grouping-child PRs via synthetic conflict-resolution gap-fill (AII-264)`

---

### Task 2: Dispatch guard — declared-file overlap deferral (poll-selection)

**Shape:** deep-and-targeted · **Migration/backfill?** no
**Files:** Modify `src/poll-selection.ts`, `src/index.ts` (selection call site only) · Test `src/__tests__/poll-selection.test.ts`
**Parallel-safe with:** Task 1 · **Blocked by:** none
**Rubric:** anchor `selectBlockers` + its test file; trust boundary: parses issue text already trusted as spec; rollback: revert (fail-open, additive); observability: `reason: "file-overlap"` blocker rows appear in the existing blocker log/UI path.

- [ ] **Step 1: Failing tests** in `poll-selection.test.ts`:

```ts
describe("declared-file overlap deferral", () => {
  const chain = [{ identifier: "P-1", mode: "feature" as const }];
  const mk = (id: string, desc: string | null) => ({ ...baseIssue, id, identifier: id, description: desc, featureBranchChain: chain });
  it("parses Modify/Create/Test paths from a Files section", () => {
    expect(parseDeclaredFiles("## Task\n**Files:**\n- Modify: `src/a.ts`\n- Create: `src/b.ts:10-20`\n"))
      .toEqual(new Set(["src/a.ts", "src/b.ts"]));
  });
  it("defers a candidate whose declared files intersect an in-flight sibling's", () => {
    const inFlight = mk("C-1", "- Modify: `src/shared.ts`");
    const candidate = mk("C-2", "- Modify: `src/shared.ts`\n- Create: `src/other.ts`");
    const d = selectFileOverlapDeferrals([candidate], [inFlight]);
    expect(d).toHaveLength(1);
    expect(d[0].reason).toBe("file-overlap");
  });
  it("fail-open: no parsable files, different grouping branch, or no in-flight sibling → no deferral", () => {
    expect(selectFileOverlapDeferrals([mk("C-3", "prose only")], [mk("C-1", "- Modify: `src/shared.ts`")])).toHaveLength(0);
    expect(selectFileOverlapDeferrals([mk("C-4", "- Modify: `src/shared.ts`")], [])).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to FAIL** — `npm test -- poll-selection` → missing exports.
- [ ] **Step 3: Implement** in `src/poll-selection.ts`:

```ts
const FILE_LINE_RE = /^\s*[-*]\s*(?:Create|Modify|Test|Delete):\s*`([^`\s:]+)/gim;
/** Declared file paths from an issue body's Files section. Empty set = unparseable (fail-open). */
export function parseDeclaredFiles(description: string | null): Set<string> {
  const out = new Set<string>();
  if (!description) return out;
  for (const m of description.matchAll(FILE_LINE_RE)) out.add(m[1]);
  return out;
}
const groupingBranchOf = (i: TicketIssue) =>
  i.featureBranchChain?.length ? i.featureBranchChain[i.featureBranchChain.length - 1] : null;

/** Fail-open guard: defer candidates whose declared files intersect an IN-FLIGHT sibling's
 *  (same last grouping-branch entry). Candidates with no declared files never defer. */
export function selectFileOverlapDeferrals(candidates: TicketIssue[], inFlightSiblings: TicketIssue[]): Blocker[] {
  const blockers: Blocker[] = [];
  for (const c of candidates) {
    const branch = groupingBranchOf(c);
    if (!branch) continue;
    const mine = parseDeclaredFiles(c.description);
    if (mine.size === 0) continue;
    for (const s of inFlightSiblings) {
      const sb = groupingBranchOf(s);
      if (!sb || sb.identifier !== branch.identifier || sb.mode !== branch.mode) continue;
      const theirs = parseDeclaredFiles(s.description);
      const shared = [...mine].filter((f) => theirs.has(f));
      if (shared.length) {
        blockers.push({ issueId: c.id, issueIdentifier: c.identifier, issueTitle: c.title, teamKey: c.scopeKey,
          reason: "file-overlap", detail: `Declared files overlap in-flight sibling ${s.identifier}: ${shared.slice(0, 5).join(", ")}. Deferred until it merges.` });
        break;
      }
    }
  }
  return blockers;
}
```

Extend `Blocker["reason"]` union with `"file-overlap"`. In `src/index.ts`, at the selection call site, compute `inFlightSiblings` = fetched issues whose id is in the in-flight set, call `selectFileOverlapDeferrals(readyCandidates, inFlightSiblings)`, and treat returned rows exactly like other blockers (skip dispatch + surface in the blocker report).

- [ ] **Step 4: PASS** — `npm test -- poll-selection`; full suite + typecheck.
- [ ] **Step 5: Commit** — `feat: defer same-feature-node siblings with overlapping declared files (AII-264 prevention)`

---

### Task 3: Docs — CLAUDE.md + seam note

**Shape:** wide-and-shallow (2 files, mechanical) · **Migration/backfill?** no
**Files:** Modify `CLAUDE.md`, `docs/feature-branch-grouping.md` · **Blocked by:** Task 1, Task 2 (documents shipped behavior; also avoids CLAUDE.md conflicts)
**Rubric:** anchor: CLAUDE.md's existing auto-merge/grouping sections; rollback trivial; no tests (docs).

- [ ] **Step 1:** CLAUDE.md: under the feature-branch-grouping section add ~6 lines: conflict auto-recovery (detect in auto-merge → synthetic gap-fill entry → cap 2 → notify), and the declared-file dispatch guard (fail-open). `docs/feature-branch-grouping.md`: a "Conflict recovery & prevention" subsection with the same content + the `classifyStalledChild` seam note for AII-263.
- [ ] **Step 2:** `npm run typecheck` (no-op guard) — commit `docs: cascade conflict recovery + dispatch guard (AII-264)`.

---

## Self-Review

1. **Decision coverage:** detection seam→T1 S4; gapfill rail+key+cap+notify→T1 S3/S4; prevention fail-open→T2; docs→T3; BDS-side audit→Phase 4 reconciliation (not a code task). ✓
2. **Placeholders:** none — real code for keys/count/instruction/regex/guard; T1 S4 names the one verify-then-match point (`mergePullRequest` return values) explicitly as a step instruction. ✓
3. **Name consistency:** `syntheticConflictCommentId` / `countConflictAttempts` / `hasPendingConflictResolution` / `enqueueConflictResolution` / `classifyStalledChild` / `selectFileOverlapDeferrals` / `parseDeclaredFiles` / reason `"file-overlap"` used identically throughout. ✓
4. **Parallelization:** T1 files (auto-merge.ts, comment-gapfill-queue.ts + their tests) vs T2 files (poll-selection.ts, index.ts + test) — disjoint. T3 blocked by both. ✓
