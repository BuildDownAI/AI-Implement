import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runOpenRouterAgentLiveCheck, CLAUDE_MODEL, CODEX_MODEL, PROMPT, WRONG_KEY, type CheckOptions } from "../../scripts/openrouter-agent-live-check.js";
import { buildModelInvocationEnv } from "../model-auth-client.js";
import { openrouterProviderArgs } from "../pipeline/codex-executor.js";
import { testDir } from "./helpers/test-dir.js";
const key = "synthetic-private-test-value";
function harness(scenario = "ok", extraEnv: NodeJS.ProcessEnv = {}, emitOutput?: (child: { stdout: PassThrough; stderr: PassThrough }, binary: string) => void) {
  const env = { PATH: "/fake", SESSION_TOKEN: "one-run", OPENROUTER_TEST_API_KEY: key, ...extraEnv };
  const log = vi.fn();
  const children: Array<{ binary: string; args: string[]; options: { cwd: string; env: Record<string, string> }; input: string; kill: ReturnType<typeof vi.fn> }> = [];
  const timers: Array<() => void> = [];
  const clock = { setTimeout: vi.fn((fn: () => void, ms: number) => { expect(ms).toBe(120000); timers.push(fn); return timers.length; }), clearTimeout: vi.fn() } as unknown as NonNullable<CheckOptions["clock"]>;
  const spawn: NonNullable<CheckOptions["spawn"]> = (binary, args, options) => {
    expect(readdirSync(options.cwd)).toEqual([]);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const call = { binary, args, options, input: "", kill: child.kill };
    children.push(call);
    child.stdin.on("data", (data) => { call.input += String(data); });
    queueMicrotask(() => {
      if (scenario === "missing") { child.emit("error", Object.assign(new Error(key), { code: "ENOENT" })); return; }
      if (scenario === "timeout") { timers.at(-1)!(); return; }
      if (emitOutput) { emitOutput(child, binary); child.emit("close", 1); return; }
      const wrong = children.length > 2;
      const error = scenario === "stdout-error" || scenario === "long-error" || scenario === "error" || (scenario === "ok" && wrong) || scenario === "zero-error";
      const answer = scenario === "no-ok" || scenario === "metadata" ? "hello" : "OK";
      child.stdout.write(binary === "claude" ? JSON.stringify({ result: error ? `refused ${key}` : answer, is_error: error })
        : error ? JSON.stringify({ type: "turn.failed", error: { message: `refused ${key}` } })
          : JSON.stringify({ type: "item.completed", unrelated: "OK", item: { type: "agent_message", text: answer } }));
      if (scenario === "long-error") child.stderr.write(`first\n${key}${"z".repeat(400)}\n`);
      else if (error && scenario !== "stdout-error") child.stderr.write(`first\nAuthorization: Bearer ${key}\nlast ${key}\n\n`);
      child.emit("close", error && scenario !== "zero-error" ? 1 : 0);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  const options = { spawn, env, log, clock, tempRoot: testDir("agent-check") };
  return { options, log, children };
}
describe("agent live check (no real process)", () => {
  it.each([undefined, ""]) ("skips absent/empty key %s", async (value) => {
    const h = harness("ok", { OPENROUTER_TEST_API_KEY: value });
    await runOpenRouterAgentLiveCheck(h.options);
    expect(h.children).toHaveLength(0);
    expect(h.log).toHaveBeenCalledWith("openrouter-agent-live-check: skipped (no key)");
  });
  it.each(["ok", "no-ok", "error", "zero-error", "missing", "timeout", "accepted"])("reports every agent for %s", async (scenario) => {
    const h = harness(scenario);
    expect(await runOpenRouterAgentLiveCheck(h.options)).toBe(0);
    expect(h.children).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      const wrong = i >= 2;
      const expected = scenario === "missing" ? "skipped (binary not found)"
        : scenario === "timeout" ? "fail (no answer)"
          : scenario === "error" || scenario === "zero-error" || (scenario === "ok" && wrong)
            ? `${wrong ? "refused as expected" : "fail"} (exit ${scenario === "zero-error" ? 0 : 1}): last ***`
            : scenario === "no-ok" ? "fail (no OK in the answer)" : wrong ? "fail (wrong key was accepted)" : "pass";
      // Exit-zero error answers with a good key have no successful answer.
      const result = scenario === "zero-error" && !wrong ? "fail (no OK in the answer)" : expected;
      expect(h.log.mock.calls[i][0]).toBe(`openrouter-agent-live-check: ${i % 2 ? "codex" : "claude"}${wrong ? " wrong-key" : ""} ${result}`);
      if (scenario === "timeout") expect(h.children[i].kill).toHaveBeenCalledWith("SIGKILL");
    }
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(key);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("Authorization");
  });
  it.each(["Authorization: Bearer", '"api_key":', "x-api-key ="])("preserves refusal errors while suppressing %s headers for both agents", async (header) => {
    const h = harness("error", {}, (child) => {
      child.stderr.write(`401: Invalid API key ${key}\n${header} ${key}\n`);
    });
    await runOpenRouterAgentLiveCheck(h.options);
    for (const [line] of h.log.mock.calls) {
      expect(line).toContain("401: Invalid API key ***");
      expect(line).not.toContain(header);
      expect(line).not.toContain(key);
    }
  });
  it.each(["stderr", "stdout"] as const)("discards secret fragments across %s capture and chunk boundaries", async (stream) => {
    const limit = stream === "stderr" ? 64_000 : 1_000_000;
    const h = harness("error", {}, (child, binary) => {
      // The old tail slice started ten characters from the end of the key.
      child[stream].write(key.slice(0, -5));
      child[stream].write(key.slice(-5) + "z".repeat(limit - 10));
      // Overflow without a newline must also discard the following continuation.
      child[stream].write(key.slice(-5));
      child[stream].write("\n");
      if (stream === "stdout") child.stdout.write(binary === "claude"
        ? JSON.stringify({ result: "401: Invalid API key", is_error: true })
        : JSON.stringify({ type: "turn.failed", error: { message: "401: Invalid API key" } }));
    });
    await runOpenRouterAgentLiveCheck(h.options);
    for (const [line] of h.log.mock.calls) {
      expect(line).not.toContain(key);
      expect(line).not.toContain(key.slice(-10));
      expect(line).not.toContain(key.slice(-5));
      expect(line).not.toContain("zzz");
      if (stream === "stdout") expect(line).toContain("401: Invalid API key");
    }
  });
  it("reads structured refusal evidence when stderr is empty", async () => {
    const h = harness("stdout-error");
    await runOpenRouterAgentLiveCheck(h.options);
    expect(h.log.mock.calls[3][0]).toBe("openrouter-agent-live-check: codex wrong-key refused as expected (exit 1): refused ***");
  });
  it("does not treat OK in Codex metadata as an answer", async () => {
    const h = harness("metadata");
    await runOpenRouterAgentLiveCheck(h.options);
    expect(h.log.mock.calls[1][0]).toBe("openrouter-agent-live-check: codex fail (no OK in the answer)");
  });
  it("runs again for a distinct run identity", async () => {
    const h = harness();
    await runOpenRouterAgentLiveCheck(h.options);
    await runOpenRouterAgentLiveCheck({ ...h.options, env: { ...h.options.env, SESSION_TOKEN: "next-run" } });
    expect(h.children).toHaveLength(8);
  });
  it("redacts before limiting the last error line to 300 characters", async () => {
    const h = harness("long-error");
    await runOpenRouterAgentLiveCheck(h.options);
    for (const [line] of h.log.mock.calls) {
      expect(line.split(": ").at(-1)).toBe("***" + "z".repeat(297));
      expect(line).not.toContain(key);
    }
  });
  it.each([false, true])("uses shared routing, isolated directories and fixed stdin (overrides %s)", async (override) => {
    const h = harness("ok", override ? { OPENROUTER_TEST_CLAUDE_MODEL: "custom-claude", OPENROUTER_TEST_CODEX_MODEL: "custom-codex" } : {});
    await runOpenRouterAgentLiveCheck(h.options);
    expect(new Set(h.children.map((c) => c.options.cwd)).size).toBe(4);
    h.children.forEach((call, i) => {
      expect(call.input).toBe(PROMPT);
      expect(call.options.env).toEqual(buildModelInvocationEnv({ authMode: "openrouter-api-key", secret: { kind: "api-key", apiKey: i >= 2 ? WRONG_KEY : key }, inheritedEnv: h.options.env }).env);
      expect(call.args).toEqual(i % 2 ? ["exec", "--json", "--ignore-user-config", "--ignore-rules", "--model", override ? "custom-codex" : CODEX_MODEL, ...openrouterProviderArgs(), "--sandbox", "read-only", "-"]
        : ["--print", "--output-format", "json", "--model", override ? "custom-claude" : CLAUDE_MODEL]);
    });
    h.log.mockClear();
    await runOpenRouterAgentLiveCheck(h.options);
    expect(h.children).toHaveLength(4);
    expect(h.log.mock.calls).toEqual([["openrouter-agent-live-check: skipped (ran before in this run)"]]);
  });
});
