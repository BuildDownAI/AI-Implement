/**
 * The two kg-refresh service definition types, for typed clients. `import type` only, so
 * `kg-repo.ts`, `kg-refresh-workflow.ts` and `tools.ts` share them without a runtime import
 * cycle (`KgRepo` sends to `KgRefresh` and back).
 */
import type { createKgRefreshWorkflow } from "./kg-refresh-workflow.js";
import type { createKgRepo } from "./kg-repo.js";

export type KgRefreshDefinition = ReturnType<typeof createKgRefreshWorkflow>;
export type KgRepoDefinition = ReturnType<typeof createKgRepo>;
