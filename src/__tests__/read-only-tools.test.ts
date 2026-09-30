import { describe, it, expect } from "vitest";
import {
  READ_ONLY_ALLOWED_TOOLS,
  READ_ONLY_BUILTIN_TOOLS,
  READ_ONLY_TOOL_PARAMS,
  buildRestrictedToolArgs,
} from "../pipeline/steps/read-only-tools.js";

describe("read-only tool policy", () => {
  it("contains only Read/Glob/Grep and no shell pattern", () => {
    expect(READ_ONLY_BUILTIN_TOOLS).toEqual(["Read", "Glob", "Grep"]);
    expect(READ_ONLY_ALLOWED_TOOLS).toEqual(["Read", "Glob", "Grep"]);
    expect(JSON.stringify(READ_ONLY_TOOL_PARAMS)).not.toMatch(/Bash|curl/);
  });

  it("builds restriction args that deny MCP, skills, delegates and writes", () => {
    const args = buildRestrictedToolArgs(READ_ONLY_BUILTIN_TOOLS);
    expect(args.slice(0, 2)).toEqual(["--tools", "Read,Glob,Grep"]);
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(args[args.indexOf("--disallowed-tools") + 1].split(",")).toEqual(
      expect.arrayContaining(["Bash", "Edit", "Write", "Task", "Agent", "Skill", "mcp__*"]),
    );
  });
});
