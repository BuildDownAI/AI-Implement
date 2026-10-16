/**
 * Trusted write guard for planning runs. Planning must create Markdown files under
 * `ai-output/comments/` and nothing else, so the Claude CLI gets `Read,Glob,Grep,Write`
 * plus a PreToolUse hook that denies any Write outside that directory. Operator-selected skills load
 * through a generated plugin (`--plugin-dir`) and the `Skill` tool; nothing else is added.
 *
 * The hook script and settings file are created in a fresh temp directory outside the
 * workspace, so neither repository content nor the planning model's own tools can
 * rewrite them (the guard denies every Write except into the approved directory).
 * `--setting-sources ""` loads no user/project/local settings, so repository or user
 * config can neither disable hooks (`disableAllHooks`) nor add competing ones; the
 * `--settings` file is the only file-based configuration and sets `disableAllHooks: false`.
 * This is a tool-boundary guard, not a filesystem sandbox: a check-then-write race
 * and anything outside the exposed tools are out of scope.
 */
import fs from "node:fs";
import path from "node:path";
import os, { tmpdir } from "node:os";
import { CLAUDE_SKILLS_SUBDIR } from "./pipeline/steps/install-skills.js";
import { READ_ONLY_BUILTIN_TOOLS, RESTRICTED_DISALLOWED_TOOLS } from "./pipeline/steps/read-only-tools.js";

export interface PlanningWriteDecision {
  allow: boolean;
  reason: string;
}

/**
 * Single source of the decision logic. It is evaluated in-process by
 * `decidePlanningWrite` and embedded verbatim in the standalone guard script, so the
 * tested code is the enforced code. Plain JavaScript; `fs` and `path` are injected.
 */
const DECISION_SOURCE = `
function decide(payload, workspaceDir) {
  const deny = (reason) => ({ allow: false, reason });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return deny("malformed tool input");
  if (payload.tool_name !== "Write") return deny("only the Write tool is permitted");
  const input = payload.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return deny("malformed tool input");
  const filePath = input.file_path;
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\\0")) {
    return deny("file_path must be a non-empty string");
  }
  let wsReal;
  try {
    wsReal = fs.realpathSync(workspaceDir);
  } catch {
    return deny("workspace could not be resolved");
  }
  const approvedDir = path.join(wsReal, "ai-output", "comments");
  const target = path.resolve(workspaceDir, filePath);
  const base = path.basename(target);
  if (!base.endsWith(".md") || base === ".md") return deny("only Markdown files may be written");
  // Canonicalize the deepest existing ancestor, then re-append the missing suffix.
  let existing = target;
  const suffix = [];
  for (;;) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (err) {
      if (!err || err.code !== "ENOENT") return deny("path could not be verified");
      const parent = path.dirname(existing);
      if (parent === existing) return deny("path could not be verified");
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
  let resolved;
  try {
    if (existing === target && fs.lstatSync(target).isSymbolicLink()) return deny("symlink targets are not permitted");
    resolved = path.join(fs.realpathSync(existing), ...suffix);
  } catch {
    return deny("path could not be verified");
  }
  if (path.dirname(resolved) !== approvedDir) return deny("writes are limited to ai-output/comments/");
  return { allow: true, reason: "" };
}
`;

type DecideFn = (payload: unknown, workspaceDir: string) => PlanningWriteDecision;

const decide = new Function("fs", "path", `${DECISION_SOURCE}\nreturn decide;`)(fs, path) as DecideFn;

/** Decide a hook payload (`{ tool_name, tool_input }`). Fails closed on anything unexpected. */
export function decidePlanningWritePayload(payload: unknown, workspaceDir: string): PlanningWriteDecision {
  try {
    return decide(payload, workspaceDir);
  } catch {
    return { allow: false, reason: "guard error" };
  }
}

/** Convenience wrapper for a bare Write `tool_input`. */
export function decidePlanningWrite(toolInput: unknown, workspaceDir: string): PlanningWriteDecision {
  return decidePlanningWritePayload({ tool_name: "Write", tool_input: toolInput }, workspaceDir);
}

const GUARD_MAIN = `
import fs from "node:fs";
import path from "node:path";
${DECISION_SOURCE}
function refuse(reason) {
  process.stderr.write("Planning write refused: " + reason + "\\n");
  process.exit(2);
}
try {
  const workspaceDir = process.argv[2];
  if (!workspaceDir) refuse("guard misconfigured");
  const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
  const verdict = decide(payload, workspaceDir);
  if (!verdict.allow) refuse(verdict.reason);
} catch {
  refuse("guard error");
}
`;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface PlanningWritePolicy {
  /** CLI args: restricted tool set, the trusted `--settings` file and, with skills, the generated plugin. */
  args: string[];
  /** Remove the temp policy directory. Safe to call more than once. */
  cleanup: () => void;
}

/** Operator-selected skills installed for this run; never derived from target repository content. */
export interface PlanningSkillInput {
  /** Skill directory names installed by `installSkills` from the selected skills repository. */
  skillNames: readonly string[];
  /** Home directory the skills were installed into; defaults to `os.homedir()`. */
  homeDir?: string;
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLUGIN_NAME = "ai-implement-planning-skills";

/**
 * Tool args only (no trusted settings): Read/Glob/Grep plus Write. With `withSkills`, `Skill` joins the
 * whitelist and leaves the deny list; `--disable-slash-commands` is never passed here, and without skills
 * `Skill` stays denied. The deny list is derived from `RESTRICTED_DISALLOWED_TOOLS`, so a tool added there
 * stays denied.
 */
export function buildPlanningToolArgs(withSkills = false): string[] {
  const builtinTools = [...READ_ONLY_BUILTIN_TOOLS, "Write", ...(withSkills ? ["Skill"] : [])];
  const denied = RESTRICTED_DISALLOWED_TOOLS.filter((t) => !builtinTools.includes(t));
  return ["--tools", builtinTools.join(","), "--strict-mcp-config", "--disallowed-tools", denied.join(",")];
}

/**
 * True when a SKILL.md front-matter block declares `hooks:`. The CLI runs skill front-matter hooks as commands
 * outside the tool whitelist (verified on 2.1.284), so such a skill is excluded rather than loaded.
 */
function declaresFrontmatterHooks(skillMd: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  return m ? /^hooks\s*:/m.test(m[1]) : false;
}

/**
 * Copies one selected skill into the generated plugin. The source must be a real directory directly under the
 * home skills directory with a regular `SKILL.md`; symlinks (anywhere in the tree) are excluded, not followed.
 */
function copySkill(homeDir: string, name: string, destRoot: string): boolean {
  if (!SKILL_NAME.test(name)) return false;
  const base = path.join(homeDir, CLAUDE_SKILLS_SUBDIR);
  const src = path.join(base, name);
  try {
    if (!fs.lstatSync(src).isDirectory()) return false;
    if (!fs.lstatSync(path.join(src, "SKILL.md")).isFile()) return false;
    if (declaresFrontmatterHooks(fs.readFileSync(path.join(src, "SKILL.md"), "utf8"))) return false;
    if (path.dirname(fs.realpathSync(src)) !== fs.realpathSync(base)) return false;
    fs.cpSync(src, path.join(destRoot, name), {
      recursive: true,
      filter: (entry) => {
        const st = fs.lstatSync(entry);
        return st.isDirectory() || st.isFile();
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the guard script and settings outside the workspace and return the planning
 * tool args. Throws on any setup failure; callers must treat that as fatal.
 */
export function setupPlanningWritePolicy(workspaceDir: string, skills?: PlanningSkillInput): PlanningWritePolicy {
  const wsReal = fs.realpathSync(workspaceDir);
  const dir = fs.mkdtempSync(path.join(tmpdir(), "planning-guard-"));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.chmodSync(dir, 0o700);
    const dirReal = fs.realpathSync(dir);
    if (dirReal === wsReal || dirReal.startsWith(wsReal + path.sep)) {
      throw new Error("policy directory must be outside the workspace");
    }
    const guardPath = path.join(dirReal, "guard.mjs");
    const settingsPath = path.join(dirReal, "settings.json");
    fs.writeFileSync(guardPath, GUARD_MAIN, { mode: 0o400 });
    const settings = {
      disableAllHooks: false,
      hooks: {
        PreToolUse: [
          {
            matcher: "Write",
            hooks: [
              {
                type: "command",
                command: `${shellQuote(process.execPath)} ${shellQuote(guardPath)} ${shellQuote(wsReal)}`,
              },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o400 });
    const pluginArgs: string[] = [];
    if (skills && skills.skillNames.length > 0) {
      // Skills load only through this generated wrapper (skills/ alone: no hooks, agents, commands,
      // settings or MCP), because `--setting-sources ""` stays empty and loads nothing from user config.
      const pluginDir = path.join(dirReal, "skills-plugin");
      const skillsRoot = path.join(pluginDir, "skills");
      fs.mkdirSync(skillsRoot, { recursive: true });
      const homeDir = skills.homeDir ?? os.homedir();
      const copied = [...new Set(skills.skillNames)].filter((n) => copySkill(homeDir, n, skillsRoot));
      if (copied.length > 0) {
        fs.mkdirSync(path.join(pluginDir, ".claude-plugin"));
        fs.writeFileSync(
          path.join(pluginDir, ".claude-plugin", "plugin.json"),
          JSON.stringify({ name: PLUGIN_NAME, version: "1.0.0", description: "Operator-selected planning skills" }),
        );
        pluginArgs.push("--plugin-dir", pluginDir);
      }
    }
    return {
      args: [...buildPlanningToolArgs(pluginArgs.length > 0), ...pluginArgs, "--setting-sources", "", "--settings", settingsPath],
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}
