/** Shared read-only tool constraints for Claude invocations. */

export const READ_ONLY_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Bash(curl *)"];

/** Returns `--allowedTools <tool>` pairs for each entry in READ_ONLY_ALLOWED_TOOLS. */
export function buildAllowedToolsArgs(): string[] {
  return READ_ONLY_ALLOWED_TOOLS.flatMap((tool) => ["--allowedTools", tool]);
}
