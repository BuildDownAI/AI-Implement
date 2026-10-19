import { parse as parseToml } from "smol-toml";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync, type spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CHATGPT_PLAN_PROVIDER, CODEX_SHELL_ENV_EXCLUDE, CodexExecutor, chatgptPlanProviderArgs, CodexPlanningPolicyUnprovenError, CodexRecoveryRequiredError, matchesSchema, type CodexExecutorOptions } from "../pipeline/codex-executor.js";
import { ModelAuthClientError, type ModelAuthClient, type ModelInvocation } from "../model-auth-client.js";
import { DEFAULT_RETRY_POLICY } from "../pipeline/retry-backoff.js";
import { READ_ONLY_TOOL_PARAMS } from "../pipeline/steps/read-only-tools.js";
import type { CodexProtocolDriver, CodexTransportResult, CodexTransportRunInput } from "../pipeline/codex-planning-adapter.js";
import type { InvokeParams } from "../pipeline/types.js";
import { testDir, testTempRoot } from "./helpers/test-dir.js";

const SYNTHETIC_KEY = "synthetic-codex-api-key-0000";
const VERDICT_SCHEMA = {
  type: "object",
  properties: { approved: { type: "boolean" }, summary: { type: "string" } },
  required: ["approved", "summary"],
  additionalProperties: false,
};

const ev = (o: unknown): string => JSON.stringify(o);
const message = (text: string): string[] => [
  ev({ type: "thread.started", thread_id: "t1" }),
  ev({ type: "turn.started" }),
  ev({ type: "item.completed", item: { id: "m1", type: "agent_message", text } }),
  ev({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
];
const verdict = (v: unknown): string[] => message(JSON.stringify(v));
const commandStarted = ev({ type: "item.started", item: { id: "c1", type: "command_execution", command: "touch x", status: "in_progress" } });

interface Script {
  stdout?: string[];
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  /** Never emits close on its own (hangs until signalled). */
  hang?: boolean;
  /** Which signals the fake honours by closing. */
  dieOn?: NodeJS.Signals[];
  error?: NodeJS.ErrnoException;
}

interface Spawned {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  stdin: string;
  signals: NodeJS.Signals[];
}

function makeSpawn(scripts: Script[], log: Spawned[], onSpawn?: () => void): typeof spawn {
  return ((cmd: string, args: string[], opts: { env: Record<string, string>; cwd?: string }) => {
    const script = scripts[log.length] ?? scripts[scripts.length - 1];
    const rec: Spawned = { cmd, args, env: opts.env, cwd: opts.cwd, stdin: "", signals: [] };
    log.push(rec);
    onSpawn?.();
    const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    stdin.on("data", (d: Buffer) => (rec.stdin += d.toString()));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const closeWith = (code: number | null, sig: NodeJS.Signals | null): void => {
      stdout.end();
      stderr.end();
      proc.emit("close", code, sig);
    };
    Object.assign(proc, {
      stdin,
      stdout,
      stderr,
      pid: undefined,
      kill: (sig: NodeJS.Signals) => {
        rec.signals.push(sig);
        if ((script.dieOn ?? []).includes(sig)) setImmediate(() => closeWith(null, sig));
        return true;
      },
      unref: () => {},
    });
    setImmediate(() => {
      if (script.error) {
        proc.emit("error", script.error);
        return;
      }
      for (const line of script.stdout ?? []) stdout.write(`${line}\n`);
      if (script.stderr) stderr.write(script.stderr);
      if (!script.hang) setImmediate(() => closeWith(script.exitCode === undefined ? 0 : script.exitCode, script.signal ?? null));
    });
    return proc;
  }) as unknown as typeof spawn;
}

interface FakeAuth {
  client: Pick<ModelAuthClient, "invoke">;
  events: string[];
  checkpointFails: boolean;
}

function makeAuth(opts: { mode?: "api" | "subscription"; checkpointFails?: boolean } = {}): FakeAuth {
  const events: string[] = [];
  let uncertain = false;
  let busy = false;
  const state: FakeAuth = {
    events,
    checkpointFails: opts.checkpointFails ?? false,
    client: {
      async invoke<T>(profileId: string, run: (i: ModelInvocation) => Promise<T>): Promise<T> {
        events.push(`invoke:${profileId}`);
        if (uncertain) throw new ModelAuthClientError("checkpoint_uncertain", { profileId });
        if (busy) throw new ModelAuthClientError("invocation_in_progress", { profileId });
        busy = true;
        const env: Record<string, string> =
          opts.mode === "subscription" ? { PATH: "/usr/bin", CODEX_HOME: "/tmp/synthetic-auth" } : { PATH: "/usr/bin", CODEX_API_KEY: SYNTHETIC_KEY };
        let result: T | undefined;
        let failure: unknown;
        let failed = false;
        try {
          result = await run({ env, strippedKeys: [] });
        } catch (e) {
          failed = true;
          failure = e;
        }
        events.push("checkpoint");
        busy = false;
        if (state.checkpointFails) {
          uncertain = true;
          throw new ModelAuthClientError("checkpoint_uncertain", { profileId });
        }
        if (failed) throw failure;
        return result as T;
      },
    },
  };
  return state;
}

let workspace: string;
beforeEach(() => {
  workspace = testDir("codex-ws");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function make(scripts: Script[], extra: Partial<CodexExecutorOptions> = {}, auth = makeAuth()) {
  const log: Spawned[] = [];
  const sleeps: number[] = [];
  const executor = new CodexExecutor(workspace, {
    auth: auth.client,
    profileId: "profile-1",
    allowRepositoryWrites: true,
    spawnImpl: makeSpawn(scripts, log),
    sleepImpl: async (ms) => void sleeps.push(ms),
    termWaitMs: 40,
    killWaitMs: 40,
    ...extra,
  });
  return { executor, log, sleeps, auth };
}

const base = { prompt: "do the thing", model: "gpt-synthetic", stage: "implement" };
const retry = { retry: { policy: { ...DEFAULT_RETRY_POLICY, requestRetries: 2, backoffInitialMs: 1, backoffMaxMs: 5 }, toolUseIsSafe: false } };

describe("CodexExecutor result contract", () => {
  it("returns a success result with nullable usage preserved and the prompt on stdin", async () => {
    const { executor, log } = make([{ stdout: message("done") }]);
    const result = await executor.invoke(base);
    expect(result.terminalStatus?.subtype).toBe("success");
    expect(result.stdout).toBe("done");
    expect(result.attempts).toBe(1);
    expect(result.failure).toBeUndefined();
    expect(log[0].stdin).toBe("do the thing");
    expect(log[0].args).not.toContain("do the thing");
  });

  it("passes the selected synthetic provider URL to codex exec through trusted config", async () => {
    const auth: Pick<ModelAuthClient, "invoke"> = {
      invoke: async (_id, cb) => cb({ env: { PATH: "/usr/bin", CODEX_API_KEY: SYNTHETIC_KEY, OPENAI_BASE_URL: "http://local-feedback-provider:8080/v1" }, strippedKeys: [] }),
    };
    const { executor, log } = make([{ stdout: message("done") }], {}, { client: auth, events: [], checkpointFails: false });
    await executor.invoke(base);
    expect(log[0].args).toContain("-c");
    expect(log[0].args).toContain('openai_base_url="http://local-feedback-provider:8080/v1"');
  });

  it("rejects unsafe selected provider URLs before spawning codex", async () => {
    const cases = [
      "https://local-feedback-provider:8080/v1",
      "http://user@local-feedback-provider:8080/v1",
      "http://local-feedback-provider:8080/v1?x=1",
      "http://local-feedback-provider:8080/v1#x",
      "http://local-feedback-provider:8080/",
      "http://evil.example:8080/v1",
      "http://local-feedback-provider:0/v1",
    ];
    for (const url of cases) {
      const log: Spawned[] = [];
      const auth: Pick<ModelAuthClient, "invoke"> = {
        invoke: async (_id, cb) => cb({ env: { PATH: "/usr/bin", CODEX_API_KEY: SYNTHETIC_KEY, OPENAI_BASE_URL: url }, strippedKeys: [] }),
      };
      const executor = new CodexExecutor(workspace, {
        auth,
        profileId: "profile-1",
        allowRepositoryWrites: true,
        spawnImpl: makeSpawn([{ stdout: message("done") }], log),
        sleepImpl: async () => {},
      });
      const error = await executor.invoke(base).catch((e: unknown) => e);
      expect(error, url).toBeInstanceOf(Error);
      expect(error, url).not.toBeInstanceOf(CodexRecoveryRequiredError);
      expect((error as Error).message, url).toMatch(/OPENAI_BASE_URL/);
      expect(log, url).toEqual([]);
    }
  });

  it("keeps usage null when the provider reports none", async () => {
    const { executor } = make([{ stdout: [ev({ type: "turn.started" }), ev({ type: "turn.completed" })] }]);
    const result = await executor.invoke(base);
    expect(result.telemetry?.tokensIn).toBeNull();
    expect(result.telemetry?.costUsd).toBeNull();
  });
});

describe("structured verdict validation", () => {
  const params = { ...base, stage: "review", jsonSchema: VERDICT_SCHEMA, expectsStructuredOutput: true, ...READ_ONLY_TOOL_PARAMS };

  it("accepts a valid verdict", async () => {
    const { executor } = make([{ stdout: verdict({ approved: true, summary: "ok" }) }]);
    const result = await executor.invoke(params);
    expect(result.failure).toBeUndefined();
    expect(result.structuredOutput).toEqual({ approved: true, summary: "ok" });
  });

  it.each([
    ["prose", message("looks good to me")],
    ["missing required key", verdict({ approved: true })],
    ["wrong type", verdict({ approved: "yes", summary: "ok" })],
    ["extra property", verdict({ approved: true, summary: "ok", extra: 1 })],
    ["array", message("[]")],
    ["no final message", [ev({ type: "turn.started" }), ev({ type: "turn.completed" })]],
  ])("rejects %s as invalid output", async (_name, stdout) => {
    const { executor } = make([{ stdout }]);
    const result = await executor.invoke(params);
    expect(result.failure?.category).toBe("invalid_output");
    expect(result.structuredOutput).toBeUndefined();
  });

  it("matchesSchema covers enum, items and nested required", () => {
    const schema = { type: "object", properties: { xs: { type: "array", items: { type: "string", enum: ["a", "b"] } } }, required: ["xs"] };
    expect(matchesSchema({ xs: ["a"] }, schema)).toBe(true);
    expect(matchesSchema({ xs: ["c"] }, schema)).toBe(false);
    expect(matchesSchema({}, schema)).toBe(false);
  });

  it.each(["constructor", "toString", "valueOf", "hasOwnProperty"])("rejects own property %s under additionalProperties", (key) => {
    const strict = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
    expect(matchesSchema({ a: "x" }, strict)).toBe(true);
    expect(matchesSchema({ a: "x", [key]: "y" }, strict)).toBe(false);
    const typed = { type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "number" } };
    expect(matchesSchema({ a: "x", [key]: 1 }, typed)).toBe(true);
    expect(matchesSchema({ a: "x", [key]: "y" }, typed)).toBe(false);
  });

  it.each(["constructor", "toString", "valueOf"])("rejects a verdict carrying own key %s", async (key) => {
    const { executor } = make([{ stdout: verdict({ approved: true, summary: "ok", [key]: "x" }) }]);
    const result = await executor.invoke(params);
    expect(result.failure?.category).toBe("invalid_output");
    expect(result.structuredOutput).toBeUndefined();
  });

  it("writes the output schema outside the workspace and removes it afterwards", async () => {
    const { executor, log } = make([{ stdout: verdict({ approved: true, summary: "ok" }) }]);
    await executor.invoke(params);
    const schemaPath = log[0].args[log[0].args.indexOf("--output-schema") + 1];
    expect(schemaPath.startsWith(workspace)).toBe(false);
    expect(existsSync(schemaPath)).toBe(false);
  });
});

describe("pinned configuration and sandbox", () => {
  it("pins provider, model and isolation on argv with no Claude or bypass flags", async () => {
    const { executor, log } = make([{ stdout: message("ok") }]);
    await executor.invoke({ ...base, jsonSchema: VERDICT_SCHEMA, tools: ["Bash(curl *)"], maxTurns: 3 });
    const args = log[0].args;
    expect(log[0].cmd).toBe("codex");
    expect(args[0]).toBe("exec");
    for (const flag of ["--json", "--ignore-user-config", "--ignore-rules", "--output-schema"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-synthetic");
    expect(args[args.indexOf("-c") + 1]).toBe('model_provider="openai"');
    expect(args.indexOf("-c")).toBeGreaterThan(args.indexOf("--ignore-rules"));
    expect(args[args.length - 1]).toBe("-");
    const joined = args.join(" ");
    for (const banned of ["--tools", "--allowed-tools", "--max-turns", "--dangerously", "bypass", "full-auto", "danger-full-access", "--dangerously-skip-permissions"]) {
      expect(joined).not.toContain(banned);
    }
  });

  it("uses the selected invocation env only, and no secret reaches argv", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-should-not-leak");
    const { executor, log } = make([{ stdout: message("ok") }]);
    await executor.invoke(base);
    expect(log[0].env).toEqual({ PATH: "/usr/bin", CODEX_API_KEY: SYNTHETIC_KEY });
    expect(log[0].args.join(" ")).not.toContain(SYNTHETIC_KEY);
  });

  it("uses read-only for restricted calls and workspace-write otherwise", async () => {
    const ro = make([{ stdout: message("ok") }]);
    await ro.executor.invoke({ ...base, ...READ_ONLY_TOOL_PARAMS });
    expect(ro.log[0].args[ro.log[0].args.indexOf("--sandbox") + 1]).toBe("read-only");
    const rw = make([{ stdout: message("ok") }]);
    await rw.executor.invoke(base);
    expect(rw.log[0].args[rw.log[0].args.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  it("derives the sandbox from the fixed agentStage, not from builtinTools or caller args", async () => {
    const argsFor = async (extra: Partial<InvokeParams>): Promise<string[]> => {
      const { executor, log } = make([{ stdout: message("ok") }]);
      await executor.invoke({ ...base, ...extra });
      return log[0].args;
    };
    const impl = await argsFor({ agentStage: "implementation", ...READ_ONLY_TOOL_PARAMS });
    expect(impl[impl.indexOf("--sandbox") + 1]).toBe("workspace-write");
    const none = await argsFor({});
    expect(none[none.indexOf("--sandbox") + 1]).toBe("workspace-write");
    // Review never falls back to `exec`: it needs its own restricted driver (AII-1438).
    const { executor, log } = make([{ stdout: message("ok") }]);
    await expect(executor.invoke({ ...base, agentStage: "review" })).rejects.toMatchObject({ code: "CODEX_PLANNING_POLICY_UNPROVEN" });
    expect(log).toHaveLength(0);
  });

  it("refuses planning before any auth checkout or spawn rather than shipping an unproven policy", async () => {
    const { executor, log, auth } = make([{ stdout: message("ok") }]);
    const err = await executor.invoke({ ...base, agentStage: "planning" }).catch((e) => e);
    expect(err).toBeInstanceOf(CodexPlanningPolicyUnprovenError);
    expect(err.code).toBe("CODEX_PLANNING_POLICY_UNPROVEN");
    expect(log).toHaveLength(0);
    expect(auth.events).toEqual([]);
  });

  it("maps a rejected pinned option to a config failure without a second spawn", async () => {
    const { executor, log } = make([{ exitCode: 2, stderr: "error: unexpected argument '--ignore-rules' found" }]);
    const result = await executor.invoke({ ...base, ...retry });
    expect(result.failure).toMatchObject({ category: "config", code: "CODEX_CONFIG_REJECTED", retryable: false });
    expect(log).toHaveLength(1);
  });

  it("classifies a missing binary as config and never retries", async () => {
    const { executor, log } = make([{ error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }) }]);
    await expect(executor.invoke({ ...base, ...retry })).rejects.toMatchObject({ failure: { category: "config" } });
    expect(log).toHaveLength(1);
  });
});

describe("failure classification and retry safety", () => {
  it("retries a transient failure before any tool event on the same profile", async () => {
    const { executor, log, sleeps, auth } = make([
      { exitCode: 1, stderr: "stream error: 503 service unavailable", stdout: [ev({ type: "turn.started" })] },
      { stdout: message("ok") },
    ]);
    const result = await executor.invoke({ ...base, ...retry });
    expect(result.attempts).toBe(2);
    expect(result.failure).toBeUndefined();
    expect(log).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(auth.events.filter((e) => e.startsWith("invoke:"))).toEqual(["invoke:profile-1", "invoke:profile-1"]);
  });

  it("bounds retries by the policy", async () => {
    const { executor, log } = make([{ exitCode: 1, stderr: "503" }]);
    const result = await executor.invoke({ ...base, ...retry });
    expect(log).toHaveLength(3);
    expect(result.failure?.category).toBe("transient");
  });

  it.each([
    ["command", [commandStarted]],
    ["file change", [ev({ type: "item.completed", item: { id: "f", type: "file_change", changes: [{}] } })]],
    ["mcp call", [ev({ type: "item.started", item: { id: "x", type: "mcp_tool_call", server: "s", tool: "t" } })]],
    ["unknown item", [ev({ type: "item.started", item: { id: "u", type: "future_thing" } })]],
    ["dropped line", ["{not json"]],
  ])("never replays after %s", async (_n, stdout) => {
    const { executor, log } = make([{ exitCode: 1, stderr: "503", stdout }, { stdout: message("ok") }]);
    const result = await executor.invoke({ ...base, ...retry });
    expect(log).toHaveLength(1);
    expect(result.failure?.category).toBe("transient");
  });

  it("does not retry without a retry policy", async () => {
    const { executor, log } = make([{ exitCode: 1, stderr: "503" }, { stdout: message("ok") }]);
    await executor.invoke(base);
    expect(log).toHaveLength(1);
  });

  it("never retries or switches profile on an auth failure", async () => {
    const { executor, log, auth } = make([{ exitCode: 1, stderr: "401 invalid x-api-key" }, { stdout: message("ok") }]);
    const result = await executor.invoke({ ...base, ...retry });
    expect(result.failure?.category).toBe("auth");
    expect(log).toHaveLength(1);
    expect(auth.events).toEqual(["invoke:profile-1", "checkpoint"]);
  });

  it("redacts the credential from stderr and the final message", async () => {
    const { executor } = make([{ exitCode: 1, stderr: `boom ${SYNTHETIC_KEY}`, stdout: message(`echo ${SYNTHETIC_KEY}`) }]);
    const result = await executor.invoke(base);
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_KEY);
  });

  it("retries a transient stdin EPIPE (child never consumed the prompt) once safe", async () => {
    // First child exits without reading; the second succeeds.
    const log: Spawned[] = [];
    const inner = makeSpawn([{ stdout: message("ok") }], log);
    let calls = 0;
    const spawnImpl = ((c: string, a: string[], o: { env: Record<string, string> }) => {
      const proc = inner(c, a, o as never) as unknown as ChildProcessWithoutNullStreams;
      if (calls++ === 0) setImmediate(() => proc.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" })));
      return proc;
    }) as unknown as typeof spawn;
    const auth = makeAuth();
    const executor = new CodexExecutor(workspace, { auth: auth.client, profileId: "p", allowRepositoryWrites: true, spawnImpl, sleepImpl: async () => {}, termWaitMs: 20, killWaitMs: 20 });
    // The fake dies on SIGTERM only if told to; give the first child a way out.
    const result = await executor.invoke({ ...base, ...retry });
    expect(result.attempts).toBe(2);
  });

  it.each([
    ["configuration", "error: unexpected argument '--ignore-user-config' found", "config"],
    ["authentication", "401 invalid x-api-key", "auth"],
  ])("fails closed on %s rejection combined with stdin EPIPE without retrying", async (_name, stderr, category) => {
    const log: Spawned[] = [];
    const inner = makeSpawn([{ exitCode: 2, stderr }, { stdout: message("ok") }], log);
    const spawnImpl = ((c: string, a: string[], o: { env: Record<string, string> }) => {
      const proc = inner(c, a, o as never) as unknown as ChildProcessWithoutNullStreams;
      setImmediate(() => proc.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" })));
      return proc;
    }) as unknown as typeof spawn;
    const auth = makeAuth();
    const executor = new CodexExecutor(workspace, { auth: auth.client, profileId: "p", allowRepositoryWrites: true, spawnImpl, sleepImpl: async () => {}, termWaitMs: 40, killWaitMs: 40 });
    const result = await executor.invoke({ ...base, ...retry });
    expect(log).toHaveLength(1);
    expect(result.failure?.category).toBe(category);
    expect(result.attempts).toBe(1);
    expect(auth.events).toEqual(["invoke:p", "checkpoint"]);
  });
});

describe("timeout, cancellation and termination", () => {
  afterEach(() => vi.restoreAllMocks());

  it("terminates on timeout with INVOCATION_TIMEOUT and keeps partial telemetry", async () => {
    const partial = [ev({ type: "turn.started" }), ev({ type: "item.completed", item: { id: "m", type: "agent_message", text: "partial" } })];
    const { executor, log } = make([{ stdout: partial, hang: true, dieOn: ["SIGTERM"] }]);
    const result = await executor.invoke({ ...base, invocationTimeoutMs: 30 });
    expect(result.failure).toMatchObject({ code: "INVOCATION_TIMEOUT", retryable: false });
    expect(result.stdout).toBe("partial");
    expect(result.telemetry).toBeDefined();
    expect(log[0].signals).toEqual(["SIGTERM"]);
  });

  it("escalates TERM to KILL and still resolves once the child dies", async () => {
    const { executor, log } = make([{ hang: true, dieOn: ["SIGKILL"] }]);
    const result = await executor.invoke({ ...base, invocationTimeoutMs: 20 });
    expect(result.failure?.code).toBe("INVOCATION_TIMEOUT");
    expect(log[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("classifies operator cancellation as cancelled", async () => {
    const ac = new AbortController();
    const { executor, log } = make([{ hang: true, dieOn: ["SIGTERM"] }], { cancelSignal: ac.signal });
    const pending = executor.invoke(base);
    setTimeout(() => ac.abort(), 20);
    const result = await pending;
    expect(result.failure).toMatchObject({ category: "cancelled" });
    expect(log[0].signals[0]).toBe("SIGTERM");
  });

  it("cancels immediately when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const { executor } = make([{ hang: true, dieOn: ["SIGTERM"] }], { cancelSignal: ac.signal });
    expect((await executor.invoke(base)).failure?.category).toBe("cancelled");
  });

  it("holds for recovery when the child ignores TERM and KILL, and refuses the next invocation", async () => {
    const { executor, log, auth } = make([{ hang: true, dieOn: [] }]);
    await expect(executor.invoke({ ...base, invocationTimeoutMs: 10 })).rejects.toBeInstanceOf(CodexRecoveryRequiredError);
    expect(log[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
    // No session read/checkpoint while the child may still be alive.
    expect(auth.events).toEqual(["invoke:profile-1"]);
    await expect(executor.invoke(base)).rejects.toMatchObject({ reason: "held" });
    expect(log).toHaveLength(1);
  });

  it("keeps the shared profile held so no second executor can invoke while the child may live", async () => {
    const auth = makeAuth({ mode: "subscription" });
    const first = make([{ hang: true, dieOn: [] }], {}, auth);
    await expect(first.executor.invoke({ ...base, invocationTimeoutMs: 10 })).rejects.toMatchObject({ reason: "child_not_terminated" });
    const second = make([{ stdout: message("ok") }], {}, auth);
    await expect(second.executor.invoke(base)).rejects.toMatchObject({ category: "invocation_in_progress" });
    expect(second.log).toHaveLength(0);
    expect(auth.events.filter((e) => e === "checkpoint")).toHaveLength(0);
  });

  it("signals the whole process group when the child has a pid", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((_pid: number, sig: NodeJS.Signals | number) => {
      if (sig === 0) {
        const err = Object.assign(new Error("gone"), { code: "ESRCH" });
        throw err;
      }
      return true;
    }) as typeof process.kill);
    const log: Spawned[] = [];
    const inner = makeSpawn([{ hang: true }], log);
    const spawnImpl = ((c: string, a: string[], o: never) => {
      const proc = inner(c, a, o) as unknown as ChildProcessWithoutNullStreams & EventEmitter;
      Object.assign(proc, { pid: 4242 });
      // The group-wide TERM is what ends it.
      killSpy.mockImplementation(((_pid: number, sig: NodeJS.Signals | number) => {
        if (sig === "SIGTERM") setImmediate(() => proc.emit("close", null, "SIGTERM"));
        if (sig === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return true;
      }) as typeof process.kill);
      return proc;
    }) as unknown as typeof spawn;
    const auth = makeAuth();
    const executor = new CodexExecutor(workspace, { auth: auth.client, profileId: "p", allowRepositoryWrites: true, spawnImpl, termWaitMs: 50, killWaitMs: 50 });
    const result = await executor.invoke({ ...base, invocationTimeoutMs: 10 });
    expect(result.failure?.code).toBe("INVOCATION_TIMEOUT");
    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
  });
});

describe("auth and checkpoint ordering", () => {
  it.each(["api", "subscription"] as const)("checkpoints after the child exits and before invoke resolves (%s)", async (mode) => {
    const auth = makeAuth({ mode });
    const order = auth.events;
    const log: Spawned[] = [];
    const executor = new CodexExecutor(workspace, {
      auth: auth.client,
      profileId: "profile-1",
      allowRepositoryWrites: true,
      spawnImpl: makeSpawn([{ stdout: message("ok") }], log, () => order.push("spawn")),
    });
    await executor.invoke(base);
    expect(order).toEqual(["invoke:profile-1", "spawn", "checkpoint"]);
    if (mode === "subscription") expect(log[0].env.CODEX_HOME).toBe("/tmp/synthetic-auth");
    else expect(log[0].env.CODEX_API_KEY).toBe(SYNTHETIC_KEY);
  });

  it("checkpoints even when the run fails", async () => {
    const auth = makeAuth();
    const { executor } = make([{ error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }) }], {}, auth);
    await expect(executor.invoke(base)).rejects.toBeDefined();
    expect(auth.events).toEqual(["invoke:profile-1", "checkpoint"]);
  });

  it("holds when the checkpoint acknowledgement is uncertain and starts no next invocation", async () => {
    const auth = makeAuth({ checkpointFails: true });
    const { executor, log } = make([{ stdout: message("ok") }], {}, auth);
    await expect(executor.invoke(base)).rejects.toMatchObject({ category: "checkpoint_uncertain" });
    await expect(executor.invoke(base)).rejects.toBeInstanceOf(CodexRecoveryRequiredError);
    expect(log).toHaveLength(1);
  });
});

describe("publication credential guard", () => {
  const tokenized = "https://x-access-token:synthetic-write-token@github.com/acme/app.git";
  const originOf = (): string => execFileSync("git", ["remote", "get-url", "origin"], { cwd: workspace, encoding: "utf-8" }).trim();

  beforeEach(() => {
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["remote", "add", "origin", tokenized], { cwd: workspace });
  });

  const guarded = (scripts: Script[], extra: Partial<CodexExecutorOptions> = {}, seen?: string[]) => {
    const auth = makeAuth();
    const log: Spawned[] = [];
    const executor = new CodexExecutor(workspace, {
      auth: auth.client,
      profileId: "p",
      spawnImpl: makeSpawn(scripts, log, () => seen?.push(originOf())),
      sleepImpl: async () => {},
      termWaitMs: 30,
      killWaitMs: 30,
      ...extra,
    });
    return { executor, log };
  };

  it("strips the credential during the run and restores it on success", async () => {
    const seen: string[] = [];
    const { executor } = guarded([{ stdout: message("ok") }], {}, seen);
    await executor.invoke(base);
    expect(seen).toEqual(["https://github.com/acme/app.git"]);
    expect(originOf()).toBe(tokenized);
  });

  it("restores on failure, timeout and cancel", async () => {
    await guarded([{ exitCode: 1, stderr: "boom" }]).executor.invoke(base);
    expect(originOf()).toBe(tokenized);
    // Frozen clock: real startup delay must not consume the 10 ms budget before spawn.
    await guarded([{ hang: true, dieOn: ["SIGTERM"] }], { nowImpl: () => 0 }).executor.invoke({ ...base, invocationTimeoutMs: 10 });
    expect(originOf()).toBe(tokenized);
    const ac = new AbortController();
    ac.abort();
    await guarded([{ hang: true, dieOn: ["SIGTERM"] }], { cancelSignal: ac.signal }).executor.invoke(base);
    expect(originOf()).toBe(tokenized);
  });

  it("restores after a spawn failure", async () => {
    const { executor } = guarded([{ error: Object.assign(new Error("x"), { code: "ENOENT" }) }]);
    await expect(executor.invoke(base)).rejects.toBeDefined();
    expect(originOf()).toBe(tokenized);
  });

  it("leaves the origin protected when the child cannot be proven stopped", async () => {
    const { executor } = guarded([{ hang: true, dieOn: [] }], { nowImpl: () => 0 });
    await expect(executor.invoke({ ...base, invocationTimeoutMs: 10 })).rejects.toBeInstanceOf(CodexRecoveryRequiredError);
    expect(originOf()).toBe("https://github.com/acme/app.git");
  });

  it("does not touch the origin when repository writes are allowed", async () => {
    const seen: string[] = [];
    const { executor } = guarded([{ stdout: message("ok") }], { allowRepositoryWrites: true }, seen);
    await executor.invoke(base);
    expect(seen).toEqual([tokenized]);
  });

  it("marks guard failures notASpawnFailure and spawns nothing", async () => {
    writeFileLock();
    const { executor, log } = guarded([{ stdout: message("ok") }]);
    await expect(executor.invoke(base)).rejects.toMatchObject({ notASpawnFailure: true });
    expect(log).toHaveLength(0);
  });

  function writeFileLock(): void {
    execFileSync("touch", [join(workspace, ".git", "config.lock")]);
    expect(readFileSync(join(workspace, ".git", "config.lock"), "utf-8")).toBe("");
  }
});

const SHELL_POLICY = `shell_environment_policy.exclude=${JSON.stringify(CODEX_SHELL_ENV_EXCLUDE)}`;

describe("shell environment exclude list (AII-1193)", () => {
  it("names exactly the credential variables, in order", () => {
    expect([...CODEX_SHELL_ENV_EXCLUDE]).toEqual(["CODEX_API_KEY", "CODEX_HOME", "CHATGPT_PLAN_ACCESS_TOKEN", "OPENAI_API_KEY", "OPENAI_BASE_URL"]);
  });
});

describe("default exec path is unchanged (AII-1001)", () => {
  it("passes the exact pinned exec argv and never selects the app-server transport", async () => {
    const { executor, log } = make([{ stdout: message("done") }]);
    await executor.invoke({ ...base, builtinTools: ["Read"] });
    expect(log[0].cmd).toBe("codex");
    expect(log[0].args).toEqual([
      "exec", "--json", "--ignore-user-config", "--ignore-rules", "--model", "gpt-synthetic", "-c", 'model_provider="openai"', "-c", SHELL_POLICY, "--sandbox", "read-only", "-",
    ]);
    expect(log[0].args.indexOf(SHELL_POLICY)).toBeGreaterThan(log[0].args.indexOf("--ignore-rules"));
    expect(log[0].args.join(" ")).not.toContain("inherit");
  });
});

describe("protocol driver seam (AII-1001)", () => {
  const okTransport = (over: Partial<CodexTransportResult> = {}): CodexTransportResult => ({
    result: {
      stdout: "plan",
      stderr: "",
      exitCode: 0,
      tokensUsed: 0,
      telemetry: { outcome: "success", numTurns: null, durationMs: null, costUsd: null, tokensIn: null, tokensOut: null },
      terminalStatus: { subtype: "success", isError: false },
      signal: null,
    },
    sawUnsafe: false,
    stopReason: null,
    ...over,
  });

  function withDriver(
    scripts: Script[],
    run: CodexProtocolDriver["run"],
    extra: Partial<CodexExecutorOptions> = {},
    auth = makeAuth(),
  ) {
    return make(scripts, { protocolDriver: { run }, ...extra }, auth);
  }

  it("builds trusted app-server argv, hands the driver streams only, and terminates the group after completion", async () => {
    let input: CodexTransportRunInput | undefined;
    const { executor, log, auth } = withDriver([{ hang: true, dieOn: ["SIGTERM"] }], async (i) => {
      input = i;
      return okTransport();
    });
    const result = await executor.invoke({ ...base, jsonSchema: VERDICT_SCHEMA });
    expect(result.stdout).toBe("plan");
    expect(result.failure).toBeUndefined();
    expect(log[0].args).toEqual([
      "app-server", "--strict-config",
      "-c", 'model="gpt-synthetic"',
      "-c", 'model_provider="openai"',
      "-c", 'approval_policy="never"',
      "-c", 'sandbox_mode="read-only"',
      "-c", "features.shell_tool=false",
      "-c", "features.view_image=false",
      "-c", "features.multi_agent=false",
      "-c", "agents.enabled=false",
      "-c", "features.goals=false",
      "-c", "features.unified_exec=false",
      "-c", 'web_search="disabled"',
      "-c", SHELL_POLICY,
    ]);
    expect(log[0].args).not.toContain("exec");
    expect(log[0].args).not.toContain("--ignore-user-config");
    expect(log[0].args).not.toContain("--ignore-rules");
    expect(log[0].args).not.toContain("do the thing");
    expect(log[0].stdin).toBe("");
    expect(log[0].signals).toEqual(["SIGTERM"]);
    expect(Object.keys(input!.io).sort()).toEqual(["halt", "stdin", "stdout"]);
    expect(input!.prompt).toBe("do the thing");
    expect(input!.redact(`x ${SYNTHETIC_KEY} y`)).toBe("x [redacted] y");
    // checkpoint happens only after the child was proven stopped
    expect(auth.events).toEqual(["invoke:profile-1", "checkpoint"]);
  });

  it("never settles the auth callback when the child outlives the completed turn", async () => {
    // A child that may still be live keeps its view under the OS temp directory.
    testTempRoot("codex-view");
    const { executor, auth } = withDriver([{ hang: true, dieOn: [] }], async () => okTransport());
    await expect(executor.invoke(base)).rejects.toBeInstanceOf(CodexRecoveryRequiredError);
    expect(auth.events).toEqual(["invoke:profile-1"]);
    await expect(executor.invoke(base)).rejects.toMatchObject({ reason: "held" });
  });

  it("never retries an unsafe transport outcome even when it classifies transient", async () => {
    let runs = 0;
    const { executor, log } = withDriver([{ hang: true, dieOn: ["SIGTERM"] }], async () => {
      runs++;
      const t = okTransport({ sawUnsafe: true });
      return { ...t, result: { ...t.result, exitCode: 1, stderr: "rate limit exceeded 429", terminalStatus: { subtype: "error", isError: true } } };
    });
    const result = await executor.invoke({ ...base, ...retry });
    expect(result.failure).toBeDefined();
    expect(runs).toBe(1);
    expect(log).toHaveLength(1);
  });

  it("lets the executor own timeout and aborts the driver's halt signal", async () => {
    let halted = false;
    const { executor, log } = withDriver([{ hang: true, dieOn: ["SIGTERM"] }], (i) => {
      return new Promise((resolve) => {
        i.io.halt.addEventListener("abort", () => {
          halted = true;
          resolve(okTransport({ result: { ...okTransport().result, exitCode: 1, terminalStatus: { subtype: "error", isError: true } } }));
        });
      });
    });
    const result = await executor.invoke({ ...base, invocationTimeoutMs: 20 });
    expect(halted).toBe(true);
    expect(result.failure?.code).toBe("INVOCATION_TIMEOUT");
    expect(log[0].signals).toContain("SIGTERM");
  });

  it("lets the executor own cancellation", async () => {
    const ctl = new AbortController();
    const { executor } = withDriver(
      [{ hang: true, dieOn: ["SIGTERM"] }],
      (i) => new Promise((resolve) => i.io.halt.addEventListener("abort", () => resolve(okTransport({ sawUnsafe: false })))),
      { cancelSignal: ctl.signal },
    );
    setTimeout(() => ctl.abort(), 10);
    const result = await executor.invoke(base);
    expect(result.failure?.code).toBe("INVOCATION_CANCELLED");
  });

  it("routes a driver-reported stdin failure through the spawn rail", async () => {
    const { executor } = withDriver([{ hang: true, dieOn: ["SIGTERM"] }], async () => okTransport({ stopReason: "stdin" }));
    await expect(executor.invoke(base)).rejects.toMatchObject({ codexSpawnFailure: true });
  });

  it("validates structured output from the driver against the schema", async () => {
    const t = okTransport();
    const { executor } = withDriver([{ hang: true, dieOn: ["SIGTERM"] }], async () => ({
      ...t,
      result: { ...t.result, stdout: '{"approved":"yes"}', structuredOutput: { approved: "yes", summary: "s" } },
    }));
    const result = await executor.invoke({ ...base, jsonSchema: VERDICT_SCHEMA, expectsStructuredOutput: true });
    expect(result.structuredOutput).toBeUndefined();
    expect(result.failure?.category).toBe("invalid_output");
  });

  it("redacts selected credentials from driver output and child stderr", async () => {
    const t = okTransport();
    const { executor } = withDriver([{ hang: true, dieOn: ["SIGTERM"], stderr: `leaked ${SYNTHETIC_KEY}` }], async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { ...t, result: { ...t.result, stdout: `out ${SYNTHETIC_KEY}` } };
    });
    const result = await executor.invoke(base);
    expect(result.stdout).not.toContain(SYNTHETIC_KEY);
    expect(result.stderr).not.toContain(SYNTHETIC_KEY);
  });

  it("converts a throwing driver into an unsafe, non-retried failure", async () => {
    const { executor, log } = withDriver([{ hang: true, dieOn: ["SIGTERM"] }], async () => {
      throw new Error("boom");
    });
    const result = await executor.invoke({ ...base, ...retry });
    expect(result.exitCode).toBe(1);
    expect(result.failure).toBeDefined();
    expect(log).toHaveLength(1);
  });
});

describe("app-server trusted view (AII-1002)", () => {
  const AUTH_ORIGINAL = '{"tokens":{"account_id":"acct-S","refresh_token":"original"}}';
  const viewDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith("codex-view-"));
  let selected: string;
  beforeEach(() => {
    selected = testDir("selected-home");
    writeFileSync(join(selected, "auth.json"), AUTH_ORIGINAL);
    writeFileSync(join(selected, "config.toml"), 'model_provider="evil"\n[mcp_servers.x]\ncommand="touch /tmp/sentinel"\n');
    mkdirSync(join(selected, "rules"));
  });

  const okResult = (): CodexTransportResult => ({
    result: {
      stdout: "plan",
      stderr: "",
      exitCode: 0,
      tokensUsed: 0,
      telemetry: { outcome: "success", numTurns: null, durationMs: null, costUsd: null, tokensIn: null, tokensOut: null },
      terminalStatus: { subtype: "success", isError: false },
      signal: null,
    },
    sawUnsafe: false,
    stopReason: null,
  });

  function run(scripts: Script[], log: Spawned[], driverRun: CodexProtocolDriver["run"], extra: Partial<CodexExecutorOptions> = {}) {
    const events: string[] = [];
    const auth: Pick<ModelAuthClient, "invoke"> = {
      async invoke<T>(_id: string, cb: (i: ModelInvocation) => Promise<T>): Promise<T> {
        const out = await cb({ env: { PATH: "/usr/bin", CODEX_HOME: selected }, strippedKeys: [] });
        events.push("checkpoint");
        return out;
      },
    };
    const executor = new CodexExecutor(workspace, {
      auth,
      profileId: "p1",
      allowRepositoryWrites: true,
      protocolDriver: { run: driverRun },
      spawnImpl: makeSpawn(scripts, log),
      sleepImpl: async () => {},
      termWaitMs: 30,
      killWaitMs: 30,
      ...extra,
    });
    return { executor, log, events };
  }

  it("spawns in a trusted empty cwd with a trusted CODEX_HOME holding only config, never the selected auth", async () => {
    let seen: { cwdFiles: string[]; cwd: string; home: string; files: string[]; config: string; input: CodexTransportRunInput } | undefined;
    const log: Spawned[] = [];
    const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, async (input) => {
      const home = log[0].env.CODEX_HOME;
      seen = {
        cwd: input.protocolCwd!,
        cwdFiles: readdirSync(input.protocolCwd!),
        home,
        files: readdirSync(home).sort(),
        config: readFileSync(join(home, "config.toml"), "utf8"),
        input,
      };
      return okResult();
    });
    // route the spawn log through the same array the driver reads
    await executor.invoke(base);
    expect(seen!.home).not.toBe(selected);
    expect(seen!.files).toEqual(["config.toml"]);
    expect(seen!.config).not.toContain("evil");
    expect(seen!.config).not.toContain("mcp_servers");
    expect(seen!.cwdFiles).toEqual([]);
    // HOME is a trusted empty dir inside the view, never the selected HOME
    expect(log[0].env.HOME).toBe(join(dirname(seen!.home), "user-home"));
    expect(seen!.input.workspaceDir).toBe(workspace);
    expect(seen!.input.protocolCwd).not.toBe(workspace);
    expect(seen!.input.forbiddenRoots).toEqual(expect.arrayContaining([selected, seen!.home]));
    expect(log[0].cwd).toBe(seen!.cwd);
    // normal path removes the view
    expect(existsSync(seen!.home)).toBe(false);
  });

  describe("trusted skills in the view HOME", () => {
    const mkSkills = (): string => {
      const dir = testDir("synthetic-skills");
      mkdirSync(join(dir, "a", "refs"), { recursive: true });
      writeFileSync(join(dir, "a", "SKILL.md"), "synthetic skill a");
      writeFileSync(join(dir, "a", "refs", "r.md"), "ref");
      return dir;
    };
    // Kept only for "removes the view on timeout with skills present", which AII-1447 changes upstream.
    const cleanup = (d: string) => {
      const walk = (p: string) => {
        try {
          chmodSync(p, 0o700);
          for (const n of readdirSync(p)) walk(join(p, n));
        } catch {
          // file or gone
        }
      };
      walk(d);
      rmSync(d, { recursive: true, force: true });
    };

    it("copies the skills read-only, logs a count, and removes the view afterward", async () => {
      const skills = mkSkills();
      const outside = testDir("synthetic-outside");
      writeFileSync(join(outside, "secret.txt"), "outside-content");
      symlinkSync(join(outside, "secret.txt"), join(skills, "a", "link-file"));
      symlinkSync(outside, join(skills, "a", "link-dir"));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      let seen: { content: string; fileMode: number; dirMode: number; nestedMode: number; names: string[]; leaked: boolean; root: string } | undefined;
      const log: Spawned[] = [];
      const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, async () => {
        const dest = join(log[0].env.HOME, ".agents", "skills");
        let leaked = false;
        for (const l of ["link-file", "link-dir"]) {
          try {
            readFileSync(join(dest, "a", l, l === "link-dir" ? "secret.txt" : ""), "utf8");
            leaked = true;
          } catch {
            // not readable through the copy
          }
        }
        seen = {
          content: readFileSync(join(dest, "a", "SKILL.md"), "utf8"),
          fileMode: statSync(join(dest, "a", "SKILL.md")).mode & 0o777,
          dirMode: statSync(dest).mode & 0o777,
          nestedMode: statSync(join(dest, "a", "refs")).mode & 0o777,
          names: readdirSync(log[0].env.HOME),
          leaked,
          root: dirname(log[0].env.HOME),
        };
        return okResult();
      }, { trustedSkillsDir: skills });
      try {
        await executor.invoke(base);
        expect(seen!.content).toBe("synthetic skill a");
        expect(seen!.fileMode).toBe(0o444);
        expect(seen!.dirMode).toBe(0o555);
        expect(seen!.nestedMode).toBe(0o555);
        expect(seen!.names).toEqual([".agents"]);
        expect(seen!.leaked).toBe(false);
        expect(logSpy.mock.calls.filter((c) => String(c[0]).includes("app-server skills copied="))).toEqual([["[codex] app-server skills copied=1"]]);
        expect(existsSync(seen!.root)).toBe(false);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("leaves HOME empty when unset, and when the directory is missing", async () => {
      for (const extra of [{}, { trustedSkillsDir: join(testDir("synthetic-skills"), "missing") }]) {
        let names: string[] | undefined;
        const log: Spawned[] = [];
        const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, async () => {
          names = readdirSync(log[0].env.HOME);
          return okResult();
        }, extra);
        await executor.invoke(base);
        expect(names).toEqual([]);
      }
    });

    it("fails before spawn, value-free, for a directory in the workspace, selected home or view", async () => {
      const inWorkspace = join(workspace, ".agents", "skills");
      mkdirSync(inWorkspace, { recursive: true });
      writeFileSync(join(inWorkspace, "SKILL.md"), "synthetic-secret-content");
      const inSelected = join(selected, "skills");
      mkdirSync(inSelected, { recursive: true });
      const viaDots = join(workspace, "..", basename(workspace), ".agents", "skills");
      for (const dir of [inWorkspace, inSelected, viaDots]) {
        const log: Spawned[] = [];
        const driver = vi.fn(async () => okResult());
        const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, driver, { trustedSkillsDir: dir });
        const err = await executor.invoke(base).then(() => null, (e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect(log.length).toBe(0);
        expect(driver).not.toHaveBeenCalled();
        expect(String(err!.message)).not.toContain(dir);
        expect(String(err!.message)).not.toContain("synthetic-secret-content");
      }
    });

    it("fails before spawn for a symlink that resolves into the workspace or selected home", async () => {
      const inWorkspace = join(workspace, ".agents", "skills");
      mkdirSync(inWorkspace, { recursive: true });
      writeFileSync(join(inWorkspace, "SKILL.md"), "synthetic-secret-content");
      const inSelected = join(selected, "skills");
      mkdirSync(inSelected, { recursive: true });
      const holder = testDir("synthetic-links");
      for (const [i, target] of [inWorkspace, inSelected].entries()) {
        const link = join(holder, `link-${i}`);
        symlinkSync(target, link);
        const log: Spawned[] = [];
        const driver = vi.fn(async () => okResult());
        const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, driver, { trustedSkillsDir: link });
        const err = await executor.invoke(base).then(() => null, (e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect(log.length).toBe(0);
        expect(driver).not.toHaveBeenCalled();
        for (const leak of [link, target, "synthetic-secret-content"]) expect(String(err!.message)).not.toContain(leak);
      }
    });

    it("removes the view on timeout with skills present", async () => {
      const skills = mkSkills();
      const log: Spawned[] = [];
      let root = "";
      const halting: CodexProtocolDriver["run"] = (i) => {
        root = dirname(log[0].env.HOME);
        return new Promise((resolve) => i.io.halt.addEventListener("abort", () => resolve({ ...okResult(), stopReason: null })));
      };
      const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, halting, { trustedSkillsDir: skills });
      try {
        const result = await executor.invoke({ ...base, invocationTimeoutMs: 20 });
        expect(result.failure?.code).toBe("INVOCATION_TIMEOUT");
        expect(root).not.toBe("");
        expect(existsSync(root)).toBe(false);
      } finally {
        cleanup(skills);
      }
    });

    it("removes the view when the spawn fails with skills present", async () => {
      const skills = mkSkills();
      const before = new Set(viewDirs());
      const { executor } = run([{ error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }) }], [], async () => okResult(), { trustedSkillsDir: skills });
      await executor.invoke(base).catch(() => undefined);
      expect(viewDirs().filter((n) => !before.has(n))).toEqual([]);
    });

    it("removes the view on a cancel path with skills present", async () => {
      const skills = mkSkills();
      const ctl = new AbortController();
      const log: Spawned[] = [];
      let root = "";
      const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, async () => {
        root = dirname(log[0].env.HOME);
        ctl.abort();
        return okResult();
      }, { trustedSkillsDir: skills, cancelSignal: ctl.signal });
      await executor.invoke(base).catch(() => undefined);
      expect(root).not.toBe("");
      expect(existsSync(root)).toBe(false);
    });
  });

  it("directs the provider only through the selected invoke env's OPENAI_BASE_URL, never selected-home config", async () => {
    const log: Spawned[] = [];
    const auth: Pick<ModelAuthClient, "invoke"> = {
      invoke: async (_id, cb) => cb({ env: { PATH: "/usr/bin", CODEX_HOME: selected, OPENAI_BASE_URL: "http://127.0.0.1:4010/v1" }, strippedKeys: [] }),
    };
    let config = "";
    const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, async () => {
      config = readFileSync(join(log[0].env.CODEX_HOME, "config.toml"), "utf8");
      return okResult();
    }, { auth });
    await executor.invoke(base);
    expect(config).toContain('openai_base_url = "http://127.0.0.1:4010/v1"');
    expect(config).not.toContain("evil");
  });

  it("keeps the view while the child may live, and still blocks a second invoke", async () => {
    testTempRoot("codex-view");
    const before = new Set(viewDirs());
    const log: Spawned[] = [];
    const { executor } = run([{ hang: true, dieOn: [] }], log, async () => {
      return okResult();
    });
    await expect(executor.invoke(base)).rejects.toBeInstanceOf(CodexRecoveryRequiredError);
    const left = viewDirs().filter((n) => !before.has(n));
    expect(left).toHaveLength(1);
    await expect(executor.invoke(base)).rejects.toMatchObject({ reason: "held" });
    expect(viewDirs().filter((n) => !before.has(n))).toEqual(left);
  });

  it("removes the view on timeout and cancel", async () => {
    const before = new Set(viewDirs());
    const halting: CodexProtocolDriver["run"] = (i) =>
      new Promise((resolve) => i.io.halt.addEventListener("abort", () => resolve({ ...okResult(), stopReason: null })));
    const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], [], halting);
    const result = await executor.invoke({ ...base, invocationTimeoutMs: 20 });
    expect(result.failure?.code).toBe("INVOCATION_TIMEOUT");
    expect(viewDirs().filter((n) => !before.has(n))).toEqual([]);
  });

  it("leaves the default exec path without a view", async () => {
    const before = new Set(viewDirs());
    const { executor, log } = make([{ stdout: message("done") }]);
    await executor.invoke(base);
    expect(log[0].args[0]).toBe("exec");
    expect(viewDirs().filter((n) => !before.has(n))).toEqual([]);
  });
});

describe("invocation deadline across attempts", () => {
  const bigBackoff = { retry: { policy: { ...DEFAULT_RETRY_POLICY, requestRetries: 3, backoffInitialMs: 10_000, backoffMaxMs: 60_000 }, toolUseIsSafe: false } };
  const transientResult: Script = { exitCode: 1, stderr: "stream error: 503 service unavailable", stdout: [ev({ type: "turn.started" }), ev({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } })] };

  function clocked(scripts: Script[], opts: { schedulingDelayMs?: number } = {}) {
    let t = 1_000;
    const auth = makeAuth();
    const inner = auth.client.invoke.bind(auth.client);
    const client: Pick<ModelAuthClient, "invoke"> = {
      invoke: (async (profileId: string, run: (i: ModelInvocation) => Promise<unknown>) => {
        t += opts.schedulingDelayMs ?? 0;
        return inner(profileId, run);
      }) as ModelAuthClient["invoke"],
    };
    const slept: number[] = [];
    const made = make(scripts, { nowImpl: () => t, sleepImpl: async (ms) => void ((t += ms), slept.push(ms)) }, { ...auth, client });
    return { ...made, slept, auth, clock: () => t };
  }

  it("bounds an oversized result-retry backoff by the remaining budget and spawns no extra child", async () => {
    const { executor, log, slept, auth, clock } = clocked([transientResult, { stdout: message("late") }]);
    const result = await executor.invoke({ ...base, ...bigBackoff, invocationTimeoutMs: 100 });
    expect(result.failure).toMatchObject({ code: "INVOCATION_TIMEOUT", retryable: false });
    expect(log).toHaveLength(1);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeLessThanOrEqual(100);
    expect(clock() - 1_000).toBeLessThanOrEqual(100);
    // Accumulated telemetry from the first attempt survives the timeout result.
    expect(result.telemetry).toMatchObject({ tokensIn: 4, tokensOut: 2 });
    expect(auth.events.filter((e) => e.startsWith("invoke:"))).toHaveLength(1);
    expect(auth.events.filter((e) => e === "checkpoint")).toHaveLength(1);
  });

  it("bounds an oversized spawn-error backoff and does not spawn again", async () => {
    const eagain = Object.assign(new Error("spawn codex EAGAIN"), { code: "EAGAIN" });
    const { executor, log, slept } = clocked([{ error: eagain }, { stdout: message("late") }]);
    const result = await executor.invoke({ ...base, ...bigBackoff, invocationTimeoutMs: 100 });
    expect(result.failure).toMatchObject({ code: "INVOCATION_TIMEOUT" });
    expect(log).toHaveLength(1);
    expect(slept[0]).toBeLessThanOrEqual(100);
  });

  it("does not spawn when scheduling delay consumed the budget, and releases auth only through the checkpoint", async () => {
    const { executor, log, auth } = clocked([{ stdout: message("never") }], { schedulingDelayMs: 500 });
    const result = await executor.invoke({ ...base, invocationTimeoutMs: 100 });
    expect(result.failure).toMatchObject({ code: "INVOCATION_TIMEOUT" });
    expect(log).toHaveLength(0);
    expect(auth.events).toEqual(["invoke:profile-1", "checkpoint"]);
  });

  it("does not acquire auth for a retry attempt whose budget expired during scheduling", async () => {
    let t = 1_000;
    const auth = makeAuth();
    const { executor, log } = make(
      [transientResult, { stdout: message("never") }],
      { nowImpl: () => t, sleepImpl: async (ms) => void (t += ms + 1_000) },
      auth,
    );
    const result = await executor.invoke({ ...base, ...bigBackoff, invocationTimeoutMs: 100 });
    expect(result.failure).toMatchObject({ code: "INVOCATION_TIMEOUT" });
    expect(log).toHaveLength(1);
    expect(auth.events.filter((e) => e.startsWith("invoke:"))).toHaveLength(1);
  });

  it("never spawns with a zero or negative timeout", async () => {
    const { executor, log, auth } = clocked([{ stdout: message("never") }]);
    const result = await executor.invoke({ ...base, invocationTimeoutMs: 0 });
    expect(result.failure).toMatchObject({ code: "INVOCATION_TIMEOUT" });
    expect(log).toHaveLength(0);
    expect(auth.events).toEqual([]);
  });
});

describe("ChatGPT plan provider", () => {
  const TOKEN = "chatgpt-plan-synthetic-token";
  const PAIRS = [
    'model_provider="chatgpt_plan"',
    'model_providers.chatgpt_plan.name="ChatGPT plan"',
    'model_providers.chatgpt_plan.base_url="https://api.openai.com/v1"',
    'model_providers.chatgpt_plan.env_key="CHATGPT_PLAN_ACCESS_TOKEN"',
    'model_providers.chatgpt_plan.wire_api="responses"',
    "model_providers.chatgpt_plan.requires_openai_auth=false",
    "model_providers.chatgpt_plan.supports_websockets=false",
  ];
  let selected: string;
  let calls: Array<{ opts: unknown }>;
  beforeEach(() => {
    selected = testDir("selected-home");
    writeFileSync(join(selected, "auth.json"), '{"tokens":{"account_id":"acct-S","refresh_token":"original"}}');
    calls = [];
  });

  const planAuth = (provider: boolean): Pick<ModelAuthClient, "invoke"> => ({
    async invoke<T>(_id: string, cb: (i: ModelInvocation) => Promise<T>, opts?: unknown): Promise<T> {
      calls.push({ opts });
      return cb({
        env: { PATH: "/usr/bin", CODEX_HOME: selected, CHATGPT_PLAN_ACCESS_TOKEN: TOKEN, OPENAI_BASE_URL: "http://local-feedback-provider:8080/v1" },
        strippedKeys: [],
        ...(provider ? { codexProvider: "chatgpt-plan" as const } : {}),
      });
    },
  });
  const build = (provider: boolean, scripts: Script[], extra: Partial<CodexExecutorOptions> = {}) => {
    const log: Spawned[] = [];
    const executor = new CodexExecutor(workspace, {
      auth: planAuth(provider),
      profileId: "p1",
      allowRepositoryWrites: true,
      spawnImpl: makeSpawn(scripts, log),
      sleepImpl: async () => {},
      termWaitMs: 30,
      killWaitMs: 30,
      ...extra,
    });
    return { executor, log };
  };
  const okDriver = (): CodexTransportResult => ({
    result: {
      stdout: "plan",
      stderr: "",
      exitCode: 0,
      tokensUsed: 0,
      telemetry: { outcome: "success", numTurns: null, durationMs: null, costUsd: null, tokensIn: null, tokensOut: null },
      terminalStatus: { subtype: "success", isError: false },
      signal: null,
    },
    sawUnsafe: false,
    stopReason: null,
  });

  it("returns the seven pairs from the helper", () => {
    const args = chatgptPlanProviderArgs();
    expect(args.filter((a) => a === "-c")).toHaveLength(7);
    expect(args.filter((a) => a !== "-c")).toEqual(PAIRS);
    expect(CHATGPT_PLAN_PROVIDER).toBe("chatgpt_plan");
  });

  it("exec: uses the pairs after the ignore flags, no openai provider and no openai_base_url", async () => {
    const { executor, log } = build(true, [{ stdout: message("done") }]);
    await executor.invoke(base);
    const args = log[0].args;
    const flat = PAIRS.flatMap((p) => ["-c", p]);
    const at = args.findIndex((a, i) => a === flat[0] && args[i + 1] === flat[1]);
    expect(at).toBeGreaterThan(args.indexOf("--ignore-rules"));
    expect(args.slice(at, at + flat.length)).toEqual(flat);
    expect(args).not.toContain('model_provider="openai"');
    expect(args.some((a) => a.startsWith("openai_base_url"))).toBe(false);
    expect(args).toContain(`shell_environment_policy.exclude=${JSON.stringify(CODEX_SHELL_ENV_EXCLUDE)}`);
  });

  it("exec: keeps the openai provider when the invocation has no codexProvider", async () => {
    const { executor, log } = build(false, [{ stdout: message("done") }]);
    await executor.invoke(base);
    expect(log[0].args).toContain('model_provider="openai"');
    expect(log[0].args.some((a) => a.includes("chatgpt_plan"))).toBe(false);
  });

  it("app-server: carries the pairs, writes the provider table, copies no auth.json and never syncs back", async () => {
    const log: Spawned[] = [];
    let seen: { files: string[]; config: string; input: CodexTransportRunInput } | undefined;
    const original = readFileSync(join(selected, "auth.json"), "utf8");
    const { executor } = {
      executor: new CodexExecutor(workspace, {
        auth: planAuth(true),
        profileId: "p1",
        allowRepositoryWrites: true,
        protocolDriver: {
          run: async (input) => {
            const home = log[0].env.CODEX_HOME;
            seen = { files: readdirSync(home).sort(), config: readFileSync(join(home, "config.toml"), "utf8"), input };
            return okDriver();
          },
        },
        spawnImpl: makeSpawn([{ hang: true, dieOn: ["SIGTERM"] }], log),
        sleepImpl: async () => {},
        termWaitMs: 30,
        killWaitMs: 30,
      }),
    };
    await executor.invoke(base);
    const flat = PAIRS.flatMap((p) => ["-c", p]);
    const args = log[0].args;
    const at = args.indexOf(flat[1]);
    expect(args.slice(at - 1, at - 1 + flat.length)).toEqual(flat);
    expect(args).not.toContain('model_provider="openai"');
    expect(args).toContain("--strict-config");
    expect(args).toContain(`shell_environment_policy.exclude=${JSON.stringify(CODEX_SHELL_ENV_EXCLUDE)}`);
    expect(seen!.files).toEqual(["config.toml"]);
    const parsed = parseToml(seen!.config) as { model_provider?: string; model_providers?: Record<string, Record<string, unknown>> };
    expect(parsed.model_provider).toBe("chatgpt_plan");
    expect(parsed.model_providers?.chatgpt_plan).toMatchObject({
      name: "ChatGPT plan",
      base_url: "https://api.openai.com/v1",
      env_key: "CHATGPT_PLAN_ACCESS_TOKEN",
      wire_api: "responses",
      requires_openai_auth: false,
      supports_websockets: false,
    });
    expect(seen!.config).toContain('model_provider = "chatgpt_plan"');
    expect(seen!.config).toContain("[model_providers.chatgpt_plan]");
    expect(seen!.config).toContain('env_key = "CHATGPT_PLAN_ACCESS_TOKEN"');
    expect(seen!.config).toContain("requires_openai_auth = false");
    expect(seen!.config).not.toContain("openai_base_url");
    expect(seen!.input.modelProvider).toBe("chatgpt_plan");
    expect(readFileSync(join(selected, "auth.json"), "utf8")).toBe(original);
  });

  it("exec: leaves the sessions directory in place while a child may still be alive", async () => {
    testTempRoot("codex-sessions");
    const { executor, log } = build(true, [{ hang: true, dieOn: [] }]);
    await expect(executor.invoke({ ...base, invocationTimeoutMs: 10 })).rejects.toMatchObject({ reason: "child_not_terminated" });
    const home = log[0].env.CODEX_HOME;
    expect(home).not.toBe(selected);
    expect(existsSync(home)).toBe(true);
  });

  it("passes requiredMs to auth.invoke: the remaining deadline, or the invocation timeout", async () => {
    let t = 1_000;
    const { executor } = build(true, [{ stdout: message("done") }], { nowImpl: () => t });
    await executor.invoke({ ...base, invocationTimeoutMs: 60_000 });
    expect(calls[0].opts).toEqual({ requiredMs: 60_000 });
  });

  it("passes a strictly smaller requiredMs to a retry attempt after the clock advances", async () => {
    let t = 1_000;
    const transient: Script = {
      exitCode: 1,
      stderr: "stream error: 503 service unavailable",
      stdout: [ev({ type: "turn.started" }), ev({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })],
    };
    const { executor } = build(true, [transient, { stdout: message("done") }], {
      nowImpl: () => t,
      sleepImpl: async (ms) => void (t += ms + 5_000),
    });
    const result = await executor.invoke({
      ...base,
      invocationTimeoutMs: 60_000,
      retry: { policy: { ...DEFAULT_RETRY_POLICY, requestRetries: 2, backoffInitialMs: 10, backoffMaxMs: 10 }, toolUseIsSafe: false },
    });
    expect(result.failure).toBeUndefined();
    expect(calls).toHaveLength(2);
    const [first, second] = calls.map((c) => (c.opts as { requiredMs: number }).requiredMs);
    expect(first).toBe(60_000);
    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThan(first);
  });

  it("passes no requiredMs when there is neither a deadline nor an invocation timeout", async () => {
    const { executor } = build(true, [{ stdout: message("done") }]);
    await executor.invoke(base);
    expect(calls[0].opts).toBeUndefined();
  });
});

describe("ChatGPT plan token expiry resume", () => {
  const CONTINUE = "Continue the task from where you stopped. Your previous turn ended because a credential expired.";
  const expired = (usage = true): string[] => [
    ev({ type: "thread.started", thread_id: "t1" }),
    ev({ type: "turn.started" }),
    ...(usage ? [ev({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } })] : []),
    ev({ type: "error", message: "unexpected status 401 Unauthorized: token expired" }),
  ];
  const expiredNoThread = (): string[] => [ev({ type: "turn.started" }), ev({ type: "error", message: "unexpected status 401 Unauthorized" })];
  let tokenN: number;
  let calls: Array<{ opts: unknown; token: string }>;
  let t: number;
  beforeEach(() => {
    tokenN = 0;
    calls = [];
    t = 1_000;
  });

  const makePlan = (scripts: Script[], opts: { provider?: boolean; advanceMs?: number } & Partial<CodexExecutorOptions> = {}) => {
    const { provider = true, advanceMs = 0, ...extra } = opts;
    const log: Spawned[] = [];
    const auth: Pick<ModelAuthClient, "invoke"> = {
      async invoke<T>(_id: string, cb: (i: ModelInvocation) => Promise<T>, o?: unknown): Promise<T> {
        const token = `plan-token-${++tokenN}-synthetic`;
        calls.push({ opts: o, token });
        try {
          return await cb({ env: { PATH: "/usr/bin", CHATGPT_PLAN_ACCESS_TOKEN: token }, strippedKeys: [], ...(provider ? { codexProvider: "chatgpt-plan" as const } : {}) });
        } finally {
          t += advanceMs;
        }
      },
    };
    const executor = new CodexExecutor(workspace, {
      auth,
      profileId: "p1",
      allowRepositoryWrites: true,
      spawnImpl: makeSpawn(scripts, log),
      sleepImpl: async () => {},
      nowImpl: () => t,
      termWaitMs: 30,
      killWaitMs: 30,
      ...extra,
    });
    return { executor, log };
  };

  it("success: returns without a renewal or resume", async () => {
    const { executor, log } = makePlan([{ stdout: message("done") }]);
    const out = await executor.invoke({ ...base, invocationTimeoutMs: 60_000 });
    expect(out.failure).toBeUndefined();
    expect(log).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("401 with a thread id: renews with the remaining deadline and resumes the same thread", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const { executor, log } = makePlan([{ stdout: expired(), exitCode: 1 }, { stdout: message("finished") }], { advanceMs: 10_000 });
    const out = await executor.invoke({ ...base, agentStage: "implementation", invocationTimeoutMs: 60_000, jsonSchema: VERDICT_SCHEMA });
    expect(out.failure).toBeUndefined();
    expect(out.stdout).toBe("finished");
    expect(log).toHaveLength(2);
    expect(calls.map((c) => c.opts)).toEqual([{ requiredMs: 60_000 }, { requiredMs: 50_000 }]);
    expect(log[1].env.CHATGPT_PLAN_ACCESS_TOKEN).toBe(calls[1].token);
    // resumed argv
    const args = log[1].args;
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args.slice(-2)).toEqual(["t1", "-"]);
    expect(args).not.toContain("--sandbox");
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args).toContain("--json");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-synthetic");
    expect(args).toContain("--output-schema");
    expect(args).toContain(`shell_environment_policy.exclude=${JSON.stringify(CODEX_SHELL_ENV_EXCLUDE)}`);
    expect(args).toContain('model_provider="chatgpt_plan"');
    expect(args).not.toContain('model_provider="openai"');
    expect(log[1].stdin).toBe(CONTINUE);
    expect(log[0].stdin).toBe("do the thing");
    // usage summed
    expect(out.telemetry?.tokensIn).toBe(20);
    expect(out.telemetry?.tokensOut).toBe(10);
    expect(out.tokensUsed).toBe(30);
    expect(logs).toContain("[codex] token expired; resumed thread (1/2)");
    expect(logs.join("\n")).not.toContain("plan-token");
  });

  it("keeps one sessions CODEX_HOME across attempts and removes it afterwards", async () => {
    const { executor, log } = makePlan([{ stdout: expired(), exitCode: 1 }, { stdout: expired(), exitCode: 1 }, { stdout: message("ok") }]);
    let seen: boolean[] = [];
    const orig = log;
    await executor.invoke(base);
    const homes = orig.map((l) => l.env.CODEX_HOME);
    expect(homes[0]).toBeTruthy();
    expect(new Set(homes).size).toBe(1);
    seen = homes.map((h) => existsSync(h));
    expect(seen).toEqual([false, false, false]);
  });

  it("removes the sessions directory when the invocation fails", async () => {
    const { executor, log } = makePlan([{ stdout: ["{}"], exitCode: 1, stderr: "boom" }]);
    await executor.invoke(base);
    expect(existsSync(log[0].env.CODEX_HOME)).toBe(false);
  });

  it("401 after two resumes fails authentication_required without a third resume", async () => {
    const { executor, log } = makePlan([{ stdout: expired(), exitCode: 1 }]);
    const out = await executor.invoke({ ...base, invocationTimeoutMs: 60_000 });
    expect(log).toHaveLength(3);
    expect(calls).toHaveLength(3);
    expect(out.failure).toMatchObject({ category: "auth", code: "AUTHENTICATION_REQUIRED", retryable: false });
    expect(log[2].args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(out.telemetry?.tokensIn).toBe(30);
  });

  it("401 once the deadline is reached fails authentication_required and does not resume", async () => {
    const { executor, log } = makePlan([{ stdout: expired(), exitCode: 1 }], { advanceMs: 70_000 });
    const out = await executor.invoke({ ...base, invocationTimeoutMs: 60_000 });
    expect(log).toHaveLength(1);
    expect(out.failure).toMatchObject({ category: "auth", code: "AUTHENTICATION_REQUIRED" });
  });

  it("401 without a thread id renews and starts a fresh attempt under the retry rules", async () => {
    const { executor, log } = makePlan([{ stdout: expiredNoThread(), exitCode: 1 }, { stdout: message("fresh") }]);
    const out = await executor.invoke({ ...base, ...retry });
    expect(out.failure).toBeUndefined();
    expect(log).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(log[1].args).not.toContain("resume");
    expect(log[1].stdin).toBe("do the thing");
  });

  it("401 without a thread id and no retry policy fails as an authentication failure", async () => {
    const { executor, log } = makePlan([{ stdout: expiredNoThread(), exitCode: 1 }]);
    const out = await executor.invoke(base);
    expect(log).toHaveLength(1);
    expect(out.failure).toMatchObject({ category: "auth", code: "AUTHENTICATION_REQUIRED" });
  });

  it("401 with an API key provider fails as today: no renewal, no resume", async () => {
    const { executor, log } = makePlan([{ stdout: expired(), exitCode: 1 }], { provider: false });
    const out = await executor.invoke({ ...base, ...retry });
    expect(log).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(out.failure?.code).not.toBe("AUTHENTICATION_REQUIRED");
    expect(log[0].args).not.toContain("resume");
  });

  it("other failures keep the existing behavior: no resume", async () => {
    const { executor, log } = makePlan([{ stdout: [ev({ type: "thread.started", thread_id: "t1" }), ev({ type: "turn.started" }), ev({ type: "error", message: "model exploded" })], exitCode: 1 }]);
    const out = await executor.invoke(base);
    expect(log).toHaveLength(1);
    expect(log[0].args).not.toContain("resume");
    expect(out.failure).toBeDefined();
  });

  it("derives the resume sandbox from the stage policy", async () => {
    for (const [agentStage, mode] of [["implementation", "workspace-write"]] as const) {
      const { executor, log } = makePlan([{ stdout: expired(), exitCode: 1 }, { stdout: message("ok") }]);
      await executor.invoke({ ...base, agentStage });
      expect(log[1].args).toContain(`sandbox_mode="${mode}"`);
      expect(log[1].args).not.toContain("--sandbox");
    }
    const { executor, log } = makePlan([{ stdout: expired(), exitCode: 1 }, { stdout: message("ok") }]);
    await executor.invoke({ ...base, builtinTools: ["Read"] });
    expect(log[1].args).toContain('sandbox_mode="read-only"');
  });

  describe("app-server", () => {
    const result = (over: Partial<CodexTransportResult> & { tokens?: [number, number] } = {}): CodexTransportResult => {
      const { tokens: tk, ...rest } = over;
      return {
        result: {
          stdout: "plan",
          stderr: "",
          exitCode: 0,
          tokensUsed: 0,
          telemetry: { outcome: "success", numTurns: null, durationMs: null, costUsd: null, tokensIn: tk?.[0] ?? null, tokensOut: tk?.[1] ?? null },
          terminalStatus: { subtype: "success", isError: false },
          signal: null,
        },
        sawUnsafe: false,
        stopReason: null,
        ...rest,
      };
    };
    const expiredResult = (): CodexTransportResult => {
      const r = result({ tokens: [4, 2], tokenExpired: true, threadId: "th-1" });
      return { ...r, result: { ...r.result, exitCode: 1, terminalStatus: { subtype: "error", isError: true }, stderr: "codex app-server transport: turn_failed" } };
    };

    it("starts a new app-server with thread/resume input and the continue prompt, sums usage, keeps one home", async () => {
      const inputs: CodexTransportRunInput[] = [];
      const homes: string[] = [];
      const driver: CodexProtocolDriver = {
        run: async (i) => {
          inputs.push(i);
          return inputs.length === 1 ? expiredResult() : result({ tokens: [6, 3] });
        },
      };
      const { executor, log } = makePlan([{ hang: true, dieOn: ["SIGTERM"] }], { protocolDriver: driver });
      const out = await executor.invoke({ ...base, agentStage: "planning", invocationTimeoutMs: 60_000 });
      for (const l of log) homes.push(l.env.CODEX_HOME);
      expect(out.failure).toBeUndefined();
      expect(log).toHaveLength(2);
      expect(calls).toHaveLength(2);
      expect(inputs[0].resumeThreadId).toBeUndefined();
      expect(inputs[1].resumeThreadId).toBe("th-1");
      expect(inputs[1].prompt).toBe(CONTINUE);
      expect(inputs[1].modelProvider).toBe("chatgpt_plan");
      expect(log[1].args[0]).toBe("app-server");
      expect(new Set(homes).size).toBe(1);
      expect(existsSync(homes[0])).toBe(false);
      expect(out.telemetry?.tokensIn).toBe(10);
      expect(out.telemetry?.tokensOut).toBe(5);
    });

    it("populates a shared ChatGPT plan view with skills once: the second attempt keeps the copy and the view is removed", async () => {
      const skills = testDir("synthetic-skills");
      mkdirSync(join(skills, "a"), { recursive: true });
      writeFileSync(join(skills, "a", "SKILL.md"), "synthetic skill a");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const seen: string[] = [];
      const homes: string[] = [];
      const driver: CodexProtocolDriver = {
        run: async () => {
          const l = planned.log[planned.log.length - 1];
          homes.push(l.env.CODEX_HOME);
          seen.push(readFileSync(join(l.env.HOME, ".agents", "skills", "a", "SKILL.md"), "utf8"));
          return seen.length === 1 ? expiredResult() : result({ tokens: [6, 3] });
        },
      };
      const planned = makePlan([{ hang: true, dieOn: ["SIGTERM"] }], { protocolDriver: driver, trustedSkillsDir: skills });
      try {
        const out = await planned.executor.invoke({ ...base, agentStage: "planning", invocationTimeoutMs: 60_000 });
        expect(out.failure).toBeUndefined();
        expect(seen).toEqual(["synthetic skill a", "synthetic skill a"]);
        expect(new Set(homes).size).toBe(1);
        expect(existsSync(dirname(homes[0]))).toBe(false);
        expect(logSpy.mock.calls.filter((c) => String(c[0]).includes("app-server skills copied="))).toHaveLength(1);
      } finally {
        logSpy.mockRestore();
      }
    });

    it("does not treat a driver 401 as expiry for the API key provider", async () => {
      const driver: CodexProtocolDriver = { run: async () => expiredResult() };
      const { executor, log } = makePlan([{ hang: true, dieOn: ["SIGTERM"] }], { protocolDriver: driver, provider: false });
      const out = await executor.invoke({ ...base, agentStage: "planning" });
      expect(log).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(out.failure).toBeDefined();
    });
  });
});

describe("ephemeral full access (AII-1437)", () => {
  const FLAG = "--dangerously-bypass-approvals-and-sandbox";
  const admitted = { nonRoot: true, socketPresent: true, socketReadable: false, socketWritable: false, admitted: true };
  const full = (extra: Partial<CodexExecutorOptions> = {}): Partial<CodexExecutorOptions> => ({
    implementationFullAccess: true,
    fullAccessAdmission: () => admitted,
    ...extra,
  });
  const okDriver = (): CodexTransportResult => ({
    result: { stdout: "review", stderr: "", exitCode: 0, tokensUsed: 0, terminalStatus: { subtype: "success", isError: false }, signal: null },
    sawUnsafe: false,
    stopReason: null,
  });
  const reviewDriver = (): CodexProtocolDriver => ({ policy: "review", run: async () => okDriver() });
  const hasBypass = (args: string[]): boolean => args.some((a) => a === FLAG || /danger|bypass|full-access|approval/i.test(a) && a !== 'approval_policy="never"');

  it("default: no policy keeps the existing sandbox argv for every stage", async () => {
    for (const [agentStage, mode] of [["implementation", "workspace-write"], [undefined, "workspace-write"]] as const) {
      const { executor, log } = make([{ stdout: message("ok") }]);
      await executor.invoke({ ...base, ...(agentStage ? { agentStage } : {}) });
      expect(log[0].args).toEqual(expect.arrayContaining(["--sandbox", mode]));
      expect(hasBypass(log[0].args)).toBe(false);
    }
  });

  it("with the policy only implementation changes; review and an absent stage keep their sandbox", async () => {
    const impl = make([{ stdout: message("ok") }], full());
    await impl.executor.invoke({ ...base, agentStage: "implementation" });
    expect(impl.log[0].args).toContain(FLAG);
    expect(impl.log[0].args).not.toContain("--sandbox");

    const review = make([{ stdout: message("ok") }], full({ protocolDriver: reviewDriver() }));
    await review.executor.invoke({ ...base, agentStage: "review" });
    expect(review.log[0].args[0]).toBe("app-server");
    expect(review.log[0].args).toContain('sandbox_mode="read-only"');
    expect(hasBypass(review.log[0].args)).toBe(false);

    const none = make([{ stdout: message("ok") }], full());
    await none.executor.invoke({ ...base });
    expect(none.log[0].args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
    expect(hasBypass(none.log[0].args)).toBe(false);
  });

  it("planning never receives the policy: the app-server argv has no bypass flag and stays read-only", async () => {
    const calls: CodexTransportRunInput[] = [];
    const driver: CodexProtocolDriver = {
      async run(input) {
        calls.push(input);
        return {
          result: { stdout: "plan", stderr: "", exitCode: 0, tokensUsed: 0, terminalStatus: { subtype: "success", isError: false }, signal: null },
          sawUnsafe: false,
          stopReason: null,
          threadId: "t1",
        };
      },
    };
    const { executor, log } = make([{ stdout: message("ok") }], full({ protocolDriver: driver }));
    await executor.invoke({ ...base, agentStage: "planning" });
    // The planning argv is built for the app-server child and must never carry the exec bypass flag.
    expect(log).toHaveLength(1);
    for (const spawned of log) {
      expect(spawned.args[0]).toBe("app-server");
      expect(hasBypass(spawned.args)).toBe(false);
      expect(spawned.args).toContain('sandbox_mode="read-only"');
    }
  });

  it("refuses root or a reachable Docker socket before any auth checkout or spawn", async () => {
    const reports = [
      { nonRoot: false, socketPresent: false, socketReadable: false, socketWritable: false, admitted: false },
      { nonRoot: true, socketPresent: true, socketReadable: true, socketWritable: false, admitted: false },
      { nonRoot: true, socketPresent: true, socketReadable: false, socketWritable: true, admitted: false },
    ];
    for (const report of reports) {
      const { executor, log, auth } = make([{ stdout: message("ok") }], full({ fullAccessAdmission: () => report }));
      await expect(executor.invoke({ ...base, agentStage: "implementation" })).rejects.toMatchObject({ code: "CODEX_FULL_ACCESS_REFUSED" });
      expect(log).toHaveLength(0);
      expect(auth.events).toEqual([]);
    }
  });

  it("review requires its own restricted driver: none, or a planning driver, is refused before auth or spawn", async () => {
    for (const protocolDriver of [undefined, { ...reviewDriver(), policy: "planning" as const }]) {
      const { executor, log, auth } = make([{ stdout: message("ok") }], full(protocolDriver ? { protocolDriver } : {}));
      await expect(executor.invoke({ ...base, agentStage: "review" })).rejects.toMatchObject({ code: "CODEX_PLANNING_POLICY_UNPROVEN" });
      expect(log).toHaveLength(0);
      expect(auth.events).toEqual([]);
    }
    // A review driver is not valid for planning either.
    const { executor, log } = make([{ stdout: message("ok") }], full({ protocolDriver: reviewDriver() }));
    await expect(executor.invoke({ ...base, agentStage: "planning" })).rejects.toMatchObject({ code: "CODEX_PLANNING_POLICY_UNPROVEN" });
    expect(log).toHaveLength(0);
  });

  it("admission is not consulted for review, so review is unaffected by a failing probe", async () => {
    const probe = vi.fn(() => ({ nonRoot: false, socketPresent: false, socketReadable: false, socketWritable: false, admitted: false }));
    const { executor, log } = make([{ stdout: message("ok") }], full({ fullAccessAdmission: probe, protocolDriver: reviewDriver() }));
    await executor.invoke({ ...base, agentStage: "review" });
    expect(probe).not.toHaveBeenCalled();
    expect(log).toHaveLength(1);
  });

  describe("resume and retry", () => {
    const expired = [
      ev({ type: "thread.started", thread_id: "t1" }),
      ev({ type: "turn.started" }),
      ev({ type: "error", message: "unexpected status 401 Unauthorized: token expired" }),
    ];
    const plan = (scripts: Script[], extra: Partial<CodexExecutorOptions>) => {
      const log: Spawned[] = [];
      let n = 0;
      const auth: Pick<ModelAuthClient, "invoke"> = {
        invoke: async (_id, cb) =>
          cb({ env: { PATH: "/usr/bin", CHATGPT_PLAN_ACCESS_TOKEN: `plan-token-${++n}-synthetic` }, strippedKeys: [], codexProvider: "chatgpt-plan" as const }),
      };
      const executor = new CodexExecutor(workspace, {
        auth, profileId: "p1", allowRepositoryWrites: true, spawnImpl: makeSpawn(scripts, log), sleepImpl: async () => {}, termWaitMs: 30, killWaitMs: 30, ...extra,
      });
      return { executor, log };
    };

    it("a token-expiry resume carries the same authority as the fresh exec", async () => {
      const { executor, log } = plan([{ stdout: expired, exitCode: 1 }, { stdout: message("ok") }], full());
      await executor.invoke({ ...base, agentStage: "implementation" });
      expect(log).toHaveLength(2);
      expect(log[0].args).toContain(FLAG);
      expect(log[1].args.slice(0, 2)).toEqual(["exec", "resume"]);
      expect(log[1].args).toContain(FLAG);
      expect(log[1].args.some((a) => a.startsWith("sandbox_mode="))).toBe(false);
    });

    it("a review resume stays on the restricted app-server even with the policy present", async () => {
      const inputs: CodexTransportRunInput[] = [];
      const protocolDriver: CodexProtocolDriver = {
        policy: "review",
        async run(input) {
          inputs.push(input);
          const first = inputs.length === 1;
          const t = okDriver();
          return first ? { ...t, threadId: "t-rev", tokenExpired: true, result: { ...t.result, exitCode: 1, terminalStatus: { subtype: "error", isError: true }, stderr: "codex app-server transport: turn_failed" } } : t;
        },
      };
      const { executor, log } = plan([{ hang: true, dieOn: ["SIGTERM"] }, { hang: true, dieOn: ["SIGTERM"] }], full({ protocolDriver }));
      await executor.invoke({ ...base, agentStage: "review", invocationTimeoutMs: 60_000 });
      expect(log).toHaveLength(2);
      for (const spawned of log) {
        expect(spawned.args[0]).toBe("app-server");
        expect(spawned.args).toContain('sandbox_mode="read-only"');
        expect(hasBypass(spawned.args)).toBe(false);
      }
      expect(inputs[1].resumeThreadId).toBe("t-rev");
    });

    it("a transient retry repeats the identical argv: no widening, no narrowing", async () => {
      const { executor, log } = make([{ exitCode: 1, stderr: "503 service unavailable" }, { stdout: message("ok") }], full());
      await executor.invoke({ ...base, agentStage: "implementation", ...retry });
      expect(log).toHaveLength(2);
      expect(log[1].args).toEqual(log[0].args);
    });

    it("a rejected full-access flag surfaces CODEX_CONFIG_REJECTED and is not retried or widened", async () => {
      const { executor, log } = make([{ exitCode: 2, stderr: "error: unexpected argument '--dangerously-bypass-approvals-and-sandbox' found" }, { stdout: message("ok") }], full());
      const out = await executor.invoke({ ...base, agentStage: "implementation", ...retry });
      expect(out.failure?.code).toBe("CODEX_CONFIG_REJECTED");
      expect(log).toHaveLength(1);
    });
  });
});
