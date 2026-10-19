import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PipelineContext, StepModule, StepReporter } from "../types.js";

export type KgBaseMergeCode =
  | "KG_BASE_MERGE_REFUSED"
  | "KG_BASE_FETCH_FAILED"
  | "KG_BASE_BEHIND"
  | "KG_BASE_CONFLICT";

export class KgBaseMergeError extends Error {
  readonly code: KgBaseMergeCode;
  readonly result?: "behind" | "conflict";
  readonly conflictPaths?: string[];
  constructor(code: KgBaseMergeCode, message: string, extra: { result?: "behind" | "conflict"; conflictPaths?: string[] } = {}) {
    super(`${code}: ${message}`);
    this.code = code;
    if (extra.result) this.result = extra.result;
    if (extra.conflictPaths) this.conflictPaths = extra.conflictPaths;
  }
}

/**
 * Paths the KG ingest reads from the base template. A conflict here is real; a directory
 * entry ends in `/` and matches everything beneath it.
 */
export const KG_BASE_INGEST_PATHS: readonly string[] = [
  "kg_ingest/",
  "kg_query/",
  "ontology/",
  "tests/",
  "pyproject.toml",
  "uv.lock",
  "requirements.txt",
  "requirements-oxigraph.txt",
];

/** Per-repo content: the KG repo's copy always wins, conflicted or not. */
const KG_REPO_OWNED_PATHS: readonly string[] = ["sources.yml", "snapshot/"];

const MAX_REPORTED_PATHS = 50;

function matchesPathList(path: string, list: readonly string[]): boolean {
  return list.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

export interface KgBaseMergeSpec {
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
}

interface KgBaseMergeInputs extends Record<string, unknown> {
  workspaceDir: string;
  dryRun?: boolean;
  kgBaseMerge?: KgBaseMergeSpec;
  /** Test-only: where `<repo>.git` is fetched from. Defaults to https://github.com. */
  remoteBase?: string;
}

interface KgBaseMergeOutputs extends Record<string, unknown> {
  baseMerge?: { headSha: string; result: "merged" };
}

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// `git merge --no-commit` still needs a committer identity, and an empty GIT_COMMITTER_NAME in the
// environment overrides `-c user.name`, so the identity goes through the environment for every call.
const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "ai-implement-kg-dry-run",
  GIT_AUTHOR_EMAIL: "noreply@builddown.ai",
  GIT_COMMITTER_NAME: "ai-implement-kg-dry-run",
  GIT_COMMITTER_EMAIL: "noreply@builddown.ai",
};

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): GitResult {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY_ENV, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function mustGit(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`[kg-base-merge] git ${args[0]} failed (exit ${r.status}): ${r.stderr.trim().slice(-1000)}`);
  return r.stdout;
}

function nulList(out: string): string[] {
  return out.split("\0").filter((p) => p.length > 0);
}

function fetchCommits(workspaceDir: string, url: string, shas: string[]): void {
  // No credential helper: the base repo is public. The URL-scoped key is blanked too, since
  // dependency-auth (or a dev harness) may have registered it globally.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const r = git(
    workspaceDir,
    ["-c", "credential.helper=", "-c", "credential.https://github.com.helper=", "fetch", "--no-tags", "--quiet", url, ...shas],
    env,
  );
  if (r.status !== 0) {
    throw new KgBaseMergeError("KG_BASE_FETCH_FAILED", `could not fetch ${shas.join(", ")} from ${url}: ${r.stderr.trim().slice(-500)}`);
  }
}

function resetToHead(workspaceDir: string): void {
  // "Already up to date" leaves no MERGE_HEAD, so --abort may legitimately fail.
  git(workspaceDir, ["merge", "--abort"]);
  mustGit(workspaceDir, ["reset", "--hard", "HEAD"]);
}

function existsInHead(workspaceDir: string, path: string): boolean {
  return git(workspaceDir, ["cat-file", "-e", `HEAD:${path}`]).status === 0;
}

/** Puts `path` back to what HEAD has (or removes it when HEAD lacks it), clearing any unmerged entry. */
function restoreFromHead(workspaceDir: string, path: string): void {
  if (existsInHead(workspaceDir, path)) {
    mustGit(workspaceDir, ["checkout", "HEAD", "--", path]);
  } else {
    git(workspaceDir, ["rm", "-f", "-q", "--ignore-unmatch", "--", path]);
  }
}

/**
 * Merges `sha` with `--no-commit --no-ff` and applies the path rule. Returns the ingest-path
 * conflicts left over (empty = clean). On a non-conflict failure it throws a plain Error.
 */
function mergeWithPathRule(workspaceDir: string, sha: string): string[] {
  const m = git(workspaceDir, ["merge", "--no-commit", "--no-ff", sha]);
  const unmerged = nulList(mustGit(workspaceDir, ["diff", "--name-only", "-z", "--diff-filter=U"]));
  if (m.status !== 0 && unmerged.length === 0) {
    throw new Error(`[kg-base-merge] git merge ${sha} failed (exit ${m.status}), not a conflict: ${(m.stderr || m.stdout).trim().slice(-1000)}`);
  }
  const unmergedSet = new Set(unmerged);
  const changed = nulList(mustGit(workspaceDir, ["diff", "--cached", "--name-only", "-z", "HEAD"]));
  const all = [...new Set([...changed, ...unmerged])];

  const ingestConflicts: string[] = [];
  for (const path of all) {
    if (matchesPathList(path, KG_REPO_OWNED_PATHS)) {
      restoreFromHead(workspaceDir, path);
    } else if (matchesPathList(path, KG_BASE_INGEST_PATHS)) {
      if (unmergedSet.has(path)) ingestConflicts.push(path);
    } else if (unmergedSet.has(path)) {
      restoreFromHead(workspaceDir, path);
    }
  }
  return ingestConflicts.sort();
}

export const kgBaseMergeStep: StepModule<KgBaseMergeInputs, KgBaseMergeOutputs> = {
  async run(_context: PipelineContext, inputs: KgBaseMergeInputs, _reporter: StepReporter): Promise<KgBaseMergeOutputs> {
    const { workspaceDir, dryRun = false, kgBaseMerge: spec, remoteBase = "https://github.com" } = inputs;
    if (!spec) return {};

    if (!dryRun) {
      throw new KgBaseMergeError(
        "KG_BASE_MERGE_REFUSED",
        "kgBaseMerge requires a dry run: a live refresh must not build a snapshot from code that main does not contain",
      );
    }
    if (!REPO_RE.test(spec.repo) || !SHA_RE.test(spec.baseSha) || !SHA_RE.test(spec.headSha)) {
      throw new KgBaseMergeError("KG_BASE_FETCH_FAILED", "kgBaseMerge has a malformed repo or commit id");
    }

    const url = `${remoteBase.replace(/\/+$/, "")}/${spec.repo}.git`;
    fetchCommits(workspaceDir, url, [spec.baseSha, spec.headSha]);

    // Baseline: does the KG repo take the PR's target commit cleanly? A conflict here is drift, not the PR.
    const baselineConflicts = mergeWithPathRule(workspaceDir, spec.baseSha);
    resetToHead(workspaceDir);
    if (baselineConflicts.length > 0) {
      throw new KgBaseMergeError(
        "KG_BASE_BEHIND",
        `the KG repo conflicts with ${spec.repo}@${spec.baseSha} in ingest paths: ${baselineConflicts.slice(0, MAX_REPORTED_PATHS).join(", ")}`,
        { result: "behind", conflictPaths: baselineConflicts.slice(0, MAX_REPORTED_PATHS) },
      );
    }

    const prConflicts = mergeWithPathRule(workspaceDir, spec.headSha);
    if (prConflicts.length > 0) {
      resetToHead(workspaceDir);
      throw new KgBaseMergeError(
        "KG_BASE_CONFLICT",
        `${spec.repo}#${spec.prNumber} conflicts in ingest paths: ${prConflicts.slice(0, MAX_REPORTED_PATHS).join(", ")}`,
        { result: "conflict", conflictPaths: prConflicts.slice(0, MAX_REPORTED_PATHS) },
      );
    }

    // A merge that was a no-op ("Already up to date") leaves no MERGE_HEAD and nothing to commit.
    if (existsSync(join(mustGit(workspaceDir, ["rev-parse", "--absolute-git-dir"]).trim(), "MERGE_HEAD"))) {
      mustGit(workspaceDir, [
        "commit", "-m", `kg dry run: merge ${spec.repo}#${spec.prNumber} @ ${spec.headSha}`,
      ]);
    }
    console.log(`[kg-base-merge] merged ${spec.repo}#${spec.prNumber} @ ${spec.headSha} into the scratch clone (not pushed)`);
    return { baseMerge: { headSha: spec.headSha, result: "merged" } };
  },
};

export default kgBaseMergeStep;
