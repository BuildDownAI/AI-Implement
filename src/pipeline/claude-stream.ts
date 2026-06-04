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
    return JSON.parse(trimmed) as StreamEvent;
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
