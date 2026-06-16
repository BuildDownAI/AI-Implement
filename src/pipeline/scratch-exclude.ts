import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Workspace-relative paths the orchestrator/runner writes as transient scratch
 * (e.g. `ai-output/comments/*.md`, which the runner-callback reads and posts to
 * the ticket) and must NEVER commit into the target repo. Gitignore-style
 * patterns, with a trailing slash for directories.
 */
export const SCRATCH_PATHS = ["ai-output/"] as const;

/**
 * Make orchestrator scratch paths uncommittable in a freshly-prepared workspace.
 *
 * Two deterministic guards, applied once after the working tree exists so every
 * downstream `git add -A` (initial push, post-push review/fix loop, gap-fill)
 * honors them without per-call-site changes:
 *
 *  1. Seed the repo-local `.git/info/exclude` (never committed; unlike the target
 *     repo's `.gitignore` it doesn't mutate their tree) so untracked scratch
 *     files are never staged.
 *  2. Untrack any scratch path a previous run already committed to the branch
 *     (`git rm --cached`), self-healing branches that leaked it before this fix.
 *
 * Idempotent: safe to call on every run, including incremental re-use of a
 * workspace.
 */
export function prepareScratchExclusion(workspaceDir: string): void {
  const excludePath = path.join(workspaceDir, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });

  let existing = "";
  try {
    existing = fs.readFileSync(excludePath, "utf-8");
  } catch {
    existing = "";
  }
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = SCRATCH_PATHS.filter((p) => !present.has(p));
  if (missing.length > 0) {
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(excludePath, `${separator}${missing.join("\n")}\n`);
  }

  // Untrack scratch paths a prior run committed; `--ignore-unmatch` makes this a
  // no-op when nothing matches, so it's safe to run unconditionally. A non-zero
  // exit means a real failure (bad repo state, wrong cwd) left the files tracked
  // — non-fatal (the exclude above still blocks re-staging) but never silent.
  for (const p of SCRATCH_PATHS) {
    const pathspec = p.replace(/\/$/, "");
    const result = spawnSync("git", ["rm", "-r", "--cached", "--ignore-unmatch", pathspec], {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      const stderr = (result.stderr?.toString() ?? "").trim();
      console.warn(
        `[scratch-exclude] git rm --cached ${pathspec} exited ${result.status ?? "null"}; ` +
          `previously-committed files may remain tracked: ${stderr}`,
      );
    }
  }
}
