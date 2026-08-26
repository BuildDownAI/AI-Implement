import { spawnSync } from "node:child_process";
import type { PipelineContext, StepModule, StepReporter, RunTelemetry } from "../types.js";
import { formatLlmResultDetail } from "../step-utils.js";

interface ImplementInputs extends Record<string, unknown> {
  workspaceDir: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  planningContext?: string;
}

interface ImplementOutputs extends Record<string, unknown> {
  filesChanged: string[];
  tokensUsed: number;
  exitCode: number;
  subagentCount: number;
  telemetry?: RunTelemetry;
}

export const implementStep: StepModule<ImplementInputs, ImplementOutputs> = {
  async run(
    context: PipelineContext,
    inputs: ImplementInputs,
    _reporter: StepReporter,
  ): Promise<ImplementOutputs> {
    const { workspaceDir, model, maxTurns, planningContext } = inputs;

    let fullPrompt = inputs.prompt;

    if (planningContext) {
      fullPrompt += `\n\n## Planning Context\n\n${planningContext}`;
    }

    const result = await context.llmExecutor.invoke({
      prompt: fullPrompt,
      model: model ?? "claude-sonnet-4-6",
      maxTurns,
    });

    // A max_turns termination is a completed-but-capped pass, not an invocation
    // failure: the feedback loop needs the partial work + telemetry to run its
    // post-mortem and open a draft PR, so don't discard it by throwing.
    if (result.exitCode !== 0 && result.telemetry?.outcome !== "max_turns") {
      throw new Error(`LLM invocation failed with exit code ${result.exitCode}${formatLlmResultDetail(result)}`);
    }

    return {
      filesChanged: getChangedFiles(workspaceDir),
      tokensUsed: result.tokensUsed,
      exitCode: result.exitCode,
      subagentCount: 0,
      telemetry: result.telemetry,
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
