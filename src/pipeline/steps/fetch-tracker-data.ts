import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repoProcessEnv } from "../process-env.js";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

// Fixed path in the runner image. repoProcessEnv() keeps RUN_PROGRESS_TOKEN so
// the script can authenticate against the orchestrator's kg-tracker-data proxy.
const FETCH_SCRIPT = "/app/session/fetch-kg-tracker-data.sh";

interface FetchTrackerDataInputs extends Record<string, unknown> {
  workspaceDir: string;
}

export const fetchTrackerDataStep: StepModule<FetchTrackerDataInputs> = {
  async run(
    _context: PipelineContext,
    inputs: FetchTrackerDataInputs,
    _reporter: StepReporter,
  ): Promise<Record<string, unknown>> {
    const outputFile = join(inputs.workspaceDir, "tracker-data.json");
    const result = spawnSync("bash", [FETCH_SCRIPT, outputFile], {
      cwd: inputs.workspaceDir,
      env: repoProcessEnv(),
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) {
      throw new Error(`fetch-kg-tracker-data.sh exited ${result.status ?? "null"}`);
    }
    return {};
  },
};

export default fetchTrackerDataStep;
