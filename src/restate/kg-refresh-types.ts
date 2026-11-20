/**
 * The two kg-refresh service definition types, for typed clients. `import type` only, so
 * `kg-repo.ts`, `kg-refresh-workflow.ts` and `tools.ts` share them without a runtime import
 * cycle (`KgRepo` sends to `KgRefresh` and back).
 */
import type { createKgRefreshWorkflow } from "./kg-refresh-workflow.js";
import type { createKgRepo } from "./kg-repo.js";

export type KgRefreshDefinition = ReturnType<typeof createKgRefreshWorkflow>;
export type KgRepoDefinition = ReturnType<typeof createKgRepo>;

/** The one fixed object key a switch uses when no KG source repo (and so no refresh rail) is configured. */
export const KG_GRAPH_SOURCE_SWITCH_REPO_KEY = "kg-graph-source-switch";

/** The kg-refresh pipeline's step ids in order (`pipelines/kg-refresh.yml`); `status().runnerStep` reads one pair of step promises per id. */
export const KG_REFRESH_RUNNER_STEPS = [
  "clone",
  "kg-scope-reconcile",
  "dependency-auth",
  "clone-code-repo",
  "clone-secondary-repos",
  "kg-tracker-data",
  "kg-ingest",
  "kg-snapshot-push",
] as const;
