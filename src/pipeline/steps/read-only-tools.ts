/**
 * Shared read-only tool constraints for Claude invocations in the planning pipeline.
 * All Claude steps (explore-codebase, architecture-analysis, test-plan,
 * work-unit-decomposition, cross-story-context) import from here so that
 * the allowed-tools list stays in one place.
 */

export const READ_ONLY_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Bash(curl *)"];

/** Returns `--allowedTools <tool>` pairs for each entry in READ_ONLY_ALLOWED_TOOLS. */
export function buildAllowedToolsArgs(): string[] {
  return READ_ONLY_ALLOWED_TOOLS.flatMap((tool) => ["--allowedTools", tool]);
}
