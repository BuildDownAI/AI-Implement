import type { RunTelemetry } from "./types.js";

export interface StreamEvent {
  type?: string;
  subtype?: string;
  [key: string]: unknown;
}

export function parseLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as StreamEvent;
  } catch {
    return null;
  }
}

function lastResult(events: StreamEvent[]): StreamEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "result") return events[i];
  }
  return undefined;
}

export function finalText(events: StreamEvent[]): string {
  const result = lastResult(events);
  if (result && typeof result.result === "string") return result.result;
  const texts: string[] = [];
  for (const e of events) {
    if (e.type !== "assistant") continue;
    const msg = e.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    for (const block of msg?.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  return texts.join("\n");
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function mapOutcome(subtype: unknown): RunTelemetry["outcome"] {
  if (subtype === "success") return "success";
  if (subtype === "error_max_turns") return "max_turns";
  if (typeof subtype === "string" && subtype.startsWith("error")) return "error";
  return "unknown";
}

export function extractTelemetry(events: StreamEvent[]): RunTelemetry {
  const result = lastResult(events);
  if (!result) {
    return { outcome: "unknown", numTurns: null, durationMs: null, costUsd: null, tokensIn: null, tokensOut: null };
  }
  const usage = (result.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  return {
    outcome: mapOutcome(result.subtype),
    numTurns: num(result.num_turns),
    durationMs: num(result.duration_ms),
    costUsd: num(result.total_cost_usd),
    tokensIn: num(usage.input_tokens),
    tokensOut: num(usage.output_tokens),
  };
}

const TOOL_INPUT_MAX = 160;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function safeStringify(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return "[unserializable]";
  }
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const candidate =
      (typeof obj.command === "string" && obj.command) ||
      (typeof obj.file_path === "string" && obj.file_path) ||
      (typeof obj.path === "string" && obj.path) ||
      (typeof obj.pattern === "string" && obj.pattern) ||
      safeStringify(obj);
    return truncate(String(candidate), TOOL_INPUT_MAX);
  }
  return truncate(String(input), TOOL_INPUT_MAX);
}

export function formatEvent(event: StreamEvent): string | null {
  switch (event.type) {
    case "system":
      if (event.subtype === "init") {
        const model = typeof event.model === "string" ? event.model : "?";
        const cwd = typeof event.cwd === "string" ? event.cwd : "?";
        return `[claude] init model=${model} cwd=${cwd}`;
      }
      return null;
    case "assistant": {
      const msg = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      const lines: string[] = [];
      for (const block of msg?.content ?? []) {
        if (block.type === "tool_use") {
          const name = typeof block.name === "string" ? block.name : "tool";
          lines.push(`[claude] tool ${name} ${summarizeToolInput(block.input)}`.trimEnd());
        } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          lines.push(`[claude] assistant: ${truncate(block.text.trim(), TOOL_INPUT_MAX)}`);
        }
      }
      return lines.length ? lines.join("\n") : null;
    }
    case "user": {
      // A `user` event is either a tool_result echo or the initial prompt turn.
      // Only the former should surface as tool_result; the initial prompt (plain
      // text, no tool_use_id) would otherwise print a misleading first line.
      const msg = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      const hasToolResult = (msg?.content ?? []).some(
        (block) => block.type === "tool_result" || typeof block.tool_use_id === "string",
      );
      return hasToolResult ? "[claude] tool_result" : null;
    }
    default:
      return null;
  }
}

function humanizeMs(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m${rem.toString().padStart(2, "0")}s` : `${rem}s`;
}

function kfmt(n: number | null): string {
  if (n == null) return "?";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function summaryLine(t: RunTelemetry): string {
  const parts = [`[claude] result=${t.outcome}`];
  if (t.numTurns != null) parts.push(`turns=${t.numTurns}`);
  if (t.durationMs != null) parts.push(`duration=${humanizeMs(t.durationMs)}`);
  // Omit cost when absent or zero (Bedrock typically reports no cost).
  if (t.costUsd != null && t.costUsd > 0) parts.push(`cost=$${t.costUsd.toFixed(2)}`);
  if (t.tokensIn != null || t.tokensOut != null) {
    parts.push(`tokens=${kfmt(t.tokensIn)}/${kfmt(t.tokensOut)} (in/out)`);
  }
  return parts.join(" ");
}
