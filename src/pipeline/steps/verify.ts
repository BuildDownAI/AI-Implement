import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { runHookScript } from "./hooks.js";

interface VerifyInputs extends Record<string, unknown> {
  workspaceDir: string;
  scriptPath: string;
}

interface VerifyOutputs extends Record<string, unknown> {
  ran: boolean;
}

export const verifyStep: StepModule<VerifyInputs, VerifyOutputs> = {
  async run(
    _context: PipelineContext,
    inputs: VerifyInputs,
    _reporter: StepReporter,
  ): Promise<VerifyOutputs> {
    const result = runHookScript("verify", inputs.scriptPath, inputs.workspaceDir);
    if (result.exitCode !== 0) {
      throw new Error(`verify hook failed with exit code ${result.exitCode}`);
    }
    return { ran: true };
  },
};

export default verifyStep;
