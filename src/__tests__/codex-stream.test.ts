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
    expect(p.telemetry.outcome).toBe("error");
    expect(p.structuredOutput).toBeUndefined();
  });

  it("bounds an oversized line and stays unsafe", () => {
    const p = new CodexStreamParser();
    p.push("x".repeat(1_100_000));
    p.push("x".repeat(10) + "\n" + j(done()));
    p.end();
    expect(p.oversizedLines).toBe(1);
    expect(p.sawUnsafeActivity).toBe(true);
    expect(p.terminalStatus?.isError).toBe(true);
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
});

const started = { type: "turn.started" };
const approved = msg('{"approved":true}');

describe("stream integrity", () => {
  const bad: Array<[string, string]> = [
    ["turn.failed", j(started, { type: "turn.failed" }, approved, done())],
    ["error", j(started, { type: "error", message: "x" }, approved, done())],
    ["malformed", j(started, approved) + "{oops\n" + j(done())],
    ["unknown top-level", j(started, { type: "foo.bar" }, approved, done())],
    ["unknown item", j(started, { type: "item.completed", item: { id: "z", type: "zzz" } }, approved, done())],
    ["shapeless item", j(started, { type: "item.completed" }, approved, done())],
    ["oversized", j(started, approved) + "x".repeat(1_100_000) + "\n" + j(done())],
  ];
  for (const [name, text] of bad) {
    it(`${name} then valid completion never succeeds`, () => {
      const p = parseCodexStream(text);
      const r = p.toResult({ exitCode: 0 });
      expect(p.terminalStatus?.isError).toBe(true);
      expect(r.telemetry?.outcome).toBe("error");
      expect(r.structuredOutput).toBeUndefined();
      expect(classifyLlmResult(r, { stage: "review", attempt: 1, expectsStructuredOutput: true })).not.toBeNull();
    });
  }
  it("unknown non-item events make replay unsafe", () => {
    expect(parseCodexStream(j({ type: "foo.bar" })).sawUnsafeActivity).toBe(true);
  });
  it("a completed turn cannot approve an interrupted later turn", () => {
    const p = parseCodexStream(j(started, approved, done({ input_tokens: 3 }), started));
    expect(p.structuredOutput).toBeUndefined();
    expect(p.finalMessage).toBeNull();
    expect(p.telemetry.outcome).toBe("unknown");
    expect(p.terminalStatus).toBeUndefined();
  });
  it("valid multi-turn stream keeps verdict and summed usage", () => {
    const p = parseCodexStream(j(started, msg("{}"), done({ input_tokens: 3 }), started, approved, done({ input_tokens: 4 })));
    expect(p.structuredOutput).toEqual({ approved: true });
    expect(p.telemetry.tokensIn).toBe(7);
    expect(p.telemetry.outcome).toBe("success");
  });
  it("maps cache_write_input_tokens", () => {
    expect(parseCodexStream(j(done({ cache_write_input_tokens: 5 }))).telemetry.cacheCreationTokens).toBe(5);
    expect(parseCodexStream(j(done({ cache_write_input_tokens: 0 }))).telemetry.cacheCreationTokens).toBe(0);
    expect(parseCodexStream(j(done({ input_tokens: 1 }))).telemetry.cacheCreationTokens).toBeNull();
  });
  it("does not leak argument credentials and stays bounded", () => {
    const cmds = ["curl -H 'Authorization: Bearer scheme tok123' x", "curl --token abc123 x"];
    const events = cmds.flatMap((command, i) => [
      { type: "item.started", item: { id: `a${i}`, type: "command_execution", command } },
      { type: "item.completed", item: { id: `a${i}`, type: "command_execution", command, status: "completed", exit_code: 0 } },
    ]);
    const out = JSON.stringify(parseCodexStream(j(...events)).telemetry);
    for (const s of ["tok123", "abc123", "scheme"]) expect(out).not.toContain(s);
    const many = Array.from({ length: 3000 }, (_, i) => ({ type: "item.started", item: { id: `u${i}`, type: "command_execution", command: "ls" } }));
    const t = parseCodexStream(j(...many)).telemetry;
    expect(t.toolTrace?.length).toBeLessThanOrEqual(201);
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
  it("keeps only the executable name", () => {
    expect(summarizeCommand("bash -lc 'git log --oneline -n 5 --all extra'")).toBe("git …");
  });
});
