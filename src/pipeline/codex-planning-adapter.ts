import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, writeSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LLMResult, RunTelemetry } from "./types.js";
import { redactSecrets } from "./codex-stream.js";

/**
 * Restricted native Codex planning transport (AII-1001).
 *
 * A pure JSON-RPC driver over child stdio that the executor owns. It negotiates `initialize`, one
 * ephemeral Default-mode thread and one turn, serves exactly three host tools (`repo_read`,
 * `repo_search`, `comments_write`) through trusted handlers, and mechanically rejects every other
 * server-originated request. It never spawns, signals, authenticates, checkpoints or disposes:
 * `CodexExecutor` keeps all of that, and a completed turn is not evidence the child group stopped.
 */

export const PLANNING_TOOL_NAMES = ["repo_read", "repo_search", "comments_write"] as const;
type PlanningToolName = (typeof PLANNING_TOOL_NAMES)[number];

export const PLANNING_LIMITS = {
  lineBytes: 1_000_000,
  messageChars: 256_000,
  readBytes: 64_000,
  searchResults: 50,
  searchFiles: 2_000,
  searchFileBytes: 256_000,
  searchDepth: 12,
  snippetChars: 200,
  patternChars: 200,
  pathChars: 512,
  writeBytes: 64_000,
  writeTotalBytes: 256_000,
  toolCalls: 200,
  errorChars: 300,
} as const;

/** Thread-start tool inventory. Sent as top-level `dynamicTools` (the pinned CLI rejects `config.dynamicTools`). */
export const PLANNING_DYNAMIC_TOOLS = [
  {
    name: "repo_read",
    description: "Read a text file in the repository, by path relative to the repository root.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "repo_search",
    description: "Search repository text files for a literal string. Optional directory path relative to the repository root.",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "comments_write",
    description: "Write a Markdown planning comment. name is a file name such as plan.md; it is created under ai-output/comments.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, content: { type: "string" } },
      required: ["name", "content"],
      additionalProperties: false,
    },
  },
] as const;

/** Bounded outcome handed back to the executor owner. */
export interface CodexTransportResult {
  result: LLMResult;
  /** True when a denied/unexpected request or item may have had (or attempted) an effect: never retried. */
  sawUnsafe: boolean;
  /** `stdin` when a write to the child failed; timeout and cancel are decided by the executor alone. */
  stopReason: "stdin" | null;
}

export interface CodexTransportIo {
  stdin: Writable;
  stdout: Readable;
  /** Aborted by the executor when it stops the child; the driver must settle promptly. */
  halt: AbortSignal;
}

export interface CodexTransportRunInput {
  io: CodexTransportIo;
  prompt: string;
  model: string;
  workspaceDir: string;
  jsonSchema?: Record<string, unknown>;
  /** Absolute directories (selected auth/session paths) the host tools must never touch. */
  forbiddenRoots: readonly string[];
  /** Executor-supplied redaction of selected-credential values from tool output and diagnostics. */
  redact: (text: string) => string;
}

/** Typed seam consumed only inside `CodexExecutor.runChild`. */
export interface CodexProtocolDriver {
  run(input: CodexTransportRunInput): Promise<CodexTransportResult>;
}

// ---------------------------------------------------------------------------
// Host tool handlers
// ---------------------------------------------------------------------------

const FORBIDDEN_SEGMENTS = new Set([".git", ".codex", ".aws", ".ssh", ".gnupg", ".docker", ".kube", ".netrc", ".npmrc", ".pypirc", "auth.json", "credentials.json"]);

function forbiddenName(seg: string): boolean {
  return FORBIDDEN_SEGMENTS.has(seg) || /^\.env$/.test(seg) || /^\.env\.(?!example$|sample$|template$)/.test(seg);
}

function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function hasForbiddenSegment(rel: string): boolean {
  return rel.split(sep).some((s) => s !== "" && forbiddenName(s));
}

export interface HostContext {
  root: string;
  forbiddenRoots: string[];
  written: number;
}

class Denied extends Error {}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function makeContext(workspaceDir: string, forbiddenRoots: readonly string[]): HostContext {
  return { root: realpathSync(workspaceDir), forbiddenRoots: forbiddenRoots.filter(Boolean).map(canonical), written: 0 };
}

/** Canonical, contained, non-forbidden path for an existing target; null on any violation. */
function resolveExisting(ctx: HostContext, input: unknown): string | null {
  if (typeof input !== "string" || input.length > PLANNING_LIMITS.pathChars || input.includes("\0") || isAbsolute(input)) return null;
  const lexical = resolve(ctx.root, input === "" ? "." : input);
  if (!within(ctx.root, lexical) || hasForbiddenSegment(relative(ctx.root, lexical))) return null;
  let real: string;
  try {
    real = realpathSync(lexical);
  } catch {
    return null;
  }
  if (!within(ctx.root, real) || hasForbiddenSegment(relative(ctx.root, real))) return null;
  if (ctx.forbiddenRoots.some((f) => within(f, real))) return null;
  return real;
}

function isBinary(buf: Buffer): boolean {
  return buf.includes(0);
}

/** Reads at most `max` bytes through a no-follow descriptor; null for non-regular files. */
function readBounded(real: string, max: number): { buf: Buffer; truncated: boolean } | null {
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(max + 1);
    const n = readSync(fd, buf, 0, max + 1, 0);
    return n > max ? { buf: buf.subarray(0, max), truncated: true } : { buf: buf.subarray(0, n), truncated: false };
  } finally {
    closeSync(fd);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(args: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(args).every((k) => allowed.includes(k));
}

function repoRead(ctx: HostContext, args: Record<string, unknown>): string {
  if (!onlyKeys(args, ["path"])) throw new Denied();
  const real = resolveExisting(ctx, args.path);
  if (!real) throw new Denied();
  const read = readBounded(real, PLANNING_LIMITS.readBytes);
  if (!read || isBinary(read.buf)) throw new Denied();
  return read.buf.toString("utf8") + (read.truncated ? "\n[truncated]" : "");
}

function repoSearch(ctx: HostContext, args: Record<string, unknown>): string {
  if (!onlyKeys(args, ["pattern", "path"])) throw new Denied();
  const pattern = args.pattern;
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > PLANNING_LIMITS.patternChars) throw new Denied();
  const start = resolveExisting(ctx, args.path === undefined ? "." : args.path);
  if (!start) throw new Denied();

  const hits: string[] = [];
  let files = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > PLANNING_LIMITS.searchDepth || hits.length >= PLANNING_LIMITS.searchResults) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (hits.length >= PLANNING_LIMITS.searchResults || files >= PLANNING_LIMITS.searchFiles) return;
      if (forbiddenName(e.name) || e.name === "node_modules" || e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (ctx.forbiddenRoots.some((f) => within(f, full))) continue;
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile()) {
        files++;
        const read = readBounded(full, PLANNING_LIMITS.searchFileBytes);
        if (!read || read.truncated || isBinary(read.buf)) continue;
        const lines = read.buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length && hits.length < PLANNING_LIMITS.searchResults; i++) {
          if (lines[i].includes(pattern)) {
            hits.push(`${relative(ctx.root, full)}:${i + 1}: ${lines[i].slice(0, PLANNING_LIMITS.snippetChars)}`);
          }
        }
      }
    }
  };
  let startStat;
  try {
    startStat = lstatSync(start);
  } catch {
    throw new Denied();
  }
  if (startStat.isDirectory()) walk(start, 0);
  else if (startStat.isFile()) {
    const read = readBounded(start, PLANNING_LIMITS.searchFileBytes);
    if (read && !read.truncated && !isBinary(read.buf)) {
      read.buf
        .toString("utf8")
        .split("\n")
        .forEach((l, i) => {
          if (hits.length < PLANNING_LIMITS.searchResults && l.includes(pattern)) {
            hits.push(`${relative(ctx.root, start)}:${i + 1}: ${l.slice(0, PLANNING_LIMITS.snippetChars)}`);
          }
        });
    }
  }
  return hits.length ? hits.join("\n") : "no matches";
}

const COMMENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$/;

/** Creates ai-output/comments one component at a time, refusing any symlink or non-directory. */
function ensureCommentsDir(ctx: HostContext): string {
  let cur = ctx.root;
  for (const part of ["ai-output", "comments"]) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      mkdirSync(cur);
      st = lstatSync(cur);
    }
    if (!st.isDirectory()) throw new Denied();
  }
  const real = realpathSync(cur);
  if (real !== join(ctx.root, "ai-output", "comments")) throw new Denied();
  return real;
}

function commentsWrite(ctx: HostContext, args: Record<string, unknown>): string {
  if (!onlyKeys(args, ["name", "content"])) throw new Denied();
  const { name, content } = args;
  if (typeof name !== "string" || !COMMENT_NAME_RE.test(name) || name.startsWith("90-")) throw new Denied();
  if (typeof content !== "string") throw new Denied();
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > PLANNING_LIMITS.writeBytes || ctx.written + bytes > PLANNING_LIMITS.writeTotalBytes) throw new Denied();
  const dir = ensureCommentsDir(ctx);
  const target = join(dir, name);
  try {
    if (!lstatSync(target).isFile()) throw new Denied();
  } catch (err) {
    if (err instanceof Denied) throw err;
    // absent: will be created
  }
  let fd: number;
  try {
    // O_NOFOLLOW makes an existing-file symlink fail before anything is truncated or written.
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  } catch {
    throw new Denied();
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  ctx.written += bytes;
  return `wrote ${bytes} bytes to ai-output/comments/${name}`;
}

const HANDLERS: Record<PlanningToolName, (ctx: HostContext, args: Record<string, unknown>) => string> = {
  repo_read: repoRead,
  repo_search: repoSearch,
  comments_write: commentsWrite,
};

/** Exported for direct handler tests; the driver is the only production caller. */
export function runPlanningTool(
  ctx: HostContext,
  tool: string,
  args: unknown,
): { ok: boolean; text: string } {
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, tool) || !isRecord(args)) return { ok: false, text: "tool call rejected" };
  try {
    return { ok: true, text: HANDLERS[tool as PlanningToolName](ctx, args) };
  } catch (err) {
    // Fixed text only: rejected arguments and filesystem errors are never echoed.
    return { ok: false, text: err instanceof Denied ? "request denied by policy" : "tool failed" };
  }
}

export function createHostContext(workspaceDir: string, forbiddenRoots: readonly string[] = []): HostContext {
  return makeContext(workspaceDir, forbiddenRoots);
}

// ---------------------------------------------------------------------------
// Protocol driver
// ---------------------------------------------------------------------------

/** Item types that cannot touch the workspace or network; anything else means a non-allowlisted effect. */
const SAFE_ITEM_TYPES = new Set(["agentMessage", "userMessage", "reasoning", "plan", "dynamicToolCall", "contextCompaction"]);

type FailCode =
  | "protocol_error"
  | "malformed_message"
  | "oversized_message"
  | "missing_completion"
  | "denied_request"
  | "unexpected_item"
  | "turn_failed"
  | "turn_interrupted"
  | "halted"
  | "output_too_large"
  | "tool_limit"
  | "stdin_failed";

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Creates the planning driver. Stateless: each `run` owns its own session. */
export function createCodexPlanningDriver(): CodexProtocolDriver {
  return { run: runSession };
}

function runSession(input: CodexTransportRunInput): Promise<CodexTransportResult> {
  return new Promise<CodexTransportResult>((resolveRun) => {
    const { io } = input;
    let ctx: HostContext;
    try {
      ctx = makeContext(input.workspaceDir, input.forbiddenRoots);
    } catch {
      resolveRun(failure("protocol_error", false, null, input));
      return;
    }

    let done = false;
    let buffered: Buffer = Buffer.alloc(0);
    let threadId: string | null = null;
    let nextId = 1;
    const pending = new Map<number, "initialize" | "thread" | "turn">();
    let lastMessage: string | null = null;
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    let unsafe = false;
    let calls = 0;
    const trace: string[] = [];

    const settle = (outcome: CodexTransportResult): void => {
      if (done) return;
      done = true;
      io.stdout.off("data", onData);
      io.stdout.off("end", onEnd);
      io.stdout.off("close", onEnd);
      io.stdout.off("error", onEnd);
      io.halt.removeEventListener("abort", onHalt);
      resolveRun(outcome);
    };
    const fail = (code: FailCode, markUnsafe = false, detail?: string): void => {
      if (markUnsafe) unsafe = true;
      settle(failure(code, unsafe, code === "stdin_failed" ? "stdin" : null, input, detail));
    };

    const send = (msg: Record<string, unknown>): void => {
      if (done) return;
      try {
        io.stdin.write(`${JSON.stringify(msg)}\n`, (err) => {
          if (err) fail("stdin_failed");
        });
      } catch {
        fail("stdin_failed");
      }
    };
    const request = (kind: "initialize" | "thread" | "turn", method: string, params: unknown): void => {
      const id = nextId++;
      pending.set(id, kind);
      send({ method, id, params });
    };

    const startTurn = (): void => {
      request("turn", "turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt }],
        model: input.model,
        approvalPolicy: "never",
        collaborationMode: { mode: "default", settings: { model: input.model, reasoning_effort: null, developer_instructions: null } },
        ...(input.jsonSchema ? { outputSchema: input.jsonSchema } : {}),
      });
    };

    const onResponse = (id: unknown, msg: Record<string, unknown>): void => {
      const kind = typeof id === "number" ? pending.get(id) : undefined;
      if (!kind) return fail("protocol_error");
      pending.delete(id as number);
      if (msg.error !== undefined || !isRecord(msg.result)) return fail("protocol_error");
      if (kind === "initialize") {
        send({ method: "initialized" });
        request("thread", "thread/start", {
          model: input.model,
          modelProvider: "openai",
          cwd: ctx.root,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          // Top-level and experimental: the pinned CLI accepts it here and rejects `config.dynamicTools`.
          dynamicTools: PLANNING_DYNAMIC_TOOLS,
        });
      } else if (kind === "thread") {
        const thread = msg.result.thread;
        if (!isRecord(thread) || typeof thread.id !== "string" || thread.id.length > 200) return fail("protocol_error");
        threadId = thread.id;
        startTurn();
      }
      // `turn` response only acknowledges; completion arrives as a notification.
    };

    const deny = (id: unknown): void => {
      send({ id, error: { code: -32601, message: "request denied" } });
    };

    const onServerRequest = (id: unknown, method: string, params: unknown): void => {
      if (method === "item/tool/call" && isRecord(params) && typeof params.tool === "string" && Object.prototype.hasOwnProperty.call(HANDLERS, params.tool)) {
        if (threadId === null || params.threadId !== threadId) {
          deny(id);
          return fail("denied_request", true);
        }
        if (++calls > PLANNING_LIMITS.toolCalls) {
          deny(id);
          return fail("tool_limit", true);
        }
        const out = runPlanningTool(ctx, params.tool, params.arguments);
        if (trace.length < 200) trace.push(`${params.tool}${out.ok ? "" : " (denied)"}`);
        send({ id, result: { success: out.ok, contentItems: [{ type: "inputText", text: input.redact(out.text) }] } });
        return;
      }
      // Command/file approval, requestUserInput, MCP elicitation, permissions, unknown tools and any
      // future request family: answered with an error before any effect, and fatal for the session.
      deny(id);
      fail("denied_request", true);
    };

    const onNotification = (method: string, params: unknown): void => {
      if (!isRecord(params)) return;
      if (method === "item/started" || method === "item/completed") {
        const item = params.item;
        if (!isRecord(item) || typeof item.type !== "string") return fail("malformed_message", true);
        if (!SAFE_ITEM_TYPES.has(item.type)) return fail("unexpected_item", true);
        if (method === "item/completed" && item.type === "agentMessage") {
          if (typeof item.text !== "string") return fail("malformed_message", true);
          if (item.text.length > PLANNING_LIMITS.messageChars) return fail("output_too_large");
          if (item.phase === undefined || item.phase === null || item.phase === "final_answer") lastMessage = item.text;
        }
        return;
      }
      if (method === "thread/tokenUsage/updated") {
        const total = isRecord(params.tokenUsage) && isRecord(params.tokenUsage.total) ? params.tokenUsage.total : null;
        if (total) {
          tokensIn = count(total.inputTokens);
          tokensOut = count(total.outputTokens);
        }
        return;
      }
      if (method === "turn/completed") {
        const turn = params.turn;
        const status = isRecord(turn) ? turn.status : undefined;
        if (status === "completed") return settle(success());
        if (status === "failed") {
          const err = isRecord(turn) && isRecord(turn.error) && typeof turn.error.message === "string" ? turn.error.message : undefined;
          return fail("turn_failed", false, err);
        }
        return fail(status === "interrupted" ? "turn_interrupted" : "protocol_error");
      }
    };

    const success = (): CodexTransportResult => {
      const telemetry: RunTelemetry = {
        outcome: "success",
        numTurns: null,
        durationMs: null,
        costUsd: null,
        tokensIn,
        tokensOut,
        toolTrace: [...trace],
      };
      let structured: Record<string, unknown> | undefined;
      if (lastMessage !== null) {
        try {
          const parsed = JSON.parse(lastMessage.trim()) as unknown;
          if (isRecord(parsed)) structured = parsed;
        } catch {
          // prose: no structured output
        }
      }
      const result: LLMResult = {
        stdout: lastMessage ?? "",
        stderr: "",
        exitCode: 0,
        tokensUsed: (tokensIn ?? 0) + (tokensOut ?? 0),
        telemetry,
        ...(structured ? { structuredOutput: structured } : {}),
        terminalStatus: { subtype: "success", isError: false },
        signal: null,
      };
      return { result, sawUnsafe: unsafe, stopReason: null };
    };

    const handleLine = (line: Buffer): void => {
      if (line.length === 0) return;
      let msg: unknown;
      try {
        msg = JSON.parse(line.toString("utf8"));
      } catch {
        // An unreadable line may have hidden a request or item; stay conservative.
        return fail("malformed_message", true);
      }
      if (!isRecord(msg)) return fail("malformed_message", true);
      const hasId = msg.id !== undefined && msg.id !== null;
      if (typeof msg.method === "string") {
        if (hasId) onServerRequest(msg.id, msg.method, msg.params);
        else onNotification(msg.method, msg.params);
      } else if (hasId && ("result" in msg || "error" in msg)) {
        onResponse(msg.id, msg);
      } else {
        fail("malformed_message", true);
      }
    };

    function onData(chunk: Buffer | string): void {
      if (done) return;
      let data: Buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (;;) {
        const nl = data.indexOf(0x0a);
        if (nl === -1) {
          buffered = Buffer.concat([buffered, data]);
          if (buffered.length > PLANNING_LIMITS.lineBytes) return fail("oversized_message", true);
          return;
        }
        const head = data.subarray(0, nl);
        data = data.subarray(nl + 1);
        const line = buffered.length ? Buffer.concat([buffered, head]) : head;
        buffered = Buffer.alloc(0);
        if (line.length > PLANNING_LIMITS.lineBytes) return fail("oversized_message", true);
        handleLine(line);
        if (done) return;
      }
    }
    function onEnd(): void {
      fail("missing_completion");
    }
    function onHalt(): void {
      fail("halted");
    }

    io.stdout.on("data", onData);
    io.stdout.on("end", onEnd);
    io.stdout.on("close", onEnd);
    io.stdout.on("error", onEnd);
    if (io.halt.aborted) return onHalt();
    io.halt.addEventListener("abort", onHalt, { once: true });

    request("initialize", "initialize", {
      clientInfo: { name: "ai-implement", title: "AI-Implement", version: "1" },
      capabilities: { experimentalApi: true },
    });
  });
}

function failure(code: FailCode, sawUnsafe: boolean, stopReason: "stdin" | null, input: CodexTransportRunInput, detail?: string): CodexTransportResult {
  const safeDetail = detail
    ? `: ${redactSecrets(input.redact(detail)).replace(/\s+/g, " ").slice(0, PLANNING_LIMITS.errorChars)}`
    : "";
  const result: LLMResult = {
    stdout: "",
    stderr: `codex app-server transport: ${code}${safeDetail}`,
    exitCode: 1,
    tokensUsed: 0,
    telemetry: {
      outcome: "error",
      numTurns: null,
      durationMs: null,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
      toolTrace: [],
    },
    terminalStatus: { subtype: "error", isError: true },
    signal: null,
  };
  return { result, sawUnsafe, stopReason };
}
