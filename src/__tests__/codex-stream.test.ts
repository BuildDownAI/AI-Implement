import { describe, it, expect } from "vitest";
import { CodexStreamParser, parseCodexStream, summarizeCommand, codexAttributionUsage } from "../pipeline/codex-stream.js";
import { classifyLlmResult } from "../pipeline/failure-classification.js";

// Shapes follow `codex exec --json` as documented for the pinned CLI (Dockerfile.session
// CODEX_CLI_VERSION); the "future" events below are synthetic and unconfirmed.
const j = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const SK = "sk-" + "synthetic0123456789abcdef";
const GH = "ghp_" + "syntheticToken123";
const msg = (text: string, id = "m1") => ({ type: "item.completed", item: { id, type: "agent_message", text } });
const done = (usage?: unknown) => ({ type: "turn.completed", ...(usage ? { usage } : {}) });
const cmdStart = { type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test", status: "in_progress" } };

describe("codex stream parsing", () => {
  it("yields the same result for chunk-split and whole input", () => {
    const text = j({ type: "thread.started", thread_id: "t1" }, { type: "turn.started" }, cmdStart, msg("{}"), done({ input_tokens: 5, output_tokens: 2 }));
    const whole = parseCodexStream(text);
    const split = new CodexStreamParser();
    for (let i = 0; i < text.length; i += 7) split.push(text.slice(i, i + 7));
    split.end();
    expect(split.telemetry).toEqual(whole.telemetry);
    expect(split.threadId).toBe("t1");
    expect(split.eventTurns).toBe(1);
  });

  it("tolerates garbage, arrays, stderr, unknown events and a truncated final line", () => {
    const p = new CodexStreamParser();
    p.push("not json\n[1,2]\n" + j({ type: "future.event", x: 1 }) + '{"type":"item.started","item":{"id":"c');
    p.pushStderr("warn: something");
    expect(() => p.end()).not.toThrow();
    expect(p.unknownEvents).toBe(1);
    expect(p.malformedLines).toBe(3);
    expect(p.sawUnsafeActivity).toBe(true); // truncated JSON object may have been a command
    expect(p.telemetry.outcome).toBe("unknown");
  });

  it("bounds an oversized line and stays unsafe", () => {
    const p = new CodexStreamParser();
    p.push("x".repeat(1_100_000));
    p.push("x".repeat(10) + "\n" + j(done()));
    p.end();
    expect(p.oversizedLines).toBe(1);
    expect(p.sawUnsafeActivity).toBe(true);
    expect(p.terminalStatus?.isError).toBe(false);
  });

  it("caps the trace at 200 with a marker", () => {
    const events = Array.from({ length: 500 }, (_, i) => ({ type: "item.completed", item: { id: `c${i}`, type: "command_execution", command: `ls ${i}`, status: "completed", exit_code: 0 } }));
    const t = parseCodexStream(j(...events)).telemetry;
    expect(t.toolTrace).toHaveLength(201);
    expect(t.toolTrace!.at(-1)).toContain("300 more");
    expect(t.executedCommands).toHaveLength(200);
  });
});

describe("safety flag", () => {
  it("a started command blocks retry even with no completed event", () => {
    expect(parseCodexStream(j(cmdStart, { type: "turn.failed", error: { message: "x" } })).sawUnsafeActivity).toBe(true);
    expect(parseCodexStream(j(cmdStart)).sawUnsafeActivity).toBe(true);
    expect(parseCodexStream(j(cmdStart)).telemetry.executedCommands).toBeUndefined();
  });
  it("flags file changes, MCP calls and unknown item types", () => {
    for (const item of [{ id: "f", type: "file_change", changes: [], status: "completed" }, { id: "m", type: "mcp_tool_call", server: "s", tool: "t" }, { id: "u", type: "future_item" }]) {
      expect(parseCodexStream(j({ type: "item.started", item })).sawUnsafeActivity).toBe(true);
    }
    expect(parseCodexStream(j({ type: "item.started", item: "weird" })).sawUnsafeActivity).toBe(true);
  });
  it("read-only streams stay safe", () => {
    const p = parseCodexStream(j({ type: "turn.started" }, { type: "item.completed", item: { id: "r", type: "reasoning", text: "hm" } }, msg("hi"), done()));
    expect(p.sawUnsafeActivity).toBe(false);
  });
  it("does not infer execution from prose", () => {
    const p = parseCodexStream(j(msg("I ran `rm -rf build` and edited files"), done()));
    expect(p.sawUnsafeActivity).toBe(false);
    expect(p.telemetry.executedCommands).toBeUndefined();
  });
  it("records failed commands from structured status", () => {
    const t = parseCodexStream(j({ type: "item.completed", item: { id: "c", type: "command_execution", command: "false", status: "failed", exit_code: 1 } })).telemetry;
    expect(t.executedCommands).toEqual([{ command: "false", failed: true }]);
  });
});

describe("structured verdict", () => {
  const classify = (p: CodexStreamParser) =>
    classifyLlmResult(p.toResult({ exitCode: 0 }), { stage: "review", attempt: 1, expectsStructuredOutput: true });

  it("parses the final message JSON object", () => {
    const p = parseCodexStream(j(msg('{"approved":true}'), done()));
    expect(p.toResult({ exitCode: 0 }).structuredOutput).toEqual({ approved: true });
  });
  it.each([
    ["missing", j(done())],
    ["prose", j(msg("Looks good, approved"), done())],
    ["partial", j(msg('{"approved":tr'), done())],
    ["array", j(msg("[1]"), done())],
    ["scalar", j(msg("true"), done())],
    ["failed turn", j(msg('{"approved":true}'), { type: "turn.failed", error: { message: "x" } })],
    ["no terminal", j(msg('{"approved":true}'))],
    ["reasoning only", j({ type: "item.completed", item: { id: "r", type: "reasoning", text: '{"approved":true}' } }, done())],
    ["earlier message", j(msg('{"approved":true}', "a"), msg("done", "b"), done())],
  ])("%s never yields a verdict", (_n, text) => {
    const p = parseCodexStream(text);
    expect(p.toResult({ exitCode: 0 }).structuredOutput).toBeUndefined();
    const failure = classify(p);
    expect(failure.category).toBe("invalid_output");
  });
});

describe("usage and terminal semantics", () => {
  it("keeps missing usage and cost null", () => {
    const t = parseCodexStream(j(done())).telemetry;
    expect([t.tokensIn, t.tokensOut, t.cacheReadTokens, t.costUsd, t.numTurns]).toEqual([null, null, null, null, null]);
    expect(codexAttributionUsage(t)).toMatchObject({ availability: "unavailable", costStatus: "unavailable" });
  });
  it("preserves zero, treats cached as a subset and leaves absent cached null", () => {
    let t = parseCodexStream(j(done({ input_tokens: 0, output_tokens: 0 }))).telemetry;
    expect([t.tokensIn, t.tokensOut, t.cacheReadTokens]).toEqual([0, 0, null]);
    t = parseCodexStream(j(done({ input_tokens: 100, cached_input_tokens: 80, output_tokens: 7 }))).telemetry;
    expect([t.tokensIn, t.cacheReadTokens, t.tokensOut]).toEqual([100, 80, 7]);
    expect(codexAttributionUsage(parseCodexStream(j(done({ input_tokens: 1 }))).telemetry).availability).toBe("partial");
  });
  it("outcomes: success, error, unknown", () => {
    expect(parseCodexStream(j(done())).telemetry.outcome).toBe("success");
    for (const e of [{ type: "turn.failed", error: { message: "x" } }, { type: "error", message: "x" }]) {
      const p = parseCodexStream(j(e));
      expect(p.telemetry.outcome).toBe("error");
      expect(p.terminalStatus).toEqual({ subtype: "error", isError: true });
    }
    expect(parseCodexStream(j({ type: "turn.started" })).terminalStatus).toBeUndefined();
  });
  it("a later turn.completed supersedes a transient error", () => {
    expect(parseCodexStream(j({ type: "error", message: "Reconnecting" }, done())).telemetry.outcome).toBe("success");
  });
});

describe("trace hygiene", () => {
  it("drops reasoning and redacts secrets everywhere", () => {
    const sentinel = "HIDDEN_REASONING_SENTINEL";
    const text = j(
      { type: "item.completed", item: { id: "r", type: "reasoning", text: sentinel } },
      { type: "item.started", item: { id: "c", type: "command_execution", command: `bash -lc 'API_KEY=${SK} curl -H "Authorization: Bearer ${GH}" https://x'` } },
      { type: "item.completed", item: { id: "c", type: "command_execution", command: `bash -lc 'API_KEY=${SK} curl ${GH}'`, status: "completed", exit_code: 0 } },
      { type: "item.completed", item: { id: "m", type: "mcp_tool_call", server: "srv", tool: "t", arguments: { token: SK } } },
      done(),
    );
    const p = parseCodexStream(text, `oops ${SK}`);
    const out = JSON.stringify(p.toResult({ exitCode: 0 }));
    for (const s of [sentinel, SK, GH]) expect(out).not.toContain(s);
    expect(p.telemetry.toolTrace).toContain("mcp srv/t");
  });
  it("summarizes only leading command tokens", () => {
    expect(summarizeCommand("bash -lc 'git log --oneline -n 5 --all extra'")).toBe("git log --oneline -n …");
  });
});
