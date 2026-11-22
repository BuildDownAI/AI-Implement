import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { redactAndCap, tailBytes } from "./pipeline/failure-classification.js";

const execFile = promisify(nodeExecFile);

export const LOCAL_JOB_LOG_LINES = 2_000;
export const LOCAL_JOB_LOG_MAX_CHARS = 256 * 1024;
const DOCKER_LOG_MAX_BUFFER = 512 * 1024;

export interface LocalJobLogsResult {
  logs: string;
  source: "live" | "saved";
}

type DockerLogFetcher = (containerId: string, lastN: number) => Promise<string>;

export function isSafeLocalContainerId(containerId: string): boolean {
  return /^[a-f0-9]{12,64}$/i.test(containerId);
}

export async function readLocalJobLogs(
  containerId: string,
  fetchLiveLogs: DockerLogFetcher = fetchLiveDockerLogs,
): Promise<LocalJobLogsResult | null> {
  assertSafeLocalContainerId(containerId);

  try {
    const live = await fetchLiveLogs(containerId, LOCAL_JOB_LOG_LINES);
    return { logs: capLocalJobLogs(live), source: "live" };
  } catch {
    const saved = await readSavedLocalJobLogs(containerId);
    return saved === null ? null : { logs: saved, source: "saved" };
  }
}

export async function archiveLocalContainerLogs(
  containerId: string,
  fetchLiveLogs: DockerLogFetcher = fetchLiveDockerLogs,
): Promise<void> {
  assertSafeLocalContainerId(containerId);

  const raw = await fetchLiveLogs(containerId, LOCAL_JOB_LOG_LINES);
  const logs = capLocalJobLogs(raw);
  const ids = new Set([containerId.toLowerCase()]);
  const canonicalId = await resolveCanonicalContainerId(containerId).catch(() => null);
  if (canonicalId) ids.add(canonicalId.toLowerCase());

  await ensureLogsDir();
  for (const id of ids) {
    await writeSavedLocalJobLogs(id, logs);
  }
}

export async function archiveLocalContainerLogsBestEffort(containerId: string): Promise<void> {
  try {
    await archiveLocalContainerLogs(containerId);
  } catch (err) {
    const detail = redactAndCap(errorMessage(err), 500);
    console.warn(`[local-docker] Failed to archive logs before removing container ${containerId}: ${detail}`);
  }
}

function assertSafeLocalContainerId(containerId: string): void {
  if (!isSafeLocalContainerId(containerId)) {
    throw new Error("Invalid local Docker container id");
  }
}

function capLocalJobLogs(logs: string): string {
  const capped = redactAndCap(logs.trim(), LOCAL_JOB_LOG_MAX_CHARS);
  if (Buffer.byteLength(capped, "utf-8") <= LOCAL_JOB_LOG_MAX_CHARS) return capped;
  return tailBytes(capped, LOCAL_JOB_LOG_MAX_CHARS).text;
}

async function fetchLiveDockerLogs(containerId: string, lastN: number): Promise<string> {
  const { stdout, stderr } = await execFile(
    "docker",
    ["logs", "--tail", String(lastN), containerId],
    { timeout: 10_000, maxBuffer: DOCKER_LOG_MAX_BUFFER },
  );
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

async function resolveCanonicalContainerId(containerId: string): Promise<string | null> {
  const { stdout } = await execFile(
    "docker",
    ["inspect", "--format", "{{.Id}}", containerId],
    { timeout: 10_000, maxBuffer: 4 * 1024 },
  );
  const id = stdout.trim();
  return isSafeLocalContainerId(id) ? id : null;
}

async function readSavedLocalJobLogs(containerId: string): Promise<string | null> {
  const dir = await logsDir();
  const dirHandle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch((err) => {
    if (isNodeErrno(err, "ENOENT")) return null;
    throw err;
  });
  if (!dirHandle) return null;
  await dirHandle.close();

  const file = logFilePath(dir, containerId);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (stat.size > LOCAL_JOB_LOG_MAX_CHARS) return null;
    return capLocalJobLogs(await readFile(file, "utf-8"));
  } catch (err) {
    if (isNodeErrno(err, "ENOENT")) return null;
    throw err;
  }
}

async function writeSavedLocalJobLogs(containerId: string, logs: string): Promise<void> {
  const dir = await logsDir();
  const file = logFilePath(dir, containerId);
  const tmp = join(dir, `.${containerId}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, logs, { mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
    await chmod(file, 0o600);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

async function ensureLogsDir(): Promise<void> {
  const dir = await logsDir();
  const existing = await lstat(dir).catch((err) => {
    if (isNodeErrno(err, "ENOENT")) return null;
    throw err;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    throw new Error("Local runner logs directory is not a normal directory");
  }

  await mkdir(dir, { recursive: true, mode: 0o700 });
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  await handle.close();
  await chmod(dir, 0o700);
}

async function logsDir(): Promise<string> {
  const { getDb } = await import("./dedup.js");
  const dbPath = getDb().name || process.env.DEDUP_DB_PATH || "/data/dedup.sqlite";
  return join(dirname(dbPath), "local-runner-logs");
}

function logFilePath(dir: string, containerId: string): string {
  assertSafeLocalContainerId(containerId);
  return join(dir, `${containerId.toLowerCase()}.log`);
}

function isNodeErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const maybe = err as { message?: string; stderr?: string; stdout?: string };
    return maybe.stderr?.trim() || maybe.stdout?.trim() || maybe.message || String(err);
  }
  return String(err);
}
