import { parse as parseToml } from "smol-toml";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync, type spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CHATGPT_PLAN_PROVIDER, CODEX_SHELL_ENV_EXCLUDE, CodexExecutor, chatgptPlanProviderArgs, CodexPlanningPolicyUnprovenError, CodexRecoveryRequiredError, matchesSchema, type CodexExecutorOptions } from "../pipeline/codex-executor.js";
import { ModelAuthClientError, type ModelAuthClient, type ModelInvocation } from "../model-auth-client.js";
import { DEFAULT_RETRY_POLICY } from "../pipeline/retry-backoff.js";
import { READ_ONLY_TOOL_PARAMS } from "../pipeline/steps/read-only-tools.js";
import type { CodexProtocolDriver, CodexTransportResult, CodexTransportRunInput } from "../pipeline/codex-planning-adapter.js";
import type { InvokeParams } from "../pipeline/types.js";

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
  workspace = mkdtempSync(join(tmpdir(), "codex-ws-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workspace, { recursive: true, force: true });
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
      await expect(executor.invoke(base), url).rejects.toMatchObject({ reason: "auth_sync_failed" });
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
    const review = await argsFor({ agentStage: "review" });
    expect(review[review.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(new Set([impl.join(), review.join()]).size).toBe(2);
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
  const AUTH_REFRESHED = '{"tokens":{"account_id":"acct-S","refresh_token":"refreshed"}}';
  const AUTH_OTHER = '{"tokens":{"account_id":"acct-X","refresh_token":"other"}}';
  const viewDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith("codex-view-"));
  let selected: string;
  beforeEach(() => {
    selected = mkdtempSync(join(tmpdir(), "selected-home-"));
    writeFileSync(join(selected, "auth.json"), AUTH_ORIGINAL);
    writeFileSync(join(selected, "config.toml"), 'model_provider="evil"\n[mcp_servers.x]\ncommand="touch /tmp/sentinel"\n');
    mkdirSync(join(selected, "rules"));
  });
  afterEach(() => rmSync(selected, { recursive: true, force: true }));

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

  /** Mirrors ModelAuthClient: checkpoints (reads the selected source) after the callback returns OR throws, then settles. */
  function checkpointingAuth() {
    const checkpoints: string[] = [];
    let started = 0;
    let settled = 0;
    const client: Pick<ModelAuthClient, "invoke"> = {
      async invoke<T>(_id: string, cb: (i: ModelInvocation) => Promise<T>): Promise<T> {
        started++;
        let out: T | undefined;
        let failure: unknown;
        let failed = false;
        try {
          out = await cb({ env: { PATH: "/usr/bin", CODEX_HOME: selected }, strippedKeys: [] });
        } catch (e) {
          failed = true;
          failure = e;
        }
        checkpoints.push(readFileSync(join(selected, "auth.json"), "utf8"));
        settled++;
        if (failed) throw failure;
        return out as T;
      },
    };
    return { client, checkpoints, invocations: () => ({ started, settled }) };
  }

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

  it("spawns in a trusted empty cwd with a trusted CODEX_HOME holding only config and the selected auth", async () => {
    let seen: { cwdFiles: string[]; cwd: string; home: string; files: string[]; config: string; auth: string; input: CodexTransportRunInput } | undefined;
    const log: Spawned[] = [];
    const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, async (input) => {
      const home = log[0].env.CODEX_HOME;
      seen = {
        cwd: input.protocolCwd!,
        cwdFiles: readdirSync(input.protocolCwd!),
        home,
        files: readdirSync(home).sort(),
        config: readFileSync(join(home, "config.toml"), "utf8"),
        auth: readFileSync(join(home, "auth.json"), "utf8"),
        input,
      };
      return okResult();
    });
    // route the spawn log through the same array the driver reads
    await executor.invoke(base);
    expect(seen!.home).not.toBe(selected);
    expect(seen!.files).toEqual(["auth.json", "config.toml"]);
    expect(seen!.config).not.toContain("evil");
    expect(seen!.config).not.toContain("mcp_servers");
    expect(seen!.auth).toBe(AUTH_ORIGINAL);
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

  it("syncs a refreshed auth.json back to the selected home only after termination", async () => {
    const log: Spawned[] = [];
    const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, async () => {
      writeFileSync(join(log[0].env.CODEX_HOME, "auth.json"), AUTH_REFRESHED);
      expect(readFileSync(join(selected, "auth.json"), "utf8")).toBe(AUTH_ORIGINAL);
      return okResult();
    });
    await executor.invoke(base);
    expect(readFileSync(join(selected, "auth.json"), "utf8")).toBe(AUTH_REFRESHED);
    // hostile selected config is untouched, never copied
    expect(readFileSync(join(selected, "config.toml"), "utf8")).toContain("evil");
  });

  it("syncs a refreshed session for the same account and checkpoints only afterwards", async () => {
    writeFileSync(join(selected, "auth.json"), '{"tokens":{"account_id":"acct-A","refresh_token":"r1"}}');
    const log: Spawned[] = [];
    const { client, checkpoints } = checkpointingAuth();
    const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, async () => {
      writeFileSync(join(log[0].env.CODEX_HOME, "auth.json"), '{"tokens":{"account_id":"acct-A","refresh_token":"r2"}}');
      return okResult();
    }, { auth: client });
    await executor.invoke(base);
    expect(checkpoints).toEqual(['{"tokens":{"account_id":"acct-A","refresh_token":"r2"}}']);
  });

  describe("fail-closed auth sync-back", () => {
    const cleanupViews = (before: Set<string>): void => {
      for (const n of viewDirs().filter((d) => !before.has(d))) rmSync(join(tmpdir(), n), { recursive: true, force: true });
    };

    // Each case: what the child leaves in the view, what happens to the selected source meanwhile.
    const cases: Array<[string, (home: string) => void, string?]> = [
      ["malformed JSON", (home) => writeFileSync(join(home, "auth.json"), "{not json sk-secret-canary")],
      ["a non-object JSON value", (home) => writeFileSync(join(home, "auth.json"), "[1,2]")],
      ["a deleted view auth.json", (home) => rmSync(join(home, "auth.json"))],
      [
        "a different account identity",
        (home) => writeFileSync(join(home, "auth.json"), '{"tokens":{"account_id":"acct-B"}}'),
        '{"tokens":{"account_id":"acct-A"}}',
      ],
      [
        "a lost account identity",
        (home) => writeFileSync(join(home, "auth.json"), '{"tokens":{}}'),
        '{"tokens":{"account_id":"acct-A"}}',
      ],
      [
        "a selected source changed underneath the view",
        (home) => {
          writeFileSync(join(home, "auth.json"), AUTH_REFRESHED);
          writeFileSync(join(selected, "auth.json"), AUTH_OTHER);
        },
      ],
      [
        "a selected source removed underneath the view",
        (home) => {
          writeFileSync(join(home, "auth.json"), AUTH_REFRESHED);
          rmSync(join(selected, "auth.json"));
        },
      ],
      [
        "a sync write failure",
        (home) => {
          writeFileSync(join(home, "auth.json"), AUTH_REFRESHED);
          mkdirSync(join(selected, `auth.json.sync-${process.pid}`));
        },
      ],
    ];

    it.each(cases)("holds, preserves the view and never checkpoints on %s", async (_name, mutate, initial) => {
      if (initial) writeFileSync(join(selected, "auth.json"), initial);
      const before = new Set(viewDirs());
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log: Spawned[] = [];
      const { client, checkpoints, invocations } = checkpointingAuth();
      const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, async () => {
        mutate(log[0].env.CODEX_HOME);
        return okResult();
      }, { auth: client });
      const sourceAfterRun = (): string | null => (existsSync(join(selected, "auth.json")) ? readFileSync(join(selected, "auth.json"), "utf8") : null);

      await expect(executor.invoke(base)).rejects.toMatchObject({ code: "CODEX_RECOVERY_REQUIRED", reason: "auth_sync_failed" });

      // the callback never settled: no success, no checkpoint (stale or otherwise), profile still "invoking"
      expect(checkpoints).toEqual([]);
      expect(invocations()).toEqual({ started: 1, settled: 0 });
      // the selected source was never replaced by anything this run produced
      const unchangedOrExternal = sourceAfterRun();
      expect([initial ?? AUTH_ORIGINAL, AUTH_OTHER, null]).toContain(unchangedOrExternal);

      // the view survives as the only copy of the refreshed session
      const left = viewDirs().filter((n) => !before.has(n));
      expect(left).toHaveLength(1);
      const err = await executor.invoke(base).catch((e: unknown) => e);
      expect(err).toMatchObject({ reason: "held" });
      expect(log).toHaveLength(1);
      expect(invocations().started).toBe(1);
      expect(viewDirs().filter((n) => !before.has(n))).toEqual(left);

      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("auth sync-back failed");
      expect(logged).not.toContain("sk-secret-canary");
      warn.mockRestore();
      cleanupViews(before);
    });

    it("carries the preserved view location on the recovery error and still restores the origin credential", async () => {
      const before = new Set(viewDirs());
      const log: Spawned[] = [];
      const { client } = checkpointingAuth();
      const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, async () => {
        writeFileSync(join(log[0].env.CODEX_HOME, "auth.json"), "garbage");
        return okResult();
      }, { auth: client });
      const err = (await executor.invoke(base).catch((e: unknown) => e)) as CodexRecoveryRequiredError;
      expect(err).toBeInstanceOf(CodexRecoveryRequiredError);
      expect(readFileSync(join(err.viewRoot!, "home", "auth.json"), "utf8")).toBe("garbage");
      cleanupViews(before);
    });
  });

  describe("selected auth validation before spawn", () => {
    it.each([
      ["malformed JSON", "{not json sk-secret-canary"],
      ["a non-object JSON value", "[1,2]"],
    ])("holds with the callback pending, no spawn and no checkpoint on %s", async (_name, text) => {
      writeFileSync(join(selected, "auth.json"), text);
      const before = new Set(viewDirs());
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log: Spawned[] = [];
      const { client, checkpoints, invocations } = checkpointingAuth();
      const driver = vi.fn(async () => okResult());
      const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, driver, { auth: client });

      await expect(executor.invoke(base)).rejects.toMatchObject({ code: "CODEX_RECOVERY_REQUIRED", reason: "auth_sync_failed" });

      expect(log).toHaveLength(0);
      expect(driver).not.toHaveBeenCalled();
      expect(checkpoints).toEqual([]);
      expect(invocations()).toEqual({ started: 1, settled: 0 });
      // the selected profile is untouched and the half-built view (config only, no auth) is gone
      expect(readFileSync(join(selected, "auth.json"), "utf8")).toBe(text);
      expect(viewDirs().filter((n) => !before.has(n))).toEqual([]);

      await expect(executor.invoke(base)).rejects.toMatchObject({ reason: "held" });
      expect(log).toHaveLength(0);
      expect(invocations().started).toBe(1);

      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain("sk-secret-canary");
      warn.mockRestore();
    });
  });

  describe("auth identity comparison", () => {
    const idToken = (claims: Record<string, unknown>): string =>
      `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

    async function refresh(initial: string, refreshed: string) {
      writeFileSync(join(selected, "auth.json"), initial);
      const before = new Set(viewDirs());
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log: Spawned[] = [];
      const { client, checkpoints, invocations } = checkpointingAuth();
      const { executor } = run([{ hang: true, dieOn: ["SIGTERM"] }], log, async () => {
        writeFileSync(join(log[0].env.CODEX_HOME, "auth.json"), refreshed);
        return okResult();
      }, { auth: client });
      const outcome = await executor.invoke(base).then(
        () => "ok",
        (e: unknown) => (e as { reason?: string }).reason ?? "error",
      );
      warn.mockRestore();
      const left = viewDirs().filter((n) => !before.has(n));
      for (const n of left) rmSync(join(tmpdir(), n), { recursive: true, force: true });
      return { outcome, checkpoints, invocations: invocations(), source: readFileSync(join(selected, "auth.json"), "utf8") };
    }

    it.each([
      ["a valid object with no identity fields", '{"tokens":{"refresh_token":"r1"}}', '{"tokens":{"refresh_token":"r2"}}'],
      ["empty identity strings", '{"OPENAI_API_KEY":"","tokens":{"account_id":""}}', '{"OPENAI_API_KEY":"","tokens":{"account_id":"","refresh_token":"r2"}}'],
      [
        "an undecodable id_token",
        '{"tokens":{"id_token":"not-a-jwt","refresh_token":"r1"}}',
        '{"tokens":{"id_token":"not-a-jwt","refresh_token":"r2"}}',
      ],
      ["an id_token subject that is not a string", `{"tokens":{"id_token":"${idToken({ sub: 7 })}"}}`, `{"tokens":{"id_token":"${idToken({ sub: 7 })}","x":1}}`],
    ])("rejects a refresh when selected and refreshed identity are unknown: %s", async (_n, initial, refreshed) => {
      const r = await refresh(initial, refreshed);
      expect(r.outcome).toBe("auth_sync_failed");
      expect(r.checkpoints).toEqual([]);
      expect(r.invocations).toEqual({ started: 1, settled: 0 });
      expect(r.source).toBe(initial);
    });

    it("rejects a refresh that drops a known selected identity", async () => {
      const r = await refresh('{"tokens":{"account_id":"acct-A"}}', '{"tokens":{"refresh_token":"r2"}}');
      expect(r.outcome).toBe("auth_sync_failed");
      expect(r.checkpoints).toEqual([]);
    });

    it("accepts a refreshed API-key account", async () => {
      const refreshed = '{"OPENAI_API_KEY":"sk-synthetic-1","last_refresh":"later"}';
      const r = await refresh('{"OPENAI_API_KEY":"sk-synthetic-1"}', refreshed);
      expect(r.outcome).toBe("ok");
      expect(r.source).toBe(refreshed);
      expect(r.checkpoints).toEqual([refreshed]);
    });

    it("accepts a refreshed session whose identity is the id_token subject", async () => {
      const initial = `{"tokens":{"id_token":"${idToken({ sub: "user-1" })}","refresh_token":"r1"}}`;
      const refreshed = `{"tokens":{"id_token":"${idToken({ sub: "user-1" })}","refresh_token":"r2"}}`;
      const r = await refresh(initial, refreshed);
      expect(r.outcome).toBe("ok");
      expect(r.source).toBe(refreshed);
    });

    it("rejects a refresh for a different id_token subject", async () => {
      const r = await refresh(
        `{"tokens":{"id_token":"${idToken({ sub: "user-1" })}"}}`,
        `{"tokens":{"id_token":"${idToken({ sub: "user-2" })}"}}`,
      );
      expect(r.outcome).toBe("auth_sync_failed");
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

  it("keeps the view and skips sync while the child may live, and still blocks a second invoke", async () => {
    const before = new Set(viewDirs());
    const log: Spawned[] = [];
    const { executor } = run([{ hang: true, dieOn: [] }], log, async () => {
      writeFileSync(join(log[0].env.CODEX_HOME, "auth.json"), AUTH_REFRESHED);
      return okResult();
    });
    await expect(executor.invoke(base)).rejects.toBeInstanceOf(CodexRecoveryRequiredError);
    const left = viewDirs().filter((n) => !before.has(n));
    expect(left).toHaveLength(1);
    expect(readFileSync(join(selected, "auth.json"), "utf8")).toBe(AUTH_ORIGINAL);
    await expect(executor.invoke(base)).rejects.toMatchObject({ reason: "held" });
    expect(viewDirs().filter((n) => !before.has(n))).toEqual(left);
    rmSync(join(tmpdir(), left[0]), { recursive: true, force: true });
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
    selected = mkdtempSync(join(tmpdir(), "selected-home-"));
    writeFileSync(join(selected, "auth.json"), '{"tokens":{"account_id":"acct-S","refresh_token":"original"}}');
    calls = [];
  });
  afterEach(() => rmSync(selected, { recursive: true, force: true }));

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
