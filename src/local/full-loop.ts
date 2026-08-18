import {
  runPlanningLocally,
  type PlanningExecutor,
  type RunPlanningLocalOptions,
} from "../run-planning.js";
import {
  runAutonomousLocally,
  type RunLocalAutonomousOptions,
} from "../run-autonomous.js";
import type { LocalRunPass } from "./run-result.js";
import type { LLMExecutor, PipelineDefinition, StepReporter } from "../pipeline/types.js";
import type { PipelineRunner } from "../pipeline/runner.js";

export type LocalExitClassification =
  | "success"
  | "plan_failed"
  | "implementation_failed"
  | "review_unapproved"
  | "max_turns_exhausted";

export interface LocalFullLoopOptions {
  workspaceDir: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  issueId?: string;
  parent?: string;
  siblings?: string;
  dependencies?: string;
  maxTurns?: number;
  maxIterations?: number;
  model?: string;
  planningExecutor?: PlanningExecutor;
  llmExecutor?: LLMExecutor;
  reporter?: StepReporter;
  pipeline?: PipelineDefinition;
  runner?: PipelineRunner;
}

export interface LocalFullLoopResult {
  exitCode: number;
  classification: LocalExitClassification;
  planningExitCode: number;
  planningContext: string;
  implementationExitCode: number;
  reviewApproved: boolean;
  reviewTerminationReason: string | null;
  iterations: number;
  passes: LocalRunPass[];
  finalFeedback: string;
}

export async function runLocalFullLoop(
  opts: LocalFullLoopOptions,
): Promise<LocalFullLoopResult> {
  const planOpts: RunPlanningLocalOptions = {
    workspaceDir: opts.workspaceDir,
    issueIdentifier: opts.issueIdentifier,
    issueTitle: opts.issueTitle,
    issueDescription: opts.issueDescription,
    parent: opts.parent,
    siblings: opts.siblings,
    dependencies: opts.dependencies,
    model: opts.model,
    executor: opts.planningExecutor,
  };

  const planResult = await runPlanningLocally(planOpts);

  if (planResult.exitCode !== 0) {
    return {
      exitCode: 1,
      classification: "plan_failed",
      planningExitCode: planResult.exitCode,
      planningContext: "",
      implementationExitCode: 0,
      reviewApproved: false,
      reviewTerminationReason: null,
      iterations: 0,
      passes: [],
      finalFeedback: "",
    };
  }

  const implOpts: RunLocalAutonomousOptions = {
    workspaceDir: opts.workspaceDir,
    issueIdentifier: opts.issueIdentifier,
    issueTitle: opts.issueTitle,
    issueDescription: opts.issueDescription,
    issueId: opts.issueId,
    maxTurns: opts.maxTurns,
    maxIterations: opts.maxIterations,
    model: opts.model,
    planningContext: planResult.planningContext,
    llmExecutor: opts.llmExecutor,
    reporter: opts.reporter,
    pipeline: opts.pipeline,
    runner: opts.runner,
  };

  const implResult = await runAutonomousLocally(implOpts);

  let classification: LocalExitClassification;
  let exitCode: number;

  if (implResult.exitCode !== 0) {
    classification = "implementation_failed";
    exitCode = 1;
  } else if (implResult.terminationReason === "max_turns") {
    classification = "max_turns_exhausted";
    exitCode = 1;
  } else if (!implResult.approved) {
    classification = "review_unapproved";
    exitCode = 1;
  } else {
    classification = "success";
    exitCode = 0;
  }

  return {
    exitCode,
    classification,
    planningExitCode: planResult.exitCode,
    planningContext: planResult.planningContext,
    implementationExitCode: implResult.exitCode,
    reviewApproved: implResult.approved,
    reviewTerminationReason: implResult.terminationReason || null,
    iterations: implResult.iterations,
    passes: implResult.passes,
    finalFeedback: implResult.finalFeedback,
  };
}
