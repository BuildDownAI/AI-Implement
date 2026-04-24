import { spawnSync } from "node:child_process";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { buildAllowedToolsArgs } from "./read-only-tools.js";

interface CrossStoryContextInputs extends Record<string, unknown> {
  workspaceDir: string;
  issueTitle: string;
  issueDescription: string;
  codebaseMap: string;
  parent: string;
  siblings: string;
  dependencies: string;
  model?: string;
}

interface CrossStoryContextOutputs extends Record<string, unknown> {
  crossStoryMarkdown: string;
}

export const crossStoryContextStep: StepModule<CrossStoryContextInputs, CrossStoryContextOutputs> = {
  async run(
    context: PipelineContext,
    inputs: CrossStoryContextInputs,
    _reporter: StepReporter,
  ): Promise<CrossStoryContextOutputs> {
    const { workspaceDir, issueTitle, issueDescription, codebaseMap, parent, siblings, dependencies, model } = inputs;
    const { issueIdentifier } = context.data;

    const prompt = `You are analyzing the cross-story dependencies for issue ${issueIdentifier}: ${issueTitle}.

Issue description:
${issueDescription}

## Related issues

**Parent issue:**
${parent}

**Sibling stories:**
${siblings}

**Dependencies:**
${dependencies}

## Codebase context
${codebaseMap}

Produce a cross-story context comment for Linear describing coordination needs across issues.

Output ONLY the following markdown, starting with the exact header line:

## 🔗 AI Planning: Cross-Story Context

### Upstream Dependencies
What must be completed in other issues before this story can begin or proceed.

### Downstream Impact
Stories or systems that will depend on the output of this work.

### Coordination Notes
Specific actions needed to coordinate with other teams or stories — shared interfaces, API contracts, migration order, etc.

Base your analysis on what you actually find — avoid generic boilerplate.`;

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
      throw new Error(`claude cross-story-context failed (exit ${result.status ?? "null"}): ${stderr}`);
    }

    const crossStoryMarkdown = result.stdout?.toString().trim() ?? "";
    return { crossStoryMarkdown };
  },
};
