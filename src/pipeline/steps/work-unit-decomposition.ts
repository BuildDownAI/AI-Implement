import { spawnSync } from "node:child_process";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { buildAllowedToolsArgs } from "./read-only-tools.js";

interface WorkUnitDecompositionInputs extends Record<string, unknown> {
  workspaceDir: string;
  issueTitle: string;
  issueDescription: string;
  analysisMarkdown: string;
  model?: string;
}

interface WorkUnitDecompositionOutputs extends Record<string, unknown> {
  workUnitsMarkdown: string;
}

export const workUnitDecompositionStep: StepModule<WorkUnitDecompositionInputs, WorkUnitDecompositionOutputs> = {
  async run(
    context: PipelineContext,
    inputs: WorkUnitDecompositionInputs,
    _reporter: StepReporter,
  ): Promise<WorkUnitDecompositionOutputs> {
    const { workspaceDir, issueTitle, issueDescription, analysisMarkdown, model } = inputs;
    const { issueIdentifier } = context.data;

    const prompt = `You are decomposing issue ${issueIdentifier}: ${issueTitle} into parallelizable work units for implementation by subagents.

Issue description:
${issueDescription}

## Architecture analysis
${analysisMarkdown}

Identify which pieces of work are independent (can be implemented in parallel by separate agents) and which are sequential (depend on other units completing first).

Output ONLY the following markdown, starting with the exact header line:

## 🔧 AI Planning: Work Units

### Independent (can be implemented in parallel)
For each independent work unit:
- **WU-N: Short name** — brief description. Files: \`file1\`, \`file2\`. No dependencies.

### Sequential (must follow independent units)
For each sequential work unit:
- **WU-N: Short name** — brief description. Files: \`file1\`, \`file2\`. Depends on: WU-X, WU-Y.

Each work unit must specify: name, description, files it touches, and dependencies (if any).
Aim for work units that a single focused subagent can complete in one session.`;

    const args = [
      "--dangerously-skip-permissions",
      ...buildAllowedToolsArgs(),
      "-p",
      prompt,
    ];
    if (model) args.unshift("--model", model);

    const result = spawnSync("claude", args, {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      maxBuffer: 100 * 1024 * 1024,
    });

    if (result.status !== 0) {
      const stderr = result.stderr?.toString() ?? "";
      throw new Error(`claude work-unit-decomposition failed (exit ${result.status ?? "null"}): ${stderr}`);
    }

    const workUnitsMarkdown = result.stdout?.toString().trim() ?? "";
    return { workUnitsMarkdown };
  },
};
