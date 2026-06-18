# Sync PR branch refresh — design

**Date:** 2026-06-08
**Status:** Approved, ready for planning

## Problem

The admin "Sync workflows" action opens/updates a single canonical PR per target repo
on the branch `sync/ai-implement` (or `<prefix>/sync/ai-implement` when the project sets
a branch prefix). When that branch still exists from a prior sync, re-syncing produces
"weird" results — confirmed across all three of these states:

1. **Stale open-PR layering.** A previous sync PR was still open (branch ahead of base).
   The current code leaves that branch untouched and layers new file updates on top, so
   the reused PR reflects stale state rather than a clean diff against the current base.
2. **Lingering post-merge branch.** A previous sync PR was merged but its branch was not
   deleted, leading to confusing subsequent syncs.
3. **Wrong/old base diff.** The reused branch is based on an outdated base SHA, so the PR
   shows more than just the current workflow changes.

The root cause is in `ensureSyncBranch` (`src/workflow-sync.ts`): when the sync branch
already exists and is **ahead** of base, it is intentionally left untouched (only a branch
that is exactly even with base, `ahead_by === 0`, is force-reset). That "preserve commits
already on the sync branch" behavior is what lets stale state persist.

## Decision

Keep one canonical, reusable sync PR per repo (no unique/disposable branch names), but make
every re-sync **refresh the branch to a clean state**: the sync branch always begins at the
current base, then the workflow templates are re-applied on top. The reused PR therefore
always shows a clean diff = *current base + current templates*.

Rejected alternative: unique branch name per sync (e.g. `sync/ai-implement-<base-sha>`).
It avoids staleness but accumulates branches/PRs and requires garbage-collecting prior open
sync PRs. The canonical-PR-refreshed model achieves clean diffs without that clutter.

## Change

A single function changes: `ensureSyncBranch` in `src/workflow-sync.ts`.

- **Branch does not exist** → create it from the current base SHA (unchanged; plain ref
  create, no force needed).
- **Branch exists** (whether ahead of, behind, or even with base, or lingering after a
  merge) → **force-reset its ref to the current base SHA**. This replaces the current
  logic that resets only when `ahead_by === 0` and otherwise leaves the branch untouched.
  The `compare` (`ahead_by`) request is removed — it is no longer needed.

The outcome is uniform in all cases: the sync branch is at current base before any
templates are applied. The mechanism differs only in create (new branch) vs. force-reset
(existing branch).

Downstream flow in `syncWorkflowTemplates` is unchanged: after the branch is at base, the
always-synced workflow files are written (overwriting), seed-once files are added only if
absent on base, `changedFiles` is computed from real differences, and the existing PR is
reused (`pr-updated`) or a new one opened (`pr-opened`).

## Deliberate behavior reversal

This removes the current guarantee that manual/operator commits on the sync branch survive
a re-sync. The sync branch becomes fully orchestrator-owned and disposable — re-syncing
force-resets it. This is intended: sync PRs are auto-generated. The existing test
`preserves an existing sync branch that is ahead of base` (`src/__tests__/workflow-sync.test.ts`)
encodes the old guarantee and is replaced (see Testing).

## Out of scope

- No unique branch names.
- No change to status semantics (`up-to-date` / `pr-existing` / `pr-opened` / `pr-updated`).
- No auto-close of an open PR that becomes empty after a reset (workflows already match
  base, nothing to sync). This is a benign, pre-existing edge — the PR stays open with an
  empty diff and an operator can close it. Not expanded here.

## Testing

In `src/__tests__/workflow-sync.test.ts`:

- **Replace** the test `preserves an existing sync branch that is ahead of base` with a
  test asserting the new behavior: given a sync branch that is ahead of base and carries a
  non-template leftover file, after sync the branch is force-reset to base (a `PATCH` to
  `…/git/refs/heads/<syncBranch>` with `sha === base` and `force === true` occurred), the
  stale non-template file is gone, and the current workflow templates are present.
- **Add** an assertion (same or sibling test) that a stale workflow file content on the old
  branch (e.g. `claude-implement.yml` = "OLD") is replaced by the current template content.
- Confirm a stale open PR is reused (`pr-updated`, same PR number), not duplicated.
- All other existing sync tests stay green, including:
  - `returns up-to-date when the sync branch already matches templates and no PR is open`
  - `updates an existing sync PR when files change`
  - `returns pr-existing when no files changed and a sync PR is already open`
  - the branch-prefix tests (`pr/sync/ai-implement`).

## Backward compatibility

The canonical branch name is unchanged (`sync/ai-implement`, or the prefixed variant). The
only change is that an existing sync branch is force-reset instead of conditionally
preserved. Repos with no lingering sync branch behave exactly as before.

## Delivery note

The implementation PR targets the `testing` branch as its base (not `main`). This may fold
into the open per-project branch-prefix PR (#79) or be a follow-up — to be decided at
plan/finish time.
