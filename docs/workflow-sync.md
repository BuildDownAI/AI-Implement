# Workflow sync

How the orchestrator delivers its workflow templates to a target repository: what one sync writes, removes, and seeds, how a sync is triggered and recovered, and what can fail.

## What a sync writes

A sync opens (or updates) one pull request in the target repo. It touches three sets of files, all defined at the top of `src/workflow-sync.ts`:

| Set | Files | Rule |
|---|---|---|
| Always-synced | `workflows/claude-implement.yml` → `.github/workflows/<mapping.workflowFile>`, `workflows/claude-plan.yml` → `.github/workflows/<mapping.planningWorkflowFile>` (defaults `claude-implement.yml`, `claude-plan.yml`) | Overwritten on every sync when the content differs. A workflow file the mapping does not name is never written, changed, or deleted |
| `SEED_ONCE_FILES` | `workflows/WORKFLOW.md` → `WORKFLOW.md`, `workflows/PLANNING.md` → `PLANNING.md` | Written only when absent on both the base branch and the sync branch; never overwritten |
| `REMOVE_FILES` | `.github/workflows/comment-trigger.yml`, `.github/workflows/claude-kg-refresh.yml` | Deleted from the sync branch when present |

Templates are read from the orchestrator's package root (`templatesRoot` overrides it in tests). A missing always-synced template throws; a missing seed template is skipped.

The dispatcher calls the workflow by the mapping's `workflowFile` (implement) and `planningWorkflowFile` (planning), so the sync delivers the templates under those names (AII-738/AII-739). Two orchestrators can serve one repo during a migration, each with its own names; neither sync touches the other's files. Before any write — before even the initial repo lookup — `syncWorkflowTemplates` checks both names with the exported `isBareWorkflowFileName` and throws when a name is not a bare `.yml`/`.yaml` file name (no `/`, no `\`, no `..`). The thrown message names both the offending field (`workflowFile` or `planningWorkflowFile`) and the rule.

## The sync branch and pull request

- Branch: `sync/ai-implement`, or `<branchPrefix>/sync/ai-implement` when the mapping sets a branch prefix (`buildSyncBranchName`).
- The branch is orchestrator-owned and disposable. `ensureSyncBranch` creates it from the base branch, or **force-resets** it to the base head on every sync, so each sync is a clean diff against base.
- Base branch: the caller's `targetBase`, else the mapping's `defaultBranch`, else the repo's GitHub default branch. A base branch that does not exist fails with a plain message naming the branch.
- One open PR per sync branch (`findSyncPr`). An existing PR is retargeted to the current base when its base differs. A changed prefix leaves the PR on the old branch open; close it by hand.
- The PR body lists the resolved paths actually synced (the mapping's `workflowFile`/`planningWorkflowFile`, not fixed defaults), the seed-once files, and the removed files.
- Result `status`: `pr-opened`, `pr-updated`, `pr-existing` (no change, PR open), or `up-to-date` (no change, no PR).

## Triggers and recovery

| Trigger | Path |
|---|---|
| Saving a mapping (`upsertMappingAction`, admin form or MCP `add_project`) | Enqueues and runs a sync in the background; the save returns 202 with `syncJobId` |
| **Sync workflows** row action, `POST /api/mappings/:teamKey/sync-workflows`, MCP `trigger_workflow_sync` | `triggerWorkflowSyncAction` enqueues and runs a sync |
| Poll loop | `processPendingWorkflowSyncs` re-runs `pending` jobs and `running` jobs idle for more than `STALE_RUNNING_MS` (5 minutes), one at a time |

`src/workflow-sync-queue.ts` keeps one row per team in `workflow_sync_queue`, so a team has at most one sync in flight. `runWorkflowSync` re-reads the mapping at run time (a deleted mapping fails the job), and leaves the job `pending` while a deploy hold is active. Clients poll `GET /api/mappings/:teamKey/sync-status/:jobId`.

## Failures

`classifySyncError` maps a failure to one of `app-not-installed`, `repo-not-found`, `permission-denied`, `clock-skew-suspected`, or `unknown`, each with an operator message. The App needs Contents, Pull requests, and **Workflows** write on the target repo; a missing Workflows permission surfaces as `permission-denied` on the `.github/workflows/` write. An invalid `workflowFile`/`planningWorkflowFile` name (see above) throws a plain `Error`, which `classifySyncError` reports as `unknown` with the message passed through verbatim.

## Bulk fallback

`.github/workflows/sync-workflow.yml` in this repo is a manual GitHub Actions fallback that syncs templates to a named `target_repo`. Normal distribution is the orchestrator path above.
