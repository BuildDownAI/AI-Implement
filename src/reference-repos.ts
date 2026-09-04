import path from "node:path";

/** One repository a project's runs clone read-only into the workspace. */
export interface ReferenceRepo {
  /** Normalized `https://github.com/owner/repo`. */
  repo: string;
  /** Workspace-relative directory the clone lands in. */
  path: string;
  /** Branch, tag, or full commit hash. Absent means the default branch. */
  ref?: string;
}

const REPO_SHORTHAND = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAX_ENTRIES = 10;
const MAX_PATH_LENGTH = 256;

/** Returns null for both absent and empty, so the column stores one "unset" value. */
export function normalizeReferenceRepos(raw: unknown): ReferenceRepo[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) throw new Error("referenceRepos must be an array of entries");
  if (raw.length === 0) return null;
  if (raw.length > MAX_ENTRIES) {
    throw new Error(`too many entries (${raw.length}); maximum is ${MAX_ENTRIES}`);
  }

  const entries: ReferenceRepo[] = [];
  const seenPaths = new Set<string>();

  for (const item of raw) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("each entry must be an object with repo and path");
    }
    const { repo, path: rawPath, ref } = item as Record<string, unknown>;
    if (typeof repo !== "string" || repo.trim() === "") {
      throw new Error("each entry needs a repo");
    }
    if (typeof rawPath !== "string") {
      throw new Error("each entry needs a path");
    }
    if (ref != null && (typeof ref !== "string" || ref.trim() === "")) {
      throw new Error("ref must be a non-empty string when present");
    }

    const normalizedPath = normalizePath(rawPath);
    if (seenPaths.has(normalizedPath)) {
      throw new Error(`two entries share the path "${normalizedPath}"; each entry needs its own directory`);
    }
    seenPaths.add(normalizedPath);

    entries.push({
      repo: normalizeGitHubRepo(repo, "referenceRepos"),
      path: normalizedPath,
      ...(ref != null ? { ref: (ref as string).trim() } : {}),
    });
  }

  return entries;
}

/** 
 * Exact host match, case-insensitive
 * 
 * www.github.com excluded — git remotes live on the apex host.
 * Other hosts and SSH URLs are rejected rather than stored: the runner's only
 * clone credential is a GitHub App token that must never be sent elsewhere, and an SSH
 * URL would store as valid and then silently no-op at clone time.
 * 
 * NOTE: the result is syntax- and host-validated only — it is NOT sanitized. Any code
 * that feeds it to a subprocess MUST pass it as a separate argv element, never
 * interpolated into a shell string, to avoid command injection.
*/
export function normalizeGitHubRepo(raw: string, field: string): string {
  const v = raw.trim();
  if (REPO_SHORTHAND.test(v)) return `https://github.com/${v}`;
  let host: string | null = null;
  if (/^https:\/\/[^\s]+$/.test(v)) {
    try {
      host = new URL(v).hostname.toLowerCase();
    } catch {
      host = null;
    }
  }
  if (host !== "github.com") {
    throw new Error(`${field} must be 'owner/repo' shorthand or an https://github.com/... URL (the runner clones with a GitHub token, so other hosts and SSH git@ URLs are not supported)`);
  }
  return v;
}

/** Checks the normalized form as well as the raw one: a path can look contained and normalize outward. */
function normalizePath(raw: string): string {
  const v = raw.trim();
  if (v === "") throw new Error("each entry needs a non-empty path");
  if (v.length > MAX_PATH_LENGTH) {
    throw new Error(`path too long (${v.length} chars): "${v.slice(0, 30)}..."; maximum is ${MAX_PATH_LENGTH}`);
  }
  if (path.posix.isAbsolute(v) || /^[A-Za-z]:/.test(v)) {
    throw new Error(`path "${v}" must be relative to the workspace`);
  }

  const normalized = path.posix.normalize(v).replace(/\/+$/, "");
  if (normalized === "." || normalized === "" || normalized.split("/").includes("..")) {
    throw new Error(`path "${v}" must stay inside the workspace and name a directory`);
  }
  if (normalized.split("/")[0] === ".git") {
    throw new Error(`path "${v}" must not write into the repository's own .git directory`);
  }
  return normalized;
}
