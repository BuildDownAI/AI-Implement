import { PipelineRunner } from "./runner.js";
import type { PipelineDefinition, StepModule } from "./types.js";
import { cloneStep } from "./steps/clone.js";
import { feedbackLoopStep } from "./steps/feedback-loop.js";
import { installStep } from "./steps/install.js";
import { preflightStep } from "./steps/preflight.js";
import { pushStep } from "./steps/push.js";
import { loadPipelineDefinition } from "./pipeline-loader.js";
import { resolveModuleImport, type ImportModuleOptions } from "./resolve-module.js";

/**
 * Default autonomous loop pipeline loaded from pipelines/autonomous.yml.
 * A custom/pipelines/autonomous.yml in the working directory takes precedence.
 */
export const DEFAULT_PIPELINE: PipelineDefinition = loadPipelineDefinition(
  "pipelines/autonomous.yml",
);

const BUILTIN_STEPS: Array<[string, StepModule]> = [
  ["clone", cloneStep],
  ["install", installStep],
  ["feedback-loop", feedbackLoopStep],
  ["preflight", preflightStep],
  ["push", pushStep],
];

/**
 * Build a PipelineRunner with all default step modules registered.
 * For each built-in step, custom/steps/<id>.ts (or .js) takes precedence when
 * present. Custom step files must export a StepModule as their default export.
 */
export async function createDefaultRunner(
  options?: ImportModuleOptions,
): Promise<PipelineRunner> {
  const runner = new PipelineRunner();
  for (const [id, builtin] of BUILTIN_STEPS) {
    const custom = await resolveModuleImport<StepModule>(`steps/${id}`, options);
    runner.register(id, custom ?? builtin);
  }
  return runner;
}
