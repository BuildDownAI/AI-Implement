import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { splitLocalRunnerEnv } from "../local-docker.js";
import type { LocalContainerState } from "../local-docker.js";
import { encodeRunConfig } from "../run-config.js";
import type { ResolvedAgentSnapshotV1 } from "../run-config.js";
import type { ConfiguredSyntheticProviderOptions } from "../run-autonomous.js";
import {
  LocalSessionOwnership,
  createLocalCredentialPort,
  loadLocalAgentConfig,
  type LocalCredentialReference,
} from "../local/agent-config.js";
import {
  awaitSessionResult,
  getSessionStatus,
  launchLocalSession,
  LOCAL_AUTH_BOOTSTRAP_ENV,
  startLocalAuthBridge,
  stopLocalSession,
  streamSessionLogs,
  streamSessionLogsUntilShellReady,
  type LocalAuthBridge,
} from "../local/session.js";
import { parseTaskFileFromPath } from "./task-file.js";
import type { ParsedTaskFile } from "./task-file.js";
import { collectPlanningArtifact } from "./planning-artifacts.js";

export type { ParsedTaskFile };

export type DevRunPhase = "implementation" | "planning" | "full" | "kg-refresh";
export type DevWorkspaceMode = "mounted" | "copy";

export interface DevRunLocalFeedbackOptions {
  providerPort: number;
  bridgePort: number;
  networkName: string;
  hostGateway: string;
}

export interface DevRunOptions {
  /** Absolute or relative path to the local target-repo checkout. */
  workspace: string;
  /**
   * Path to the task markdown file (YAML front matter + body).
   * Required for implementation, planning, and full phases.
   * Optional for kg-refresh (synthetic defaults are used when absent).
   */
  task?: string;
  /** Runner image. Defaults to LOCAL_RUNNER_IMAGE env var or ai-implement-runner:local. */
  image?: string;
  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
  anthropicApiKey?: string;
  /** Claude OAuth token. Falls back to CLAUDE_CODE_OAUTH_TOKEN env var. */
  claudeOAuthToken?: string;
  /** GitHub token for clone/push. Falls back to GITHUB_TOKEN / GH_TOKEN env vars. */
  githubToken?: string;
  /** Runner log verbosity. Defaults to "stream". */
  logLevel?: "summary" | "stream";
  /** Directory for run artifacts. Defaults to .dev-runs/<timestamp>/ relative to cwd. */
  artifactsDir?: string;
  /** Extra env vars injected into the container. */
  env?: Record<string, string>;
  /** Runner phase. Defaults to implementation. */
  phase?: DevRunPhase;
  /** Mounted keeps legacy live checkout behavior; copy uses a sanitized read-only source mounted at /source-workspace. */
  workspaceMode?: DevWorkspaceMode;
  /** External standalone stage-agent configuration file for trusted local configured runs. */
  agentConfig?: string;
  /** Local synthetic feedback provider wiring for real-image full-loop validation. */
  localFeedback?: DevRunLocalFeedbackOptions;
  /**
   * Path to a pre-fetched tracker-data JSON file — the offline path for phase=kg-refresh.
   * Mounted read-only at /dev-tracker-data.json inside the container; the
   * kg-tracker-data step detects KG_TRACKER_DATA_FILE=/dev-tracker-data.json and
   * uses the file instead of fetching from the orchestrator. When absent and
   * phase=kg-refresh, startDevRun fetches the export itself from ORCHESTRATOR_URL
   * (see resolveKgTrackerDataFile) using an admin credential from the operator's env.
   */
  trackerData?: string;
  /**
   * Run only up through this named step (by step id), then stop. The critical
   * case is "setup": clone/mount → install → setup hook, no Claude invocation,
   * zero tokens. Exit code reflects the last step's result.
   */
  untilStep?: string;
  /**
   * After the last executed step, keep the container alive and attach an
   * interactive bash session via `docker exec -it`. The container is removed
   * when the shell exits. Requires the terminal to be a TTY.
   */
  shell?: boolean;
}

export interface DevRunHandle {
  runId: string;
  containerId: string;
  containerName: string;
  artifactsDir: string;
  startedAt: Date;
  task: ParsedTaskFile;
  workspace: string;
  phase: DevRunPhase;
  localAuth?: LocalAuthBridge;
  sourceWorkspaceCleanup?: () => Promise<void>;
  workspaceMode?: DevWorkspaceMode;
}

export interface DevRunResult {
  exitCode: number | null;
  durationMs: number;
}

function detectCurrentBranch(workspaceDir: string): string {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 0) {
    const branch = result.stdout.toString().trim();
    if (branch && branch !== "HEAD") return branch;
  }
  return "main";
}

function detectRepoFromOrigin(workspaceDir: string): { owner: string; repo: string } | null {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const url = result.stdout.toString().trim();
  const scp = url.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (scp) return { owner: scp[1], repo: scp[2] };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com" || parsed.search || parsed.hash) return null;
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:" && parsed.protocol !== "git+ssh:") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
}

function sanitizeContainerName(identifier: string): string {
  const slug = identifier.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `ai-implement-dev-${slug || "task"}-${Date.now().toString(36)}`;
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    const stderr = result.stderr instanceof Buffer ? result.stderr.toString().trim() : "";
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout.toString().trim();
}

async function createStandaloneSourceWorkspace(workspace: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dirty = runGit(["status", "--porcelain"], workspace);
  if (dirty) {
    throw new Error("copy workspace mode requires a clean working tree; commit or stash changes before using --workspace-mode copy");
  }
  const root = await mkdtemp(join(tmpdir(), "ai-implement-source-"));
  const dest = join(root, "repo");
  const clone = spawnSync("git", ["clone", "--no-local", "--no-hardlinks", workspace, dest], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (clone.status !== 0) {
    await rm(root, { recursive: true, force: true });
    const stderr = clone.stderr instanceof Buffer ? clone.stderr.toString().trim() : "";
    throw new Error(`Failed to create isolated source workspace: ${stderr}`);
  }
  runGit(["checkout", "--detach", "HEAD"], dest);
  await rm(join(dest, ".dev-runs"), { recursive: true, force: true });
  return { path: dest, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function snapshotFromLocalConfig(
  loaded: Awaited<ReturnType<typeof loadLocalAgentConfig>>,
): ResolvedAgentSnapshotV1 | undefined {
  if (loaded.resolution.mode !== "configured") return undefined;
  const resolvedIdentity = JSON.stringify({
    resolution: loaded.resolution,
    references: [...loaded.references.values()].map((r) => ({
      profileId: r.profileId,
      authMode: r.authMode,
      kind: r.kind,
    })),
  });
  const hash = createHash("sha256").update(resolvedIdentity).digest("hex").slice(0, 24);
  const ref = { configRevisionId: `local-${hash}`, revision: 1 };
  return {
    version: 1,
    snapshotId: `local-${hash}`,
    configRevisions: { orchestratorDefault: ref, project: ref },
    stages: loaded.resolution.stages,
    sources: loaded.resolution.sources,
    profiles: loaded.resolution.profiles,
  };
}

function verifyLocalSubscriptionRepoTrust(repository: string): void {
  const result = spawnSync("gh", ["repo", "view", repository, "--json", "visibility", "-q", ".visibility"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const visibility = result.status === 0 ? result.stdout.toString().trim().toUpperCase() : "";
  if (visibility !== "PRIVATE" && visibility !== "INTERNAL") {
    throw new Error(
      "Local subscription configured runs require an independently verified private/internal GitHub repository; " +
      `could not verify ${repository} with gh repo view.`,
    );
  }
}

function hasSubscriptionReference(references: readonly LocalCredentialReference[]): boolean {
  return references.some((r) => r.kind === "session");
}

function selectedCodexOpenAiProfileIds(snapshot: ResolvedAgentSnapshotV1): string[] {
  return [...new Set(Object.values(snapshot.profiles)
    .filter((profile) => profile.agent === "codex" && profile.provider === "openai")
    .map((profile) => profile.id))];
}

function validatePort(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid local feedback ${name}: expected TCP port 1-65535`);
  }
}

function validateHostGateway(value: string): void {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
    throw new Error("Invalid local feedback hostGateway: expected IPv4 address");
  }
}

function validateNetworkName(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error("Invalid local feedback networkName");
  }
  if (/^(bridge|host|none|container|ingress)(?:$|[_.:-])/i.test(value)) {
    throw new Error("Invalid local feedback networkName: reserved Docker network name");
  }
}

function validateLocalFeedbackOptions(options: DevRunLocalFeedbackOptions | undefined): void {
  if (!options) return;
  validatePort(options.providerPort, "providerPort");
  validatePort(options.bridgePort, "bridgePort");
  validateNetworkName(options.networkName);
  validateHostGateway(options.hostGateway);
}

function assertNoConfiguredEnvOverrides(env: Record<string, string> | undefined): void {
  if (!env) return;
  const protectedNames = new Set([
    "AI_IMPLEMENT_RUN_CONFIG",
    LOCAL_AUTH_BOOTSTRAP_ENV,
    "AI_IMPLEMENT_WORKSPACE_MODE",
    "AI_IMPLEMENT_HOST_UID",
    "AI_IMPLEMENT_HOST_GID",
    "RUNNER_PHASE",
    "ISSUE_ID",
    "ISSUE_IDENTIFIER",
    "ISSUE_TITLE",
    "ISSUE_DESCRIPTION",
    "GITHUB_OWNER",
    "GITHUB_REPO",
    "GITHUB_DEFAULT_BRANCH",
    "GITHUB_TOKEN",
    "SESSION_TOKEN",
    "SESSION_MODE",
    "MACHINE_NONCE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_API_KEY",
    "CODEX_HOME",
  ]);
  for (const key of Object.keys(env)) {
    if (protectedNames.has(key) || key.startsWith("AI_IMPLEMENT_MODEL_AUTH_")) {
      throw new Error(`Configured local runs do not allow opts.env to override protected runner environment: ${key}`);
    }
  }
}

function confirmedContainerNotRunning(containerName: string): "confirmed" | "unknown" {
  const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", containerName], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (inspect.status === 0 && inspect.stdout.toString().trim() === "false") return "confirmed";
  if (inspect.status === 0) return "unknown";
  const listed = spawnSync("docker", ["ps", "-a", "--filter", `name=^/${containerName}$`, "--format", "{{.Names}}"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (listed.status === 0 && listed.stdout.toString().trim() === "") return "confirmed";
  return "unknown";
}

async function prepareLocalConfiguredAuth(input: {
  configPath: string;
  projectKey: string;
  actualRepository: string | null;
  workspace: string;
  artifactsDir: string;
  repositories: readonly string[];
  localFeedback?: DevRunLocalFeedbackOptions;
}): Promise<{ snapshot: ResolvedAgentSnapshotV1 | undefined; env: Record<string, string>; bridge?: LocalAuthBridge; bootstrapDir?: string }> {
  const configPath = resolve(input.configPath);
  const ownership = new LocalSessionOwnership({ forbiddenRoots: [input.workspace, input.artifactsDir] });
  const leases = [];
  let bridge: LocalAuthBridge | undefined;
  let dir: string | undefined;
  try {
    const loaded = await loadLocalAgentConfig({
      configPath,
      projectKey: input.projectKey,
      forbiddenRoots: [input.workspace, input.artifactsDir],
    });
    const snapshot = snapshotFromLocalConfig(loaded);
    if (!snapshot && input.localFeedback) {
      throw new Error("localFeedback requires an external agent config that resolves to configured stage agents");
    }
    if (!snapshot) return { snapshot: undefined, env: {} };
    const syntheticProvider: ConfiguredSyntheticProviderOptions | undefined = input.localFeedback
      ? {
          version: 1,
          kind: "local-feedback-provider",
          port: input.localFeedback.providerPort,
          profileIds: selectedCodexOpenAiProfileIds(snapshot),
        }
      : undefined;
    if (input.localFeedback && (!syntheticProvider || syntheticProvider.profileIds.length === 0)) {
      throw new Error("Local feedback requires at least one selected Codex/OpenAI profile");
    }
    const references = [...loaded.references.values()];
    if (hasSubscriptionReference(references)) {
      if (!input.actualRepository) {
        throw new Error("Local subscription configured runs require a detected GitHub origin for the actual workspace checkout");
      }
      if (input.projectKey !== input.actualRepository || input.repositories.some((repo) => repo !== input.actualRepository)) {
        throw new Error("Local subscription configured runs require task repo, config projectKey, and actual workspace origin to match");
      }
      verifyLocalSubscriptionRepoTrust(input.actualRepository);
    }
    for (const reference of references) {
      if (reference.kind === "session") leases.push(await ownership.acquire(reference));
    }
    const credentialPort = createLocalCredentialPort({
      references: loaded.references,
      forbiddenRoots: [input.workspace, input.artifactsDir],
      ownership,
    });
    bridge = await startLocalAuthBridge({
      snapshotId: snapshot.snapshotId,
      projectKey: input.projectKey,
      credentialPort,
      ownership,
      leases,
      references: references as LocalCredentialReference[],
      trustedRepositories: input.repositories,
      ...(syntheticProvider ? { syntheticProvider, listenPort: input.localFeedback!.bridgePort } : {}),
    });
    dir = await mkdtemp(join(tmpdir(), "ai-implement-local-auth-"));
    const bootstrapPath = join(dir, "bootstrap.json");
    await writeFile(bootstrapPath, JSON.stringify(bridge.bootstrap), { mode: 0o600 });
    await chmod(bootstrapPath, 0o600);
    return { snapshot, bridge, env: { [LOCAL_AUTH_BOOTSTRAP_ENV]: bootstrapPath }, bootstrapDir: dir };
  } catch (error) {
    await bridge?.close().catch(() => undefined);
    const errors: unknown[] = [];
    for (const lease of leases) {
      try {
        await ownership.releaseUnused(lease, { confirmTermination: async () => "confirmed" });
      } catch (releaseError) {
        errors.push(releaseError);
      }
    }
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (errors.length > 0) throw new AggregateError([error, ...errors], "local configured auth cleanup failed");
    throw error;
  }
}

/**
 * Resolves the tracker-data file to mount for a kg-refresh run: `opts.trackerData`
 * when given (the offline path, always wins), otherwise fetches the export from the
 * orchestrator using an admin credential from the operator's env — never both. Mints
 * a session via POST /api/auth the way the admin UI does when only ADMIN_ACCESS_CODE
 * is set; AI_IMPLEMENT_ADMIN_TOKEN is used directly as an already-valid bearer.
 * Neither `opts.trackerData` nor the orchestrator env present throws, naming both
 * options. Logs which source supplied the data.
 */
async function resolveKgTrackerDataFile(opts: DevRunOptions, artifactsDir: string): Promise<string> {
  if (opts.trackerData) {
    const filePath = resolve(opts.trackerData);
    console.log(`[dev-harness] tracker data source: file ${filePath}`);
    return filePath;
  }

  const orchestratorUrl = process.env.ORCHESTRATOR_URL?.trim();
  const adminToken = process.env.AI_IMPLEMENT_ADMIN_TOKEN?.trim();
  const accessCode = process.env.ADMIN_ACCESS_CODE?.trim();

  if (!orchestratorUrl || (!adminToken && !accessCode)) {
    throw new Error(
      "kg-refresh needs tracker data: pass --tracker-data <file>, or set ORCHESTRATOR_URL plus " +
      "ADMIN_ACCESS_CODE or AI_IMPLEMENT_ADMIN_TOKEN in the operator's env so the harness can fetch it.",
    );
  }

  const base = orchestratorUrl.replace(/\/+$/, "");
  let bearer: string;
  if (adminToken) {
    bearer = adminToken;
  } else {
    const authRes = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: accessCode }),
    });
    if (!authRes.ok) {
      throw new Error(`Failed to mint an admin session from ${base}/api/auth: HTTP ${authRes.status}`);
    }
    const authBody = (await authRes.json()) as { token?: string };
    if (!authBody.token) {
      throw new Error(`Admin session mint at ${base}/api/auth did not return a token`);
    }
    bearer = authBody.token;
  }

  const res = await fetch(`${base}/api/kg/tracker-data`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) {
    throw new Error(`GET ${base}/api/kg/tracker-data failed: HTTP ${res.status}`);
  }
  const body = await res.text();
  const filePath = join(artifactsDir, "tracker-data.json");
  await writeFile(filePath, body);
  console.log(`[dev-harness] tracker data source: fetched from ${base}/api/kg/tracker-data`);
  return filePath;
}

/**
 * Launch a dev runner container against a local workspace. Returns a handle
 * used to stream logs and collect results. No orchestrator, no tracker, no push.
 *
 * The container receives AI_IMPLEMENT_WORKSPACE_MODE=mounted so the clone step
 * skips git fetch/reset and the push step is a no-op — the mount is the user's
 * live (dirty-by-design) checkout, so pushing from it is never safe; the run's
 * changes stay in the working tree for inspection. The workspace is bind-mounted
 * at /workspace, meaning uncommitted WORKFLOW.md and hook script edits take
 * effect immediately.
 */
export async function startDevRun(opts: DevRunOptions): Promise<DevRunHandle> {
  const workspace = resolve(opts.workspace);
  if (!existsSync(workspace)) {
    throw new Error(`Workspace directory does not exist: ${workspace}`);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const artifactsDir = opts.artifactsDir ?? join(process.cwd(), ".dev-runs", ts);
  await mkdir(artifactsDir, { recursive: true });

  const phase = opts.phase ?? "implementation";

  const task = opts.task
    ? parseTaskFileFromPath(opts.task, `DEV-${Math.floor(Date.now() / 1000)}`)
    : {
        identifier: "KG-DEV",
        title: "KG refresh (local dev)",
        description: "Local dev kg-refresh run",
        maxTurns: undefined,
        maxIterations: undefined,
        repo: undefined,
        branch: undefined,
        profiles: undefined,
      };

  const anthropicApiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  const claudeOAuthToken = opts.claudeOAuthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  const githubToken =
    opts.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "dev-placeholder-token";

  const detectedOrigin = detectRepoFromOrigin(workspace);
  const actualRepository = detectedOrigin ? `${detectedOrigin.owner}/${detectedOrigin.repo}` : null;
  const { repoOwner, repoName } = (() => {
    if (task.repo) {
      const parts = task.repo.split("/");
      return { repoOwner: parts[0] ?? "dev-local", repoName: parts[1] ?? "workspace" };
    }
    return detectedOrigin
      ? { repoOwner: detectedOrigin.owner, repoName: detectedOrigin.repo }
      : { repoOwner: "dev-local", repoName: "workspace" };
  })();

  const branch = task.branch ?? detectCurrentBranch(workspace);
  const image = opts.image ?? process.env.LOCAL_RUNNER_IMAGE ?? "ai-implement-runner:local";
  const logLevel = opts.logLevel ?? "stream";
  const issueId = randomUUID();
  const runId = randomUUID();
  const containerName = sanitizeContainerName(task.identifier);
  const runnerPhase = phase === "full" ? "implementation" : phase;
  const entryPhase = phase === "planning" ? "local-planning" : phase;
  const workspaceMode = opts.workspaceMode ?? "mounted";
  if (workspaceMode !== "mounted" && workspaceMode !== "copy") {
    throw new Error("Invalid workspaceMode: expected mounted or copy");
  }
  if (opts.agentConfig && phase !== "full") {
    throw new Error("--agent-config is only supported with --phase full; other phases do not bootstrap the selected stage executors locally");
  }
  if (opts.localFeedback && (!opts.agentConfig || phase !== "full")) {
    throw new Error("localFeedback is only supported for configured --phase full runs");
  }
  if (opts.agentConfig) assertNoConfiguredEnvOverrides(opts.env);
  validateLocalFeedbackOptions(opts.localFeedback);
  const projectKey = `${repoOwner}/${repoName}`;
  const repositories = [`${repoOwner}/${repoName}`];
  const sourceWorkspace = workspaceMode === "copy" ? await createStandaloneSourceWorkspace(workspace) : undefined;
  let localConfigured: Awaited<ReturnType<typeof prepareLocalConfiguredAuth>>;
  try {
    localConfigured = opts.agentConfig
      ? await prepareLocalConfiguredAuth({
          configPath: opts.agentConfig,
          projectKey,
          actualRepository,
          workspace,
          artifactsDir,
          repositories,
          ...(opts.localFeedback ? { localFeedback: opts.localFeedback } : {}),
        })
      : { snapshot: undefined, env: {} };
  } catch (error) {
    await sourceWorkspace?.cleanup().catch(() => undefined);
    throw error;
  }
  if (!localConfigured.snapshot && !anthropicApiKey && !claudeOAuthToken) {
    throw new Error("Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set");
  }

  const runConfig = encodeRunConfig({
    v: 1,
    issue: { id: issueId, identifier: task.identifier, title: task.title, description: task.description },
    runnerPhase,
    baseBranch: branch,
    ...(task.maxTurns !== undefined ? { maxTurns: task.maxTurns } : {}),
    ...(task.maxIterations !== undefined ? { maxIterations: task.maxIterations } : {}),
    ...(task.profiles !== undefined ? { profiles: task.profiles } : {}),
    ...(localConfigured.snapshot ? { agentConfig: localConfigured.snapshot } : {}),
  });

  if (phase === "kg-refresh") {
    // kg-refresh runs non-mounted: the KG source repo is cloned from file:///kg-source
    // inside the container. AI_IMPLEMENT_DEP_TOKEN_OVERRIDE carries the operator's GH_TOKEN
    // to satisfy clone-secondary-repos without an orchestrator token vend.
    const trackerData = await resolveKgTrackerDataFile(opts, artifactsDir);
    const operatorGhToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? githubToken;

    const allEnv: Record<string, string> = {
      AI_IMPLEMENT_MODE: "local",
      AI_IMPLEMENT_LOG_LEVEL: logLevel,
      AI_IMPLEMENT_KG_DRY_RUN: "true",
      AI_IMPLEMENT_RUN_CONFIG: runConfig,
      KG_TRACKER_DATA_FILE: "/dev-tracker-data.json",
      ...(opts.untilStep ? { AI_IMPLEMENT_UNTIL_STEP: opts.untilStep } : {}),
      ...(opts.shell ? { AI_IMPLEMENT_SHELL_MODE: "true" } : {}),
      ISSUE_ID: issueId,
      ISSUE_IDENTIFIER: task.identifier,
      ISSUE_TITLE: task.title,
      ISSUE_DESCRIPTION: task.description,
      GITHUB_OWNER: repoOwner,
      GITHUB_REPO: repoName,
      GITHUB_DEFAULT_BRANCH: branch,
      GITHUB_TOKEN: githubToken,
      SESSION_TOKEN: runId,
      MACHINE_NONCE: runId,
      SESSION_MODE: "autonomous",
      RUNNER_PHASE: entryPhase,
      AI_IMPLEMENT_DEP_TOKEN_OVERRIDE: operatorGhToken,
      ...(process.getuid ? { AI_IMPLEMENT_HOST_UID: String(process.getuid()) } : {}),
      ...(process.getgid ? { AI_IMPLEMENT_HOST_GID: String(process.getgid()) } : {}),
      ...(anthropicApiKey ? { ANTHROPIC_API_KEY: anthropicApiKey } : {}),
      ...(claudeOAuthToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeOAuthToken } : {}),
      ...(opts.env ?? {}),
    };

    const { publicEnv, secretEnv } = splitLocalRunnerEnv(allEnv);

    const session = await launchLocalSession({
      containerName,
      image,
      publicEnv,
      secretEnv,
      extraVolumes: [
        `${workspace}:/kg-source:ro`,
        `${trackerData}:/dev-tracker-data.json:ro`,
      ],
    });

    return {
      runId,
      containerId: session.containerId,
      containerName: session.containerName,
      artifactsDir,
      startedAt: session.startedAt,
      task,
      workspace,
      phase,
    };
  }

  const allEnv: Record<string, string> = {
    AI_IMPLEMENT_MODE: "local",
    AI_IMPLEMENT_WORKSPACE_MODE: workspaceMode,
    AI_IMPLEMENT_LOG_LEVEL: logLevel,
    AI_IMPLEMENT_RUN_CONFIG: runConfig,
    ...(opts.untilStep ? { AI_IMPLEMENT_UNTIL_STEP: opts.untilStep } : {}),
    ...(opts.shell ? { AI_IMPLEMENT_SHELL_MODE: "true" } : {}),
    ISSUE_ID: issueId,
    ISSUE_IDENTIFIER: task.identifier,
    ISSUE_TITLE: task.title,
    ISSUE_DESCRIPTION: task.description,
    GITHUB_OWNER: repoOwner,
    GITHUB_REPO: repoName,
    GITHUB_DEFAULT_BRANCH: branch,
    GITHUB_TOKEN: githubToken,
    SESSION_TOKEN: runId,
    MACHINE_NONCE: runId,
    SESSION_MODE: "autonomous",
    RUNNER_PHASE: entryPhase,
    ...localConfigured.env,
    ...(process.getuid ? { AI_IMPLEMENT_HOST_UID: String(process.getuid()) } : {}),
    ...(process.getgid ? { AI_IMPLEMENT_HOST_GID: String(process.getgid()) } : {}),
    ...(!localConfigured.snapshot && anthropicApiKey ? { ANTHROPIC_API_KEY: anthropicApiKey } : {}),
    ...(!localConfigured.snapshot && claudeOAuthToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeOAuthToken } : {}),
    ...(opts.env ?? {}),
  };

  const { publicEnv, secretEnv } = splitLocalRunnerEnv(allEnv);

  let session;
  try {
    session = await launchLocalSession({
      containerName,
      image,
      publicEnv,
      secretEnv,
      ...(workspaceMode === "mounted" ? { workspace } : {}),
      ...((workspaceMode === "copy" && sourceWorkspace) || localConfigured.bootstrapDir
        ? {
            extraVolumes: [
              ...(workspaceMode === "copy" && sourceWorkspace ? [`${sourceWorkspace.path}:/source-workspace:ro`] : []),
              ...(localConfigured.bootstrapDir
                ? [`${localConfigured.bootstrapDir}:${localConfigured.bootstrapDir}:rw`]
                : []),
            ],
            ...(opts.localFeedback ? { networkName: opts.localFeedback.networkName, hostGateway: opts.localFeedback.hostGateway } : {}),
          }
        : {}),
    });
  } catch (error) {
    const proof = confirmedContainerNotRunning(containerName);
    await localConfigured.bridge?.close().catch(() => undefined);
    await localConfigured.bridge?.releaseUnused(async () => proof).catch(() => undefined);
    if (localConfigured.bootstrapDir) await rm(localConfigured.bootstrapDir, { recursive: true, force: true }).catch(() => undefined);
    await sourceWorkspace?.cleanup().catch(() => undefined);
    throw error;
  }
  const cleanupLocalTemps = async () => {
    if (localConfigured.bootstrapDir) await rm(localConfigured.bootstrapDir, { recursive: true, force: true }).catch(() => undefined);
    await sourceWorkspace?.cleanup().catch(() => undefined);
  };

  return {
    runId,
    containerId: session.containerId,
    containerName: session.containerName,
    artifactsDir,
    startedAt: session.startedAt,
    task,
    workspace,
    phase,
    ...(localConfigured.bridge ? { localAuth: localConfigured.bridge } : {}),
    ...(sourceWorkspace || localConfigured.bootstrapDir ? { sourceWorkspaceCleanup: cleanupLocalTemps } : {}),
    workspaceMode,
  };
}

/**
 * Query the current state of the dev runner container.
 */
export async function getRunStatus(handle: DevRunHandle): Promise<LocalContainerState> {
  return getSessionStatus(handle);
}

/**
 * Stream container logs line by line via `docker logs -f`. Resolves once the
 * container exits and all log output has been emitted.
 */
export async function streamLogs(
  handle: DevRunHandle,
  onLine: (line: string) => void,
): Promise<void> {
  return streamSessionLogs(handle, onLine);
}

/**
 * Stream container logs until either the container exits or the shell-ready
 * sentinel "[dev:run] shell-ready exit=N" is emitted. Returns whether the
 * sentinel was found and, if so, the pipeline exit code embedded in it.
 * Non-sentinel log lines are forwarded to onLine as usual.
 */
export async function streamLogsUntilShellReady(
  handle: DevRunHandle,
  onLine: (line: string) => void,
): Promise<{ ready: boolean; exitCode: number | null }> {
  return streamSessionLogsUntilShellReady(handle, onLine);
}

/**
 * Poll until the container exits and return the result.
 */
export async function getRunResult(handle: DevRunHandle): Promise<DevRunResult> {
  return awaitSessionResult(handle);
}

/**
 * Force-remove the dev runner container. Best-effort; errors are swallowed.
 */
export async function stopDevRun(handle: DevRunHandle): Promise<void> {
  return stopLocalSession(handle);
}

/**
 * Write run artifacts into handle.artifactsDir:
 * - run.log (full container log)
 * - changes.diff (git diff of working tree)
 * - diffstat.txt (git diff --stat)
 * - telemetry.json (exit code, timing, issue metadata)
 */
export async function collectRunArtifacts(
  handle: DevRunHandle,
  exitCode: number | null,
): Promise<void> {
  const { artifactsDir, workspace, containerId, runId, task, startedAt } = handle;

  const logs = await new Promise<string>((resolve) => {
    const proc = spawn("docker", ["logs", containerId], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr?.on("data", (d: Buffer) => chunks.push(d));
    proc.on("close", () => resolve(Buffer.concat(chunks).toString()));
  });
  await writeFile(join(artifactsDir, "run.log"), logs);

  let artifactWorkspace = workspace;
  if (handle.workspaceMode === "copy") {
    artifactWorkspace = join(artifactsDir, "workspace");
    await rm(artifactWorkspace, { recursive: true, force: true });
    await mkdir(artifactWorkspace, { recursive: true });
    const copied = spawnSync("docker", ["cp", `${containerId}:/workspace/.`, artifactWorkspace], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (copied.status !== 0) {
      const stderr = copied.stderr instanceof Buffer ? copied.stderr.toString().trim() : "";
      await writeFile(join(artifactsDir, "workspace-copy-error.txt"), stderr || "docker cp failed");
    }
  }

  if (handle.phase === "planning" || handle.phase === "full") {
    await collectPlanningArtifact(artifactWorkspace, artifactsDir);
  }

  const diffstatResult = spawnSync("git", ["diff", "--stat"], {
    cwd: artifactWorkspace,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await writeFile(join(artifactsDir, "diffstat.txt"), diffstatResult.stdout?.toString() ?? "");

  const fullDiffResult = spawnSync("git", ["diff"], {
    cwd: artifactWorkspace,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await writeFile(join(artifactsDir, "changes.diff"), fullDiffResult.stdout?.toString() ?? "");

  const telemetry = {
    runId,
    containerId: containerId.slice(0, 12),
    identifier: task.identifier,
    title: task.title,
    phase: handle.phase,
    exitCode,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
  };
  await writeFile(join(artifactsDir, "telemetry.json"), JSON.stringify(telemetry, null, 2));
}
