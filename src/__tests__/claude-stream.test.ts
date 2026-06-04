import { describe, it, expect } from "vitest";
import {
  parseLine,
  finalText,
  extractTelemetry,
  formatEvent,
  summaryLine,
  type StreamEvent,
} from "../pipeline/claude-stream.js";

const initEvent: StreamEvent = { type: "system", subtype: "init", model: "claude-x", cwd: "/workspace" };
const toolEvent: StreamEvent = {
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm check" } }] },
};
const textEvent: StreamEvent = {
  type: "assistant",
  message: { content: [{ type: "text", text: "All done." }] },
};
const resultSuccess: StreamEvent = {
  type: "result",
  subtype: "success",
  result: "Final answer text",
  num_turns: 12,
  duration_ms: 372000,
  total_cost_usd: 0.83,
  usage: { input_tokens: 182000, output_tokens: 4100 },
};

describe("parseLine", () => {
  it("parses a JSON line", () => {
    expect(parseLine('{"type":"result"}')).toEqual({ type: "result" });
  });
  it("returns null for a non-JSON line", () => {
    expect(parseLine("not json")).toBeNull();
  });
  it("returns null for a blank line", () => {
    expect(parseLine("   ")).toBeNull();
  });
  it("returns null for valid JSON that is not an object", () => {
    expect(parseLine('"just a string"')).toBeNull();
    expect(parseLine("42")).toBeNull();
    expect(parseLine("[1,2,3]")).toBeNull();
  });
});

describe("finalText", () => {
  it("returns the result event's text", () => {
    expect(finalText([initEvent, resultSuccess])).toBe("Final answer text");
  });
  it("falls back to concatenated assistant text when no result event", () => {
    expect(finalText([initEvent, textEvent])).toBe("All done.");
  });
  it("returns empty string for an empty event list", () => {
    expect(finalText([])).toBe("");
  });
});

describe("extractTelemetry", () => {
  it("extracts metrics from a success result", () => {
    const t = extractTelemetry([initEvent, toolEvent, resultSuccess]);
    expect(t).toEqual({
      outcome: "success",
      numTurns: 12,
      durationMs: 372000,
      costUsd: 0.83,
      tokensIn: 182000,
      tokensOut: 4100,
    });
  });
  it("maps error_max_turns to outcome=max_turns", () => {
    const t = extractTelemetry([{ type: "result", subtype: "error_max_turns", num_turns: 50 }]);
    expect(t.outcome).toBe("max_turns");
    expect(t.numTurns).toBe(50);
  });
  it("returns outcome=unknown with nulls when no result event", () => {
    expect(extractTelemetry([initEvent])).toEqual({
      outcome: "unknown",
      numTurns: null,
      durationMs: null,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    });
  });
  it("tolerates a Bedrock result with no cost", () => {
    const t = extractTelemetry([{ type: "result", subtype: "success", num_turns: 3, usage: { input_tokens: 10, output_tokens: 2 } }]);
    expect(t.costUsd).toBeNull();
    expect(t.outcome).toBe("success");
  });
});

describe("formatEvent", () => {
  it("formats an init event", () => {
    expect(formatEvent({ type: "system", subtype: "init", model: "claude-x", cwd: "/workspace" }))
      .toBe("[claude] init model=claude-x cwd=/workspace");
  });
  it("formats a tool_use as tool name + command", () => {
    expect(
      formatEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm check" } }] } }),
    ).toBe("[claude] tool Bash pnpm check");
  });
  it("truncates long tool input", () => {
    const long = "x".repeat(500);
    const out = formatEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { command: long } }] } });
    expect(out!.length).toBeLessThan(220);
    expect(out!.endsWith("…")).toBe(true);
  });
  it("returns null for a result event (summary handles it)", () => {
    expect(formatEvent({ type: "result", subtype: "success" })).toBeNull();
  });
  it("returns null for an unknown event type", () => {
    expect(formatEvent({ type: "whatever" })).toBeNull();
  });
});

describe("summaryLine", () => {
  it("renders a full success summary", () => {
    expect(
      summaryLine({ outcome: "success", numTurns: 12, durationMs: 372000, costUsd: 0.83, tokensIn: 182000, tokensOut: 4100 }),
    ).toBe("[claude] result=success turns=12 duration=6m12s cost=$0.83 tokens=182.0k/4.1k (in/out)");
  });
  it("omits cost when null", () => {
    const line = summaryLine({ outcome: "success", numTurns: 3, durationMs: 5000, costUsd: null, tokensIn: 10, tokensOut: 2 });
    expect(line).not.toContain("cost=");
    expect(line).toContain("result=success");
  });
  it("shows max_turns outcome at summary level", () => {
    expect(summaryLine({ outcome: "max_turns", numTurns: 50, durationMs: null, costUsd: null, tokensIn: null, tokensOut: null }))
      .toContain("result=max_turns");
  });
});
