import { spawnSync } from "node:child_process";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { buildAllowedToolsArgs } from "./read-only-tools.js";

interface ExploreInputs extends Record<string, unknown> {
  workspaceDir: string;
  issueTitle: string;
  issueDescription: string;
  model?: string;
}

interface ExploreOutputs extends Record<string, unknown> {
  codebaseMap: string;
}

export const exploreCodebaseStep: StepModule<ExploreInputs, ExploreOutputs> = {
  async run(
    context: PipelineContext,
    inputs: ExploreInputs,
    _reporter: StepReporter,
  ): Promise<ExploreOutputs> {
    const { workspaceDir, issueTitle, issueDescription, model } = inputs;
    const { issueIdentifier } = context.data;

    const prompt = `You are performing a read-only codebase exploration for issue ${issueIdentifier}: ${issueTitle}.

Issue description:
${issueDescription}

Explore the repository and produce a concise codebase map covering:
1. Project structure — key directories and their purpose
2. Main modules, services, and components relevant to this issue
3. Existing patterns, conventions, and abstractions that implementations should follow
4. Related existing code that would be affected by or inform this issue

Output ONLY the codebase map in markdown. Include specific file paths and explain what each relevant file/module does. Focus on what is relevant to implementing this issue.

Do NOT create, edit, or delete any files.`;

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
      throw new Error(`claude explore-codebase failed (exit ${result.status ?? "null"}): ${stderr}`);
    }

    const codebaseMap = result.stdout?.toString().trim() ?? "";
    return { codebaseMap };
  },
};
