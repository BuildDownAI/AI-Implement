import { mkdir, rm, lstat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LocalArtifactInput, LocalRunSummary } from "./run-result.js";

const DEFAULT_OUTPUT_ROOT = "/output/runs";

// UUID-like: alphanumeric + hyphens, 8–64 chars, must start with alphanumeric.
// Rejects dots, slashes, backslashes, and all other path-significant characters.
const VALID_RUN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{7,63}$/;

/**
 * Validate that a run ID is safe to use as a path component.
 * Rejects anything that could enable path traversal or directory escapes.
 * Throws on invalid input.
 */
export function validateRunId(runId: string): void {
  if (!VALID_RUN_ID_RE.test(runId)) {
    throw new Error(
      `Invalid run ID ${JSON.stringify(runId)}: must be 8–64 characters, alphanumeric and hyphens only, starting with alphanumeric.`,
    );
  }
}

/**
 * Return the absolute artifact directory path for a given run ID.
 * Validates runId before constructing the path. Does not touch the filesystem.
 */
export function resolveArtifactDir(runId: string, outputRoot?: string): string {
  validateRunId(runId);
  return resolve(join(outputRoot ?? DEFAULT_OUTPUT_ROOT, runId));
}

/**
 * Assert that dir is directly under root and is not itself a symlink.
 * Uses path.resolve for normalisation (prevents .. traversal) and lstat for
 * the symlink check. Does not resolve symlinks in intermediate path components
 * — the outputRoot is a trusted caller-controlled value.
 */
async function assertSafeArtifactDir(dir: string, root: string): Promise<void> {
  const absDir = resolve(dir);
  const absRoot = resolve(root);
  if (!absDir.startsWith(absRoot + "/")) {
    throw new Error(
      `Path traversal rejected: "${absDir}" is not under "${absRoot}"`,
    );
  }
  try {
    const st = await lstat(absDir);
    if (st.isSymbolicLink()) {
      throw new Error(`Symlink escape rejected: "${absDir}" is a symbolic link`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * Assert that a file path is not a symbolic link before writing.
 * If the path does not exist, proceeds silently (safe to create).
 */
async function assertNotSymlink(filePath: string): Promise<void> {
  try {
    const st = await lstat(filePath);
    if (st.isSymbolicLink()) {
      throw new Error(`Symlink escape rejected: "${filePath}" is a symbolic link`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/**
 * Write run artifacts under outputRoot/<runId>/ and return the absolute path.
 *
 * summary.json is always written and contains no credentials or repository
 * content — only run IDs, numeric telemetry, and outcome codes.
 * All other files are written only when the caller supplies their content.
 *
 * Throws on invalid run ID, path traversal, or symlink escape.
 */
export async function writeRunArtifacts(input: LocalArtifactInput): Promise<string> {
  const root = input.outputRoot ?? DEFAULT_OUTPUT_ROOT;
  const dir = resolveArtifactDir(input.runId, root);
  await assertSafeArtifactDir(dir, root);
  await mkdir(dir, { recursive: true });

  const summary: LocalRunSummary = {
    runId: input.runId,
    identifier: input.identifier,
    title: input.title,
    outcome: input.outcome,
    exitCode: input.exitCode,
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    durationMs: input.endedAt.getTime() - input.startedAt.getTime(),
    passes: input.passes,
    tokenSummary: input.tokenSummary ?? null,
    failureCode: input.failureCode ?? null,
    repairAction: input.repairAction ?? null,
    artifactDir: dir,
  };

  const files: [string, string][] = [
    [join(dir, "summary.json"), JSON.stringify(summary, null, 2)],
  ];

  if (input.logs != null) files.push([join(dir, "run.log"), input.logs]);
  if (input.plan != null) files.push([join(dir, "plan.md"), input.plan]);
  if (input.patch != null) files.push([join(dir, "changes.diff"), input.patch]);
  if (input.changedFiles != null)
    files.push([join(dir, "changed-files.txt"), input.changedFiles.join("\n")]);
  if (input.testSummary != null)
    files.push([join(dir, "test-summary.txt"), input.testSummary]);
  if (input.reviewResult != null)
    files.push([join(dir, "review.md"), input.reviewResult]);
  if (input.runSummary != null)
    files.push([join(dir, "run-summary.md"), input.runSummary]);
  if (input.tokenSummary != null)
    files.push([join(dir, "tokens.json"), JSON.stringify(input.tokenSummary, null, 2)]);
  if (input.autopsy != null) files.push([join(dir, "autopsy.md"), input.autopsy]);

  await Promise.all(files.map(([path]) => assertNotSymlink(path)));
  await Promise.all(files.map(([path, content]) => writeFile(path, content, "utf-8")));
  return dir;
}

/**
 * Remove the artifact directory for a single validated run ID.
 * Rejects traversal and symlink escapes. Never touches other run directories.
 * Idempotent: silently succeeds when the directory does not exist.
 */
export async function removeRunArtifacts(runId: string, outputRoot?: string): Promise<void> {
  const root = outputRoot ?? DEFAULT_OUTPUT_ROOT;
  const dir = resolveArtifactDir(runId, root);
  await assertSafeArtifactDir(dir, root);
  await rm(dir, { recursive: true, force: true });
}
