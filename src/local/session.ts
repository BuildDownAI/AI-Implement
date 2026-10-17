import { execFile as nodeExecFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AccountAuthMode } from "../agent-config.js";
import type { ConfiguredRunOptions, ConfiguredSyntheticProviderOptions } from "../run-autonomous.js";
import { validateResolvedAgentSnapshot, type ResolvedAgentSnapshotV1 } from "../run-config.js";
import { buildDockerEnvFileContent, inspectLocalContainer } from "../local-docker.js";
import type { LocalCredentialPort } from "../model-auth-client.js";
import type { ModelAuthSecret } from "../model-auth-contract.js";
import {
  LocalAgentConfigError,
  LocalSessionLease,
  LocalSessionOwnership,
  type LocalCredentialReference,
  type TerminationProof,
} from "./agent-config.js";
import type { LocalContainerState } from "../local-docker.js";

export type { LocalContainerState };

const execFile = promisify(nodeExecFile);
export const LOCAL_AUTH_BOOTSTRAP_ENV = "AI_IMPLEMENT_LOCAL_AUTH_BOOTSTRAP_FILE";

export interface LocalSessionBootstrapV1 {
  version: 1;
  snapshotId: string;
  projectKey: string;
  bridge: { baseUrl: string; bearer: string };
  references: readonly { profileId: string; authMode: AccountAuthMode; kind: "api-key" | "session" }[];
  trustedRepositories: readonly string[];
  syntheticProvider?: ConfiguredSyntheticProviderOptions;
  authRoot?: string;
}

export interface LocalAuthBridge {
  readonly bootstrap: LocalSessionBootstrapV1;
  readonly safeDisposition: boolean | null;
  close(): Promise<void>;
  releaseAfterTermination(confirmTermination: () => Promise<TerminationProof>): Promise<void>;
  releaseUnused(confirmTermination: () => Promise<TerminationProof>): Promise<void>;
}

export interface LocalSessionLaunchOptions {
  containerName: string;
  image: string;
  /** Environment variables passed as -e flags (visible to docker inspect). */
  publicEnv: Record<string, string>;
  /** Sensitive environment variables written to a mode-0600 env file. */
  secretEnv: Record<string, string>;
  /** If set, bind-mounts this absolute path at /workspace inside the container. */
  workspace?: string;
  /**
   * Additional volume mounts passed verbatim as docker run -v arguments.
   * Each entry is a Docker volume spec: "host_path:container_path" or
   * "host_path:container_path:ro". Used by kg-refresh runs which mount the
   * KG source repo at /kg-source and the tracker-data file at /dev-tracker-data.json.
   */
  extraVolumes?: string[];
  /** Optional Docker network for local feedback runs. */
  networkName?: string;
  /** Host gateway/IP mapped to host.docker.internal. Defaults to Docker's host-gateway. */
  hostGateway?: string;
}

export interface LocalSessionHandle {
  containerId: string;
  containerName: string;
  startedAt: Date;
}

async function writeSessionSecretEnvFile(secretEnv: Record<string, string>): Promise<string> {
  const dir = join(tmpdir(), "ai-implement-local-session");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${randomUUID()}.env`);
  await writeFile(filePath, buildDockerEnvFileContent(secretEnv), { mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bootstrapError(message: string): Error {
  return new Error(`Invalid local auth bootstrap: ${message}`);
}

function parseBootstrap(value: unknown): LocalSessionBootstrapV1 {
  if (!isRecord(value)) throw bootstrapError("expected object");
  if (value.version !== 1) throw bootstrapError("unsupported version");
  if (typeof value.snapshotId !== "string" || value.snapshotId.length === 0) throw bootstrapError("missing snapshot id");
  if (typeof value.projectKey !== "string" || value.projectKey.length === 0) throw bootstrapError("missing project key");
  if (!isRecord(value.bridge)) throw bootstrapError("missing bridge");
  const baseUrl = value.bridge.baseUrl;
  const bearer = value.bridge.bearer;
  if (typeof baseUrl !== "string" || !baseUrl.startsWith("http://")) throw bootstrapError("invalid bridge URL");
  if (typeof bearer !== "string" || bearer.length < 32) throw bootstrapError("invalid bridge bearer");
  if (!Array.isArray(value.references) || value.references.length === 0) throw bootstrapError("missing references");
  const references: LocalSessionBootstrapV1["references"] = value.references.map((r) => {
    if (!isRecord(r)) throw bootstrapError("invalid reference");
    if (typeof r.profileId !== "string" || r.profileId.length === 0) throw bootstrapError("invalid profile id");
    if (
      r.authMode !== "anthropic-api-key" &&
      r.authMode !== "bedrock" &&
      r.authMode !== "claude-subscription" &&
      r.authMode !== "openai-api-key" &&
      r.authMode !== "codex-subscription"
    ) {
      throw bootstrapError("invalid auth mode");
    }
    if (r.kind !== "api-key" && r.kind !== "session") throw bootstrapError("invalid reference kind");
    return { profileId: r.profileId, authMode: r.authMode, kind: r.kind };
  });
  if (!Array.isArray(value.trustedRepositories) || value.trustedRepositories.length === 0) {
    throw bootstrapError("missing trusted repositories");
  }
  const trustedRepositories = value.trustedRepositories.map((r) => {
    if (typeof r !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(r)) throw bootstrapError("invalid trusted repository");
    return r;
  });
  if (value.authRoot !== undefined && (typeof value.authRoot !== "string" || value.authRoot.length === 0)) {
    throw bootstrapError("invalid auth root");
  }
  let syntheticProvider: ConfiguredSyntheticProviderOptions | undefined;
  if (value.syntheticProvider !== undefined) {
    const raw = value.syntheticProvider;
    if (!isRecord(raw)) throw bootstrapError("invalid synthetic provider");
    if (raw.version !== 1 || raw.kind !== "local-feedback-provider") throw bootstrapError("invalid synthetic provider");
    const port = raw.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw bootstrapError("invalid synthetic provider");
    }
    if (!Array.isArray(raw.profileIds) || raw.profileIds.length === 0) throw bootstrapError("invalid synthetic provider");
    const ids = new Set<string>();
    const profileIds = raw.profileIds.map((id) => {
      if (typeof id !== "string" || id.length === 0 || ids.has(id)) throw bootstrapError("invalid synthetic provider");
      ids.add(id);
      return id;
    });
    syntheticProvider = { version: 1, kind: "local-feedback-provider", port, profileIds };
  }
  return {
    version: 1,
    snapshotId: value.snapshotId,
    projectKey: value.projectKey,
    bridge: { baseUrl, bearer },
    references,
    trustedRepositories,
    ...(syntheticProvider ? { syntheticProvider } : {}),
    ...(value.authRoot ? { authRoot: value.authRoot } : {}),
  };
}

async function readBootstrap(path: string): Promise<LocalSessionBootstrapV1> {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) throw bootstrapError("missing path");
  const text = await readFile(path, "utf8");
  return parseBootstrap(JSON.parse(text));
}

/**
 * Pure metadata validation used by the local entrypoint before any repository hooks,
 * model tools, or git work. It does not contact the host bridge or load credentials.
 */
export async function validateLocalSessionBootstrap(
  path: string,
  snapshot: ResolvedAgentSnapshotV1 | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalSessionBootstrapV1> {
  if (env.NODE_OPTIONS || env.NODE_PATH) throw bootstrapError("node preload environment is not allowed");
  if (env[LOCAL_AUTH_BOOTSTRAP_ENV] !== path) throw bootstrapError("bootstrap pointer mismatch");
  const linkInfo = await lstat(path);
  if (!linkInfo.isFile()) throw bootstrapError("bootstrap path is not a file");
  const info = await stat(path);
  if (!info.isFile()) throw bootstrapError("bootstrap path is not a file");
  if ((info.mode & 0o077) !== 0) throw bootstrapError("bootstrap file is not private");
  const expectedUid = env.AI_IMPLEMENT_HOST_UID ? Number(env.AI_IMPLEMENT_HOST_UID) : undefined;
  if (expectedUid !== undefined && Number.isSafeInteger(expectedUid) && info.uid !== expectedUid) {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const rootProjection =
      currentUid === 0 &&
      env.AI_IMPLEMENT_MODE === "local" &&
      info.uid === 0 &&
      (linkInfo.mode & 0o077) === 0;
    if (rootProjection) {
      const parentInfo = await lstat(dirname(path));
      if (!parentInfo.isDirectory()) throw bootstrapError("bootstrap directory is not private");
      if (parentInfo.uid !== 0 || (parentInfo.mode & 0o077) !== 0) {
        throw bootstrapError("bootstrap directory is not private");
      }
    } else {
      throw bootstrapError("bootstrap owner does not match host uid");
    }
  }
  const validatedSnapshot = validateResolvedAgentSnapshot(snapshot);
  const bootstrap = await readBootstrap(path);
  if (bootstrap.snapshotId !== validatedSnapshot.snapshotId) throw bootstrapError("snapshot mismatch");
  for (const ref of bootstrap.references) {
    const selected = Object.values(validatedSnapshot.profiles).some(
      (p) => p.id === ref.profileId && p.authMode === ref.authMode,
    );
    if (!selected) throw bootstrapError("reference not selected by snapshot");
  }
  if (bootstrap.syntheticProvider) {
    for (const id of bootstrap.syntheticProvider.profileIds) {
      const selected = Object.values(validatedSnapshot.profiles).some(
        (p) => p.id === id && p.agent === "codex" && p.provider === "openai",
      );
      if (!selected) throw bootstrapError("synthetic provider profile not selected by snapshot");
    }
  }
  return bootstrap;
}

function bridgeCredentialPort(bootstrap: LocalSessionBootstrapV1): LocalCredentialPort {
  const base = bootstrap.bridge.baseUrl.replace(/\/$/, "");
  async function post(route: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bootstrap.bridge.bearer}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) as unknown : undefined;
      if (!res.ok) {
        const category = isRecord(parsed) && typeof parsed.category === "string" ? parsed.category : "credential_unreadable";
        throw new LocalAgentConfigError(category as never, "local credential bridge rejected the request");
      }
      return parsed;
    } catch (error) {
      if (error instanceof LocalAgentConfigError) throw error;
      throw new LocalAgentConfigError("credential_unreadable", "local credential bridge request failed");
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async load(request) {
      return await post("/load", request) as ModelAuthSecret;
    },
    async persistSession(request) {
      await post("/persist", request);
    },
  };
}

/**
 * Consumes the one-use local bootstrap file, withdraws it before configured options
 * are returned, and creates the configured-run inputs that talk to the host-owned
 * local credential bridge through closures rather than environment variables.
 */
export async function loadLocalSessionBootstrap(input: {
  env: NodeJS.ProcessEnv;
  snapshot: ResolvedAgentSnapshotV1;
  workspaceDir: string;
}): Promise<{ configured: ConfiguredRunOptions; onConfiguredFinish: (safe: boolean) => Promise<void> }> {
  const path = input.env[LOCAL_AUTH_BOOTSTRAP_ENV];
  if (!path) throw bootstrapError("bootstrap pointer is missing");
  const bootstrap = await validateLocalSessionBootstrap(path, input.snapshot, input.env);
  delete input.env[LOCAL_AUTH_BOOTSTRAP_ENV];
  delete input.env.NODE_OPTIONS;
  delete input.env.NODE_PATH;
  await unlink(path);
  const port = bridgeCredentialPort(bootstrap);
  const configured: ConfiguredRunOptions = {
    agentConfig: input.snapshot,
    localCredentialPort: port,
    repositories: bootstrap.trustedRepositories,
    repoTrust: async (repository) =>
      bootstrap.trustedRepositories.includes(repository)
        ? { visibility: "private", trustedForSubscription: true }
        : { visibility: "unknown", trustedForSubscription: false },
    ...(bootstrap.syntheticProvider ? { syntheticProvider: bootstrap.syntheticProvider } : {}),
    ...(bootstrap.authRoot ? { modelAuthRoot: bootstrap.authRoot } : {}),
  };
  return {
    configured,
    onConfiguredFinish: async (safe: boolean) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(`${bootstrap.bridge.baseUrl.replace(/\/$/, "")}/disposition`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${bootstrap.bridge.bearer}` },
          body: JSON.stringify({ safe }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("local configured disposition was not acknowledged");
      } catch {
        throw new Error("local configured disposition was not acknowledged");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (Buffer.concat(chunks).length > 64 * 1024) throw new Error("body too large");
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export async function startLocalAuthBridge(input: {
  snapshotId: string;
  projectKey: string;
  credentialPort: LocalCredentialPort;
  ownership: LocalSessionOwnership;
  leases: readonly LocalSessionLease[];
  references: readonly LocalCredentialReference[];
  trustedRepositories: readonly string[];
  syntheticProvider?: ConfiguredSyntheticProviderOptions;
  listenPort?: number;
  authRoot?: string;
}): Promise<LocalAuthBridge> {
  const bearer = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  let safeDisposition: boolean | null = null;
  const handlers = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const handler = (async () => {
      try {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${bearer}`) return sendJson(res, 401, { error: "unauthorized" });
        const body = await readJsonBody(req);
        if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
        if (req.url === "/load") return sendJson(res, 200, await input.credentialPort.load(body as never));
        if (req.url === "/persist") {
          if (!input.credentialPort.persistSession) return sendJson(res, 404, { error: "unsupported" });
          await input.credentialPort.persistSession(body as never);
          return sendJson(res, 200, { ok: true });
        }
        if (req.url === "/disposition") {
          safeDisposition = isRecord(body) && body.safe === true;
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 404, { error: "unknown" });
      } catch (error) {
        const category = error instanceof LocalAgentConfigError ? error.category : "credential_unreadable";
        return sendJson(res, 500, { category });
      }
    })();
    handlers.add(handler);
    handler.finally(() => handlers.delete(handler));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.listenPort ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local credential bridge did not bind a TCP port");
  const bootstrap: LocalSessionBootstrapV1 = {
    version: 1,
    snapshotId: input.snapshotId,
    projectKey: input.projectKey,
    bridge: { baseUrl: `http://host.docker.internal:${address.port}`, bearer },
    references: input.references.map((r) => ({ profileId: r.profileId, authMode: r.authMode, kind: r.kind })),
    trustedRepositories: input.trustedRepositories,
    ...(input.syntheticProvider ? { syntheticProvider: input.syntheticProvider } : {}),
    ...(input.authRoot ? { authRoot: input.authRoot } : {}),
  };
  async function closeServer(): Promise<void> {
    await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
    await Promise.allSettled([...handlers]);
  }
  return {
    bootstrap,
    get safeDisposition() {
      return safeDisposition;
    },
    close: closeServer,
    async releaseAfterTermination(confirmTermination) {
      if (safeDisposition !== true) return;
      const errors: unknown[] = [];
      for (const lease of input.leases) {
        try {
          if (lease.used) {
            await input.ownership.release(lease, { confirmTermination });
          } else {
            await input.ownership.releaseUnused(lease, { confirmTermination });
          }
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "local session release failed");
    },
    async releaseUnused(confirmTermination) {
      const errors: unknown[] = [];
      for (const lease of input.leases) {
        try {
          await input.ownership.releaseUnused(lease, { confirmTermination });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "local unused session release failed");
    },
  };
}

/**
 * Launch a Docker container and return a handle for log streaming and status
 * queries. The secret env file is removed as soon as Docker reads it (in the
 * finally block), whether the launch succeeds or fails.
 */
export async function launchLocalSession(
  opts: LocalSessionLaunchOptions,
): Promise<LocalSessionHandle> {
  const envFilePath = await writeSessionSecretEnvFile(opts.secretEnv);
  const cidFilePath = join(tmpdir(), "ai-implement-local-session", `${randomUUID()}.cid`);

  const args = [
    "run", "-d",
    "--name", opts.containerName,
    "--cidfile", cidFilePath,
    "--add-host", `host.docker.internal:${opts.hostGateway ?? "host-gateway"}`,
  ];

  if (opts.networkName) {
    args.push("--network", opts.networkName);
  }

  if (opts.workspace) {
    args.push("-v", `${opts.workspace}:/workspace`);
  }

  for (const vol of opts.extraVolumes ?? []) {
    args.push("-v", vol);
  }

  args.push("--env-file", envFilePath);

  for (const [key, value] of Object.entries(opts.publicEnv)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(opts.image);

  const startedAt = new Date();
  let containerId: string;
  try {
    const { stdout } = await execFile("docker", args);
    containerId = stdout.trim();
  } catch (err) {
    const cidFileContent = await readFile(cidFilePath, "utf8").catch(() => null);
    const cidFileId = cidFileContent?.trim() || null;
    if (cidFileId) {
      await execFile("docker", ["rm", "-f", cidFileId]).catch(() => undefined);
    }
    const msg =
      (err as { stderr?: string }).stderr?.trim() ||
      (err instanceof Error ? err.message : String(err));
    throw new Error(`Failed to launch local session container: ${msg}`);
  } finally {
    await unlink(envFilePath).catch(() => undefined);
    await unlink(cidFilePath).catch(() => undefined);
  }

  return { containerId, containerName: opts.containerName, startedAt };
}

/**
 * Query the current state of the container.
 */
export async function getSessionStatus(handle: LocalSessionHandle): Promise<LocalContainerState> {
  return inspectLocalContainer(handle.containerId);
}

const SHELL_READY_RE = /^\[dev:run\] shell-ready exit=(\d+)$/;

/**
 * Stream container logs line by line. Resolves once the container exits and
 * all log output has been emitted.
 */
export async function streamSessionLogs(
  handle: LocalSessionHandle,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const proc = spawn("docker", ["logs", "-f", handle.containerId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const emit = (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const t = line.trimEnd();
        if (t) onLine(t);
      }
    };
    proc.stdout?.on("data", emit);
    proc.stderr?.on("data", emit);
    proc.on("close", () => resolve());
  });
}

/**
 * Stream container logs until either the container exits or the shell-ready
 * sentinel "[dev:run] shell-ready exit=N" is emitted. Returns whether the
 * sentinel was found and the pipeline exit code embedded in it. Non-sentinel
 * lines are forwarded to onLine as usual.
 */
export async function streamSessionLogsUntilShellReady(
  handle: LocalSessionHandle,
  onLine: (line: string) => void,
): Promise<{ ready: boolean; exitCode: number | null }> {
  return new Promise<{ ready: boolean; exitCode: number | null }>((resolve) => {
    const proc = spawn("docker", ["logs", "-f", handle.containerId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolved = false;
    const finish = (result: { ready: boolean; exitCode: number | null }) => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve(result);
      }
    };
    const emit = (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const t = line.trimEnd();
        if (!t) continue;
        const m = t.match(SHELL_READY_RE);
        if (m) {
          finish({ ready: true, exitCode: parseInt(m[1], 10) });
          return;
        }
        onLine(t);
      }
    };
    proc.stdout?.on("data", emit);
    proc.stderr?.on("data", emit);
    proc.on("close", () => finish({ ready: false, exitCode: null }));
  });
}

/**
 * Poll until the container exits and return the exit code and wall-clock
 * duration.
 */
export async function awaitSessionResult(
  handle: LocalSessionHandle,
): Promise<{ exitCode: number | null; durationMs: number }> {
  while (true) {
    const state = await inspectLocalContainer(handle.containerId);
    if (!state.running) {
      return { exitCode: state.exitCode, durationMs: Date.now() - handle.startedAt.getTime() };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Force-remove the container. Best-effort; errors are swallowed.
 */
export async function stopLocalSession(handle: LocalSessionHandle): Promise<void> {
  try {
    await execFile("docker", ["rm", "-f", handle.containerId]);
  } catch {
    // best-effort cleanup
  }
}
