import { PipelineRunner } from "./runner.js";
import type { PipelineContext, PipelineDefinition } from "./types.js";
import { cloneStep } from "./steps/clone.js";
import { exploreCodebaseStep } from "./steps/explore-codebase.js";
import { architectureAnalysisStep } from "./steps/architecture-analysis.js";
import { testPlanStep } from "./steps/test-plan.js";
import { workUnitDecompositionStep } from "./steps/work-unit-decomposition.js";
import { crossStoryContextStep } from "./steps/cross-story-context.js";
import { postToTicketingStep } from "./steps/post-to-ticketing.js";

function hasRelatedIssues(ctx: PipelineContext): boolean {
  const { parent, siblings, dependencies } = ctx.data;
  const isNone = (v: string | undefined) => !v || v.trim() === "None";
  return !isNone(parent) || !isNone(siblings) || !isNone(dependencies);
}

/**
 * Planning pipeline: clone → explore-codebase → architecture-analysis → test-plan →
 * work-unit-decomposition → cross-story-context (conditional) → post-to-ticketing.
 *
 * All Claude invocations run with read-only tool constraints (Read, Glob, Grep, Bash(curl *)).
 * cross-story-context is skipped when the issue has no parent, siblings, or dependencies.
 * Requires LINEAR_API_KEY env var for the post-to-ticketing step (when ticketingProvider="linear").
 */
export const PLANNING_PIPELINE: PipelineDefinition = {
  id: "planning",
  steps: [
    {
      id: "clone",
      type: "clone",
    },
    {
      id: "explore-codebase",
      type: "explore-codebase",
      inputs: (ctx: PipelineContext) => ({
        workspaceDir: ctx.getOutputs("clone").workspaceDir,
        issueTitle: ctx.data.issueTitle,
        issueDescription: ctx.data.issueDescription,
        ...(ctx.data.model ? { model: ctx.data.model } : {}),
      }),
    },
    {
      id: "architecture-analysis",
      type: "architecture-analysis",
      inputs: (ctx: PipelineContext) => ({
        workspaceDir: ctx.getOutputs("clone").workspaceDir,
        issueTitle: ctx.data.issueTitle,
        issueDescription: ctx.data.issueDescription,
        codebaseMap: ctx.getOutputs("explore-codebase").codebaseMap,
        ...(ctx.data.model ? { model: ctx.data.model } : {}),
      }),
    },
    {
      id: "test-plan",
      type: "test-plan",
      inputs: (ctx: PipelineContext) => ({
        workspaceDir: ctx.getOutputs("clone").workspaceDir,
        issueTitle: ctx.data.issueTitle,
        issueDescription: ctx.data.issueDescription,
        codebaseMap: ctx.getOutputs("explore-codebase").codebaseMap,
        analysisMarkdown: ctx.getOutputs("architecture-analysis").analysisMarkdown,
        ...(ctx.data.model ? { model: ctx.data.model } : {}),
      }),
    },
    {
      id: "work-unit-decomposition",
      type: "work-unit-decomposition",
      inputs: (ctx: PipelineContext) => ({
        workspaceDir: ctx.getOutputs("clone").workspaceDir,
        issueTitle: ctx.data.issueTitle,
        issueDescription: ctx.data.issueDescription,
        analysisMarkdown: ctx.getOutputs("architecture-analysis").analysisMarkdown,
        ...(ctx.data.model ? { model: ctx.data.model } : {}),
      }),
    },
    {
      id: "cross-story-context",
      type: "cross-story-context",
      inputs: (ctx: PipelineContext) => ({
        workspaceDir: ctx.getOutputs("clone").workspaceDir,
        issueTitle: ctx.data.issueTitle,
        issueDescription: ctx.data.issueDescription,
        codebaseMap: ctx.getOutputs("explore-codebase").codebaseMap,
        parent: ctx.data.parent ?? "None",
        siblings: ctx.data.siblings ?? "None",
        dependencies: ctx.data.dependencies ?? "None",
        ...(ctx.data.model ? { model: ctx.data.model } : {}),
      }),
      skip: (ctx: PipelineContext) => !hasRelatedIssues(ctx),
    },
    {
      id: "post-to-ticketing",
      type: "post-to-ticketing",
      inputs: (ctx: PipelineContext) => ({
        analysisMarkdown: ctx.getOutputs("architecture-analysis").analysisMarkdown,
        testPlanMarkdown: ctx.getOutputs("test-plan").testPlanMarkdown,
        workUnitsMarkdown: ctx.getOutputs("work-unit-decomposition").workUnitsMarkdown,
        crossStoryMarkdown: ctx.getOutputs("cross-story-context").crossStoryMarkdown ?? "",
      }),
    },
  ],
};

/** Build a PipelineRunner with all planning step modules registered. */
export function createPlanningRunner(): PipelineRunner {
  return new PipelineRunner()
    .register("clone", cloneStep)
    .register("explore-codebase", exploreCodebaseStep)
    .register("architecture-analysis", architectureAnalysisStep)
    .register("test-plan", testPlanStep)
    .register("work-unit-decomposition", workUnitDecompositionStep)
    .register("cross-story-context", crossStoryContextStep)
    .register("post-to-ticketing", postToTicketingStep);
}
