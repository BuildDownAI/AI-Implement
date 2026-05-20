import { spawnSync } from "node:child_process";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

export interface WorkUnit {
  id: string;
  title: string;
  files?: string[];
  dependencies?: string[];
}

interface ImplementInputs extends Record<string, unknown> {
  workspaceDir: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  planningContext?: string;
  workUnits?: WorkUnit[];
}

interface ImplementOutputs extends Record<string, unknown> {
  filesChanged: string[];
  tokensUsed: number;
  exitCode: number;
  subagentCount: number;
}

const PARALLEL_IMPL_INSTRUCTIONS = `

## Parallel Implementation

If the planning context includes a "Work Units" section with independent units,
use subagents (Task tool) to implement them in parallel:
- Assign each independent work unit to a separate subagent
- Scope each subagent to the files listed in its work unit
- After all independent units complete, implement sequential units yourself
- Review all changes together for consistency before proceeding
- If no work units are provided, implement the full issue in a single pass`;

export const implementStep: StepModule<ImplementInputs, ImplementOutputs> = {
  async run(
    context: PipelineContext,
    inputs: ImplementInputs,
    _reporter: StepReporter,
  ): Promise<ImplementOutputs> {
    const { workspaceDir, model, maxTurns, planningContext, workUnits } = inputs;

    let fullPrompt = inputs.prompt;

    if (planningContext) {
      fullPrompt += `\n\n## Planning Context\n\n${planningContext}`;
    }

    if (workUnits && workUnits.length > 0) {
      const unitsSection = workUnits
        .map((u) => {
          let entry = `### ${u.id}: ${u.title}`;
          if (u.files?.length) entry += `\nFiles: ${u.files.join(", ")}`;
          if (u.dependencies?.length) entry += `\nDependencies: ${u.dependencies.join(", ")}`;
          return entry;
        })
        .join("\n\n");
      fullPrompt += `\n\n## Work Units\n\n${unitsSection}`;
      fullPrompt += PARALLEL_IMPL_INSTRUCTIONS;
    }

    const result = await context.llmExecutor.invoke({
      prompt: fullPrompt,
      model: model ?? "claude-sonnet-4-6",
      maxTurns,
    });

    if (result.exitCode !== 0) {
      throw new Error(`LLM invocation failed with exit code ${result.exitCode}${llmResultDetail(result)}`);
    }

    return {
      filesChanged: getChangedFiles(workspaceDir),
      tokensUsed: result.tokensUsed,
      exitCode: result.exitCode,
      // subagentCount is not observable from the CLI's stdout; when workUnits parallelism
      // is triggered, subagents run inside the single Claude session and are not reported
      // separately. This always returns 0 until the CLI exposes subagent metrics.
      subagentCount: 0,
    };
  },
};

function llmResultDetail(result: { stdout?: string; stderr?: string }): string {
  const detail = (result.stderr || result.stdout || "").trim();
  return detail ? `: ${detail}` : "";
}

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
