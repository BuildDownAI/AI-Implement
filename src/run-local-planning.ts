import { runPlanningLocally } from "./run-planning.js";
import { decodeRunConfig } from "./run-config.js";
import { prepareScratchExclusion } from "./pipeline/scratch-exclude.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface LocalPlanningRunnerDependencies {
  runPlanning: typeof runPlanningLocally;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
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
  if (existsSync(join(workspaceDir, ".git"))) {
    prepareScratchExclusion(workspaceDir);
  }
  deps.writeStdout("[dev:run] planning: analyzing repository and writing plan artifacts\n");
  const result = await deps.runPlanning({
    workspaceDir,
    issueIdentifier: config.issue.identifier,
    issueTitle: config.issue.title,
    issueDescription: config.issue.description,
    model: env.CLAUDE_MODEL,
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
