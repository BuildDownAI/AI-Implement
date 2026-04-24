import { spawnSync } from "node:child_process";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { buildAllowedToolsArgs } from "./read-only-tools.js";

interface TestPlanInputs extends Record<string, unknown> {
  workspaceDir: string;
  issueTitle: string;
  issueDescription: string;
  codebaseMap: string;
  analysisMarkdown: string;
  model?: string;
}

interface TestPlanOutputs extends Record<string, unknown> {
  testPlanMarkdown: string;
}

export const testPlanStep: StepModule<TestPlanInputs, TestPlanOutputs> = {
  async run(
    context: PipelineContext,
    inputs: TestPlanInputs,
    _reporter: StepReporter,
  ): Promise<TestPlanOutputs> {
    const { workspaceDir, issueTitle, issueDescription, codebaseMap, analysisMarkdown, model } = inputs;
    const { issueIdentifier } = context.data;

    const prompt = `You are a senior software engineer writing a test plan for issue ${issueIdentifier}: ${issueTitle}.

Issue description:
${issueDescription}

## Codebase context
${codebaseMap}

## Architecture analysis
${analysisMarkdown}

Produce a test plan comment for Linear. You may use Read, Glob, Grep to inspect existing tests and patterns.

Output ONLY the following markdown, starting with the exact header line:

## 🧪 AI Planning: Test Plan

### Unit Tests
List individual components, functions, or modules to unit-test with a brief description of what each test validates.

### Integration Tests
List end-to-end or cross-component scenarios to verify correct integration.

### Manual Verification
Step-by-step checklist a human reviewer should follow to verify the feature works correctly.

Base your test plan on the actual test patterns found in this codebase — avoid generic boilerplate.`;

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
      throw new Error(`claude test-plan failed (exit ${result.status ?? "null"}): ${stderr}`);
    }

    const testPlanMarkdown = result.stdout?.toString().trim() ?? "";
    return { testPlanMarkdown };
  },
};
