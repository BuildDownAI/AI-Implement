# Feature-branch grouping for parent/child issues

How the `AI-Implement` label drives parent/child issue trees onto a cascade of feature
branches, how each issue is classified and dispatched, and how completed feature branches
roll back up.

This is the operator/developer reference. The decision history lives in
`docs/plans/2026-05-30-001-feat-feature-branches-parent-child-issues-plan.md`.

---

## 1. Mental model

A Linear issue tree maps onto a tree of git branches:

- A **parent issue** that carries the `AI-Implement` label *and* has at least one
  `AI-Implement` child becomes a **feature node**. It owns a long-running shared branch
  `ai-implement/<mode>/<issue-key>` (mode defaults to `feature` — see §5).
- Its **labelled children** are worked on and open PRs **into that feature branch**, not
  into the repo's base branch.
- Unlabelled children are ignored until they too get the `AI-Implement` label — so you can
  roll a tree out incrementally.
- The tree is **recursive**: a child that is itself a feature node gets its own branch cut
  from its parent's branch, and so on.
- When a feature node's children are all done, the node's **own work** runs (a parent
  can carry work that isn't done in any child — e.g. a final cleanup), committed onto its
  own feature branch.
- Completed feature branches **roll up** into their parent's branch automatically; the
  single top-of-tree `feature → base` merge is left as a human-reviewed PR.

```
testing                                  (repo base branch)
└─ ai-implement/feature/PROJ-100         parent PROJ-100 (feature node)
   ├─ ai-implement/feature/PROJ-101      child PROJ-101 (also a feature node)
   │   ├─ PR: PROJ-103 (leaf) ─────────► feature/PROJ-101
   │   └─ PR: PROJ-104 (leaf) ─────────► feature/PROJ-101
   └─ PR: PROJ-102 (leaf) ─────────────► feature/PROJ-100
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
| **no children** | **leaf** | dispatched; PR targets the nearest feature-node ancestor branch (or base) |
| **≥1 `AI-Implement` child, not all terminal** | **feature node (waiting)** | skipped — its branch is cut lazily when the first child dispatches |
| **≥1 `AI-Implement` child, all terminal** | **feature node (ready)** | dispatched; its own closing work lands on its own feature branch |
| **has children but none `AI-Implement` yet** | **waiting parent** | skipped — race guard (see below) |

This classification and the label lifecycle above apply identically to both `feature` and
`multi-issue` mode — the grouping mode affects only the shared branch name (§4).

### The race guard

If you label a parent **before** its children, the parent has children but none carry
`AI-Implement` yet. It is **not** treated as a leaf and implemented — it's left alone until
a child gets labelled. This is what lets you label a whole tree at once (or top-down)
without the parent being worked prematurely. Log line:
`Skipping <key>: parent labeled but no child has AI-Implement set yet`.

### Parent closing work is deferred

A feature node is **not** implemented while any of its `AI-Implement` children are still
in flight (`Skipping <key>: feature-node parent waiting on in-flight AI-Implement
children`). Only once **all** its labelled children reach a terminal state does its own
work dispatch — onto its own feature branch. "Terminal" means completed *or* cancelled, so
a cancelled child doesn't block the parent forever.

---

## 4. Feature branches: naming and the cascade

- Branch name: `ai-implement/<mode>/<issue-key-slug>` (`buildGroupingBranchName` in
  `src/pipeline/branch-name.ts`), where `<mode>` is the grouping mode read from the
  parent's `ai-implement.yml` block (see §5) — `"feature"` by default. The two modes
  (`"feature"` and `"multi-issue"`) differ **only** in this path segment; everything else
  about grouping — dispatch gating, base-branch resolution, roll-up, and lifecycle — is
  identical for both.
- The provider attaches an ordered `featureBranchChain` (base-most first) to each
  dispatchable issue (`TicketIssue.featureBranchChain` in `src/providers/types.ts`). For a
  leaf it ends at the nearest feature-node ancestor; for a ready feature node it ends at
  the node itself.
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

## 5. `ai-implement.yml` — per-issue grouping config

A parent issue can embed a fenced code block in its description to configure the
orchestrator. Today the only config key is `feature_branch.mode`, which selects the
grouping branch path segment.

This is a general-purpose issue-config channel; `feature_branch` is its first key. Future
per-issue settings will extend this block without changing the discovery logic.

### Schema

```
# ai-implement.yml (example)
feature_branch:
  mode: "multi-issue"   # "feature" (default) | "multi-issue"
```

`feature_branch.mode` selects the branch path segment for the parent's shared branch —
`ai-implement/feature/<key>` or `ai-implement/multi-issue/<key>`. Any unrecognized value
(or an absent block) silently defaults to `"feature"`.

### Block selection

The **first fenced code block** in the description whose **first non-blank line** is
exactly `# ai-implement.yml` wins. The fence info string is **not** the selector —
` ```yaml `, ` ```yml `, and bare ` ``` ` all work equally. The marker must be the first
non-blank content line inside the block; the YAML comment syntax (`# ...`) ensures it is
ignored by the YAML parser and survives Jira's ADF-to-plaintext pipeline verbatim.

> **Examples in docs:** use `# ai-implement.yml (example)` as the marker line (extra text
> after `yml` prevents the block from matching the selector pattern), as shown in the schema
> example above.

### Strip-from-description behaviour

A matched block is **always stripped** from `TicketIssue.description` before the runner
sees it, even when the block is broken YAML. Config is orchestrator metadata, not
implementation spec — removing it prevents the agent from trying to create or manage the
configuration file as part of the work. An unmatched block is never touched.

### Fail-open ladder

Every failure path silently resolves to `"feature"` mode so no dispatch is ever blocked by
a config error:

| Condition | Outcome |
|-----------|---------|
| No marked block found in description | `feature` mode (no warning) |
| Marked block present, YAML invalid | `feature` mode + `[issue-config]` warning |
| Marked block present, no `feature_branch` key | `feature` mode (no warning) |
| `feature_branch` is not a mapping | `feature` mode + `[issue-config]` warning |
| `feature_branch.mode` is an unrecognized string | `feature` mode + `[issue-config]` warning |
| `feature_branch.mode: "feature"` | `feature` mode |
| `feature_branch.mode: "multi-issue"` | `multi-issue` mode |

---

## 6. Roll-up (the merge-up)

When a feature-node issue completes, its branch is merged into its parent's branch
(`src/merge-up.ts`, fed by `LinearProvider.fetchFeatureNodeRollUps`, run each poll **before**
dispatch so a parent's own work clones a branch that already contains its children's work):

- **Internal level** (the parent is itself a feature node) → a **direct git merge**
  (`POST /merges`, `mergeBranch` in `src/github.ts`), **not** a pull request, with a commit
  message that carries no issue identifier. *Why no PR:* a roll-up PR's base branch name and
  title encode the parent's key, so Linear's GitHub integration would auto-link the PR to the
  parent issue and mark it **Done on merge — before the parent's own work runs**. A plain
  merge commit gives Linear nothing to link, so the parent's lifecycle stays correct.
- **Top of the tree** (no feature-node parent) → an open `feature → base` **PR for human
  review**, never auto-merged. The PR body includes a `Grouped issues:` list enumerating the
  child issue identifiers that were merged into the branch. This applies to both `feature`
  and `multi-issue` mode.

The step is **idempotent** and **fails soft** per roll-up — one failure never aborts the others or the poll loop. It scans only feature nodes completed in a recent window to stay cheap.

Idempotency is handled differently per path:
- **Internal level:** `compareBranches` returning 0 (branch already merged into parent) or `null` (branch missing) causes an early return.
- **Top of the tree:** `findPullRequestByBranches` is checked first. If the `feature → base` PR is **merged** — by any method (merge-commit, squash, or rebase) — the orchestrator deletes the feature branch (`deleteBranch`) and calls `markMerged` to idempotently finalize the parent node in the tracker. If the PR is still open, the step returns and awaits the human. Only when no PR exists is a new one opened (guarded by an ahead-check so a missing branch exits early). This replaces the old git-ancestry heuristic (`compareBranches` alone at the top-of-tree path), which misread squash/rebase merges as "still ahead" and re-opened the PR on each poll tick ([AII-188](https://linear.app/eudoxus/issue/AII-188)).

> ⚠️ **Auto-roll-up needs the runner callback.** A feature node only completes when its
> closing-work PR merges and Linear marks it Done; the roll-up keys off that completed
> state. Planning's `Plan-Complete` transition is delivered by the runner callback
> (`RUNNER_CALLBACK_BASE_URL` + `RUNNER_TOKEN_SECRET`, which must be **publicly reachable**).
> With the callback disabled, planning stalls at `AI-Planning` and the cascade can't advance
> on its own.

---

## 7. End-to-end lifecycle of one tree

1. Label the tree `AI-Implement` (whole tree at once is fine — the gates sequence it).
2. Leaves with no blockers dispatch: **plan → (auto-approve) → implement → PR** into their
   parent's feature branch. The cascade branches are created on the first leaf dispatch.
3. A human merges each leaf PR → the orchestrator marks the leaf **Done** (via poll detector + webhook) → any blocked sibling
   unblocks and runs.
4. When a feature node's children are all Done, its **own closing work** dispatches → PR
   into its own feature branch → human merges → orchestrator marks node Done.
5. The **merge-up** rolls each completed feature node's branch up into its parent's branch
   (direct merge). The top node's branch is offered as a `feature → base` PR (with a
   `Grouped issues:` list in the body).
6. A human reviews and merges that final PR **by any merge method** (merge-commit, squash, or rebase). On the next poll tick the orchestrator detects the merged PR state, deletes the feature branch, and calls `markMerged` to finalize the top node Done — the tree lands on the base branch and the PR is never re-opened.

---

## 8. Where each part lives

| Concern | File |
|---------|------|
| Label query, classification, roll-up discovery (Linear) | `src/providers/linear.ts` (`fetchAIImplementSnapshot`, `fetchFeatureNodeRollUps`) |
| Jira classification, chain enrichment, roll-up discovery | `src/providers/jira.ts` (`enrichFeatureBranches`, `fetchFeatureNodeRollUps`), pure helpers in `src/providers/jira-hierarchy.ts`, Epic Link field discovery in `src/providers/jira-fields.ts` |
| Shared types (`featureBranchChain`, `FeatureNodeRollUp`) | `src/providers/types.ts` |
| Per-issue config (`ai-implement.yml` mode selector) | `src/issue-config.ts` (`parseIssueConfig`) |
| Branch names | `src/pipeline/branch-name.ts` (`buildGroupingBranchName`, `FeatureBranchMode`) |
| Cascade branch creation + PR-base resolution | `src/feature-branch.ts` (`resolveBaseBranch`) |
| Roll-up (direct merge / human PR) | `src/merge-up.ts` (`runMergeUps`) |
| GitHub helpers (branch/compare/merge/PR/merged-state) | `src/github.ts` (`ensureBranchExists`, `compareBranches`, `mergeBranch`, `createPullRequest`, `findOpenPullRequest`, `findPullRequestByBranches`, `deleteBranch`) — `findPullRequestByBranches` detects the top-of-tree PR's merged state (robust to any merge method); `deleteBranch` removes the feature branch after merge |
| Plan-Complete transition | `src/runner-callback.ts` → `markPlanComplete` |
| Poll-loop wiring (roll-up before dispatch; base resolved per issue) | `src/index.ts` |

Feature-branch grouping is supported on **both providers**:

- **Linear**: a parent issue is a feature node when it carries the `AI-Implement` label and
  has labelled children; completion is the issue reaching a completed workflow state.
- **Jira**: hierarchy comes from the native `parent` field, falling back to the classic
  **Epic Link** custom field when the instance has one (so Epic → Story trees group too).
  An issue is "designated" when its AI-Implement Status field is set and its AI-Implement
  Repo field matches the mapping. Roll-up discovery treats a node as completed when its
  native status category is Done **or** its AI-Implement Status field is `Merged` — the
  orchestrator's done-on-merge path only sets the custom field, never the native status,
  so without the OR the cascade would stall waiting for a manual status move. The gating
  children query fails **closed** (candidates are deferred for the poll rather than
  dispatched prematurely); the branch-targeting ancestor walk fails **open** (chains
  default to the base branch).

---

## 9. Operational notes

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
- **Top-of-tree PR merge method:** any method (merge-commit, squash, rebase) works correctly — the orchestrator detects completion via the PR's merged state, not git ancestry. On orchestrator versions before AII-188 shipped, squash/rebase merges left the feature branch appearing "ahead" of base, causing the PR to be re-opened each poll tick. If running a pre-fix orchestrator, use merge-commit with **Delete branch** checked as a temporary workaround.
- **Don't restart the orchestrator mid-run.** A restart drops in-flight job tracking,
  leaving dispatched issues stuck with `AI-Working` plus a dedup row. Recover by removing
  `AI-Working` in Linear and deleting the dedup entry (`DELETE /api/dedup/<issue-uuid>`).
