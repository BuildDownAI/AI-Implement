import { describe, it, expect } from "vitest";
import {
  parseLine,
  finalText,
  extractTelemetry,
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
});

describe("finalText", () => {
  it("returns the result event's text", () => {
    expect(finalText([initEvent, resultSuccess])).toBe("Final answer text");
  });
  it("falls back to concatenated assistant text when no result event", () => {
    expect(finalText([initEvent, textEvent])).toBe("All done.");
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
