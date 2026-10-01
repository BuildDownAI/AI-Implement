import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync, type spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexExecutor, CodexRecoveryRequiredError, matchesSchema, type CodexExecutorOptions } from "../pipeline/codex-executor.js";
import { ModelAuthClientError, type ModelAuthClient, type ModelInvocation } from "../model-auth-client.js";
import { DEFAULT_RETRY_POLICY } from "../pipeline/retry-backoff.js";
import { READ_ONLY_TOOL_PARAMS } from "../pipeline/steps/read-only-tools.js";
import type { CodexProtocolDriver, CodexTransportResult, CodexTransportRunInput } from "../pipeline/codex-planning-adapter.js";

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
  stdin: string;
  signals: NodeJS.Signals[];
}

function makeSpawn(scripts: Script[], log: Spawned[], onSpawn?: () => void): typeof spawn {
  return ((cmd: string, args: string[], opts: { env: Record<string, string> }) => {
    const script = scripts[log.length] ?? scripts[scripts.length - 1];
    const rec: Spawned = { cmd, args, env: opts.env, stdin: "", signals: [] };
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
    await guarded([{ hang: true, dieOn: ["SIGTERM"] }]).executor.invoke({ ...base, invocationTimeoutMs: 10 });
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
    const { executor } = guarded([{ hang: true, dieOn: [] }]);
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

describe("default exec path is unchanged (AII-1001)", () => {
  it("passes the exact pinned exec argv and never selects the app-server transport", async () => {
    const { executor, log } = make([{ stdout: message("done") }]);
    await executor.invoke({ ...base, builtinTools: ["Read"] });
    expect(log[0].cmd).toBe("codex");
    expect(log[0].args).toEqual([
      "exec", "--json", "--ignore-user-config", "--ignore-rules", "--model", "gpt-synthetic", "-c", 'model_provider="openai"', "--sandbox", "read-only", "-",
    ]);
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
      "app-server", "--ignore-user-config", "--ignore-rules",
      "-c", 'model="gpt-synthetic"',
      "-c", 'model_provider="openai"',
      "-c", 'approval_policy="never"',
      "-c", 'sandbox_mode="read-only"',
      "-c", "features.shell_tool=false",
      "-c", 'web_search="disabled"',
    ]);
    expect(log[0].args).not.toContain("exec");
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
