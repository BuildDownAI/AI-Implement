import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  decidePlanningWrite,
  decidePlanningWritePayload,
  setupPlanningWritePolicy,
  buildPlanningToolArgs,
  declaresFrontmatterHooks,
} from "../planning-write-policy.js";
import { buildRestrictedToolArgs, READ_ONLY_BUILTIN_TOOLS, RESTRICTED_DISALLOWED_TOOLS } from "../pipeline/steps/read-only-tools.js";

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

  it("allows valid writes through a symlinked workspace alias and its canonical spelling", () => {
    const aliasParent = mkdtempSync(join(tmpdir(), "pwp-alias-"));
    try {
      const alias = join(aliasParent, "ws-link");
      symlinkSync(ws, alias);
      const real = realpathSync(ws);
      for (const workspaceDir of [ws, alias, real]) {
        for (const base of [ws, alias, real]) {
          const p = join(base, "ai-output", "comments", "01-a.md");
          expect(decidePlanningWrite({ file_path: p }, workspaceDir).allow, `${workspaceDir} <- ${p}`).toBe(true);
        }
        expect(decidePlanningWrite({ file_path: "ai-output/comments/01-a.md" }, workspaceDir).allow).toBe(true);
        expect(decidePlanningWrite({ file_path: join(alias, "src", "a.md") }, workspaceDir).allow).toBe(false);
        expect(decidePlanningWrite({ file_path: join(real, "ai-output", "comments-evil", "a.md") }, workspaceDir).allow).toBe(false);
      }
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
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

  it("builds tool args that keep Write, deny Skill without skills, and allow it with them", () => {
    const none = buildPlanningToolArgs();
    expect(none[none.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Write");
    expect(none[none.indexOf("--disallowed-tools") + 1].split(",")).toContain("Skill");

    const args = buildPlanningToolArgs(true);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Write,Skill");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--disable-slash-commands");
    const denied = args[args.indexOf("--disallowed-tools") + 1].split(",");
    expect(denied).toEqual(RESTRICTED_DISALLOWED_TOOLS.filter((t) => t !== "Write" && t !== "Skill"));
    expect(denied).toEqual(expect.arrayContaining(["Bash", "Edit", "NotebookEdit", "Task", "Agent", "mcp__*"]));
    expect(args).not.toContain("--allowedTools");
  });

  describe("selected skills plugin", () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), "pwp-home-"));
      const skills = join(home, ".claude", "skills");
      mkdirSync(join(skills, "good", "refs"), { recursive: true });
      writeFileSync(join(skills, "good", "SKILL.md"), "---\nname: good\ndescription: d\nallowed-tools: Bash, Edit\n---\nbody");
      writeFileSync(join(skills, "good", "refs", "a.md"), "a");
      writeFileSync(join(outside, "secret.txt"), "s");
      symlinkSync(join(outside, "secret.txt"), join(skills, "good", "link.txt"));
      mkdirSync(join(skills, "nomd"));
      mkdirSync(join(skills, "linked-skill-target"));
      writeFileSync(join(skills, "linked-skill-target", "SKILL.md"), "x");
      symlinkSync(join(skills, "linked-skill-target"), join(skills, "linked"));
      mkdirSync(join(skills, "hooked"));
      writeFileSync(join(skills, "hooked", "SKILL.md"), "---\nname: hooked\nhooks:\n  PreToolUse: []\n---\nbody");
      mkdirSync(join(skills, "other"));
      writeFileSync(join(skills, "other", "SKILL.md"), "x");
      mkdirSync(join(skills, "good", "hooks"));
      writeFileSync(join(skills, "good", "hooks", "hooks.json"), "{}");
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it("wraps only valid selected skills in a plugin outside the workspace and wires the flags", () => {
      const policy = setupPlanningWritePolicy(ws, {
        homeDir: home,
        skillNames: ["good", "nomd", "linked", "hooked", "../escape", "missing", "good"],
      });
      try {
        const dir = policy.args[policy.args.indexOf("--plugin-dir") + 1];
        expect(dir.startsWith(realpathSync(tmpdir()))).toBe(true);
        expect(policy.args[policy.args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Write,Skill");
        expect(policy.args[policy.args.indexOf("--setting-sources") + 1]).toBe("");
        expect(policy.args).not.toContain("--disable-slash-commands");
        expect(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf-8")).name).toBeTruthy();
        expect(readdirSync(join(dir, "skills"))).toEqual(["good"]);
        expect(existsSync(join(dir, "skills", "good", "SKILL.md"))).toBe(true);
        expect(existsSync(join(dir, "skills", "good", "refs", "a.md"))).toBe(true);
        expect(existsSync(join(dir, "skills", "good", "link.txt"))).toBe(false);
        expect(readdirSync(dir).sort()).toEqual([".claude-plugin", "skills"]);
      } finally {
        policy.cleanup();
      }
    });

    it.each([
      ["unquoted", "---\nname: x\nhooks:\n  PreToolUse: []\n---\nb"],
      ["double-quoted", '---\nname: x\n"hooks":\n  PreToolUse: []\n---\nb'],
      ["single-quoted", "---\nname: x\n'hooks':\n  PreToolUse: []\n---\nb"],
      ["CRLF quoted", '---\r\nname: x\r\n"hooks":\r\n  PreToolUse: []\r\n---\r\nb'],
      ["flow style", "---\n{name: x, hooks: {}}\n---\nb"],
      ["merge key", "---\nbase: &b {hooks: {}}\n<<: *b\n---\nb"],
      ["malformed YAML", "---\nname: [unclosed\n---\nb"],
      ["duplicate keys", "---\nname: a\nname: b\n---\nb"],
      ["unterminated", "---\nname: x\nb"],
      ["non-mapping", "---\n- a\n---\nb"],
    ])("excludes hook-bearing or unparseable front matter (%s)", (_l, md) => {
      expect(declaresFrontmatterHooks(md)).toBe(true);
    });

    it.each([
      ["allowed-tools", "---\nname: x\nallowed-tools: Bash, Edit\n---\nhooks: in body"],
      ["nested hooks key", "---\nname: x\nmetadata:\n  hooks: y\n---\nb"],
      ["no front matter", "just text"],
      ["empty front matter", "---\n---\nb"],
    ])("keeps benign front matter (%s)", (_l, md) => {
      expect(declaresFrontmatterHooks(md)).toBe(false);
    });

    it("never copies a quoted-hooks skill", () => {
      const skills = join(home, ".claude", "skills");
      mkdirSync(join(skills, "qhooked"));
      writeFileSync(join(skills, "qhooked", "SKILL.md"), '---\nname: qhooked\n"hooks":\n  PreToolUse: []\n---\nb');
      const policy = setupPlanningWritePolicy(ws, { homeDir: home, skillNames: ["qhooked"] });
      expect(policy.args).not.toContain("--plugin-dir");
      policy.cleanup();
    });

    it("rejects skill sources overlapping the workspace in either direction, including symlink aliases", () => {
      const repoSkill = join(ws, ".claude", "skills", "repo-skill");
      mkdirSync(repoSkill, { recursive: true });
      writeFileSync(join(repoSkill, "SKILL.md"), "---\nname: repo-skill\n---\nb");
      const a = setupPlanningWritePolicy(ws, { homeDir: ws, skillNames: ["repo-skill"] });
      expect(a.args).not.toContain("--plugin-dir");
      a.cleanup();

      const alias = mkdtempSync(join(tmpdir(), "pwp-alias-"));
      symlinkSync(ws, join(alias, "ws"));
      const b = setupPlanningWritePolicy(ws, { homeDir: join(alias, "ws"), skillNames: ["repo-skill"] });
      expect(b.args).not.toContain("--plugin-dir");
      b.cleanup();
      rmSync(alias, { recursive: true, force: true });

      // workspace nested inside the skill source (ancestor direction)
      const skills = join(home, ".claude", "skills");
      mkdirSync(join(skills, "wide", "nested-ws"), { recursive: true });
      writeFileSync(join(skills, "wide", "SKILL.md"), "---\nname: wide\n---\nb");
      const nested = join(skills, "wide", "nested-ws");
      const c = setupPlanningWritePolicy(nested, { homeDir: home, skillNames: ["wide"] });
      expect(c.args).not.toContain("--plugin-dir");
      c.cleanup();
    });

    it("adds no plugin and keeps Skill denied when nothing valid is selected, and cleans up", () => {
      const none = setupPlanningWritePolicy(ws, { homeDir: home, skillNames: ["nomd", "linked"] });
      expect(none.args).not.toContain("--plugin-dir");
      expect(none.args[none.args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Write");
      none.cleanup();

      const policy = setupPlanningWritePolicy(ws, { homeDir: home, skillNames: ["good"] });
      const dir = policy.args[policy.args.indexOf("--plugin-dir") + 1];
      policy.cleanup();
      policy.cleanup();
      expect(existsSync(dir)).toBe(false);
    });
  });

  it("keeps the trusted settings and empty setting sources on the planning policy", () => {
    const policy = setupPlanningWritePolicy(ws);
    try {
      expect(policy.args[policy.args.indexOf("--setting-sources") + 1]).toBe("");
      expect(policy.args).toContain("--settings");
      expect(policy.args).not.toContain("--disable-slash-commands");
      expect(policy.args).not.toContain("--plugin-dir");
    } finally {
      policy.cleanup();
    }
  });

  it("leaves review and post-mortem restricted args denying Skill", () => {
    const args = buildRestrictedToolArgs(READ_ONLY_BUILTIN_TOOLS);
    expect(args).toContain("--disable-slash-commands");
    expect(args[args.indexOf("--disallowed-tools") + 1].split(",")).toContain("Skill");
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
        expect(run(settingsPath, call("Write", join(realpathSync(ws), "ai-output", "comments", "01-a.md"))).status).toBe(0);
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

    it("runs with lexical and canonical workspace spellings when the workspace is a symlink alias", () => {
      const aliasParent = mkdtempSync(join(tmpdir(), "pwp-alias-"));
      const alias = join(aliasParent, "ws-link");
      symlinkSync(ws, alias);
      const policy = setupPlanningWritePolicy(alias);
      try {
        const settingsPath = policy.args[policy.args.indexOf("--settings") + 1];
        const call = (file_path: string) => JSON.stringify({ tool_name: "Write", tool_input: { file_path } });
        for (const base of [alias, ws, realpathSync(ws)]) {
          expect(run(settingsPath, call(join(base, "ai-output", "comments", "01-a.md"))).status).toBe(0);
          expect(run(settingsPath, call(join(base, "src", "a.md"))).status).toBe(2);
        }
      } finally {
        policy.cleanup();
        rmSync(aliasParent, { recursive: true, force: true });
      }
    });

    it("makes the trusted settings authoritative: hooks enabled and no file-based setting sources", () => {
      const policy = setupPlanningWritePolicy(ws);
      try {
        const args = policy.args;
        const i = args.indexOf("--setting-sources");
        expect(i).toBeGreaterThanOrEqual(0);
        expect(args[i + 1]).toBe("");
        expect(args.indexOf("--settings")).toBeGreaterThan(-1);
        const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf-8"));
        expect(settings.disableAllHooks).toBe(false);
        expect(settings.hooks.PreToolUse).toHaveLength(1);
        expect(settings.hooks.PreToolUse[0].hooks[0].command).not.toContain(ws + "/.claude");
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
