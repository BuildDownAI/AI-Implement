import { runLocalFullLoop } from "./local/full-loop.js";
import { decodeRunConfig, decodeTrustedRunConfig, type ResolvedAgentSnapshotV1 } from "./run-config.js";
import { hasConfiguredIntent, type ConfiguredRunOptions } from "./run-autonomous.js";

const LOCAL_AUTH_BOOTSTRAP_ENV = "AI_IMPLEMENT_LOCAL_AUTH_BOOTSTRAP_FILE";
const SAFE_CONFIGURED_ERROR = "configured local full loop rejected before execution";
const CONFIGURED_BOOTSTRAP_ERROR = new Error(SAFE_CONFIGURED_ERROR);
const hasLocalBootstrapPointer = (env: NodeJS.ProcessEnv): boolean => typeof env[LOCAL_AUTH_BOOTSTRAP_ENV] === "string" && env[LOCAL_AUTH_BOOTSTRAP_ENV]!.length > 0;

export interface LocalSessionBootstrap {
  configured: ConfiguredRunOptions;
  onConfiguredFinish: (safe: boolean) => Promise<void>;
}

export type LoadLocalSessionBootstrap = (input: {
  env: NodeJS.ProcessEnv;
  snapshot: ResolvedAgentSnapshotV1;
  workspaceDir: string;
}) => Promise<LocalSessionBootstrap>;

export interface LocalFullLoopRunnerDependencies {
  runFullLoop: typeof runLocalFullLoop;
  loadLocalSessionBootstrap: LoadLocalSessionBootstrap;
  writeStdout: (text: string) => void;
}

async function defaultLoadLocalSessionBootstrap(input: {
  env: NodeJS.ProcessEnv;
  snapshot: ResolvedAgentSnapshotV1;
  workspaceDir: string;
}): Promise<LocalSessionBootstrap> {
  const mod = await import("./local/session.js") as { loadLocalSessionBootstrap?: LoadLocalSessionBootstrap };
  if (!mod.loadLocalSessionBootstrap) {
    throw new Error("Configured local full loop requires local session bootstrap support");
  }
  return mod.loadLocalSessionBootstrap(input);
}

const DEFAULT_DEPENDENCIES: LocalFullLoopRunnerDependencies = {
  runFullLoop: runLocalFullLoop,
  loadLocalSessionBootstrap: defaultLoadLocalSessionBootstrap,
  writeStdout: (text) => process.stdout.write(text),
};

export function formatLocalFullLoopEntrypointError(env: NodeJS.ProcessEnv, err: unknown): string {
  return hasConfiguredIntent(env.AI_IMPLEMENT_RUN_CONFIG) || hasLocalBootstrapPointer(env)
    ? SAFE_CONFIGURED_ERROR
    : err instanceof Error ? err.message : String(err);
}

export async function runLocalFullLoopFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: Partial<LocalFullLoopRunnerDependencies> = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const resolvedDeps = { ...DEFAULT_DEPENDENCIES, ...deps };
  const encoded = env.AI_IMPLEMENT_RUN_CONFIG;
  if (!encoded) throw new Error("Missing required env var: AI_IMPLEMENT_RUN_CONFIG");

  const config = decodeRunConfig(encoded);
  const configuredIntent = hasConfiguredIntent(encoded) || hasLocalBootstrapPointer(env);
  if (configuredIntent && !decodeTrustedRunConfig(encoded).agentConfig) {
    throw CONFIGURED_BOOTSTRAP_ERROR;
  }
  const workspaceDir = env.WORKSPACE_DIR ?? "/workspace";
  const bootstrap = config.agentConfig && env[LOCAL_AUTH_BOOTSTRAP_ENV]
    ? await resolvedDeps.loadLocalSessionBootstrap({ env, snapshot: config.agentConfig, workspaceDir })
    : undefined;

  resolvedDeps.writeStdout("[dev:run] full loop: planning -> implementation -> review\n");
  const result = await resolvedDeps.runFullLoop({
    workspaceDir,
    issueId: config.issue.id,
    issueIdentifier: config.issue.identifier,
    issueTitle: config.issue.title,
    issueDescription: config.issue.description,
    maxTurns: config.maxTurns,
    maxIterations: config.maxIterations,
    model: env.CLAUDE_MODEL,
    agentConfig: config.agentConfig,
    configured: bootstrap?.configured,
    configuredEnv: bootstrap ? undefined : env,
    onConfiguredFinish: bootstrap?.onConfiguredFinish,
  });
  resolvedDeps.writeStdout(
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
      process.stderr.write(`[dev:run] full loop failed: ${formatLocalFullLoopEntrypointError(process.env, err)}\n`);
      process.exit(1);
    });
}
