import { runLocalFullLoop } from "./local/full-loop.js";
import { decodeRunConfig } from "./run-config.js";

export interface LocalFullLoopRunnerDependencies {
  runFullLoop: typeof runLocalFullLoop;
  writeStdout: (text: string) => void;
}

const DEFAULT_DEPENDENCIES: LocalFullLoopRunnerDependencies = {
  runFullLoop: runLocalFullLoop,
  writeStdout: (text) => process.stdout.write(text),
};

export async function runLocalFullLoopFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: LocalFullLoopRunnerDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const encoded = env.AI_IMPLEMENT_RUN_CONFIG;
  if (!encoded) throw new Error("Missing required env var: AI_IMPLEMENT_RUN_CONFIG");

  const config = decodeRunConfig(encoded);
  const workspaceDir = env.WORKSPACE_DIR ?? "/workspace";

  deps.writeStdout("[dev:run] full loop: planning -> implementation -> review\n");
  const result = await deps.runFullLoop({
    workspaceDir,
    issueId: config.issue.id,
    issueIdentifier: config.issue.identifier,
    issueTitle: config.issue.title,
    issueDescription: config.issue.description,
    maxTurns: config.maxTurns,
    maxIterations: config.maxIterations,
    model: env.CLAUDE_MODEL,
  });
  deps.writeStdout(
    `[dev:run] full loop complete: classification=${result.classification} ` +
      `planning=${result.planningExitCode} implementation=${result.implementationExitCode} ` +
      `review=${result.reviewApproved ? "approved" : "unapproved"}\n`,
  );
  return result.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLocalFullLoopFromEnv()
    .then((exitCode) => process.exit(exitCode))
    .catch((err) => {
      process.stderr.write(`[dev:run] full loop failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
