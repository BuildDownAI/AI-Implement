import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  decidePlanningWrite,
  decidePlanningWritePayload,
  setupPlanningWritePolicy,
  buildPlanningToolArgs,
} from "../planning-write-policy.js";

describe("planning write policy", () => {
  let ws: string;
  let outside: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "pwp-ws-"));
    outside = mkdtempSync(join(tmpdir(), "pwp-out-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const allow = (p: unknown) => decidePlanningWrite({ file_path: p }, ws).allow;

  it("allows Markdown files in ai-output/comments, absolute and relative, even if the directory is missing", () => {
    expect(allow(join(ws, "ai-output", "comments", "01-x.md"))).toBe(true);
    expect(allow("ai-output/comments/01-x.md")).toBe(true);
    mkdirSync(join(ws, "ai-output", "comments"), { recursive: true });
    writeFileSync(join(ws, "ai-output", "comments", "02-y.md"), "x");
    expect(allow("ai-output/comments/02-y.md")).toBe(true);
  });

  it("denies traversal, outside paths, prefix collisions, non-markdown and policy/config targets", () => {
    writeFileSync(join(ws, "PLANNING.md"), "x");
    for (const p of [
      "ai-output/comments/../../src/a.ts",
      "ai-output/comments/../../ai-output/comments/../x.md",
      join(outside, "a.md"),
      "ai-output/comments-evil/x.md",
      "ai-output/comments/x.txt",
      "ai-output/comments/.md",
      "ai-output/comments/sub/x.md",
      "ai-output/comments",
      ".claude/settings.json",
      "PLANNING.md",
      join(tmpdir(), "planning-guard-x", "guard.mjs"),
    ]) {
      expect(allow(p), p).toBe(false);
    }
  });

  it("denies symlinked comments directory, ai-output parent, and symlinked files", () => {
    mkdirSync(join(ws, "ai-output"));
    symlinkSync(outside, join(ws, "ai-output", "comments"));
    expect(allow("ai-output/comments/x.md")).toBe(false);
    rmSync(join(ws, "ai-output"), { recursive: true, force: true });

    symlinkSync(outside, join(ws, "ai-output"));
    expect(allow("ai-output/comments/x.md")).toBe(false);
    rmSync(join(ws, "ai-output"), { force: true });

    mkdirSync(join(ws, "ai-output", "comments"), { recursive: true });
    writeFileSync(join(outside, "target.md"), "x");
    symlinkSync(join(outside, "target.md"), join(ws, "ai-output", "comments", "link.md"));
    expect(allow("ai-output/comments/link.md")).toBe(false);
    symlinkSync(join(ws, "nonexistent.md"), join(ws, "ai-output", "comments", "dangling.md"));
    expect(allow("ai-output/comments/dangling.md")).toBe(false);
  });

  it("fails closed on malformed input", () => {
    for (const input of [null, undefined, "str", 5, [], {}, { file_path: 1 }, { file_path: "" }, { file_path: null }, { file_path: "a\0.md" }]) {
      expect(decidePlanningWrite(input, ws).allow).toBe(false);
    }
    expect(decidePlanningWritePayload({ tool_name: "Bash", tool_input: { file_path: "ai-output/comments/a.md" } }, ws).allow).toBe(false);
    expect(decidePlanningWritePayload({ tool_input: { file_path: "ai-output/comments/a.md" } }, ws).allow).toBe(false);
    expect(decidePlanningWritePayload(null, ws).allow).toBe(false);
    expect(decidePlanningWrite({ file_path: "ai-output/comments/a.md" }, join(ws, "missing-workspace")).allow).toBe(false);
  });

  it("builds tool args that keep Write but deny shell, MCP and delegates", () => {
    const args = buildPlanningToolArgs();
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Write");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    const denied = args[args.indexOf("--disallowed-tools") + 1].split(",");
    expect(denied).toEqual(expect.arrayContaining(["Bash", "Edit", "NotebookEdit", "Task", "Agent", "Skill", "mcp__*"]));
    expect(denied).not.toContain("Write");
    expect(args).not.toContain("--allowedTools");
  });

  describe("generated guard script", () => {
    const run = (settingsPath: string, stdin: string) => {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const command = settings.hooks.PreToolUse[0].hooks[0].command as string;
      return spawnSync("sh", ["-c", command], { input: stdin, encoding: "utf-8" });
    };

    it("exits 0 for allowed writes and 2 for every denial, and lives outside the workspace", () => {
      const policy = setupPlanningWritePolicy(ws);
      try {
        const settingsPath = policy.args[policy.args.indexOf("--settings") + 1];
        expect(settingsPath.startsWith(ws)).toBe(false);
        expect(existsSync(settingsPath)).toBe(true);
        const call = (tool: string, file_path: unknown) =>
          JSON.stringify({ tool_name: tool, tool_input: { file_path } });
        expect(run(settingsPath, call("Write", "ai-output/comments/01-a.md")).status).toBe(0);
        expect(run(settingsPath, call("Write", join(ws, "ai-output", "comments", "01-a.md"))).status).toBe(0);
        expect(run(settingsPath, call("Write", "src/a.ts")).status).toBe(2);
        expect(run(settingsPath, call("Write", "ai-output/comments/../../src/a.ts")).status).toBe(2);
        expect(run(settingsPath, call("Write", join(dirname(settingsPath), "guard.mjs"))).status).toBe(2);
        expect(run(settingsPath, call("Bash", "ai-output/comments/a.md")).status).toBe(2);
        expect(run(settingsPath, call("Write", 7)).status).toBe(2);
        expect(run(settingsPath, "not json").status).toBe(2);
        expect(run(settingsPath, "null").status).toBe(2);
        expect(run(settingsPath, "").status).toBe(2);
      } finally {
        policy.cleanup();
      }
    });

    it("routes only Write through the guard, so Read/Glob/Grep are never denied by it", () => {
      const policy = setupPlanningWritePolicy(ws);
      try {
        const settingsPath = policy.args[policy.args.indexOf("--settings") + 1];
        const pre = JSON.parse(readFileSync(settingsPath, "utf-8")).hooks.PreToolUse;
        expect(pre).toHaveLength(1);
        expect(pre[0].matcher).toBe("Write");
        for (const tool of ["Read", "Glob", "Grep"]) expect(new RegExp(`^(?:${pre[0].matcher})$`).test(tool)).toBe(false);
        expect(run(settingsPath, JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" } })).status).toBe(2);
      } finally {
        policy.cleanup();
      }
    });

    it("removes the policy directory on cleanup", () => {
      const policy = setupPlanningWritePolicy(ws);
      const settingsPath = policy.args[policy.args.indexOf("--settings") + 1];
      policy.cleanup();
      expect(existsSync(dirname(settingsPath))).toBe(false);
      policy.cleanup();
    });
  });
});
