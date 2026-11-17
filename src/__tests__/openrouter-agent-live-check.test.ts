import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runOpenRouterAgentLiveCheck, DEFAULT_MODEL, type AgentCheckDeps } from "../../scripts/openrouter-agent-live-check.js";
import { buildModelInvocationEnv } from "../model-auth-client.js";
import { openrouterProviderArgs } from "../pipeline/codex-executor.js";
import { testTempRoot } from "./helpers/test-dir.js";

const key = "synthetic-agent-secret-value";
const answer = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n";
function fixture(outcomes: Array<{ code?: number; text?: string; stderr?: string; error?: boolean; missing?: boolean; hang?: boolean }> = [{ text: "OK" }, { code: 1 }]) {
  testTempRoot("agent-check");
  const children: ChildProcessWithoutNullStreams[] = [];
  const prompts: string[] = [];
  const spawn: NonNullable<AgentCheckDeps["spawn"]> = vi.fn((_cmd, _args, options) => {
    expect(readdirSync(options.cwd)).toEqual([]);
    const scenario = outcomes[children.length] ?? {};
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true) }) as unknown as ChildProcessWithoutNullStreams;
    children.push(child);
    child.stdin.on("data", (chunk: Buffer) => prompts.push(chunk.toString()));
    queueMicrotask(() => {
      if (scenario.hang) return;
      if (scenario.missing) { child.emit("error", Object.assign(new Error(key), { code: "ENOENT" })); return; }
      child.stdout.emit("data", Buffer.from(scenario.error ? JSON.stringify({ type: "error", message: "refused" }) + "\n" : answer(scenario.text ?? "")));
      child.stderr.emit("data", Buffer.from(scenario.stderr ?? ""));
      child.emit("close", scenario.code ?? 0);
    });
    return child;
  });
  const log = vi.fn();
  const account = vi.fn(async () => key);
  const env = { OPENROUTER_TEST_API_KEY: key, PATH: "/fake", OPENAI_API_KEY: "other", OPENROUTER_ACCOUNT_CHECK_RUN_ID: "run" };
  const run = (extra: AgentCheckDeps = {}) => runOpenRouterAgentLiveCheck({ env, spawn, log, account, ...extra });
  return { run, spawn: vi.mocked(spawn), log, account, env, prompts, children };
}

describe("OpenRouter agent live check", () => {
  it.each([undefined, ""])('skips missing/empty key %s', async (value) => {
    const f = fixture();
    expect(await f.run({ env: { OPENROUTER_TEST_API_KEY: value } })).toBe(0);
    expect(f.log.mock.calls).toEqual([["openrouter-agent-live-check: skipped (no key)"]]);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.account).not.toHaveBeenCalled();
  });
  it("skips an account failure without leaking its error", async () => {
    const f = fixture();
    await f.run({ account: async () => { throw new Error(key); } });
    expect(f.log.mock.calls).toEqual([["openrouter-agent-live-check: skipped (no test account)"]]);
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each([
    { scenario: { text: "OK" }, expected: "pass" },
    { scenario: { text: "hello" }, expected: "fail (no OK in the answer)" },
    { scenario: { code: 7, stderr: "first\nlast\n\n" }, expected: "fail (exit 7): last" },
    { scenario: { missing: true }, expected: "skipped (binary not found)" },
  ])("reports good-key $expected", async ({ scenario, expected }) => {
    const f = fixture([scenario, { code: 1 }]);
    await f.run();
    expect(f.log.mock.calls[0]).toEqual([`openrouter-agent-live-check: codex ${expected}`]);
  });
  it.each([
    { scenario: { code: 1, stderr: "unauthorized" }, expected: "refused as expected (exit 1): unauthorized" },
    { scenario: { error: true }, expected: "refused as expected (exit 0): refused" },
    { scenario: { text: "OK" }, expected: "fail (wrong key was accepted)" },
    { scenario: { text: "" }, expected: "fail (no OK in the answer)" },
    { scenario: { missing: true }, expected: "skipped (binary not found)" },
  ])("reports wrong-key $expected", async ({ scenario, expected }) => {
    const f = fixture([{ text: "OK" }, scenario]);
    await f.run();
    expect(f.log.mock.calls[1]).toEqual([`openrouter-agent-live-check: codex wrong-key ${expected}`]);
  });
  it.each([undefined, "override/model"])('uses shared arguments and environments with model %s', async (model) => {
    const f = fixture();
    const env = { ...f.env, OPENROUTER_TEST_MODEL: model };
    await f.run({ env });
    expect(f.spawn).toHaveBeenCalledTimes(2);
    for (const [i, [cmd, args, options]] of f.spawn.mock.calls.entries()) {
      expect(cmd).toBe("codex");
      expect(args).toEqual(["exec", "--json", "--ignore-user-config", "--ignore-rules", "--model", model ?? DEFAULT_MODEL,
        ...openrouterProviderArgs(), "--sandbox", "read-only", "-"]);
      expect(options.env).toEqual(buildModelInvocationEnv({ inheritedEnv: env, authMode: "openrouter-api-key", secret: { kind: "api-key", apiKey: i === 0 ? key : "sk-or-v1-invalid" } }).env);
      expect(existsSync(options.cwd)).toBe(false);
    }
    expect(f.spawn.mock.calls[0][2].cwd).not.toBe(f.spawn.mock.calls[1][2].cwd);
    expect(f.prompts).toEqual(["Reply with the one word OK.", "Reply with the one word OK."]);
  });
  it("deduplicates a second start but permits a new run", async () => {
    const f = fixture();
    await f.run();
    f.spawn.mockClear(); f.log.mockClear();
    await f.run();
    expect(f.log.mock.calls).toEqual([["openrouter-agent-live-check: skipped (ran before in this run)"]]);
    expect(f.spawn).not.toHaveBeenCalled();
    await f.run({ env: { ...f.env, OPENROUTER_ACCOUNT_CHECK_RUN_ID: "next-run" } });
    expect(f.spawn).toHaveBeenCalledTimes(2);
  });
  it("redacts keys and headers before truncating the last error line", async () => {
    const f = fixture([{ code: 1, stderr: `ignored\nAuthorization: Bearer ${key}\n${key} ${"x".repeat(400)}\n\n` },
      { code: 1, stderr: `Authorization: Bearer sk-or-v1-invalid ${key}` }]);
    await f.run();
    const output = f.log.mock.calls.flat().join("\n");
    expect(output).not.toContain(key);
    expect(output).not.toContain("sk-or-v1-invalid");
    expect(output).not.toContain("Authorization");
    expect(output).not.toContain("Bearer");
    expect(f.log.mock.calls[0][0].split(": ").at(-1)).toHaveLength(300);
  });
  it("does not mistake an echoed prompt in an error for an answer", async () => {
    const f = fixture([{ error: true }]);
    await f.run();
    expect(f.log.mock.calls[0][0]).toContain("fail (no OK in the answer)");
  });
  it("stops both timed-out agents at 120 seconds and cleans their directories", async () => {
    const f = fixture([{ hang: true }, { hang: true }]);
    const timers: Array<() => void> = [];
    const setTimer = vi.fn((callback: () => void, ms: number) => {
      expect(ms).toBe(120_000);
      timers.push(callback);
      queueMicrotask(callback);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const clearTimer = vi.fn();
    await f.run({ setTimer, clearTimer });
    expect(timers).toHaveLength(2);
    expect(clearTimer).toHaveBeenCalledTimes(2);
    for (const child of f.children) expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    for (const call of f.spawn.mock.calls) expect(existsSync(call[2].cwd)).toBe(false);
    expect(f.log.mock.calls).toEqual([["openrouter-agent-live-check: codex fail (no answer)"], ["openrouter-agent-live-check: codex wrong-key fail (no answer)"]]);
  });
});
