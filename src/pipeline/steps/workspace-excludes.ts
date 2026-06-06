import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Paths the runner writes into the workspace as a transient orchestrator
 * channel — collected by `collectRunnerComments` and posted to the ticketing
 * provider, never meant to land in the PR. They are added to the clone's local
 * `.git/info/exclude` (not a committed `.gitignore`) so that `git add -A` skips
 * them and `git status --porcelain` ignores them, across every commit site
 * (initial push and the post-push review fix loop).
 */
const RESERVED_PATTERNS = ["ai-output/"];
const MARKER = "# ai-implement: runner-reserved paths (never committed)";

/**
 * Idempotently register the runner-reserved paths in the workspace's local git
 * exclude file. No-op when the workspace has no `.git` directory.
 */
export function ensureRunnerExcludes(workspaceDir: string): void {
  if (!existsSync(join(workspaceDir, ".git"))) return;

  const infoDir = join(workspaceDir, ".git", "info");
  mkdirSync(infoDir, { recursive: true });
  const excludePath = join(infoDir, "exclude");
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
  const existingLines = new Set(existing.split("\n").map((l) => l.trim()));

  const missing = RESERVED_PATTERNS.filter((p) => !existingLines.has(p));
  if (missing.length === 0) return;

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(excludePath, `${prefix}${MARKER}\n${missing.join("\n")}\n`);
}
