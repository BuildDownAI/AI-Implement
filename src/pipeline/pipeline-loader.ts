import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { PipelineContext, PipelineDefinition, StepDefinition, StepType } from "./types.js";
import { resolveModule, type ResolveModuleOptions } from "./resolve-module.js";
import { buildIssueBranchName } from "./branch-name.js";

const VALID_STEP_TYPES = new Set<StepType>([
  "clone",
  "install",
  "implement",
  "review",
  "preflight",
  "push",
  "await_ci",
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
          baseBranch: ctx.data.baseBranch,
          prNumber: ctx.data.prNumber,
          orchestratorUrl: ctx.data.orchestratorUrl,
          machineNonce: ctx.data.nonce,
        }),
      };

    case "install-skills":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => ({
          skillsRepoUrl: ctx.data.skillsRepo ?? "",
          githubToken: ctx.getOutputs("clone").githubToken,
        }),
        skip: (ctx: PipelineContext) => !ctx.data.skillsRepo,
      };

    case "dependency-auth":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => ({
          dependencyTokenScope: ctx.data.dependencyTokenScope,
          callbackUrl: ctx.data.callbackUrl,
          // RUN_PROGRESS_TOKEN is a live bearer secret — placing it here would
          // persist it to the step log and expose it via the admin API. The step
          // reads it directly from process.env instead.
        }),
        skip: (ctx: PipelineContext) => !ctx.data.dependencyTokenScope,
      };

    case "install":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => ({
          workspaceDir: ctx.getOutputs("clone").workspaceDir,
        }),
      };

    case "setup":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => ({
          workspaceDir: ctx.getOutputs("clone").workspaceDir,
          scriptPath: ctx.data.hooks?.setup,
        }),
        skip: (ctx: PipelineContext) => !ctx.data.hooks?.setup,
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
            provider: ctx.data.provider,
            maxTurns: ctx.data.maxTurns,
            maxIterations: ctx.data.maxIterations,
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
      // Push always runs after the feedback loop on an initial run: unapproved work ships
      // as a draft PR (with the reviewer feedback in the body) instead of being silently
      // discarded. Gap-fill runs are different: Claude commits and pushes to the *existing*
      // PR branch itself (the pipeline never owns git there — see run-autonomous.ts's
      // gap-fill prompt), so the tree is clean by the time push would run and it would just
      // throw "Nothing to commit" — turning an approved gap-fill into a red failure. Skip
      // push for every gap-fill run; run-autonomous.ts's outcome derivation handles both
      // gap-fill outcomes without push outputs (approved → gap-analysis success, unapproved
      // → coded failure callback with no prUrl plus autopsy).
      return {
        ...step,
        skip: (ctx: PipelineContext) => Boolean(ctx.data.prNumber),
        inputs: (ctx: PipelineContext) => {
          const fb = ctx.getOutputs("feedback-loop");
          const approved = fb.approved === true;
          return {
            workspaceDir: ctx.getOutputs("clone").workspaceDir,
            repoOwner: ctx.getOutputs("clone").repoOwner,
            repoRepo: ctx.getOutputs("clone").repoRepo,
            githubToken: ctx.getOutputs("clone").githubToken,
            orchestratorUrl: ctx.data.orchestratorUrl,
            machineNonce: ctx.data.nonce,
            branchName: buildIssueBranchName(ctx.data.issueIdentifier, ctx.data.issueTitle, ctx.data.branchPrefix),
            baseBranch: ctx.getOutputs("clone").branch,
            prTitle: `${ctx.data.issueIdentifier}: ${ctx.data.issueTitle}`,
            sensitiveFiles: ctx.data.sensitiveFiles,
            groupingParent: ctx.data.groupingParent,
            draft: !approved,
            reviewSummary: approved
              ? undefined
              : {
                  terminationReason: typeof fb.terminationReason === "string" ? fb.terminationReason : "unknown",
                  iterations: typeof fb.iterations === "number" ? fb.iterations : 0,
                  finalFeedback: typeof fb.finalFeedback === "string" ? fb.finalFeedback : "",
                  passes: Array.isArray(fb.passes) ? fb.passes : [],
                  ...(typeof fb.postMortem === "string" ? { postMortem: fb.postMortem } : {}),
                },
          };
        },
      };

    case "verify":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => ({
          workspaceDir: ctx.getOutputs("clone").workspaceDir,
          scriptPath: ctx.data.hooks?.verify,
        }),
        skip: (ctx: PipelineContext) => {
          if (!ctx.data.hooks?.verify) return true;
          return ctx.getOutputs("feedback-loop").approved !== true;
        },
      };

    case "post-push-review":
      return {
        ...step,
        inputs: (ctx: PipelineContext) => ({
          prNumber: String(ctx.getOutputs("push").prNumber ?? ""),
          workspaceDir: ctx.getOutputs("clone").workspaceDir,
          reviewProviders: ctx.getOutputs("install").reviewProviders,
        }),
        skip: (ctx: PipelineContext) => {
          // Never run further review/force-push cycles against an unapproved
          // draft — the review budget is already exhausted.
          if (ctx.getOutputs("feedback-loop").approved !== true) return true;
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
