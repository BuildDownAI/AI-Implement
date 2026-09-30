/**
 * Trusted write guard for planning runs. Planning must create Markdown files under
 * `ai-output/comments/` and nothing else, so the Claude CLI gets `Read,Glob,Grep,Write`
 * plus a PreToolUse hook that denies any Write outside that directory.
 *
 * The hook script and settings file are created in a fresh temp directory outside the
 * workspace, so neither repository content nor the planning model's own tools can
 * rewrite them (the guard denies every Write except into the approved directory).
 * This is a tool-boundary guard, not a filesystem sandbox: a check-then-write race
 * and anything outside the exposed tools are out of scope.
 */
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { buildRestrictedToolArgs, READ_ONLY_BUILTIN_TOOLS } from "./pipeline/steps/read-only-tools.js";

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
  const target = path.resolve(wsReal, filePath);
  if (path.dirname(target) !== approvedDir) return deny("writes are limited to ai-output/comments/");
  if (!target.endsWith(".md") || path.basename(target) === ".md") return deny("only Markdown files may be written");
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
  if (resolved !== target) return deny("path resolves outside ai-output/comments/ (symlink)");
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
  /** CLI args: restricted tool set plus the trusted `--settings` file. */
  args: string[];
  /** Remove the temp policy directory. Safe to call more than once. */
  cleanup: () => void;
}

/** Tool args only (no trusted settings): Read/Glob/Grep plus Write. */
export function buildPlanningToolArgs(): string[] {
  return buildRestrictedToolArgs([...READ_ONLY_BUILTIN_TOOLS, "Write"]);
}

/**
 * Create the guard script and settings outside the workspace and return the planning
 * tool args. Throws on any setup failure; callers must treat that as fatal.
 */
export function setupPlanningWritePolicy(workspaceDir: string): PlanningWritePolicy {
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
    return { args: [...buildPlanningToolArgs(), "--settings", settingsPath], cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
