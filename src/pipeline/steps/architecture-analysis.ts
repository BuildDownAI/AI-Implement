import { spawnSync } from "node:child_process";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { buildAllowedToolsArgs } from "./read-only-tools.js";

interface ArchitectureAnalysisInputs extends Record<string, unknown> {
  workspaceDir: string;
  issueTitle: string;
  issueDescription: string;
  codebaseMap: string;
  model?: string;
}

interface ArchitectureAnalysisOutputs extends Record<string, unknown> {
  analysisMarkdown: string;
}

export const architectureAnalysisStep: StepModule<ArchitectureAnalysisInputs, ArchitectureAnalysisOutputs> = {
  async run(
    context: PipelineContext,
    inputs: ArchitectureAnalysisInputs,
    _reporter: StepReporter,
  ): Promise<ArchitectureAnalysisOutputs> {
    const { workspaceDir, issueTitle, issueDescription, codebaseMap, model } = inputs;
    const { issueIdentifier } = context.data;

    const prompt = `You are a senior software architect analyzing how to implement issue ${issueIdentifier}: ${issueTitle}.

Issue description:
${issueDescription}

## Codebase context
${codebaseMap}

Produce an architecture analysis comment for Linear. You may use Read, Glob, Grep to inspect specific files for deeper detail.

Output ONLY the following markdown, starting with the exact header line:

## 🏗️ AI Planning: Architecture Analysis

### Approach
1-3 sentences describing the implementation strategy.

### Files to Create/Modify
List each file path with a one-line description of the change.

### Key Decisions
Architectural choices and rationale — data models, API boundaries, naming, patterns.

### Risks & Open Questions
Edge cases, unknowns, and potential problems to watch out for.

Base your analysis on the actual codebase — avoid generic boilerplate.`;

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
      throw new Error(`claude architecture-analysis failed (exit ${result.status ?? "null"}): ${stderr}`);
    }

    const analysisMarkdown = result.stdout?.toString().trim() ?? "";
    return { analysisMarkdown };
  },
};
