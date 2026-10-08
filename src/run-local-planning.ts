import { runPlanningLocally } from "./run-planning.js";
import { decodeRunConfig } from "./run-config.js";
import type { ModelAuthClient } from "./model-auth-client.js";
import { prepareScratchExclusionIfGit } from "./pipeline/scratch-exclude.js";

export interface LocalPlanningRunnerDependencies {
  runPlanning: typeof runPlanningLocally;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  /**
   * Selected-credential client for configured runs; absent fails closed when `agentConfig` is present. The default
   * dependencies supply none: building it from the bootstrap is owned by the runner bootstrap issues
   * (AII-951/AII-955/AII-965), not a second resolver here.
   */
  auth?: Pick<ModelAuthClient, "invoke">;
}

const DEFAULT_DEPENDENCIES: LocalPlanningRunnerDependencies = {
  runPlanning: runPlanningLocally,
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

export async function runLocalPlanningFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalPlanningRunnerDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const encoded = env.AI_IMPLEMENT_RUN_CONFIG;
  if (!encoded) throw new Error("Missing required env var: AI_IMPLEMENT_RUN_CONFIG");

  const config = decodeRunConfig(encoded);
  const workspaceDir = env.WORKSPACE_DIR ?? "/workspace";
  prepareScratchExclusionIfGit(workspaceDir);
  deps.writeStdout("[dev:run] planning: analyzing repository and writing plan artifacts\n");
  const result = await deps.runPlanning({
    workspaceDir,
    issueIdentifier: config.issue.identifier,
    issueTitle: config.issue.title,
    issueDescription: config.issue.description,
    model: env.CLAUDE_MODEL,
    ...(config.planningContext?.parent !== undefined ? { parent: config.planningContext.parent } : {}),
    ...(config.planningContext?.siblings !== undefined ? { siblings: config.planningContext.siblings } : {}),
    ...(config.planningContext?.dependencies !== undefined ? { dependencies: config.planningContext.dependencies } : {}),
    ...(config.agentConfig ? { agentConfig: config.agentConfig } : {}),
    ...(deps.auth ? { auth: deps.auth } : {}),
  });

  if (result.exitCode !== 0) {
    deps.writeStderr(`[dev:run] planning failed: ${result.diagnostics}\n`);
    return 1;
  }
  deps.writeStdout("[dev:run] planning complete: plan.md will be saved with run artifacts\n");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLocalPlanningFromEnv()
    .then((exitCode) => process.exit(exitCode))
    .catch((err) => {
      process.stderr.write(`[dev:run] planning failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
