import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { runHookScript } from "./hooks.js";

interface VerifyInputs extends Record<string, unknown> {
  workspaceDir: string;
  scriptPath?: string;
}

interface VerifyOutputs extends Record<string, unknown> {
  ran: boolean;
  skipped?: boolean;
}

export const verifyStep: StepModule<VerifyInputs, VerifyOutputs> = {
  async run(
    _context: PipelineContext,
    inputs: VerifyInputs,
    _reporter: StepReporter,
  ): Promise<VerifyOutputs> {
    if (!inputs.scriptPath) return { ran: false, skipped: true };
    const result = await runHookScript("verify", inputs.scriptPath, inputs.workspaceDir);
    if (result.exitCode !== 0) {
      throw new Error(`verify hook failed with exit code ${result.exitCode}`);
    }
    return { ran: true };
  },
};

export default verifyStep;
