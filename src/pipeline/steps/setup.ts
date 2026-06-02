import type { PipelineContext, StepModule, StepReporter } from "../types.js";
import { runHookScript } from "./hooks.js";

interface SetupInputs extends Record<string, unknown> {
  workspaceDir: string;
  scriptPath: string;
}

interface SetupOutputs extends Record<string, unknown> {
  ran: boolean;
}

export const setupStep: StepModule<SetupInputs, SetupOutputs> = {
  async run(
    _context: PipelineContext,
    inputs: SetupInputs,
    _reporter: StepReporter,
  ): Promise<SetupOutputs> {
    const result = runHookScript("setup", inputs.scriptPath, inputs.workspaceDir);
    if (result.exitCode !== 0) {
      throw new Error(`setup hook failed with exit code ${result.exitCode}`);
    }
    return { ran: true };
  },
};

export default setupStep;
