/** Shared read-only tool constraints for Claude invocations. */

/** Built-in tools a restricted session may use. Names, not permission patterns. */
export const READ_ONLY_BUILTIN_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];

/** Permission patterns preapproved for a restricted session — no shell, so no `Bash(...)` rule. */
export const READ_ONLY_ALLOWED_TOOLS: readonly string[] = [...READ_ONLY_BUILTIN_TOOLS];

/**
 * Belt-and-braces deny rules for a restricted session. `--tools` already limits
 * built-ins but does not cover MCP tools, so MCP is denied by wildcard; `Task`
 * and `Agent` (the delegate tool's name varies by CLI version) and `Skill` are
 * denied so no delegate path can restore write or command capability.
 */
export const RESTRICTED_DISALLOWED_TOOLS: readonly string[] = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "Task",
  "Agent",
  "Skill",
  "mcp__*",
];

/** The `InvokeParams` fields every read-only review / post-mortem call site spreads in. */
export const READ_ONLY_TOOL_PARAMS: { tools: string[]; builtinTools: string[] } = {
  tools: [...READ_ONLY_ALLOWED_TOOLS],
  builtinTools: [...READ_ONLY_BUILTIN_TOOLS],
};

/**
 * CLI args that make `builtinTools` the only available tools: `--tools` gates
 * built-ins, `--strict-mcp-config` (with no `--mcp-config`) loads no MCP server
 * from repo or user config, `--disable-slash-commands` disables skills, and
 * `--disallowed-tools` denies the rest explicitly (it wins even under bypass mode).
 */
export function buildRestrictedToolArgs(builtinTools: readonly string[]): string[] {
  return [
    "--tools",
    builtinTools.join(","),
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--disallowed-tools",
    RESTRICTED_DISALLOWED_TOOLS.filter((t) => !builtinTools.includes(t)).join(","),
  ];
}
