# Feature-branch grouping for parent/child issues

How the `AI-Implement` label drives parent/child issue trees onto a cascade of feature
branches, how each issue is classified and dispatched, and how completed feature branches
roll back up.

This is the operator/developer reference. The decision history lives in
`docs/plans/2026-05-30-001-feat-feature-branches-parent-child-issues-plan.md`.

---

## 1. Mental model

Two grouping modes are available, selected by whether the parent issue also carries
the `Multi-Issue` label.

### Feature-node mode (default)

A **parent issue** that carries `AI-Implement` *and* has at least one `AI-Implement` child
(without the `Multi-Issue` label) becomes a **feature node**. It owns a long-running branch
`ai-implement/feature/<issue-key>`. Its labelled children open PRs **into that branch**.
When all children finish, the parent runs its own closing work on that branch, then the
branch rolls up.

```
testing                                  (repo base branch)
└─ ai-implement/feature/PROJ-100         parent PROJ-100 (feature node)
   ├─ ai-implement/feature/PROJ-101      child PROJ-101 (also a feature node)
   │   ├─ PR: PROJ-103 (leaf) ─────────► feature/PROJ-101
   │   └─ PR: PROJ-104 (leaf) ─────────► feature/PROJ-101
   └─ PR: PROJ-102 (leaf) ─────────────► feature/PROJ-100
```

The tree is **recursive**: a child that is itself a feature node gets its own branch cut
from its parent's branch. Unlabelled children are ignored until they get `AI-Implement`,
so trees can be rolled out incrementally.

### Multi-issue mode

A parent that carries **both** `AI-Implement` and `Multi-Issue` (and has ≥2 `AI-Implement`
children) becomes a **multi-issue grouping node**. It is a pure container — it never
dispatches its own work. All children PRs target the shared grouping branch
`ai-implement/multi-issue/<sorted-child-slugs>`. When all children are terminal, the
grouping branch self-finalizes.

```
testing                                  (repo base branch)
└─ ai-implement/multi-issue/aii-10-aii-5 shared grouping branch
   ├─ PR: AII-5 (leaf) ─────────────────► multi-issue/aii-10-aii-5
   └─ PR: AII-10 (leaf) ────────────────► multi-issue/aii-10-aii-5
```

**Degenerate case:** `Multi-Issue` label on a parent with fewer than 2 `AI-Implement`
children is not recognised as a group. The parent is skipped with a log line:
`Skipping <key>: Multi-Issue parent needs >=2 AI-Implement children (has N) — not a group`.

---

## 2. The labels

| Label | Meaning | Who sets it |
|-------|---------|-------------|
| `AI-Implement` | **Trigger.** The orchestrator only sees issues with this label (and a non-terminal state). | Human |
| `Multi-Issue` | **Mode selector.** Applied to a parent alongside `AI-Implement` to opt it into multi-issue grouping mode (pure container, ≥2 children required). Without this label a parent with AI-Implement children is a feature node. | Human |
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
| **no children** | **leaf** | dispatched; PR targets the nearest grouping-ancestor branch (or base) |
| **`Multi-Issue` label + ≥2 `AI-Implement` children, not all terminal** | **multi-issue grouping (in flight)** | skipped — grouping branch cut lazily when the first child dispatches |
| **`Multi-Issue` label + ≥2 `AI-Implement` children, all terminal** | **multi-issue grouping (ready)** | not dispatched (no work); roll-up fires via `fetchFeatureNodeRollUps` |
| **`Multi-Issue` label + <2 `AI-Implement` children** | **degenerate multi-issue** | skipped — not a group |
| **≥1 `AI-Implement` child (no `Multi-Issue`), not all terminal** | **feature node (waiting)** | skipped — its branch is cut lazily when the first child dispatches |
| **≥1 `AI-Implement` child (no `Multi-Issue`), all terminal** | **feature node (ready)** | dispatched; its own closing work lands on its own feature branch |
| **has children but none `AI-Implement` yet** | **waiting parent** | skipped — race guard (see below) |

### The race guard

If you label a parent **before** its children, the parent has children but none carry
`AI-Implement` yet. It is **not** treated as a leaf and implemented — it's left alone until
a child gets labelled. This is what lets you label a whole tree at once (or top-down)
without the parent being worked prematurely. Log line:
`Skipping <key>: parent labeled but no child has AI-Implement set yet`.

### Parent closing work is deferred (feature-node mode only)

A feature node is **not** implemented while any of its `AI-Implement` children are still
in flight (`Skipping <key>: feature-node parent waiting on in-flight AI-Implement
children`). Only once **all** its labelled children reach a terminal state does its own
work dispatch — onto its own feature branch. "Terminal" means completed *or* cancelled, so
a cancelled child doesn't block the parent forever.

A multi-issue grouping node **never** dispatches closing work; it is a pure container.

---

## 4. Feature branches: naming and the cascade

Two branch-naming functions live in `src/pipeline/branch-name.ts`:

- **`buildFeatureBranchName(parentIdentifier)`** → `ai-implement/feature/<slug>`  
  Used for feature-node parents (no `Multi-Issue` label). The branch is derived from the
  parent identifier only (stable across child dispatches; no title drift).

- **`buildMultiIssueBranchName(childIdentifiers[])`** → `ai-implement/multi-issue/<sorted-slugs>`  
  Used for multi-issue grouping nodes. Slugs are sorted lexicographically and capped at 3,
  with a `-plus<N>` suffix for any extras:
  - `["AII-10", "AII-5"]` → `ai-implement/multi-issue/aii-10-aii-5`
  - `["AII-5", "AII-10", "AII-1"]` → `ai-implement/multi-issue/aii-1-aii-10-aii-5`
  - `["AII-1", "AII-2", "AII-3", "AII-4", "AII-5"]` → `ai-implement/multi-issue/aii-1-aii-2-aii-3-plus2`
  
  The parent key is **excluded** from the multi-issue branch name — the name is derived
  from child identifiers (the grouping truth is the hierarchy, not the parent's identity).
  The sort is order-independent, so any permutation of the same child set yields the same
  branch name.

The provider attaches an ordered `featureBranchChain` (base-most first) to each
dispatchable issue (`TicketIssue.featureBranchChain` in `src/providers/types.ts`). Branch
names are **pre-computed** by the provider (either `ai-implement/feature/<key>` or
`ai-implement/multi-issue/<slugs>`) — consumers never need to derive them. For a leaf it
ends at the nearest grouping ancestor; for a ready feature node it ends at the node itself.

At dispatch time, `resolveBaseBranch` (`src/feature-branch.ts`) walks the chain and
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

`src/merge-up.ts` (fed by `LinearProvider.fetchFeatureNodeRollUps`, run each poll **before**
dispatch) handles both modes:

### Feature-node roll-up

Fires when a feature-node issue's `state.type` is `"completed"` and it has ≥1
`AI-Implement` child. The branch `ai-implement/feature/<key>` is merged into its parent's
branch (or offered as a top-of-tree PR).

### Multi-issue roll-up

Fires when a multi-issue grouping node has ≥2 `AI-Implement` children **and** all of those
children are terminal (completed or cancelled). The grouping branch
`ai-implement/multi-issue/<sorted-slugs>` is then merged up via the same paths below.
The multi-issue grouping node itself is never dispatched (no closing work), so its
`markMerged` is driven purely by the top-of-tree PR merged-state detection.

> ⚠️ **Internal multi-issue self-finalize is deferred (AII-193).** When a multi-issue
> grouping node is itself a child of a larger feature tree (i.e., it has a
> `parentIdentifier` in the roll-up record), the direct-merge path runs as expected, but
> the inner container does **not** currently self-finalize (call `markMerged`) — that is
> scheduled for AII-193. Only the top-of-tree multi-issue PR path self-finalizes today.

### Merge paths (shared by both modes)

- **Internal level** (the node's parent is itself a grouping node) → a **direct git merge**
  (`POST /merges`, `mergeBranch` in `src/github.ts`), **not** a pull request, with a commit
  message that carries no issue identifier. *Why no PR:* a roll-up PR's base branch name and
  title encode the parent's key, so Linear's GitHub integration would auto-link the PR to the
  parent issue and mark it **Done on merge — before the parent's own work runs**. A plain
  merge commit gives Linear nothing to link, so the parent's lifecycle stays correct.
- **Top of the tree** (no grouping parent) → an open `grouping → base` **PR for human
  review**, never auto-merged.

The step is **idempotent** and **fails soft** per roll-up — one failure never aborts the
others or the poll loop. It scans only issues updated in a recent window to stay cheap.

Idempotency is handled differently per path:
- **Internal level:** `compareBranches` returning 0 (branch already merged into parent) or
  `null` (branch missing) causes an early return.
- **Top of the tree:** `findPullRequestByBranches` is checked first. If the PR is **merged**
  — by any method (merge-commit, squash, or rebase) — the orchestrator deletes the grouping
  branch (`deleteBranch`) and calls `markMerged` to idempotently finalize the node in the
  tracker. If the PR is still open, the step returns and awaits the human. Only when no PR
  exists is a new one opened (guarded by an ahead-check so a missing branch exits early).
  This replaces the old git-ancestry heuristic, which misread squash/rebase merges as
  "still ahead" and re-opened the PR on each poll tick ([AII-188](https://linear.app/eudoxus/issue/AII-188)).

> ⚠️ **Auto-roll-up needs the runner callback.** A feature node only completes when its
> closing-work PR merges and Linear marks it Done; the feature-node roll-up keys off that
> completed state. Planning's `Plan-Complete` transition is delivered by the runner callback
> (`RUNNER_CALLBACK_BASE_URL` + `RUNNER_TOKEN_SECRET`, which must be **publicly reachable**).
> With the callback disabled, planning stalls at `AI-Planning` and the cascade can't advance
> on its own. Multi-issue roll-up is not affected since it keys off children being terminal,
> not the parent's own state.

---

## 6. End-to-end lifecycle of one tree

### Feature-node tree

1. Label the tree `AI-Implement` (whole tree at once is fine — the gates sequence it).
2. Leaves with no blockers dispatch: **plan → (auto-approve) → implement → PR** into their
   parent's feature branch. The cascade branches are created on the first leaf dispatch.
3. A human merges each leaf PR → the orchestrator marks the leaf **Done** (via poll detector + webhook) → any blocked sibling
   unblocks and runs.
4. When a feature node's children are all Done, its **own closing work** dispatches → PR
   into its own feature branch → human merges → orchestrator marks node Done.
5. The **merge-up** rolls each completed feature node's branch up into its parent's branch
   (direct merge). The top node's branch is offered as a `feature → base` PR.
6. A human reviews and merges that final PR **by any merge method** (merge-commit, squash, or rebase). On the next poll tick the orchestrator detects the merged PR state, deletes the feature branch, and calls `markMerged` to finalize the top node Done.

### Multi-issue group

1. Label the parent `AI-Implement` + `Multi-Issue`; label children `AI-Implement`.
2. Children dispatch as leaves: **plan → implement → PR** into the shared multi-issue branch.
   The grouping branch is created on the first child dispatch.
3. A human merges each child PR → the orchestrator marks the child **Done**.
4. When **all** children are terminal (Done or cancelled), `fetchFeatureNodeRollUps`
   emits a roll-up record for the grouping node.
5. The merge-up offers the grouping branch as a `multi-issue → base` PR (if at the top of
   the tree) or direct-merges it into the parent (if it's nested).
6. A human reviews and merges the top-of-tree PR. The orchestrator detects the merged PR
   state, deletes the grouping branch, and calls `markMerged` to finalize the grouping node.

---

## 7. Where each part lives

| Concern | File |
|---------|------|
| `AI_IMPLEMENT_LABEL`, `MULTI_ISSUE_LABEL` constants | `src/providers/linear.ts` |
| Label query, classification, roll-up discovery (mode-aware) | `src/providers/linear.ts` (`fetchAIImplementSnapshot`, `fetchFeatureNodeRollUps`) |
| Shared types (`featureBranchChain`, `FeatureNodeRollUp`) | `src/providers/types.ts` |
| Feature-node branch names (`buildFeatureBranchName`) | `src/pipeline/branch-name.ts` |
| Multi-issue branch names (`buildMultiIssueBranchName`) | `src/pipeline/branch-name.ts` |
| Cascade branch creation + PR-base resolution | `src/feature-branch.ts` (`resolveBaseBranch`) |
| Roll-up (direct merge / human PR, both modes) | `src/merge-up.ts` (`runMergeUps`) |
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
- **Runner callback must be public** for planning to auto-advance and thus for the
  feature-node cascade to self-drive. On a local (`localhost`) orchestrator the callback
  can't be reached, so `Plan-Complete` must be set by hand to test the
  implementation/grouping path. Multi-issue roll-up does not require the callback — it
  triggers on children being terminal, not on the parent's own planning/implementation state.
- **Pair the runner image with the orchestrator.** A testing orchestrator should set
  `SESSION_IMAGE=ghcr.io/builddownai/ai-implement-runner:next`; otherwise a GitHub Actions
  run falls back to the `:latest` runner, which may be incompatible with the current
  workflow/entrypoint.
- **Top-of-tree PR merge method:** any method (merge-commit, squash, rebase) works
  correctly — the orchestrator detects completion via the PR's merged state, not git
  ancestry. On orchestrator versions before AII-188 shipped, squash/rebase merges left the
  grouping branch appearing "ahead" of base, causing the PR to be re-opened each poll tick.
  If running a pre-fix orchestrator, use merge-commit with **Delete branch** checked as a
  temporary workaround.
- **Opt a parent into multi-issue mode** by adding both `AI-Implement` and `Multi-Issue`
  labels. Without `Multi-Issue`, a parent with AI-Implement children is always treated as a
  feature node (deferred closing work). With `Multi-Issue`, it becomes a pure container
  (no closing work, children share a grouping branch).
- **The ≥2 child gate:** a `Multi-Issue` parent with 0 or 1 AI-Implement children is
  treated as degenerate and skipped each poll tick with a log line. Add a second labelled
  child (or remove `Multi-Issue` to fall back to feature-node mode) to resolve.
- **Child-set mutation hazard:** the multi-issue branch name is derived from the child
  identifiers at the time the first child dispatches. Adding or removing AI-Implement
  children after the grouping branch is cut will cause the computed name to drift from
  the existing branch. The safest recovery is to rename the existing branch manually to
  match the new name, or to re-derive the name by looking at the current child set via
  `buildMultiIssueBranchName`.
- **Internal multi-issue self-finalize is deferred (AII-193).** When a multi-issue grouping
  node is nested inside a larger feature tree (it has a parent grouping node), the
  orchestrator direct-merges its branch but does not call `markMerged` on it. Only the
  top-of-tree multi-issue PR path calls `markMerged` today. AII-193 will close this gap.
- **Don't restart the orchestrator mid-run.** A restart drops in-flight job tracking,
  leaving dispatched issues stuck with `AI-Working` plus a dedup row. Recover by removing
  `AI-Working` in Linear and deleting the dedup entry (`DELETE /api/dedup/<issue-uuid>`).
