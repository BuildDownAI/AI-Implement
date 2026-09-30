import type { AttributionUsage, LLMResult, LLMTerminalStatus, RunTelemetry } from "./types.js";

/**
 * Pure parser for `codex exec --json` JSONL (pinned CLI: `CODEX_CLI_VERSION` in Dockerfile.session).
 * No I/O and no process spawning; the executor feeds stdout chunks in and reads a result out.
 *
 * Event shapes treated as confirmed: `thread.started`, `turn.started`, `turn.completed` (with
 * `usage.{input_tokens,cached_input_tokens,output_tokens}`), `turn.failed`, `error`, and
 * `item.started|updated|completed` carrying `agent_message`, `reasoning`, `command_execution`,
 * `file_change`, `mcp_tool_call`, `web_search`, `todo_list` or `error` items. Anything else is an
 * unknown future shape: counted, never fatal, and — for item-shaped data — treated as possibly
 * mutating so it can never authorize an automatic retry.
 */

const LINE_MAX_CHARS = 1_000_000;
const TOOL_TRACE_MAX = 200;
const EXECUTED_COMMANDS_MAX = 200;
const TRACE_ENTRY_MAX = 160;
const STDERR_MAX = 64_000;
const SEEN_ITEMS_MAX = 5000;
const COMMAND_TOKENS_MAX = 4;

// Item types that cannot touch the workspace. Everything else is unsafe or uncertain.
const SAFE_ITEM_TYPES = new Set(["agent_message", "reasoning", "todo_list", "web_search", "error"]);

const SECRET_RE = /(sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{3,}|github_pat_\w+|xox[bp]-[\w-]+|AKIA[0-9A-Z]{8,}|Bearer\s+\S+)/gi;

export interface CodexEvent {
  type?: string;
  [key: string]: unknown;
}

function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, "[redacted]");
}

export function parseCodexLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return record(parsed) ? (parsed as CodexEvent) : null;
  } catch {
    return null;
  }
}

/**
 * Compact, redacted command summary: shell wrappers unwrapped, only the first few tokens kept,
 * `KEY=value` and secret-shaped tokens masked. Arguments beyond that never reach a trace.
 */
export function summarizeCommand(command: string): string {
  let inner = command.trim();
  const wrapped = /^(?:\S*\/)?(?:ba|z|da)?sh\s+(?:-\w+\s+)*-\w*c\s+(['"]?)([\s\S]*)$/.exec(inner);
  if (wrapped) inner = wrapped[2].replace(/['"]$/, "");
  const tokens = inner.split(/\s+/).filter(Boolean);
  const kept = tokens.slice(0, COMMAND_TOKENS_MAX).map((t) => {
    const eq = t.indexOf("=");
    if (eq > 0) return `${t.slice(0, eq)}=[redacted]`;
    return redactSecrets(t);
  });
  const more = tokens.length > COMMAND_TOKENS_MAX ? " …" : "";
  return truncate(`${kept.join(" ")}${more}`, TRACE_ENTRY_MAX);
}

function safeLabel(v: unknown): string {
  return typeof v === "string" && /^[\w.:-]{1,40}$/.test(v) ? v : "?";
}

type Terminal = "completed" | "failed" | "error";

function sumNullable(a: number | null, b: number | null): number | null {
  if (b == null) return a;
  return (a ?? 0) + b;
}

export class CodexStreamParser {
  private partial = "";
  private discarding = false;
  private sawUnsafe = false;
  private terminal: Terminal | null = null;
  private lastMessage: string | null = null;
  private seenItems = new Set<string>();
  private pendingCommands = new Map<string, string>();
  private trace: string[] = [];
  private droppedTrace = 0;
  private commands: Array<{ command: string; failed: boolean }> = [];
  private tokensIn: number | null = null;
  private tokensOut: number | null = null;
  private cachedIn: number | null = null;
  private cost: number | null = null;
  private stderrText = "";

  threadId: string | null = null;
  /** Codex event turns (`turn.started`); deliberately distinct from Claude native turns. */
  eventTurns = 0;
  unknownEvents = 0;
  malformedLines = 0;
  oversizedLines = 0;

  /** Feed a stdout chunk; complete lines are reduced immediately, the tail is buffered (bounded). */
  push(chunk: string): void {
    let rest = chunk;
    for (;;) {
      const nl = rest.indexOf("\n");
      if (nl === -1) {
        this.append(rest);
        return;
      }
      this.append(rest.slice(0, nl));
      this.finishLine();
      rest = rest.slice(nl + 1);
    }
  }

  /** Flush a final unterminated line (early termination). Safe to call repeatedly. */
  end(): void {
    this.finishLine();
  }

  pushStderr(chunk: string): void {
    if (this.stderrText.length < STDERR_MAX) this.stderrText += chunk.slice(0, STDERR_MAX - this.stderrText.length);
  }

  private append(text: string): void {
    if (this.discarding) return;
    if (this.partial.length + text.length > LINE_MAX_CHARS) {
      this.partial = "";
      this.discarding = true;
      this.oversizedLines++;
      // The dropped line may have carried a command or file change we can no longer see.
      this.sawUnsafe = true;
      return;
    }
    this.partial += text;
  }

  private finishLine(): void {
    const line = this.partial;
    const wasDiscarding = this.discarding;
    this.partial = "";
    this.discarding = false;
    if (wasDiscarding) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    const event = parseCodexLine(trimmed);
    if (!event) {
      this.malformedLines++;
      // A corrupted or truncated JSON object may have been an item event; stay conservative.
      if (trimmed.startsWith("{")) this.sawUnsafe = true;
      return;
    }
    this.apply(event);
  }

  apply(event: CodexEvent): void {
    switch (event.type) {
      case "thread.started":
        if (typeof event.thread_id === "string") this.threadId = truncate(event.thread_id, 128);
        return;
      case "turn.started":
        this.eventTurns++;
        return;
      case "turn.completed":
        this.terminal = "completed";
        this.applyUsage(event);
        return;
      case "turn.failed":
        this.terminal = "failed";
        return;
      case "error":
        this.terminal = "error";
        return;
      case "item.started":
      case "item.updated":
      case "item.completed":
        this.applyItem(event.type, event.item);
        return;
      default:
        this.unknownEvents++;
        if (typeof event.type === "string" && event.type.startsWith("item")) this.sawUnsafe = true;
    }
  }

  private applyUsage(event: CodexEvent): void {
    const usage = record(event.usage) ? event.usage : {};
    this.tokensIn = sumNullable(this.tokensIn, count(usage.input_tokens));
    this.tokensOut = sumNullable(this.tokensOut, count(usage.output_tokens));
    this.cachedIn = sumNullable(this.cachedIn, count(usage.cached_input_tokens));
    const cost = count(event.total_cost_usd) ?? count(usage.total_cost_usd) ?? count(usage.cost_usd);
    if (cost != null) this.cost = (this.cost ?? 0) + cost;
  }

  private addTrace(entry: string): void {
    if (this.trace.length < TOOL_TRACE_MAX) this.trace.push(entry);
    else this.droppedTrace++;
  }

  /** True the first time this item id is seen; ids beyond the cap are never deduplicated. */
  private firstSighting(id: unknown): boolean {
    if (typeof id !== "string") return true;
    if (this.seenItems.has(id)) return false;
    if (this.seenItems.size < SEEN_ITEMS_MAX) this.seenItems.add(id);
    return true;
  }

  private applyItem(phase: string, raw: unknown): void {
    if (!record(raw) || typeof raw.type !== "string") {
      this.unknownEvents++;
      this.sawUnsafe = true;
      return;
    }
    const type = raw.type;
    const id = raw.id;
    if (!SAFE_ITEM_TYPES.has(type) && type !== "command_execution" && type !== "file_change" && type !== "mcp_tool_call") {
      this.unknownEvents++;
    }
    if (type === "reasoning") return; // hidden reasoning: never read, never traced

    if (type === "agent_message") {
      if (phase === "item.completed" && typeof raw.text === "string") this.lastMessage = raw.text;
      return;
    }

    if (!SAFE_ITEM_TYPES.has(type)) this.sawUnsafe = true;
    const first = this.firstSighting(id);

    if (type === "command_execution") {
      const summary = summarizeCommand(typeof raw.command === "string" ? raw.command : "");
      if (first) this.addTrace(`command ${summary}`.trimEnd());
      const key = typeof id === "string" ? id : "";
      const status = raw.status;
      const exit = typeof raw.exit_code === "number" ? raw.exit_code : null;
      if (phase === "item.completed" && (status === "completed" || status === "failed")) {
        if (this.commands.length < EXECUTED_COMMANDS_MAX) {
          this.commands.push({ command: summary, failed: status === "failed" || (exit != null && exit !== 0) });
        }
        this.pendingCommands.delete(key);
      } else if (key) {
        this.pendingCommands.set(key, summary);
      }
      return;
    }
    if (!first) return;
    if (type === "file_change") {
      const n = Array.isArray(raw.changes) ? raw.changes.length : 0;
      this.addTrace(`file_change ${n} file${n === 1 ? "" : "s"}`);
    } else if (type === "mcp_tool_call") {
      this.addTrace(`mcp ${safeLabel(raw.server)}/${safeLabel(raw.tool)}`);
    } else if (type === "web_search") {
      this.addTrace("web_search");
    } else if (!SAFE_ITEM_TYPES.has(type)) {
      this.addTrace(`unknown_item ${safeLabel(type)}`);
    }
  }

  /**
   * Whether the workspace may have been touched: any command that *started* (completed or not),
   * any file change or MCP call, any unknown item shape, or a line we had to drop unread.
   * Never derived from model prose.
   */
  get sawUnsafeActivity(): boolean {
    return this.sawUnsafe;
  }

  get finalMessage(): string | null {
    return this.lastMessage;
  }

  get terminalStatus(): LLMTerminalStatus | undefined {
    if (this.terminal == null) return undefined;
    return this.terminal === "completed"
      ? { subtype: "success", isError: false }
      : { subtype: "error", isError: true };
  }

  /**
   * Schema-constrained verdict: only the last completed `agent_message`, only after a successful
   * terminal event, only a JSON object. Missing, prose, partial, array or scalar output is
   * undefined, which `classifyLlmResult` reports as invalid_output.
   */
  get structuredOutput(): Record<string, unknown> | undefined {
    if (this.terminal !== "completed" || this.lastMessage == null) return undefined;
    try {
      const parsed = JSON.parse(this.lastMessage.trim()) as unknown;
      return record(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  get telemetry(): RunTelemetry {
    const toolTrace = this.droppedTrace > 0 ? [...this.trace, `… ${this.droppedTrace} more tool calls truncated`] : [...this.trace];
    return {
      outcome: this.terminal === "completed" ? "success" : this.terminal ? "error" : "unknown",
      numTurns: null,
      durationMs: null,
      costUsd: this.cost,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      cacheReadTokens: this.cachedIn,
      cacheCreationTokens: null,
      toolTrace,
      ...(this.commands.length > 0 ? { executedCommands: [...this.commands] } : {}),
    };
  }

  /** Assemble an `LLMResult`; call `end()` first. stdout carries the final message only. */
  toResult(proc: { exitCode: number; signal?: string | null }): LLMResult {
    const telemetry = this.telemetry;
    const structuredOutput = this.structuredOutput;
    return {
      stdout: this.lastMessage ?? "",
      stderr: redactSecrets(this.stderrText),
      exitCode: proc.exitCode,
      tokensUsed: (telemetry.tokensIn ?? 0) + (telemetry.tokensOut ?? 0),
      telemetry,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      ...(this.terminalStatus ? { terminalStatus: this.terminalStatus } : {}),
      ...(proc.signal !== undefined ? { signal: proc.signal } : {}),
    };
  }
}

/** Usage projection for attribution: unavailable stays unavailable, cost is provider-reported only. */
export function codexAttributionUsage(t: RunTelemetry): AttributionUsage {
  const present = (t.tokensIn !== null ? 1 : 0) + (t.tokensOut !== null ? 1 : 0);
  return {
    availability: present === 2 ? "complete" : present === 1 ? "partial" : "unavailable",
    tokensIn: t.tokensIn,
    tokensOut: t.tokensOut,
    costUsd: t.costUsd,
    costStatus: t.costUsd !== null ? "reported" : "unavailable",
  };
}

/** One-shot convenience over a complete stdout capture. */
export function parseCodexStream(stdout: string, stderr = ""): CodexStreamParser {
  const parser = new CodexStreamParser();
  parser.push(stdout);
  parser.end();
  if (stderr) parser.pushStderr(stderr);
  return parser;
}
