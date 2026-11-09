/** Read-only workflow generation diagnostics, including the GHA failover path. */
import { RETIRED_WORKFLOW_PATHS } from "../agent-run-preparation.js";
import type { WorkflowCapabilities } from "../workflow-probe.js";
import type { SetupCheck, SetupCheckOutcome } from "./index.js";

const FIX = "Sync workflows on this project (admin row action or MCP trigger_workflow_sync) and merge its PR";

function missingMarkers(cap: WorkflowCapabilities): string[] {
  return [
    ...(!cap.supportsPrivateRunConfig ? ["private-run-config-v1"] : []),
    ...(!(cap.hasStageAgentConfigMarker ?? cap.supportsStageAgentConfig) ? ["stage-agent-config-v1"] : []),
    ...(!(cap.hasStageAgentLaunchContextMarker ?? cap.supportsStageAgentConfig) ? ["stage-agent-launch-context-v1"] : []),
  ];
}

export const GITHUB_CONFIG_CHECKS: readonly SetupCheck[] = [{
  id: "github.workflow-generation",
  title: "Workflow template generation",
  group: "github",
  tier: "core",
  onAdminPath: false,
  async run(ctx) {
    const mappings = Object.entries(ctx.mappings());
    if (!mappings.length) return [{ state: "not-applicable", detail: "No projects are mapped" }];
    return Promise.all(mappings.map(async ([project, mapping]): Promise<SetupCheckOutcome> => {
      const files = [mapping.workflowFile, ...(mapping.planningEnabled ? [mapping.planningWorkflowFile] : [])];
      const read = [...files, ...RETIRED_WORKFLOW_PATHS].map((file) => `${file}@${mapping.defaultBranch}`).join(", ");
      try {
        // Await every read before judging: an unreadable file must never look like a legacy generation.
        const results = await Promise.allSettled([
          ...files.map((file) => ctx.workflowCapabilities(mapping, file)),
          ...RETIRED_WORKFLOW_PATHS.map((path) => ctx.defaultBranchFileExists(mapping, path)),
        ]);
        if (results.some((result) => result.status === "rejected")) {
          return { project, state: "cannot-verify", detail: `Could not verify ${read}; a GitHub authentication or file read failed.`, fix: "Check GitHub App credentials and repository read access, then run the setup checks again." };
        }
        const values = results.map((result) => (result as PromiseFulfilledResult<WorkflowCapabilities | boolean>).value);
        const caps = values.slice(0, files.length) as WorkflowCapabilities[];
        const retired = RETIRED_WORKFLOW_PATHS.filter((_, i) => values[files.length + i]);
        const broken = caps.flatMap((cap, i) => cap.contract === "legacy" ? [`${files[i]}@${mapping.defaultBranch}: ${cap.missing ? "404 (missing file)" : "missing run_config (legacy)"}`] : []);
        const tokenWarnings = caps.slice(0, 1).flatMap((cap) => {
          const missing = [
            ...(!cap.supportsRunPublicationToken ? ["run_publication_token"] : []),
            ...(!cap.supportsAttemptCorrelation ? ["run_attempt_token"] : []),
          ];
          return missing.length ? [`${files[0]}@${mapping.defaultBranch}: missing ${missing.join(", ")}`] : [];
        });
        const markerWarnings = caps.flatMap((cap, i) => {
          const missing = missingMarkers(cap);
          return missing.length ? [`${files[i]}@${mapping.defaultBranch}: missing ${missing.join(", ")}`] : [];
        });
        const warnings = tokenWarnings.length ? tokenWarnings : markerWarnings;
        const fault = retired.length
          ? `retired_workflow_present: ${retired.map((path) => `${path}@${mapping.defaultBranch}`).join(", ")} (dispatch refused)`
          : broken[0];
        const state = fault ? (mapping.executionMode === "github-actions" ? "fail" : "warn") : warnings.length ? "warn" : "pass";
        return { project, state, detail: `Read ${read}. ${fault || warnings.join("; ") || "All required workflow inputs and markers are present."}`, ...(state === "pass" ? {} : { fix: FIX }) };
      } catch {
        return { project, state: "cannot-verify", detail: `Could not verify ${read}.`, fix: "Check GitHub App credentials and repository read access, then run the setup checks again." };
      }
    }));
  },
}];
