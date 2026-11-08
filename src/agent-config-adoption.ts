import { parse } from "yaml";
import { STAGE_NAMES, type StageAgentConfigurationV1, type StageName } from "./agent-config.js";
import type { RepoMapping } from "./config.js";
import type { AgentReadiness, AgentRunRequest } from "./agent-run-preparation.js";
import { StaleStageInputsError } from "./agent-config-store.js";
import { parseWorkflowMd } from "./workflow-md.js";
import { resolveExecutionPath, resolvePlanningExecutionPath, type RunnerMode } from "./runner-mode.js";
import { DEFAULT_MODEL } from "./pipeline/default-model.js";

export interface AdoptionDeps {
  getDefaults(): { config: StageAgentConfigurationV1 } | null;
  getMappings(): Record<string, RepoMapping>;
  getProject(key: string): { config: StageAgentConfigurationV1 } | null;
  fingerprint(key: string): string;
  runnerMode(): RunnerMode;
  readFile(mapping: RepoMapping, path: string): Promise<string | null>;
  inspectReadiness(request: Omit<AgentRunRequest, "dispatchId">, candidate: StageAgentConfigurationV1): Promise<AgentReadiness>;
  write(key: string, candidate: StageAgentConfigurationV1, expectedInputs: string): void;
}
export interface AdoptionResult {
  projectKey: string;
  outcome: string;
  modelNotCarried: boolean;
  stages: Record<StageName, { model: string; source: string }>;
}

/** Operator-driven opt-in. No credentials, profiles, or dispatch grants are written. */
export async function adoptProjects(deps: AdoptionDeps, options: { projectKey?: string; dryRun: boolean }): Promise<AdoptionResult[]> {
  if (deps.getDefaults()?.config.mode !== "configured") throw new Error("run adopt-env first");
  const mappings = deps.getMappings();
  if (options.projectKey && !Object.hasOwn(mappings, options.projectKey)) throw new Error("unknown project");
  const results: AdoptionResult[] = [];
  for (const [projectKey, mapping] of Object.entries(mappings)) {
    if (options.projectKey && options.projectKey !== projectKey) continue;
    // Guard the defaults used to omit redundant overrides as well as the project row.
    const expectedInputs = deps.fingerprint(projectKey);
    const defaults = deps.getDefaults()?.config;
    if (defaults?.mode !== "configured") throw new Error("run adopt-env first");
    const existing = deps.getProject(projectKey);
    const stages = Object.fromEntries(STAGE_NAMES.map(stage => [stage, {
      model: defaults.stages?.[stage]?.model ?? DEFAULT_MODEL, source: "configured defaults",
    }])) as AdoptionResult["stages"];
    const result: AdoptionResult = { projectKey, outcome: "", modelNotCarried: false, stages };
    results.push(result);
    if (existing) {
      result.outcome = existing.config.mode === "configured" ? "already configured" : "opted out";
      for (const stage of STAGE_NAMES) {
        const model = existing.config.stages?.[stage]?.model;
        if (model) stages[stage] = { model, source: "project configuration" };
      }
      continue;
    }
    const runnerMode = deps.runnerMode();
    const path = resolveExecutionPath(runnerMode, mapping.executionMode);
    const backends = path === "both" ? ["github-actions", "fly-machines"] as const : [path];
    const planningBackend = resolvePlanningExecutionPath(runnerMode, mapping.executionMode);
    const candidate: StageAgentConfigurationV1 = { version: 1, mode: "configured", stages: {} };
    try {
      const [config, workflow, planning] = await Promise.all([
        deps.readFile(mapping, ".ai-implement/config.yml"), deps.readFile(mapping, "WORKFLOW.md"), deps.readFile(mapping, "PLANNING.md"),
      ]);
      let models: Record<string, unknown> = {};
      try {
        const doc = config ? parse(config) : null;
        if (doc && typeof doc === "object" && !Array.isArray(doc) && doc.models && typeof doc.models === "object" && !Array.isArray(doc.models)) models = doc.models;
      } catch { /* Malformed YAML is no repo config, matching legacy dispatch. */ }
      const workflowModel = workflow ? parseWorkflowMd(workflow, {}).frontMatter.model : undefined;
      const planningModel = planning ? parseWorkflowMd(planning, {}).frontMatter.model : undefined;
      for (const stage of STAGE_NAMES) {
        const configured = models[stage === "implementation" ? "implement" : stage];
        const repoModel = stage !== "planning" && typeof configured === "string" && configured.trim() ? configured.trim() : undefined;
        // Mapping Extra Env reaches Fly/local containers, but not legacy GHA.
        // Repo stage inputs in feedback-loop beat run-autonomous's context model.
        const selections = (stage === "planning" ? [planningBackend] : backends).map(backend => {
          const envModel = backend !== "github-actions" ? mapping.extraEnv?.CLAUDE_MODEL?.trim() || undefined : undefined;
          const fileModel = stage === "planning" ? planningModel : workflowModel;
          const selected = repoModel ?? envModel ?? fileModel;
          return {
            backend, model: selected?.trim() || DEFAULT_MODEL,
            source: repoModel ? ".ai-implement/config.yml" : envModel ? "mapping.extraEnv.CLAUDE_MODEL" : fileModel?.trim() ? stage === "planning" ? "PLANNING.md" : "WORKFLOW.md" : "DEFAULT_MODEL",
          };
        });
        const { model, source } = selections[0];
        if (selections.some(selection => selection.model !== model)) {
          result.outcome = `model_conflict: ${stage}; ${selections.map(selection => `${selection.backend}=${selection.model} (${selection.source})`).join("; ")}`;
          break;
        }
        stages[stage] = { model, source };
        // Preserve the legacy effective model without redundant project overrides.
        if (model !== defaults.stages?.[stage]?.model) candidate.stages![stage] = { model };
      }
    } catch {
      result.modelNotCarried = true;
      candidate.stages = {};
    }
    if (result.outcome) continue;
    const checks = backends.map(backend => ({ backend, workflowFile: mapping.workflowFile }));
    if (mapping.planningEnabled) {
      checks.push({ backend: resolvePlanningExecutionPath(runnerMode, mapping.executionMode), workflowFile: mapping.planningWorkflowFile });
    }
    try {
      for (const check of checks) {
        const readiness = await deps.inspectReadiness({ projectKey, ...check, workflowRepository: `${mapping.owner}/${mapping.repo}` }, candidate);
        if (readiness.status !== "ready") {
          result.outcome = readiness.status === "not-ready" ? readiness.code : "resolution_failed";
          break;
        }
      }
    } catch { result.outcome = "readiness_unavailable"; }
    if (result.outcome) continue;
    if (!options.dryRun) {
      try { deps.write(projectKey, candidate, expectedInputs); }
      catch (error) {
        result.outcome = error instanceof StaleStageInputsError ? "inputs_changed" : "write_failed";
        continue;
      }
    }
    result.outcome = options.dryRun ? "would adopt" : "adopted";
  }
  return results;
}
