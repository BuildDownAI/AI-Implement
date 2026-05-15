import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { PipelineContext, PipelineDefinition, StepDefinition, StepType } from "./types.js";
import { resolveModule, type ResolveModuleOptions } from "./resolve-module.js";

const VALID_STEP_TYPES = new Set<StepType>([
  "clone",
  "install",
  "implement",
  "review",
  "preflight",
  "push",
  "await_ci",
  "explore-codebase",
  "architecture-analysis",
  "test-plan",
  "work-unit-decomposition",
  "cross-story-context",
  "post-to-ticketing",
  "custom",
]);

interface YamlStep {
  id: string;
  type: StepType;
  moduleId?: string;
}

interface YamlPipeline {
  id: string;
  steps: YamlStep[];
}

export interface LoadPipelineOptions extends ResolveModuleOptions {
  /** Injectable fs.readFileSync for testing. */
  readFileSyncImpl?: (path: string, encoding: "utf-8") => string;
}

function parseYamlPipeline(raw: string, sourcePath: string): YamlPipeline {
  const doc = parseYaml(raw) as unknown;

  if (!doc || typeof doc !== "object") {
    throw new Error(`Pipeline YAML at "${sourcePath}" is empty or not an object`);
  }

  const { id, steps } = doc as { id?: unknown; steps?: unknown };

  if (typeof id !== "string" || !id) {
    throw new Error(`Pipeline YAML at "${sourcePath}" missing required 'id' field`);
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`Pipeline YAML at "${sourcePath}" must define at least one step`);
  }

  const parsedSteps: YamlStep[] = steps.map((step, i) => {
    if (!step || typeof step !== "object") {
      throw new Error(`Pipeline YAML at "${sourcePath}" step[${i}] is not an object`);
    }
    const { id: stepId, type, moduleId } = step as Record<string, unknown>;
    if (typeof stepId !== "string" || !stepId) {
      throw new Error(`Pipeline YAML at "${sourcePath}" step[${i}] missing 'id'`);
    }
    if (typeof type !== "string" || !type) {
      throw new Error(`Pipeline YAML at "${sourcePath}" step "${stepId}" missing 'type'`);
    }
    if (!VALID_STEP_TYPES.has(type as StepType)) {
      throw new Error(`Pipeline YAML at "${sourcePath}" step "${stepId}" has unknown type "${type}"`);
    }
    if (moduleId !== undefined && typeof moduleId !== "string") {
      throw new Error(`Pipeline YAML at "${sourcePath}" step "${stepId}" has non-string 'moduleId'`);
    }
    return { id: stepId, type: type as StepType, ...(moduleId ? { moduleId } : {}) };
  });

  return { id, steps: parsedSteps };
}

/**
 * Standard input wiring for the autonomous pipeline steps. Applied by step ID
 * so the YAML only needs to declare IDs, types, and optional moduleIds.
 */
function applyWiring(step: YamlStep): StepDefinition {
  switch (step.id) {
    case "clone":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => ({
          repoOwner: ctx.data.githubOwner,
          repoRepo: ctx.data.githubRepo,
          branch: ctx.data.branch,
          githubToken: ctx.data.githubToken,
          workspaceDir: ctx.data.workspaceDir,
        }),
      };

    case "install":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => ({
          workspaceDir: ctx.getOutputs("clone").workspaceDir,
        }),
      };

    case "feedback-loop":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => {
          const repoModels = ctx.getOutputs("install").repoModels as
            | { implement?: string; review?: string }
            | undefined;
          return {
            workspaceDir: ctx.getOutputs("clone").workspaceDir,
            issueTitle: ctx.data.issueTitle,
            issueDescription: ctx.data.issueDescription,
            implementationPrompt: ctx.data.implementationPrompt,
            planningContext: ctx.data.planningContext,
            repoImplementModel: repoModels?.implement,
            repoReviewModel: repoModels?.review,
          };
        },
      };

    case "preflight":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => ({
          workspaceDir: ctx.getOutputs("clone").workspaceDir,
          packageManager: ctx.getOutputs("install").packageManager,
        }),
        skip: (ctx: PipelineContext) => ctx.getOutputs("feedback-loop").approved !== true,
      };

    case "push":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => ({
          workspaceDir: ctx.getOutputs("clone").workspaceDir,
          repoOwner: ctx.getOutputs("clone").repoOwner,
          repoRepo: ctx.getOutputs("clone").repoRepo,
          githubToken: ctx.getOutputs("clone").githubToken,
          branchName: ctx.getOutputs("clone").branch,
        }),
        skip: (ctx: PipelineContext) => ctx.getOutputs("feedback-loop").approved !== true,
      };

    case "post-push-review":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => ({
          prNumber: String(ctx.getOutputs("push").prNumber ?? ""),
          workspaceDir: ctx.getOutputs("clone").workspaceDir,
        }),
        skip: (ctx: PipelineContext) => {
          const pushOutputs = ctx.getOutputs("push");
          return pushOutputs.branchPushed !== true || !pushOutputs.prNumber;
        },
      };

    default:
      return step;
  }
}

/**
 * Loads a pipeline definition from a YAML file, resolving custom/ overrides
 * before falling back to the built-in. Standard step wiring is applied
 * automatically for the known autonomous pipeline steps.
 */
export function loadPipelineDefinition(
  modulePath: string,
  options?: LoadPipelineOptions,
): PipelineDefinition {
  const resolvedPath = resolveModule(modulePath, options);
  const readFn = options?.readFileSyncImpl ?? readFileSync;
  const raw = readFn(resolvedPath, "utf-8");
  const parsed = parseYamlPipeline(raw, resolvedPath);
  return {
    id: parsed.id,
    steps: parsed.steps.map(applyWiring),
  };
}
