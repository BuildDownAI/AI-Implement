import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { splitLocalRunnerEnv } from "../local-docker.js";
import type { LocalContainerState } from "../local-docker.js";
import { encodeRunConfig } from "../run-config.js";
import {
  awaitSessionResult,
  getSessionStatus,
  launchLocalSession,
  stopLocalSession,
  streamSessionLogs,
  streamSessionLogsUntilShellReady,
} from "../local/session.js";
import { parseTaskFileFromPath } from "./task-file.js";
import type { ParsedTaskFile } from "./task-file.js";
import { collectPlanningArtifact } from "./planning-artifacts.js";

export type { ParsedTaskFile };

export type DevRunPhase = "implementation" | "planning" | "full" | "kg-refresh";

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
  /**
   * Path to a pre-fetched tracker-data JSON file — the offline path for phase=kg-refresh.
   * Mounted read-only at /dev-tracker-data.json inside the container; the
   * kg-tracker-data step detects KG_TRACKER_DATA_FILE=/dev-tracker-data.json and
   * uses the file instead of fetching from the orchestrator. When absent and
   * phase=kg-refresh, startDevRun fetches the export itself from ORCHESTRATOR_URL
   * (see resolveKgTrackerDataFile) using an admin credential from the operator's env.
   * The kg-scope-reconcile dry run is resolved separately and unconditionally (see
   * resolveKgScopeFile): whenever the same ORCHESTRATOR_URL/admin credential are set,
   * GET /api/kg/scope is fetched and mounted regardless of whether trackerData is given.
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
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

function sanitizeContainerName(identifier: string): string {
  const slug = identifier.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `ai-implement-dev-${slug || "task"}-${Date.now().toString(36)}`;
}

/**
 * Mints an admin bearer for the orchestrator at `base`: AI_IMPLEMENT_ADMIN_TOKEN is used
 * directly when set, otherwise mints a session via POST /api/auth the way the admin UI
 * does with ADMIN_ACCESS_CODE. Shared by every fetch-from-orchestrator dev-harness path
 * (tracker data, KG scope) so each mints independently but identically.
 */
async function mintAdminBearer(base: string): Promise<string> {
  const adminToken = process.env.AI_IMPLEMENT_ADMIN_TOKEN?.trim();
  if (adminToken) return adminToken;

  const accessCode = process.env.ADMIN_ACCESS_CODE?.trim();
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
  return authBody.token;
}

/**
 * Resolves the tracker-data file to mount for a kg-refresh run: `opts.trackerData`
 * when given (the offline path, always wins), otherwise fetches the export from the
 * orchestrator using an admin credential from the operator's env — never both.
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
  const bearer = await mintAdminBearer(base);

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
 * Resolves the KG-scope file to mount for a kg-refresh run's kg-scope-reconcile dry run:
 * fetches GET /api/kg/scope from the orchestrator (same ORCHESTRATOR_URL + admin credential
 * as resolveKgTrackerDataFile) and mounts it so the step reads it via KG_SCOPE_FILE instead
 * of calling back — the harness has no live orchestrator for the runner to call back to.
 * Unlike tracker data, this is optional and never required: with no orchestrator env
 * configured, or the fetch failing, this logs and returns null — kg-scope-reconcile then
 * runs its normal "no callback URL" skip inside the container, same as today.
 */
async function resolveKgScopeFile(artifactsDir: string): Promise<string | null> {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL?.trim();
  const adminToken = process.env.AI_IMPLEMENT_ADMIN_TOKEN?.trim();
  const accessCode = process.env.ADMIN_ACCESS_CODE?.trim();

  if (!orchestratorUrl || (!adminToken && !accessCode)) {
    console.log(
      "[dev-harness] ORCHESTRATOR_URL/admin credential not set — kg-scope-reconcile dry run will skip (no scope to diff against)",
    );
    return null;
  }

  const base = orchestratorUrl.replace(/\/+$/, "");
  try {
    const bearer = await mintAdminBearer(base);
    const res = await fetch(`${base}/api/kg/scope`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) {
      console.warn(`[dev-harness] GET ${base}/api/kg/scope failed: HTTP ${res.status} — kg-scope-reconcile dry run will skip`);
      return null;
    }
    const body = await res.text();
    const filePath = join(artifactsDir, "kg-scope.json");
    await writeFile(filePath, body);
    console.log(`[dev-harness] kg scope source: fetched from ${base}/api/kg/scope`);
    return filePath;
  } catch (err) {
    console.warn(
      `[dev-harness] kg-scope fetch failed: ${err instanceof Error ? err.message : String(err)} — kg-scope-reconcile dry run will skip`,
    );
    return null;
  }
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
  if (!anthropicApiKey && !claudeOAuthToken) {
    throw new Error("Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set");
  }
  const githubToken =
    opts.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "dev-placeholder-token";

  const detectedOrigin = detectRepoFromOrigin(workspace);
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

  const runConfig = encodeRunConfig({
    v: 1,
    issue: { id: issueId, identifier: task.identifier, title: task.title, description: task.description },
    runnerPhase,
    baseBranch: branch,
    ...(task.maxTurns !== undefined ? { maxTurns: task.maxTurns } : {}),
    ...(task.maxIterations !== undefined ? { maxIterations: task.maxIterations } : {}),
    ...(task.profiles !== undefined ? { profiles: task.profiles } : {}),
  });

  if (phase === "kg-refresh") {
    // kg-refresh runs non-mounted: the KG source repo is cloned from file:///kg-source
    // inside the container. AI_IMPLEMENT_DEP_TOKEN_OVERRIDE carries the operator's GH_TOKEN
    // to satisfy clone-secondary-repos without an orchestrator token vend.
    const trackerData = await resolveKgTrackerDataFile(opts, artifactsDir);
    const scopeFile = await resolveKgScopeFile(artifactsDir);
    const operatorGhToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? githubToken;

    const allEnv: Record<string, string> = {
      AI_IMPLEMENT_MODE: "local",
      AI_IMPLEMENT_LOG_LEVEL: logLevel,
      AI_IMPLEMENT_KG_DRY_RUN: "true",
      AI_IMPLEMENT_RUN_CONFIG: runConfig,
      KG_TRACKER_DATA_FILE: "/dev-tracker-data.json",
      ...(scopeFile ? { KG_SCOPE_FILE: "/dev-kg-scope.json" } : {}),
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
        ...(scopeFile ? [`${scopeFile}:/dev-kg-scope.json:ro`] : []),
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
    AI_IMPLEMENT_WORKSPACE_MODE: "mounted",
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
    workspace,
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

  if (handle.phase === "planning" || handle.phase === "full") {
    await collectPlanningArtifact(workspace, artifactsDir);
  }

  const diffstatResult = spawnSync("git", ["diff", "--stat"], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await writeFile(join(artifactsDir, "diffstat.txt"), diffstatResult.stdout?.toString() ?? "");

  const fullDiffResult = spawnSync("git", ["diff"], {
    cwd: workspace,
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
