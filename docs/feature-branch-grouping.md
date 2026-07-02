# Feature-branch grouping for parent/child issues

How the `AI-Implement` label drives parent/child issue trees onto a cascade of feature
branches, how each issue is classified and dispatched, and how completed feature branches
roll back up.

This is the operator/developer reference. The decision history lives in
`docs/plans/2026-05-30-001-feat-feature-branches-parent-child-issues-plan.md`.

---

## 1. Mental model

A Linear issue tree maps onto a tree of git branches:

- A **parent issue** that carries the `AI-Implement` label *and* has **two or more**
  `AI-Implement` children becomes a **grouping node**. It owns a shared branch named from
  its children: `ai-implement/multi-issue/<sorted child slugs>`. The grouping node carries
  **no implementation work of its own** and is never dispatched.
- A parent with **exactly one** `AI-Implement` child is **not** a grouping node — that lone
  child PRs directly to the repo base branch (or the nearest grouping ancestor) as if the
  parent didn't exist.
- The **labelled children** open PRs **into the shared grouping branch**, not into the
  repo's base branch.
- Unlabelled children are ignored until they too get the `AI-Implement` label — so you can
  roll a tree out incrementally.
- The tree is **recursive**: a child that is itself a grouping node gets its own shared
  branch cut from its parent's branch, and so on.
- When **all** AI-Implement children reach a terminal state (completed or cancelled), the
  grouping branch **rolls up** automatically. Internal levels roll up via a direct merge;
  the single top-of-tree roll-up is offered as a human-reviewed `multi-issue → base` PR.

```
testing                                           (repo base branch)
└─ ai-implement/multi-issue/aii-100-aii-101       grouping node AII-99
   ├─ ai-implement/multi-issue/aii-103-aii-104    grouping node AII-100
   │   ├─ PR: AII-103 (leaf) ──────────────────► multi-issue/aii-103-aii-104
   │   └─ PR: AII-104 (leaf) ──────────────────► multi-issue/aii-103-aii-104
   └─ PR: AII-101 (leaf) ──────────────────────► multi-issue/aii-100-aii-101
```

---

## 2. The labels

| Label | Meaning | Who sets it |
|-------|---------|-------------|
| `AI-Implement` | **Trigger.** The orchestrator only sees issues with this label (and a non-terminal state). | Human |
| `AI-Planning` | Planning in flight. Counts against the team's in-progress capacity; the issue is skipped while present. | Orchestrator on planning dispatch |
| `Plan-Complete` | Planning finished and approved → the issue is ready for implementation. | Orchestrator via the **runner callback** (`runner-callback.ts` → `markPlanComplete`) |
| `AI-Working` | Implementation in flight. Counts against capacity; the issue is skipped while present. | Orchestrator on implementation dispatch |
| `Ready for Review` | An implementation PR is open. The issue is skipped (waiting on the human to merge). | Orchestrator when the PR is detected |

When a PR merges, the orchestrator moves the issue to **Done** via `markMerged` — driven by
a poll detector (guaranteed, runs every tick) and optionally accelerated by a webhook delivery
(optimization, reduces latency). This complements any native Linear/Jira GitHub integration.
"Done" is what unblocks the next step.

---

## 3. Classification (what each issue becomes)

Every poll, the Linear provider fetches all `AI-Implement`, non-terminal issues together
with each issue's direct children (labels + state) and its labelled-ancestor chain, then
classifies each one (`src/providers/linear.ts`, `fetchAIImplementSnapshot`):

| Condition | Class | Action |
|-----------|-------|--------|
| `AI-Working` or `AI-Planning` present | in-progress | counted for capacity, skipped |
| `Ready for Review` present | in review | skipped |
| blocked by an open "blocks" relation | blocked | skipped |
| **no children** | **leaf** | dispatched; PR targets the nearest grouping-node ancestor branch (or base) |
| **exactly 1 `AI-Implement` child** | **single-child parent** | skipped — not a grouping node; the lone child PRs to base as a leaf |
| **≥2 `AI-Implement` children, not all terminal** | **grouping node (waiting)** | skipped — its branch is cut lazily when the first child dispatches |
| **≥2 `AI-Implement` children, all terminal** | **grouping node (roll-up ready)** | roll-up fires; grouping node is NOT dispatched |
| **has children but none `AI-Implement` yet** | **waiting parent** | skipped — race guard (see below) |

### The ≥2 gate

Two or more AI-Implement children are required to form a grouping node. A parent with
exactly one AI-Implement child is treated the same as a non-parent: the orchestrator skips
it and the lone child dispatches as a leaf toward the base branch. Only at ≥2 children does
the parent become a passive grouping container.

### The race guard

If you label a parent **before** its children, the parent has children but none carry
`AI-Implement` yet. It is **not** treated as a leaf and implemented — it's left alone until
a child gets labelled. This is what lets you label a whole tree at once (or top-down)
without the parent being worked prematurely. Log line:
`Skipping <key>: parent labeled but no child has AI-Implement set yet`.

---

## 4. Branch naming and the cascade

- Branch name: `ai-implement/multi-issue/<sorted child slugs>` (`buildMultiIssueBranchName`
  in `src/pipeline/branch-name.ts`). Each child identifier is slugified (lowercased;
  non-alphanumeric runs replaced by hyphens), the slugs are sorted, and the first three are
  joined with hyphens. When there are more than three children, a `-plus{N}` suffix records
  the count of omitted children. Examples:
  - 2 children AII-101 and AII-102 → `ai-implement/multi-issue/aii-101-aii-102`
  - 5 children AII-101 through AII-105 → `ai-implement/multi-issue/aii-101-aii-102-aii-103-plus2`
- The parent's own key is **excluded** from the branch name by design. The name is a stable
  label; the grouping truth lives in the Linear hierarchy. Nothing parses the name back into
  a set of issues.
- The provider attaches an ordered `featureBranchChain` (base-most first) carrying **branch
  name strings** to each dispatchable issue (`TicketIssue.featureBranchChain` in
  `src/providers/types.ts`). Only grouping ancestors with ≥2 AI children appear in the
  chain; single-AI-child ancestors are dropped so the lone child reaches the base.
- At dispatch time, `resolveBaseBranch` (`src/feature-branch.ts`) walks the chain and
  **creates each branch that doesn't exist, cut from the previous one** (or from the repo
  base for the first), returning the branch the PR should target. Branch creation is
  idempotent and **fails open**: any GitHub error falls back to the base branch, so a
  grouping failure never blocks the work.

This resolution is the same in all execution modes — the resolved branch is passed to the
runner as the `base_branch` workflow input (GitHub Actions) or as the runner's default
branch (Fly machines / local Docker). The target repo's `claude-implement.yml` must accept
the `base_branch` input, so **re-sync workflows to the target repo before relying on
grouping**.

---

## 5. Roll-up (the merge-up)

When **all** of a grouping node's AI-Implement children reach a terminal state (completed
or cancelled), `fetchFeatureNodeRollUps` surfaces the node and the roll-up fires
(`src/merge-up.ts`, run each poll **before** dispatch). The grouping node itself is **never
dispatched** — it has no implementation work and does not need a runner callback to advance.

- **Internal level** (the parent is itself a grouping node) → a **direct git merge**
  (`POST /merges`, `mergeBranch` in `src/github.ts`), **not** a pull request, with a commit
  message that carries no issue identifier. *Why no PR:* a roll-up PR's base branch name
  and title would encode the parent's key, giving Linear's GitHub integration a signal to
  mark the parent Done before the tree is finalized. A plain merge commit gives Linear
  nothing to link.
- **Top of the tree** (no grouping-node parent) → an open `multi-issue → base` **PR for
  human review**, never auto-merged.

The step is **idempotent** and **fails soft** per roll-up — one failure never aborts the
others or the poll loop.

Idempotency is handled differently per path:
- **Internal level:** `compareBranches` returning 0 (branch already merged into parent) or
  `null` (branch missing) causes an early return.
- **Top of the tree:** `findPullRequestByBranches` is checked first. If the
  `multi-issue → base` PR is **merged** — by any method (merge-commit, squash, or rebase)
  — the orchestrator deletes the grouping branch (`deleteBranch`) and calls `markMerged` to
  finalize the grouping node in the tracker. **This path self-finalizes without requiring
  native Linear/GitHub integration** — the PR merged-state check is the only signal needed.
  If the PR is still open, the step returns and awaits the human. Only when no PR exists is
  a new one opened (guarded by an ahead-check so a missing branch exits early).

---

## 6. End-to-end lifecycle of one tree

1. Label the tree `AI-Implement` (whole tree at once is fine — the gates sequence it).
2. Leaves with no blockers dispatch: **plan → (auto-approve) → implement → PR** into their
   parent's grouping branch. The cascade branches are created on the first leaf dispatch.
3. A human merges each leaf PR → the orchestrator marks the leaf **Done** (via poll
   detector + webhook) → any blocked sibling unblocks and runs.
4. When all of a grouping node's AI-Implement children are Done (or cancelled), the
   **roll-up** fires automatically: the shared grouping branch merges into its parent's
   branch (internal levels) or is offered as a `multi-issue → base` PR (top of tree).
5. A human reviews and merges that final PR **by any merge method** (merge-commit, squash,
   or rebase). On the next poll tick the orchestrator detects the merged PR state, deletes
   the grouping branch, and calls `markMerged` to finalize the top grouping node Done.

---

## 7. Where each part lives

| Concern | File |
|---------|------|
| Label query, classification, roll-up discovery | `src/providers/linear.ts` (`fetchAIImplementSnapshot`, `fetchFeatureNodeRollUps`) |
| Shared types (`featureBranchChain` carries branch name strings; `FeatureNodeRollUp`) | `src/providers/types.ts` |
| Branch names | `src/pipeline/branch-name.ts` (`buildMultiIssueBranchName`); `fetchFeatureNodeRollUps` surfaces grouping nodes on children-all-terminal |
| Cascade branch creation + PR-base resolution | `src/feature-branch.ts` (`resolveBaseBranch`) |
| Roll-up (direct merge / human PR) | `src/merge-up.ts` (`runMergeUps`) |
| GitHub helpers (branch/compare/merge/PR/merged-state) | `src/github.ts` (`ensureBranchExists`, `compareBranches`, `mergeBranch`, `createPullRequest`, `findOpenPullRequest`, `findPullRequestByBranches`, `deleteBranch`) — `findPullRequestByBranches` detects the top-of-tree PR's merged state (robust to any merge method); `deleteBranch` removes the grouping branch after merge |
| Plan-Complete transition | `src/runner-callback.ts` → `markPlanComplete` |
| Poll-loop wiring (roll-up before dispatch; base resolved per issue) | `src/index.ts` |

Feature-branch grouping is **Linear-only**. The Jira provider returns an empty roll-up list
and no `featureBranchChain`, so its issues always PR to the base branch.

---

## 8. Operational notes

- **Re-sync workflows** to the target repo so `claude-implement.yml` accepts the
  `base_branch` input; otherwise GitHub 422s the grouped dispatch (the orchestrator only
  sends `base_branch` when grouping moved it off the default, so un-synced repos keep
  working for the non-grouped path).
- **Runner callback must be public** for planning to auto-advance and thus for the cascade
  to self-drive. On a local (`localhost`) orchestrator the callback can't be reached, so
  `Plan-Complete` must be set by hand to test the implementation/grouping path.
- **Pair the runner image with the orchestrator.** A testing orchestrator should set
  `SESSION_IMAGE=ghcr.io/builddownai/ai-implement-runner:next`; otherwise a GitHub Actions
  run falls back to the `:latest` runner, which may be incompatible with the current
  workflow/entrypoint.
- **Top-of-tree PR merge method:** any method (merge-commit, squash, rebase) works
  correctly — the orchestrator detects completion via the PR's merged state, not git
  ancestry.
- **Child-set mutation hazard:** the grouping branch name is derived from the child set at
  the time the branch is first created. If a child is added to or removed from a grouping
  node while the branch is in flight, `buildMultiIssueBranchName` will compute a different
  name for the current child set, and the orchestrator will create a second branch —
  orphaning the first. **Drain all in-flight `ai-implement/multi-issue/*` groups before
  mutating their child sets.**
- **Migration from old `ai-implement/feature/*` branches:** teams upgrading from the
  pre-AII-152 model (where grouping branches used `ai-implement/feature/<parent-key>`)
  should drain any in-flight `ai-implement/feature/*` groups before deploying. After
  deploy, new groups use the `ai-implement/multi-issue/…` form; the old form will no longer
  be created.
- **Don't restart the orchestrator mid-run.** A restart drops in-flight job tracking,
  leaving dispatched issues stuck with `AI-Working` plus a dedup row. Recover by removing
  `AI-Working` in Linear and deleting the dedup entry (`DELETE /api/dedup/<issue-uuid>`).
