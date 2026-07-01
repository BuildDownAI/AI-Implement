# Feature-node top-of-tree completion — Design Decisions

> Bug fix for AII-188 (re-open of the top-of-tree PR after a human/squash merge),
> grouped with AII-187 (multi-level roll-up verification) under one feature node.

## Objective

Make top-of-tree feature-node completion robust to **human merges via any merge
method** (squash, rebase, merge-commit). Today the grouping decides "merged" by git
ancestry (`compareBranches`), which a squash/rebase breaks, so the orchestrator
re-opens an identical `feature → base` PR every poll and Linear flips the parent issue
back to In Progress. Fix: detect completion via the **PR's merged state**, delete the
feature branch, and reuse AII-166's `markMerged` to idempotently finalize the parent.

## Scope

**In v1:**
- Detect the top-of-tree `feature → base` PR's **merged** state (not ancestry), covering
  squash, rebase, and merge-commit.
- On detection: **delete the feature branch** and **`markMerged(parentIssueId)`** (AII-166
  verb — idempotent no-op if already Done), so the PR is never re-opened and the parent
  stays Done.
- Multi-level verification (AII-187): lock in that the internal roll-up (direct-merge,
  no-PR) mitigation holds and that top-of-tree completion works at the top of a ≥2-level
  tree.
- Docs: update `docs/feature-branch-grouping.md` §5/§6 to describe merged-state completion.

**Deferred (explicit follow-up, NOT in this build-up):**
- **True no-native-integration self-finalize.** Because `fetchFeatureNodeRollUps` only
  returns nodes already in `completed` state, our detection point only fires when Linear's
  GitHub integration already marked the parent Done. Repos *without* that integration never
  enter the roll-up set, so the grouping can't self-complete the top of the tree there. Truly
  covering that needs detection independent of the completed-state (persist the top PR +
  poll its merged state, à la AII-166's `detectMergedPrs`). Filed as a separate issue; the
  repos that actually hit AII-188 all have native integration.

**Out of scope:**
- Internal roll-up mechanics (direct merge, no PR) — unchanged; only *verified* (AII-187).
- Jira grouping (Linear-only feature).
- AII-152's broader grouping work (Cameron, In Progress) — coordinate, don't absorb.

## Decisions

- **Detection mechanism:** In `merge-up.ts` `rollUpOne`, top-of-tree path, replace the
  ancestry-only gate with a **PR lookup by (head, base) across all states**. New/generalized
  GitHub helper returns `{ number, state, merged }`. Branch by result:
  - **merged** → `deleteBranch(feature)` + `finalizeMerged(parentIssueId)` (→ `markMerged`),
    then return. Fixes all three merge methods.
  - **open** → return (awaiting human review).
  - **none / closed-unmerged** → if `compareBranches` ahead > 0, `createPullRequest`
    (unchanged behavior).
- **Reuse AII-166:** `finalizeMerged` is wired in `index.ts` to the Linear provider's
  `markMerged(issueId)` — idempotent (no-op on completed/canceled), drops `Ready for Review`.
  No new "move to Done" logic.
- **Carry the UUID:** `FeatureNodeRollUp` gains `issueId` (the Linear UUID) so `markMerged`
  can be called without a second lookup. `fetchFeatureNodeRollUps` selects `id`.
- **New GitHub helpers:** `deleteBranch(token, owner, repo, branch)` (DELETE ref; **404 =
  already gone = success**, idempotent) and a merged-aware PR finder
  (`findPullRequestByBranches`, or generalize `findOpenPullRequest` to `state=all`).
- **Ordering:** detection runs inside the existing merge-up step (already runs each poll
  before dispatch), so no new poll wiring. Branch deletion makes it durably idempotent:
  once deleted, `compareBranches` returns null and the node is skipped forever.
- **Grouping structure (dogfood):** a new **parent feature node** owns
  `ai-implement/feature/<parent-key>`; **AII-188** (the fix) and **AII-187** (verification)
  are its labelled children. Parent's own closing work = the docs update, `Blocked by` both
  children. Running this tree through the pipeline exercises the fixed top-of-tree path.

- **Trust boundaries:** none new. All calls are orchestrator→GitHub App (already
  authenticated) and orchestrator→Linear (already authenticated). `deleteBranch` only ever
  targets an `ai-implement/feature/*` branch the orchestrator owns.
- **Failure modes:**
  - PR finder returns null / API error → fall through to existing behavior (fail-open, as
    grouping already does).
  - `deleteBranch` 404 → treat as success (branch already gone).
  - `deleteBranch` other error → log, do **not** re-open (avoid the bug); markMerged still
    runs. Next poll retries deletion.
  - `markMerged` throws (e.g. no completed state) → logged, per-rollup soft-fail; branch
    already deleted so no re-open.
- **Rollout:** pure code; no migration/flag. Takes effect when the testing orchestrator
  redeploys off `testing`. Operator workaround until deployed (from the issue): merge grouped
  top-of-tree PRs with `--delete-branch` or a real merge commit.
- **Testing:** unit tests via the existing `vi.mock("../github.js")` seam in
  `merge-up.test.ts`: merged→delete+markMerged (squash/rebase/merge-commit), open→no-op,
  unmerged→create, deleteBranch-404 tolerance, idempotent second poll. AII-187 adds
  multi-level assertions.
- **Observability:** existing `[merge-up]` console logs; add explicit lines for
  "detected merged top PR → deleted branch + finalized" and "deleteBranch failed".

## Overlap & Reconciliation

- **AII-166** "Mark issue done on PR merge" — **Dependency (shipped, merged to `testing`
  via PR #89).** Action: **reuse** `markMerged` + the merged-state checking style. Already
  merged into this branch. No duplication.
- **AII-152** "Feature-branch support + auto-merge" (Cameron, In Progress) — **Adjacent.**
  GitHub scan (2026-07-01): **no open PR/branch touches `merge-up.ts` or grouping yet**, so
  no immediate collision. Action: **flag for coordination** — John to sync with Cameron
  before the tree is labelled `AI-Implement`; sequence AII-188 vs AII-152 to avoid a
  `merge-up.ts` / `linear.ts` conflict. Not blocked in the tracker pending that conversation.
- **AII-187** "Verify merge-up false-Done holds for multi-level trees" — **Adjacent →
  absorbed as a sibling child.** Action: reparent under the new feature node alongside
  AII-188; do both in one feature branch (per operator decision).
- **AII-134** "Auto-Merge into feature branches" — **Stale / superseded** by the shipped
  grouping + AII-152. Action: **ignore** for this build-up (not this bug's job; not touched).

## Open Questions

- **Parent-node own work:** default = the docs update is the parent's closing work
  (`Blocked by` both children). If preferred, the docs can instead ride on the AII-188 child
  and the parent carries no own work (pure container). Default: docs = parent closing work.
- **AII-188 code split:** default = one deep-and-targeted child issue (helpers + merge-up
  detection + tests are tightly coupled and small). Alternative: split helpers (github.ts)
  from the merge-up consumer. Default: single issue.
- **Deferred no-integration follow-up:** file now (Backlog) or hold? Default: file a Backlog
  issue so it isn't lost.
