import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  lstat,
  writeFile,
  unlink,
  link,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { RepoMapping } from "../config.js";
import { assemblePlanningContext } from "../planning-context-assembly.js";
import { parseTaskDocument } from "../task-document.js";
import type {
  AIImplementSnapshot,
  FeatureNodeRollUp,
  IssueLifecycleState,
  TicketIssue,
  TicketingProvider,
} from "./types.js";

export type FilesystemStatus =
  | "ready"
  | "planning"
  | "plan-approved"
  | "implementing"
  | "pr-ready"
  | "failed"
  | "completed"
  | "cancelled";

export interface FilesystemState {
  version: 1;
  status: FilesystemStatus;
  comments: Array<{ body: string; createdAt: string }>;
  prUrls: string[];
  failurePhase?: "planning" | "implementation";
  updatedAt: string;
}

interface FilesystemTask {
  issue: TicketIssue;
  taskPath: string;
  statePath: string;
  markdown: string;
  state: FilesystemState | null;
  ticketPath: string;
  location: FilesystemIssueLocation;
}

export type FilesystemIssueLocation = "active" | "completed" | "failed";

export interface FilesystemIssueDetails {
  issue: TicketIssue;
  markdown: string;
  state: FilesystemState | null;
  statePath: string;
  ticketPath: string;
  location: FilesystemIssueLocation;
}

const IDENTIFIER_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const TERMINAL = new Set<FilesystemStatus>(["completed", "cancelled"]);
// Registry invalidation can replace a provider while an old callback is still writing.
const issueLocks = new Map<string, Promise<unknown>>();
const PLANNING_PREFIXES = [
  "## 🏗️ AI Planning: Architecture Analysis",
  "## 🧪 AI Planning: Test Plan",
  "## 🔗 AI Planning: Cross-Story Context",
  "## 🗺 AI Planning: Implementation Map",
  "## ✅ AI Planning: Acceptance Bar",
  "## ⚠️ AI Planning: Risks & Open Questions",
];

export class FilesystemProvider implements TicketingProvider {
  readonly id = "filesystem";
  private readonly getMappings: () => Record<string, RepoMapping>;

  constructor(getMappings: () => Record<string, RepoMapping>) {
    this.getMappings = getMappings;
  }

  async fetchAIImplementSnapshot(): Promise<AIImplementSnapshot> {
    const needsPlanning: TicketIssue[] = [];
    const readyForImplementation: TicketIssue[] = [];
    const inProgressCountsByScope: Record<string, number> = {};

    const tasks = await this.scanTasks();
    for (const task of tasks.values()) {
      if (task.state?.status === "completed") {
        await this.withIssueLock(task.issue.id, async () => {
          const current = (await this.scanTasks()).get(task.issue.id);
          if (current) await this.archiveCompletedTask(current);
        });
        continue;
      }
      if (task.location !== "active") continue;
      const mapping = this.mappingForScope(task.issue.scopeKey);
      if (!mapping) continue;
      const status = task.state?.status ?? (mapping.planningEnabled ? "ready" : "plan-approved");
      task.issue.nativeStatus = status;

      if (status === "planning" || status === "implementing") {
        inProgressCountsByScope[task.issue.scopeKey] =
          (inProgressCountsByScope[task.issue.scopeKey] ?? 0) + 1;
        continue;
      }
      if (status === "ready") {
        needsPlanning.push(task.issue);
      } else if (status === "plan-approved") {
        readyForImplementation.push(task.issue);
      }
    }

    return { needsPlanning, readyForImplementation, inProgressCountsByScope, parentsToFinalize: [] };
  }

  async fetchLifecycleStates(issueIds: string[]): Promise<Map<string, IssueLifecycleState>> {
    const tasks = await this.scanTasks();
    const result = new Map<string, IssueLifecycleState>();
    for (const id of issueIds) {
      const task = tasks.get(id);
      if (!task) continue;
      const status = task.state?.status;
      if (status === "completed") result.set(id, "completed");
      else if (status === "cancelled") result.set(id, "cancelled");
      else result.set(id, "active");
    }
    return result;
  }

  async fetchFeatureNodeRollUps(): Promise<FeatureNodeRollUp[]> {
    return [];
  }

  async markPlanningStarted(issueId: string, scopeKey: string): Promise<void> {
    await this.updateTask(issueId, scopeKey, (state) => (
      isCallbackTerminal(state.status) || state.status === "implementing" || state.status === "plan-approved"
        ? null : { ...state, status: "planning" }
    ), { activeOnly: true });
  }

  async markPlanComplete(issueId: string, scopeKey: string): Promise<void> {
    await this.updateTask(issueId, scopeKey, (state) => (
      isCallbackTerminal(state.status) || state.status === "implementing"
        ? null : { ...state, status: "plan-approved" }
    ), { activeOnly: true });
  }

  async markPlanningFailed(issueId: string, scopeKey: string, reason: string): Promise<boolean> {
    return this.updateTask(issueId, scopeKey, (state) => {
      if (isCallbackTerminal(state.status) || state.status === "implementing") return null;
      return appendComment(
        { ...state, status: "failed", failurePhase: "planning" },
        `⚠️ Planning failed: ${reason}`,
      );
    }, { activeOnly: true });
  }

  async markImplementing(issueId: string, scopeKey: string): Promise<void> {
    await this.updateTask(issueId, scopeKey, (state) => (
      isCallbackTerminal(state.status) ? null : { ...state, status: "implementing" }
    ), { activeOnly: true });
  }

  async markPrReady(issueId: string, scopeKey: string, prUrl: string): Promise<boolean> {
    return this.updateTask(issueId, scopeKey, (state) => {
      if (isCallbackTerminal(state.status)) return null;
      return appendComment(
        { ...state, status: "pr-ready", prUrls: unique([...state.prUrls, prUrl]) },
        `🚀 PR ready for review: ${prUrl}`,
      );
    }, { activeOnly: true });
  }

  async markImplementationFailed(issueId: string, scopeKey: string, reason: string): Promise<boolean> {
    return this.updateTask(issueId, scopeKey, (state) => {
      if (isCallbackTerminal(state.status)) return null;
      return appendComment(
        { ...state, status: "failed", failurePhase: "implementation" },
        `⚠️ Implementation failed: ${reason}`,
      );
    }, { activeOnly: true });
  }

  async clearWorkingState(issueId: string, scopeKey: string): Promise<boolean> {
    const mapping = this.mappingForScope(scopeKey);
    return this.updateTask(issueId, scopeKey, (state) => {
      if (isCallbackTerminal(state.status)) return null;
      const nextStatus =
        state.failurePhase === "implementation" || state.status === "implementing" || state.status === "plan-approved"
          ? "plan-approved"
          : mapping?.planningEnabled
            ? "ready"
            : "plan-approved";
      const { failurePhase: _failurePhase, ...rest } = state;
      return { ...rest, status: nextStatus };
    }, { activeOnly: true });
  }

  async markMerged(issueId: string, scopeKey: string): Promise<void> {
    const updated = await this.updateTask(issueId, scopeKey, (state) => (
      state.status === "cancelled" ? state : { ...state, status: "completed" }
    ));
    if (updated) {
      await this.withIssueLock(issueId, async () => {
        const task = (await this.scanTasks()).get(issueId);
        if (task?.state?.status === "completed") await this.archiveCompletedTask(task);
      });
    }
  }

  async postComment(issueId: string, body: string): Promise<void> {
    const scopeKey = scopeFromIssueId(issueId);
    await this.updateTask(issueId, scopeKey, (state) => appendComment(state, body));
  }

  async fetchPlanningContext(issueId: string): Promise<string> {
    try {
      const task = (await this.scanTasks()).get(issueId);
      if (!task?.state) return "";
      return assemblePlanningContext(task.state.comments, PLANNING_PREFIXES);
    } catch (err) {
      console.warn(`[filesystem] Failed to fetch planning context for ${issueId}:`, err);
      return "";
    }
  }

  issueUrl(issue: TicketIssue): string {
    const issueId = issue.id?.startsWith("filesystem:")
      ? issue.id
      : issue.scopeKey
        ? `filesystem:${issue.scopeKey}:${issue.identifier}`
        : null;
    return issueId ? `/admin?filesystemIssue=${encodeURIComponent(issueId)}` : `/admin`;
  }

  async readIssueDetails(issueId: string): Promise<FilesystemIssueDetails | null> {
    const parsed = parseFilesystemIssueId(issueId);
    const task = (await this.scanTasks()).get(issueId);
    if (!task) return null;
    return {
      issue: task.issue,
      markdown: task.markdown,
      state: task.state,
      statePath: `.state/${parsed.scopeKey}/${parsed.identifier}.json`,
      ticketPath: task.ticketPath,
      location: task.location,
    };
  }

  async findByKey(key: string): Promise<TicketIssue | null> {
    if (!IDENTIFIER_RE.test(key)) return null;
    const matches = [...(await this.scanTasks()).values()].filter((task) => task.issue.identifier === key);
    return matches.length === 1 ? matches[0].issue : null;
  }

  async archiveFailed(
    issueId: string,
    scopeKey: string,
    phase: "planning" | "implementation",
  ): Promise<boolean> {
    validateSafeSegment(scopeKey, "scopeKey");
    if (!issueId.startsWith(`filesystem:${scopeKey}:`)) {
      throw new Error(`Filesystem issueId ${JSON.stringify(issueId)} does not belong to scopeKey ${JSON.stringify(scopeKey)}`);
    }
    return this.withIssueLock(issueId, async () => {
      const task = (await this.scanTasks()).get(issueId);
      if (!task || task.location !== "active") return false;
      const current = task.state ?? defaultState(this.mappingForScope(scopeKey)?.planningEnabled ?? true);
      if (isCallbackTerminal(current.status) || current.prUrls.length > 0) {
        return false;
      }
      await writeStateAtomic(task.statePath, {
        ...current,
        status: "failed",
        failurePhase: phase,
        version: 1,
        updatedAt: new Date().toISOString(),
      });
      const refreshed = (await this.scanTasks()).get(issueId);
      if (!refreshed || refreshed.location !== "active" || refreshed.state?.status !== "failed") return false;
      return this.moveTaskToArchive(task, "failed");
    });
  }

  async retryFailed(issueId: string, scopeKey: string): Promise<boolean> {
    validateSafeSegment(scopeKey, "scopeKey");
    if (!issueId.startsWith(`filesystem:${scopeKey}:`)) {
      throw new Error(`Filesystem issueId ${JSON.stringify(issueId)} does not belong to scopeKey ${JSON.stringify(scopeKey)}`);
    }
    return this.withIssueLock(issueId, async () => {
      const task = (await this.scanTasks()).get(issueId);
      if (!task || (task.location !== "failed" && task.location !== "active") || !task.state) return false;
      if (task.state.status !== "failed" || task.state.prUrls.length > 0) return false;
      const mapping = this.mappingForScope(scopeKey);
      if (!mapping) return false;
      if (task.location === "failed" && !(await this.restoreFailedTask(task))) return false;
      const { failurePhase: _failurePhase, ...rest } = task.state;
      const status = task.state.failurePhase === "implementation"
        ? "plan-approved"
        : mapping.planningEnabled
          ? "ready"
          : "plan-approved";
      await writeStateAtomic(task.statePath, {
        ...rest,
        status,
        version: 1,
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
  }

  private async updateTask(
    issueId: string,
    scopeKey: string,
    update: (state: FilesystemState) => FilesystemState | null,
    options: { activeOnly?: boolean } = {},
  ): Promise<boolean> {
    validateSafeSegment(scopeKey, "scopeKey");
    if (!issueId.startsWith(`filesystem:${scopeKey}:`)) {
      throw new Error(`Filesystem issueId ${JSON.stringify(issueId)} does not belong to scopeKey ${JSON.stringify(scopeKey)}`);
    }
    return this.withIssueLock(issueId, async () => {
      const task = (await this.scanTasks()).get(issueId);
      if (!task) throw new Error(`Unknown filesystem issue: ${issueId}`);
      if (options.activeOnly && task.location !== "active") return false;
      const current = task.state ?? defaultState(this.mappingForScope(scopeKey)?.planningEnabled ?? true);
      const next = update(current);
      if (next === null) return false;
      await writeStateAtomic(task.statePath, { ...next, version: 1, updatedAt: new Date().toISOString() });
      return true;
    });
  }

  private async withIssueLock<T>(issueId: string, fn: () => Promise<T>): Promise<T> {
    const prior = issueLocks.get(issueId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    const tail = next.catch(() => undefined);
    issueLocks.set(issueId, tail);
    try {
      return await next;
    } finally {
      if (issueLocks.get(issueId) === tail) issueLocks.delete(issueId);
    }
  }

  private async scanTasks(): Promise<Map<string, FilesystemTask>> {
    const tasks: FilesystemTask[] = [];
    for (const [scopeKey, mapping] of Object.entries(this.getMappings())) {
      if (mapping.ticketingConfig.kind !== "filesystem") continue;
      validateSafeSegment(scopeKey, "scopeKey");
      const directory = await existingRealDirectory(mapping.ticketingConfig.directory);
      if (!directory) continue;
      const stateRoot = join(directory, ".state", scopeKey);
      for (const location of ["active", "completed", "failed"] as const) {
        const scanDirectory = location === "active" ? directory : join(directory, location);
        const entries = await readTaskDirectory(scanDirectory, location === "active");
        for (const entry of entries) {
          const taskPath = join(scanDirectory, entry);
          const fallbackIdentifier = basename(entry, ".md");
          try {
            const content = await readFile(taskPath, "utf8");
            const parsed = parseTaskDocument(content, `filesystem:${scopeKey}:${fallbackIdentifier}`, fallbackIdentifier);
            const identifier = parsed.issue.identifier;
            if (!IDENTIFIER_RE.test(identifier)) throw new Error("Ticket id must have the form REVIEW-001 (or use that filename when id is omitted)");
            const statePath = join(stateRoot, `${identifier}.json`);
            await checkStateDirectories(stateRoot);
            const state = await readState(statePath);
            if (state === "corrupt") throw new Error(`Invalid state in ${statePath}; refusing to redispatch`);
            tasks.push({
              taskPath,
              statePath,
              markdown: content,
              state,
              ticketPath: relative(directory, taskPath),
              location,
              issue: {
                id: `filesystem:${scopeKey}:${identifier}`,
                identifier,
                title: parsed.issue.title,
                description: parsed.issue.description,
                scopeKey,
                nativeStatus: state?.status ?? (mapping.planningEnabled ? "ready" : "plan-approved"),
                ...(parsed.baseBranch ? { baseBranch: parsed.baseBranch } : {}),
                ...(parsed.profiles ? { profiles: parsed.profiles } : {}),
                ...(parsed.maxTurns ? { maxTurns: parsed.maxTurns } : {}),
                ...(parsed.maxIterations ? { maxIterations: parsed.maxIterations } : {}),
              },
            });
          } catch (err) {
            console.warn(`[filesystem] Skipping malformed task ${taskPath}: ${(err as Error).message}`);
          }
        }
      }
    }

    const byId = new Map<string, FilesystemTask>();
    const duplicates = new Set<string>();
    for (const task of tasks) {
      if (byId.has(task.issue.id)) duplicates.add(task.issue.id);
      else byId.set(task.issue.id, task);
    }
    for (const id of duplicates) {
      byId.delete(id);
      console.warn(`[filesystem] Duplicate ticket id ${id}; refusing to dispatch either file`);
    }
    return byId;
  }

  private mappingForScope(scopeKey: string): RepoMapping | null {
    const mapping = this.getMappings()[scopeKey];
    return mapping?.ticketingConfig.kind === "filesystem" ? mapping : null;
  }

  private async archiveCompletedTask(task: FilesystemTask): Promise<boolean> {
    if (task.location === "completed") return true;
    if (task.state?.status !== "completed") return false;
    return this.moveTaskToArchive(task, "completed");
  }

  private async moveTaskToArchive(task: FilesystemTask, archive: "completed" | "failed"): Promise<boolean> {
    if (task.location !== "active" && !(archive === "completed" && task.location === "failed")) return false;
    const root = task.location === "active" ? dirname(task.taskPath) : dirname(dirname(task.taskPath));
    if (await isSharedFilesystemRoot(root, this.getMappings())) {
      console.warn(`[filesystem] Skipping ${archive} archive for ${task.issue.id}; directory is shared by multiple filesystem mappings`);
      return false;
    }
    const archiveDir = join(root, archive);
    const target = join(archiveDir, basename(task.taskPath));
    if (await pathExists(target)) return false;
    await mkdir(archiveDir, { recursive: true });
    if (!(await isSafeArchiveDirectory(archiveDir))) return false;
    return moveWithoutOverwrite(task.taskPath, target);
  }

  private async restoreFailedTask(task: FilesystemTask): Promise<boolean> {
    if (task.location !== "failed") return false;
    const root = dirname(dirname(task.taskPath));
    const target = join(root, basename(task.taskPath));
    if (await pathExists(target)) return false;
    return moveWithoutOverwrite(task.taskPath, target);
  }
}

async function moveWithoutOverwrite(source: string, target: string): Promise<boolean> {
  // link creates the destination exclusively; rename would overwrite a file
  // created after the preflight collision check. Both paths share one volume.
  try {
    await link(source, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    await unlink(source);
  } catch (err) {
    // Roll back our extra link when the original could not be removed. Leave
    // both copies untouched if another process replaced either path.
    const [original, linked] = await Promise.all([lstat(source), lstat(target)]);
    if (original.dev === linked.dev && original.ino === linked.ino) await unlink(target);
    throw err;
  }
  return true;
}

function defaultState(planningEnabled: boolean): FilesystemState {
  return {
    version: 1,
    status: planningEnabled ? "ready" : "plan-approved",
    comments: [],
    prUrls: [],
    updatedAt: new Date().toISOString(),
  };
}

function appendComment(state: FilesystemState, body: string): FilesystemState {
  return {
    ...state,
    comments: [...state.comments, { body, createdAt: new Date().toISOString() }],
  };
}

async function existingRealDirectory(path: string): Promise<string | null> {
  try {
    const resolved = resolve(path);
    const info = await stat(resolved);
    if (!info.isDirectory()) return null;
    return await realpath(resolved);
  } catch {
    return null;
  }
}

async function readTaskDirectory(directory: string, isRoot: boolean): Promise<string[]> {
  if (!(await isSafeScanDirectory(directory))) return [];
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries.sort()) {
    if (isRoot && (entry === ".state" || entry === "completed" || entry === "failed")) continue;
    if (extname(entry) !== ".md") continue;
    if (!SAFE_SEGMENT_RE.test(entry)) continue;
    const taskPath = join(directory, entry);
    try {
      const fileStat = await lstat(taskPath);
      if (fileStat.isFile() && !fileStat.isSymbolicLink()) result.push(entry);
    } catch {
      continue;
    }
  }
  return result;
}

async function isSafeScanDirectory(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

async function isSafeArchiveDirectory(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (err) {
    if (isMissing(err)) return true;
    throw err;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

async function isSharedFilesystemRoot(root: string, mappings: Record<string, RepoMapping>): Promise<boolean> {
  let matches = 0;
  for (const mapping of Object.values(mappings)) {
    if (mapping.ticketingConfig.kind !== "filesystem") continue;
    const directory = await existingRealDirectory(mapping.ticketingConfig.directory);
    if (directory === root) matches += 1;
  }
  return matches > 1;
}

async function readState(path: string): Promise<FilesystemState | null | "corrupt"> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`State must be a regular file: ${path}`);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<FilesystemState>;
    if (parsed.version !== 1 || !isFilesystemStatus(parsed.status) ||
        !Array.isArray(parsed.comments) || !parsed.comments.every(isComment) ||
        !Array.isArray(parsed.prUrls) || !parsed.prUrls.every((url) => typeof url === "string") ||
        typeof parsed.updatedAt !== "string") return "corrupt";
    return {
      version: 1,
      status: parsed.status,
      comments: Array.isArray(parsed.comments)
        ? parsed.comments.filter(isComment)
        : [],
      prUrls: Array.isArray(parsed.prUrls)
        ? parsed.prUrls.filter((url): url is string => typeof url === "string")
        : [],
      failurePhase: parsed.failurePhase === "planning" || parsed.failurePhase === "implementation"
        ? parsed.failurePhase
        : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return "corrupt";
  }
}

async function writeStateAtomic(path: string, state: FilesystemState): Promise<void> {
  await checkStateDirectories(dirname(path));
  await mkdir(dirname(path), { recursive: true });
  await checkStateDirectories(dirname(path));
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch((err: unknown) => { if (!isMissing(err)) throw err; });
  }
}

/** The configured root is canonicalized; neither .state nor its scope may redirect writes. */
async function checkStateDirectories(scopeDirectory: string): Promise<void> {
  for (const path of [dirname(scopeDirectory), scopeDirectory]) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`State directory must not be a symlink: ${path}`);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isFilesystemStatus(value: unknown): value is FilesystemStatus {
  return typeof value === "string" && (
    value === "ready" ||
    value === "planning" ||
    value === "plan-approved" ||
    value === "implementing" ||
    value === "pr-ready" ||
    value === "failed" ||
    value === "completed" ||
    value === "cancelled"
  );
}

function isCallbackTerminal(status: FilesystemStatus): boolean {
  return TERMINAL.has(status) || status === "pr-ready";
}

function isComment(value: unknown): value is { body: string; createdAt: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { body?: unknown }).body === "string" &&
    typeof (value as { createdAt?: unknown }).createdAt === "string",
  );
}

function validateSafeSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT_RE.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid filesystem ${label}: ${JSON.stringify(value)}`);
  }
}

function scopeFromIssueId(issueId: string): string {
  const parsed = parseFilesystemIssueId(issueId);
  if (!parsed) throw new Error(`Invalid filesystem issueId: ${JSON.stringify(issueId)}`);
  return parsed.scopeKey;
}

function parseFilesystemIssueId(issueId: string): { scopeKey: string; identifier: string } {
  const match = /^filesystem:([^:]+):([^:]+)$/.exec(issueId);
  if (!match) throw new Error(`Invalid filesystem issueId: ${JSON.stringify(issueId)}`);
  const [, scopeKey, identifier] = match;
  validateSafeSegment(scopeKey, "scopeKey");
  if (!IDENTIFIER_RE.test(identifier)) {
    throw new Error(`Invalid filesystem issue identifier: ${JSON.stringify(identifier)}`);
  }
  return { scopeKey, identifier };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
