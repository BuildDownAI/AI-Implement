import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { ClaudeCliExecutor } from "../pipeline/executor.js";
import type { StreamEvent } from "../pipeline/claude-stream.js";

const schema = {
  type: "object",
  properties: { approved: { type: "boolean" } },
  required: ["approved"],
  additionalProperties: false,
};

function executorWithEvents(events: StreamEvent[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdout, stderr, stdin });
  const spawnMock = vi.fn(() => {
    setImmediate(() => {
      // Split a JSON event across chunks and omit the trailing newline, as a
      // real process can do independently of message boundaries.
      const data = events.map(event => JSON.stringify(event)).join("\n");
      const midpoint = Math.floor(data.length / 2);
      stdout.write(data.slice(0, midpoint));
      stdout.end(data.slice(midpoint));
      stderr.end();
      setImmediate(() => proc.emit("close", 0));
    });
    return proc as unknown as ChildProcessWithoutNullStreams;
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  return {
    executor: new ClaudeCliExecutor("/tmp", "summary", true, spawnMock as unknown as typeof spawn),
    spawnMock,
    stdin,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("structured Claude CLI results", () => {
  it("passes the schema as one argument and preserves structured data independently of prose", async () => {
    const verdict = { approved: false };
    const { executor, spawnMock, stdin } = executorWithEvents([
      { type: "assistant", message: { content: [{ type: "text", text: "I approve this." }] } },
      { type: "result", subtype: "success", is_error: false, result: "```json\nnot valid JSON\n```", structured_output: verdict,
        usage: { input_tokens: 20, output_tokens: 5 } },
    ]);
    const result = await executor.invoke({ prompt: "Review this", model: "claude-sonnet-5", jsonSchema: schema });
    const call: unknown[] = spawnMock.mock.calls[0];
    const args = call[1] as string[];
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1])).toEqual(schema);
    expect(args).not.toContain("Review this");
    expect(stdin.read()?.toString()).toBe("Review this");
    expect(result.structuredOutput).toEqual(verdict);
    expect(result.stdout).toContain("not valid JSON");
    expect(result.terminalStatus).toEqual({ subtype: "success", isError: false });
    expect(result.tokensUsed).toBe(25);
  });

  it("does not promote assistant structured_output into a terminal verdict", async () => {
    const { executor } = executorWithEvents([
      { type: "assistant", structured_output: { approved: true } },
    ]);
    const result = await executor.invoke({ prompt: "review", model: "m", jsonSchema: schema });
    expect(result.structuredOutput).toBeUndefined();
    expect(result.terminalStatus).toBeUndefined();
    expect(result.hasTerminalResult).toBe(false);
  });

  it("keeps the final failure status even when an earlier result approved", async () => {
    const { executor } = executorWithEvents([
      { type: "result", subtype: "success", is_error: false, structured_output: { approved: true } },
      { type: "result", subtype: "error_max_structured_output_retries", is_error: true },
    ]);
    const result = await executor.invoke({ prompt: "review", model: "m", jsonSchema: schema });
    expect(result.exitCode).toBe(0);
    expect(result.structuredOutput).toBeUndefined();
    expect(result.terminalStatus).toEqual({ subtype: "error_max_structured_output_retries", isError: true });
    expect(result.telemetry?.outcome).toBe("error");
  });

  it("preserves is_error even when subtype incorrectly says success", async () => {
    const { executor } = executorWithEvents([
      { type: "result", subtype: "success", is_error: true, structured_output: { approved: true } },
    ]);
    const result = await executor.invoke({ prompt: "review", model: "m", jsonSchema: schema });
    expect(result.terminalStatus?.isError).toBe(true);
  });

  it("leaves ordinary text invocations without a schema flag", async () => {
    const { executor, spawnMock } = executorWithEvents([
      { type: "result", subtype: "success", result: "Done" },
    ]);
    const result = await executor.invoke({ prompt: "implement", model: "m" });
    const call: unknown[] = spawnMock.mock.calls[0];
    expect(call[1]).not.toContain("--json-schema");
    expect(result.stdout).toBe("Done");
  });
});
