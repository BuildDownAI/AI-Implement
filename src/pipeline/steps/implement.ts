import { spawnSync } from "node:child_process";
import type { PipelineContext, StepModule, StepReporter, RunTelemetry } from "../types.js";
import { formatLlmResultDetail } from "../step-utils.js";
import { classifyLlmResult, type FailureRecord } from "../failure-classification.js";
import { describeReferenceRepoCause, type ReferenceRepoResult } from "../../reference-repos.js";

interface ImplementInputs extends Record<string, unknown> {
  workspaceDir: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  planningContext?: string;
  referenceRepoResults?: ReferenceRepoResult[];
  /** Feedback-loop iteration this call belongs to (AII-798); defaults to 1. */
  iteration?: number;
}

interface ImplementOutputs extends Record<string, unknown> {
  filesChanged: string[];
  tokensUsed: number;
  exitCode: number;
  subagentCount: number;
  telemetry?: RunTelemetry;
  attempts: number;
}

function buildReferenceReposSection(results: ReferenceRepoResult[]): string {
  const arrived = results.filter((r) => r.arrived);
  const missed = results.filter((r) => !r.arrived);
  const lines: string[] = ["## Reference Repositories"];

  if (arrived.length > 0) {
    lines.push(
      "",
      "The following repositories are available in the workspace as read-only reference material. Read them for context and do not modify them.",
      "",
    );
    for (const r of arrived) {
      lines.push(`- \`${r.repo}\` — available at \`${r.path}\``);
    }
  }

  if (missed.length > 0) {
    lines.push(
      "",
      "The following repositories were declared but could not be cloned. Do not assert anything about their contents — treat them as unavailable.",
      "",
    );
    for (const r of missed) {
      lines.push(`- \`${r.repo}\`: ${describeReferenceRepoCause(r.cause)}`);
    }
  }

  return lines.join("\n");
}

export const implementStep: StepModule<ImplementInputs, ImplementOutputs> = {
  async run(
    context: PipelineContext,
    inputs: ImplementInputs,
    _reporter: StepReporter,
  ): Promise<ImplementOutputs> {
    const { workspaceDir, model, maxTurns, planningContext, referenceRepoResults } = inputs;
    const iteration = typeof inputs.iteration === "number" ? inputs.iteration : 1;

    let fullPrompt = inputs.prompt;

    if (planningContext) {
      fullPrompt += `\n\n## Planning Context\n\n${planningContext}`;
    }

    if (referenceRepoResults && referenceRepoResults.length > 0) {
      fullPrompt += `\n\n${buildReferenceReposSection(referenceRepoResults)}`;
    }

    const { retryPolicy } = context.data;
    const result = await context.llmExecutor.invoke({
      prompt: fullPrompt,
      model: model ?? "claude-sonnet-5",
      maxTurns,
      stage: "implement",
      expectsStructuredOutput: false,
      retry: retryPolicy ? { policy: retryPolicy, toolUseIsSafe: false } : undefined,
      cycle: iteration,
    });

    // A max_turns termination is a completed-but-capped pass, not an invocation
    // failure: the feedback loop needs the partial work + telemetry to run its
    // post-mortem and open a draft PR, so don't discard it by throwing.
    if (result.exitCode !== 0 && result.telemetry?.outcome !== "max_turns") {
      const err = new Error(
        `LLM invocation failed with exit code ${result.exitCode}${formatLlmResultDetail(result)}`,
      ) as Error & { failure?: FailureRecord; telemetry?: RunTelemetry };
      // The executor already classified this failure (with the correct
      // expectsStructuredOutput/attempt/elapsedMs) when deciding whether to retry.
      // A custom LLMExecutor (e.g. a test seam) may settle a non-zero exit without
      // attaching one at all — fall back to classifying it here so failure_json is
      // never empty just because the executor that produced this result didn't.
      err.failure =
        result.failure ??
        classifyLlmResult(result, {
          stage: "implement",
          attempt: result.attempts ?? 1,
          expectsStructuredOutput: false,
          elapsedMs: result.telemetry?.durationMs ?? undefined,
        });
      // Carry whatever telemetry this settled (but failing) attempt reported —
      // a spawn-level rejection already stamps this on the executor's own thrown
      // error, but a settled LLMResult never did; without it the failed sub-step
      // report built from this error would lose the tokens/cost this attempt burned.
      err.telemetry = result.telemetry;
      throw err;
    }

    return {
      filesChanged: getChangedFiles(workspaceDir),
      tokensUsed: result.tokensUsed,
      exitCode: result.exitCode,
      subagentCount: 0,
      telemetry: result.telemetry,
      attempts: result.attempts ?? 1,
    };
  },
};

function getChangedFiles(workspaceDir: string): string[] {
  const result = spawnSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return [];
  return result.stdout
    .toString()
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}
