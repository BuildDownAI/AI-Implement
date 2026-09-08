import { spawnSync } from "node:child_process";
import type { PipelineContext, StepModule, StepReporter, RunTelemetry } from "../types.js";
import { formatLlmResultDetail } from "../step-utils.js";
import type { ReferenceRepoResult, ReferenceRepoResultCause } from "./reference-repos.js";

interface ImplementInputs extends Record<string, unknown> {
  workspaceDir: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  planningContext?: string;
  referenceRepoResults?: ReferenceRepoResult[];
}

interface ImplementOutputs extends Record<string, unknown> {
  filesChanged: string[];
  tokensUsed: number;
  exitCode: number;
  subagentCount: number;
  telemetry?: RunTelemetry;
}

function describeCause(cause: ReferenceRepoResultCause | undefined): string {
  switch (cause) {
    case "no-auth": return "the GitHub App is not installed on that owner";
    case "ref-not-found": return "the declared ref does not exist in the repository";
    case "token-error": return "the authentication token could not be minted for that owner";
    case "clone-error": return "a network or git error prevented the clone";
    case "path-invalid": return "the declared path is invalid or duplicated";
    default: return "an unknown error prevented the clone";
  }
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
    if (arrived.length > 0) lines.push("");
    lines.push(
      "",
      "The following repositories were declared but could not be cloned. Do not assert anything about their contents — treat them as unavailable.",
      "",
    );
    for (const r of missed) {
      lines.push(`- \`${r.repo}\`: ${describeCause(r.cause)}`);
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

    let fullPrompt = inputs.prompt;

    if (planningContext) {
      fullPrompt += `\n\n## Planning Context\n\n${planningContext}`;
    }

    if (referenceRepoResults && referenceRepoResults.length > 0) {
      fullPrompt += `\n\n${buildReferenceReposSection(referenceRepoResults)}`;
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
