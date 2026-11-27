import path from "node:path";
import type { StageName } from "./agent-config.js";

/** Why a declared reference repository did not arrive in the workspace. */
export type ReferenceRepoResultCause =
  | "no-auth"
  | "ref-not-found"
  | "token-error"
  | "clone-error"
  | "path-invalid";

/** One repository a project's runs clone read-only into the workspace. */
export interface ReferenceRepo {
  /** Normalized `https://github.com/owner/repo`. */
  repo: string;
  /** Workspace-relative directory the clone lands in. */
  path: string;
  /** Branch, tag, or full commit hash. Absent means the default branch. */
  ref?: string;
}

/** One declared entry's outcome. Extends the entry so the two cannot drift. */
export interface ReferenceRepoResult extends ReferenceRepo {
  arrived: boolean;
  cause?: ReferenceRepoResultCause;
}

export const REPO_SHORTHAND = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAX_ENTRIES = 10;
const MAX_PATH_LENGTH = 256;

// Keyed to the union rather than to `string`: adding a cause without a phrase then
// fails the build instead of silently rendering "an unknown error" in a prompt.
const CAUSE_PHRASES: Record<ReferenceRepoResultCause, string> = {
  "no-auth": "the repository is private and the GitHub App is not installed on that owner",
  "ref-not-found": "the declared ref does not exist in the repository",
  "token-error": "the authentication token could not be minted for that owner",
  "clone-error": "a network or git error prevented the clone",
  "path-invalid": "the declared path is invalid or duplicated",
};

export function describeReferenceRepoCause(cause: ReferenceRepoResultCause | undefined): string {
  return cause ? CAUSE_PHRASES[cause] : "an unknown error prevented the clone";
}

/** The prompt section naming each declared repository. Every stage confirms its claims against them; a reviewer also rates a contradicted one by its effect. */
export function buildReferenceReposSection(results: readonly ReferenceRepoResult[], agentStage: Exclude<StageName, "planning">): string {
  const arrived = results.filter((r) => r.arrived);
  const missed = results.filter((r) => !r.arrived);
  const lines: string[] = ["## Reference Repositories"];

  if (arrived.length > 0) {
    lines.push(
      "",
      "The following repositories are available in the workspace as read-only reference material, each at the ref shown. Do not modify them.",
      "When the work states how one of them behaves, confirm the claim against its checkout.",
      ...(agentStage === "review" ? ["When you report a claim its checkout contradicts, rate it minor if it only describes, and blocking if acting on it fails: a call the code refuses, a value it never sets, or a step that cannot succeed."] : []),
      "",
    );
    for (const r of arrived) {
      lines.push(`- \`${r.repo}\` at ${r.ref ? `\`${r.ref}\`` : "its default branch"} — available at \`${r.path}\``);
    }
  }

  if (missed.length > 0) {
    lines.push(
      "",
      "The following repositories were declared but could not be cloned. Do not assert anything about their contents — treat them as unavailable.",
      "",
    );
    for (const r of missed) {
      lines.push(`- \`${r.repo}\`: ${describeReferenceRepoCause(r.cause)}`);
    }
  }

  return lines.join("\n");
}

/** Returns null for both absent and empty, so the column stores one "unset" value. */
export function normalizeReferenceRepos(raw: unknown, subject = "referenceRepos"): ReferenceRepo[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) throw new Error(`${subject} must be a list of entries.`);
  if (raw.length === 0) return null;
  if (raw.length > MAX_ENTRIES) {
    throw new Error(`${subject} may hold at most ${MAX_ENTRIES} entries, not ${raw.length}.`);
  }

  const entries: ReferenceRepo[] = [];
  const seenPaths = new Set<string>();

  for (const item of raw) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Each entry in ${subject} needs a repository and a path.`);
    }
    const { repo, path: rawPath, ref } = item as Record<string, unknown>;
    if (typeof repo !== "string" || repo.trim() === "") {
      throw new Error(`Each entry in ${subject} needs a repository.`);
    }
    if (typeof rawPath !== "string") {
      throw new Error(`Each entry in ${subject} needs a path.`);
    }
    if (ref != null && (typeof ref !== "string" || ref.trim() === "")) {
      throw new Error(`An entry's ref in ${subject} must not be blank.`);
    }

    const normalizedPath = normalizePath(rawPath, subject);
    if (seenPaths.has(normalizedPath)) {
      throw new Error(`Two entries in ${subject} share the path "${normalizedPath}". Each entry needs its own directory.`);
    }
    seenPaths.add(normalizedPath);

    entries.push({
      repo: normalizeGitHubRepo(repo, subject),
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
  let hasUserinfo = false;
  if (/^https:\/\/[^\s]+$/.test(v)) {
    try {
      const parsed = new URL(v);
      host = parsed.hostname.toLowerCase();
      hasUserinfo = parsed.username !== "" || parsed.password !== "";
    } catch {
      host = null;
    }
  }
  if (host !== "github.com") {
    throw new Error(`${field} must be 'owner/repo' shorthand or an https://github.com/... URL (the runner clones with a GitHub token, so other hosts and SSH git@ URLs are not supported)`);
  }
  // A token here would survive into the clone's remote.origin.url, in a directory that persists for the whole run and that the agent is pointed at.
  if (hasUserinfo) {
    throw new Error(`${field} must not carry a username or token in its URL. The runner supplies its own credential when it clones.`);
  }
  return v;
}

/** The owner and name a stored repository URL points at, or null when it is not a `github.com/<owner>/<name>` URL. */
export function githubRepoParts(url: string): { owner: string; repo: string } | null {
  let path: string[];
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    path = parsed.pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
  if (path.length < 2) return null;
  return { owner: path[0], repo: path[1].replace(/\.git$/, "") };
}

/** Checks the normalized form as well as the raw one: a path can look contained and normalize outward. */
function normalizePath(raw: string, subject: string): string {
  const v = raw.trim();
  if (v === "") throw new Error(`Each entry in ${subject} needs a path.`);
  if (v.length > MAX_PATH_LENGTH) {
    throw new Error(`The path "${v.slice(0, 30)}..." in ${subject} is ${v.length} characters, more than the ${MAX_PATH_LENGTH} allowed.`);
  }
  if (path.posix.isAbsolute(v) || /^[A-Za-z]:/.test(v)) {
    throw new Error(`The path "${v}" in ${subject} must be relative to the workspace.`);
  }
  // Not a traversal vector here — backslash is a literal filename character on the runner.
  if (v.includes("\\")) {
    throw new Error(`The path "${v}" in ${subject} must use forward slashes.`);
  }

  const normalized = path.posix.normalize(v).replace(/\/+$/, "");
  if (normalized === "." || normalized === "" || normalized.split("/").includes("..")) {
    throw new Error(`The path "${v}" in ${subject} must stay inside the workspace and name a directory.`);
  }
  if (normalized.split("/")[0] === ".git") {
    throw new Error(`The path "${v}" in ${subject} must not write into the repository's own .git directory.`);
  }
  return normalized;
}
