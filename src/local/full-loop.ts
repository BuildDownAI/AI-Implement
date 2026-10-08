import {
  runPlanningLocally,
  type PlanningExecutor,
  type PlanningStageExecutor,
  type RunPlanningLocalOptions,
} from "../run-planning.js";
import type { spawn } from "node:child_process";
import {
  runAutonomousLocally,
  type RunLocalAutonomousOptions,
} from "../run-autonomous.js";
import { ConfiguredRunError, hasConfiguredIntent, prepareConfiguredRun, type ConfiguredRun, type ConfiguredRunOptions } from "../run-autonomous.js";
import type { LocalRunPass, LocalRunTokenSummary } from "./run-result.js";
import type { InvocationAttributionV1, LLMExecutor, PipelineDefinition, StepReporter } from "../pipeline/types.js";
import type { PipelineRunner } from "../pipeline/runner.js";
import type { ResolvedAgentSnapshotV1 } from "../run-config.js";

export type LocalExitClassification =
  | "success"
  | "plan_failed"
  | "implementation_failed"
  | "review_unapproved"
  | "review_error"
  | "iterations_exhausted"
  | "max_turns_exhausted"
  | "verification_failed"
  | "provider_unavailable";

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
  /** Resolved stage snapshot for configured local runs; absent = legacy behavior. */
  agentConfig?: ResolvedAgentSnapshotV1;
  /** Protected local configured-run source, prepared once and borrowed by every full-loop phase. */
  configured?: ConfiguredRunOptions;
  /** Trusted env source for hosted configured grants; absent means local legacy/config options only. */
  configuredEnv?: NodeJS.ProcessEnv;
  /** Called after the full-loop-owned configured run is finished; false means held or cleanup failed. */
  onConfiguredFinish?: (safe: boolean) => Promise<void>;
  /** Asynchronous stage executor for configured planning. */
  stageExecutor?: PlanningStageExecutor;
  /** Construction seam for the Claude child spawn of a configured planning run (tests only). */
  spawnImpl?: typeof spawn;
  reporter?: StepReporter;
  pipeline?: PipelineDefinition;
  runner?: PipelineRunner;
}

export interface LocalFullLoopResult {
  exitCode: number;
  /** Optional diagnostic attribution (AII-946); emission is AII-971. */
  attribution?: InvocationAttributionV1;
  classification: LocalExitClassification;
  planningExitCode: number;
  planningContext: string;
  /** True when planning produced at least one readable Markdown plan file. */
  planFound: boolean;
  /** Diagnostics string for plan_failed outcomes. */
  planDiagnostics: string;
  implementationExitCode: number;
  reviewApproved: boolean;
  reviewTerminationReason: string | null;
  iterations: number;
  passes: LocalRunPass[];
  finalFeedback: string;
  effectiveMaxTurns: number;
  effectiveMaxIterations: number;
  tokenSummary: LocalRunTokenSummary | null;
}

function configuredFailureResult(
  effectiveMaxTurns: number,
  effectiveMaxIterations: number,
  diagnostics: string,
): LocalFullLoopResult {
  return {
    exitCode: 1,
    classification: "plan_failed",
    planningExitCode: 1,
    planningContext: "",
    planFound: false,
    planDiagnostics: diagnostics,
    implementationExitCode: 0,
    reviewApproved: false,
    reviewTerminationReason: null,
    iterations: 0,
    passes: [],
    finalFeedback: "",
    effectiveMaxTurns,
    effectiveMaxIterations,
    tokenSummary: null,
  };
}

function describeLocalConfiguredFailure(err: unknown): string {
  const reason = err instanceof ConfiguredRunError ? err.reason : "bootstrap_invalid";
  return `Configured local full loop failed (${reason})`;
}

function hasConfiguredEnvIntent(env: NodeJS.ProcessEnv | undefined): boolean {
  if (!env) return false;
  return hasConfiguredIntent(env.AI_IMPLEMENT_RUN_CONFIG) || Boolean(env.AI_IMPLEMENT_LOCAL_AUTH_BOOTSTRAP_FILE);
}

export async function runLocalFullLoop(
  opts: LocalFullLoopOptions,
): Promise<LocalFullLoopResult> {
  const effectiveMaxTurns = opts.maxTurns ?? 50;
  const effectiveMaxIterations = opts.maxIterations ?? 3;
  let configured: ConfiguredRun | undefined;
  if (opts.agentConfig || opts.configured?.agentConfig || opts.configured?.localCredentialPort || opts.configured?.modelAuthClient || hasConfiguredEnvIntent(opts.configuredEnv)) {
    try {
      if (opts.agentConfig && opts.configured?.agentConfig && JSON.stringify(opts.agentConfig) !== JSON.stringify(opts.configured.agentConfig)) {
        throw new ConfiguredRunError("snapshot_incomplete");
      }
      configured = await prepareConfiguredRun({
        env: opts.configuredEnv ?? {},
        snapshot: opts.agentConfig,
        workspaceDir: opts.workspaceDir,
        options: opts.configured,
      });
      if (!configured) throw new ConfiguredRunError("bootstrap_missing");
      const expectedSnapshot = opts.agentConfig ?? opts.configured?.agentConfig;
      if (expectedSnapshot && JSON.stringify(expectedSnapshot) !== JSON.stringify(configured.snapshot)) {
        throw new ConfiguredRunError("snapshot_incomplete");
      }
    } catch (err) {
      try {
        await opts.onConfiguredFinish?.(false);
      } catch (finishErr) {
        console.error("[dev:run] configured finish callback failed: callback_error");
      }
      return configuredFailureResult(effectiveMaxTurns, effectiveMaxIterations, describeLocalConfiguredFailure(err));
    }
  }
  let result: LocalFullLoopResult | undefined;

  try {
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
      agentConfig: configured?.snapshot ?? opts.agentConfig,
      configured: opts.configured,
      configuredEnv: opts.configuredEnv,
      prebuiltConfiguredRun: configured,
      spawnImpl: opts.spawnImpl,
    };

    const planResult = await runPlanningLocally(planOpts);

    if (planResult.exitCode !== 0) {
      result = {
        exitCode: 1,
        classification: "plan_failed",
        planningExitCode: planResult.exitCode,
        planningContext: "",
        planFound: planResult.planFound,
        planDiagnostics: planResult.diagnostics,
        implementationExitCode: 0,
        reviewApproved: false,
        reviewTerminationReason: null,
        iterations: 0,
        passes: [],
        finalFeedback: "",
        effectiveMaxTurns,
        effectiveMaxIterations,
        tokenSummary: null,
      };
      return result;
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
      configured: opts.configured,
      configuredEnv: opts.configuredEnv,
      prebuiltConfiguredRun: configured,
      pipeline: opts.pipeline,
      runner: opts.runner,
    };

    const implResult = await runAutonomousLocally(implOpts);

    let classification: LocalExitClassification;
    let exitCode: number;

    if (implResult.terminationReason === "verify_failed") {
      classification = "verification_failed";
      exitCode = 1;
    } else if (implResult.terminationReason === "provider_unavailable") {
      // A provider outage during implement or review is a transient run-level
      // failure, not a review rejection — classify it distinctly so a caller
      // doesn't read it as "the reviewer didn't approve".
      classification = "provider_unavailable";
      exitCode = 1;
    } else if (implResult.exitCode !== 0) {
      classification = "implementation_failed";
      exitCode = 1;
    } else if (implResult.terminationReason === "max_turns") {
      classification = "max_turns_exhausted";
      exitCode = 1;
    } else if (implResult.terminationReason === "review_error") {
      classification = "review_error";
      exitCode = 1;
    } else if (implResult.terminationReason === "iterations_exhausted") {
      classification = "iterations_exhausted";
      exitCode = 1;
    } else if (!implResult.approved) {
      classification = "review_unapproved";
      exitCode = 1;
    } else {
      classification = "success";
      exitCode = 0;
    }

    result = {
      exitCode,
      classification,
      planningExitCode: planResult.exitCode,
      planningContext: planResult.planningContext,
      planFound: planResult.planFound,
      planDiagnostics: planResult.diagnostics,
      implementationExitCode: implResult.exitCode,
      reviewApproved: implResult.approved,
      reviewTerminationReason: implResult.terminationReason || null,
      iterations: implResult.iterations,
      passes: implResult.passes,
      finalFeedback: implResult.finalFeedback,
      effectiveMaxTurns: implResult.effectiveMaxTurns,
      effectiveMaxIterations: implResult.effectiveMaxIterations,
      tokenSummary: implResult.tokenSummary,
    };
    return result;
  } finally {
    if (configured) {
      let safe = false;
      try {
        safe = await configured.finish(result?.exitCode === 0 ? "completed" : "failed");
      } finally {
        try {
          await opts.onConfiguredFinish?.(safe);
        } catch (err) {
          console.error("[dev:run] configured finish callback failed: callback_error");
          safe = false;
        }
      }
      if (result && result.exitCode === 0 && !safe) {
        result.exitCode = 1;
        result.classification = "provider_unavailable";
        result.finalFeedback = "Configured credential cleanup was held or could not be confirmed";
      }
    }
  }
}
