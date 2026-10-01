import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRecoveryRequiredError, AgentStageError, createStageExecutor, safeLimitLabel, safeModelLabel } from "../pipeline/stage-executor.js";
import { ClaudeCliExecutor } from "../pipeline/executor.js";
import { CodexExecutor, CodexRecoveryRequiredError } from "../pipeline/codex-executor.js";
import { normalizeInvocation } from "../agent-usage.js";
import type { ResolvedAgentSnapshotV1 } from "../run-config.js";
import type { ModelAuthClient, ModelInvocation } from "../model-auth-client.js";
import type { InvokeParams, LLMExecutor, LLMResult } from "../pipeline/types.js";

const rev = { configRevisionId: "rev-1", revision: 1 };
const snapshot: ResolvedAgentSnapshotV1 = {
  version: 1,
  snapshotId: "snap-1",
  configRevisions: { orchestratorDefault: rev, project: rev },
  stages: {
    planning: { agent: "codex", provider: "openai", model: "gpt-plan", accountProfileId: "p-plan", invocationTimeoutMs: 1000 },
    implementation: { agent: "claude", provider: "anthropic", model: "claude-impl", accountProfileId: "p-impl", invocationTimeoutMs: 2000 },
    review: { agent: "codex", provider: "openai", model: "gpt-rev", accountProfileId: "p-rev", invocationTimeoutMs: 3000 },
  },
  sources: {} as ResolvedAgentSnapshotV1["sources"],
  profiles: {
    planning: { id: "p-plan", identity: "a", revision: 1, agent: "codex", provider: "openai", authMode: "openai-api-key" },
    implementation: { id: "p-impl", identity: "b", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" },
    review: { id: "p-rev", identity: "c", revision: 1, agent: "codex", provider: "openai", authMode: "codex-subscription" },
  },
};

const ok: LLMResult = { stdout: "ok", exitCode: 0, tokensUsed: 3, telemetry: { outcome: "success", numTurns: 1, durationMs: 5, costUsd: null, tokensIn: 2, tokensOut: 1 } };

function fakeAuth(events: string[] = []) {
  const invoke = vi.fn(async <T>(profileId: string, run: (i: ModelInvocation) => Promise<T>): Promise<T> => {
    events.push(`invoke:${profileId}`);
    try {
      return await run({ env: { PATH: "/bin", ANTHROPIC_API_KEY: "synthetic-selected-key-0000" }, strippedKeys: [] });
    } finally {
      events.push("checkpoint");
    }
  });
  return { invoke } as unknown as Pick<ModelAuthClient, "invoke"> & { invoke: typeof invoke };
}

function fakeExec(result: LLMResult | Error = ok) {
  const invoke = vi.fn(async (_p: InvokeParams, _o?: unknown) => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { invoke } as LLMExecutor & { invoke: typeof invoke };
}

const base: InvokeParams = { prompt: "p", model: "caller-model", invocationTimeoutMs: 99, maxTurns: 7 };

afterEach(() => vi.restoreAllMocks());

describe("createStageExecutor", () => {
  it("returns the exact injected executor without a snapshot", () => {
    const legacy = fakeExec();
    expect(createStageExecutor({ workspaceDir: "/tmp", legacy })).toBe(legacy);
  });

  it("requires an auth client when a snapshot is supplied", () => {
    expect(() => createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot })).toThrow(AgentStageError);
  });

  it("selects agent, model, profile and timeout independently per stage and ignores caller values", async () => {
    const events: string[] = [];
    const auth = fakeAuth(events);
    const claude = fakeExec();
    const codex = new Map<string, ReturnType<typeof fakeExec>>();
    const transports: string[] = [];
    const ex = createStageExecutor({
      workspaceDir: "/tmp",
      legacy: fakeExec(),
      snapshot,
      auth,
      createClaude: () => claude as never,
      createCodex: (id, transport) => {
        transports.push(`${id}:${transport}`);
        return codex.set(id, fakeExec()).get(id)!;
      },
    });

    // Diagnostic labels that look like other stages must not influence selection.
    await ex.invoke({ ...base, agentStage: "planning", stage: "review" });
    await ex.invoke({ ...base, agentStage: "implementation", stage: "plan" });
    await ex.invoke({ ...base, agentStage: "review", stage: "implement" });

    const plan = codex.get("p-plan")!.invoke.mock.calls[0][0];
    expect(plan).toMatchObject({ model: "gpt-plan", invocationTimeoutMs: 1000, agentStage: "planning" });
    expect(plan.maxTurns).toBeUndefined();
    const rv = codex.get("p-rev")!.invoke.mock.calls[0][0];
    expect(rv).toMatchObject({ model: "gpt-rev", invocationTimeoutMs: 3000 });
    expect(claude.invoke.mock.calls[0][0]).toMatchObject({ model: "claude-impl", invocationTimeoutMs: 2000, maxTurns: 7 });
    // Planning uses the native transport; review uses `codex exec`.
    expect(transports).toEqual(["p-plan:native", "p-rev:exec"]);
    // Codex wraps its own auth; only Claude goes through the selector's single auth.invoke.
    expect(events).toEqual(["invoke:p-impl", "checkpoint"]);
  });

  it.each([undefined, "bogus", "implement", "Planning"])("rejects agentStage %s before any auth or executor call", async (agentStage) => {
    const auth = fakeAuth();
    const claude = fakeExec();
    const createCodex = vi.fn();
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth, createClaude: () => claude as never, createCodex });
    await expect(ex.invoke({ ...base, stage: "review", agentStage: agentStage as never })).rejects.toBeInstanceOf(AgentStageError);
    expect(auth.invoke).not.toHaveBeenCalled();
    expect(claude.invoke).not.toHaveBeenCalled();
    expect(createCodex).not.toHaveBeenCalled();
  });

  it("caches one executor per agent and per profile+transport across calls", async () => {
    const createCodex = vi.fn((_id: string, _t: string) => fakeExec());
    const createClaude = vi.fn(() => fakeExec() as never);
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth: fakeAuth(), createClaude, createCodex });
    for (let i = 0; i < 2; i++) {
      await ex.invoke({ ...base, agentStage: "implementation" });
      await ex.invoke({ ...base, agentStage: "planning" });
      await ex.invoke({ ...base, agentStage: "review" });
    }
    expect(createClaude).toHaveBeenCalledTimes(1);
    expect(createCodex.mock.calls).toEqual([["p-plan", "native"], ["p-rev", "exec"]]);
  });

  it("does not share a Codex executor between planning and review on the same account profile", async () => {
    const shared = { ...snapshot, stages: { ...snapshot.stages, planning: { ...snapshot.stages.planning, accountProfileId: "p-rev" } }, profiles: { ...snapshot.profiles, planning: { ...snapshot.profiles.review } } };
    const made = new Map<string, ReturnType<typeof fakeExec>>();
    const createCodex = vi.fn((id: string, transport: string) => {
      const e = fakeExec();
      made.set(`${id}:${transport}`, e);
      return e;
    });
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot: shared, auth: fakeAuth(), createCodex });
    await ex.invoke({ ...base, agentStage: "review" });
    await ex.invoke({ ...base, agentStage: "planning" });
    await ex.invoke({ ...base, agentStage: "review" });
    await ex.invoke({ ...base, agentStage: "planning" });
    expect(createCodex).toHaveBeenCalledTimes(2);
    expect(made.get("p-rev:exec")!.invoke).toHaveBeenCalledTimes(2);
    expect(made.get("p-rev:native")!.invoke).toHaveBeenCalledTimes(2);
    expect(made.get("p-rev:native")!.invoke.mock.calls[0][0]).toMatchObject({ agentStage: "planning", model: "gpt-plan" });
    expect(made.get("p-rev:exec")!.invoke.mock.calls[0][0]).toMatchObject({ agentStage: "review", model: "gpt-rev" });
  });

  it("attaches verified attribution with the actual agent and limit", async () => {
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth: fakeAuth(), createClaude: () => fakeExec() as never, createCodex: () => fakeExec() });
    const claudeRes = await ex.invoke({ ...base, agentStage: "implementation" });
    expect(claudeRes.attribution).toMatchObject({ agent: "claude", model: "claude-impl", profileId: "p-impl", limit: { kind: "max_turns", value: 7 }, outcome: "success" });
    expect(claudeRes.telemetry?.attribution).toEqual(claudeRes.attribution);
    const codexRes = await ex.invoke({ ...base, agentStage: "review" });
    expect(codexRes.attribution).toMatchObject({ agent: "codex", authMode: "codex-subscription", limit: { kind: "timeout_ms", value: 3000 } });
    const row = normalizeInvocation(snapshot, { stage: "review", telemetry: codexRes.telemetry, attribution: codexRes.attribution });
    expect(row).toMatchObject({ attribution: "verified", mismatches: [] });
  });

  it("keeps a failed result's attribution as error", async () => {
    const failed: LLMResult = { ...ok, exitCode: 1, telemetry: { ...ok.telemetry!, outcome: "error" }, failure: { category: "crash", code: "INVOCATION_TIMEOUT", retryable: false, message: "x", stage: "s", attempt: 1 } as never };
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth: fakeAuth(), createCodex: () => fakeExec(failed) });
    const res = await ex.invoke({ ...base, agentStage: "planning" });
    expect(res.attribution).toMatchObject({ outcome: "error", limit: { kind: "timeout_ms", value: 1000 } });
  });

  it("attaches attribution to a rejected error and propagates recovery errors unchanged", async () => {
    const held = new CodexRecoveryRequiredError("child_not_terminated");
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth: fakeAuth(), createCodex: () => fakeExec(held) });
    const err = await ex.invoke({ ...base, agentStage: "review" }).catch((e) => e);
    expect(err).toBe(held);
    expect(err.reason).toBe("child_not_terminated");
    expect(err.attribution).toMatchObject({ outcome: "error", agent: "codex", profileId: "p-rev" });
  });

  it("does not finish or dispose a profile", async () => {
    const auth = { ...fakeAuth(), finish: vi.fn(), dispose: vi.fn() };
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth, createClaude: () => fakeExec() as never });
    await ex.invoke({ ...base, agentStage: "implementation" });
    expect(auth.finish).not.toHaveBeenCalled();
    expect(auth.dispose).not.toHaveBeenCalled();
  });
});

describe("Claude selected env isolation", () => {
  function claudeSpawn(code: number) {
    return vi.fn(() => {
      const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
      setImmediate(() => {
        proc.stdout.end(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 1, output_tokens: 1 } }));
        proc.stderr.end();
        setImmediate(() => proc.emit("close", code));
      });
      return proc as unknown as ChildProcessWithoutNullStreams;
    });
  }

  it("spawns with the selected env only, checkpoints before returning, and leaves process.env untouched", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-key-must-not-leak");
    vi.stubEnv("RUN_TOKEN", "runner-token-0000");
    const before = { ...process.env };
    const events: string[] = [];
    const spawnMock = claudeSpawn(0);
    const claude = new ClaudeCliExecutor("/tmp", "summary", true, spawnMock as unknown as typeof spawn);
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth: fakeAuth(events), createClaude: () => claude });
    const res = await ex.invoke({ ...base, agentStage: "implementation" });
    const env = (spawnMock.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "synthetic-selected-key-0000" });
    expect(events).toEqual(["invoke:p-impl", "checkpoint"]);
    expect(res.attribution?.agent).toBe("claude");
    expect(process.env).toEqual(before);
  });
});

describe("labels", () => {
  it("describes the actual model and limit without credential data", () => {
    expect(safeModelLabel({ agent: "codex", model: "gpt-rev" })).toBe("codex/gpt-rev");
    expect(safeModelLabel({ agent: "claude", model: "sk-abcdefghijkl" })).toBe("claude/unknown-model");
    expect(safeLimitLabel({ kind: "timeout_ms", value: 90_000 })).toBe("timeout 90s");
    expect(safeLimitLabel({ kind: "max_turns", value: 7 })).toBe("7 turns");
    expect(safeLimitLabel(null)).toBe("no limit");
    expect(safeLimitLabel({ kind: "timeout_ms", value: 90_000 })).not.toMatch(/turn/);
  });
});

describe("real CodexExecutor behind the selector", () => {
  const ev = (o: unknown) => JSON.stringify(o);
  const okLines = [
    ev({ type: "thread.started", thread_id: "t" }),
    ev({ type: "item.completed", item: { id: "m", type: "agent_message", text: "fine" } }),
    ev({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } }),
  ];

  interface Spawned { args: string[]; stdin: string }
  function codexSpawn(opts: { hang?: boolean } = {}, log: Spawned[] = []) {
    const impl = vi.fn((_cmd: string, args: string[]) => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        pid: undefined,
        kill: () => true,
      });
      const entry: Spawned = { args, stdin: "" };
      log.push(entry);
      proc.stdin.on("data", (d) => (entry.stdin += String(d)));
      if (!opts.hang) {
        setImmediate(() => {
          proc.stdout.end(okLines.join("\n") + "\n");
          proc.stderr.end();
          setImmediate(() => proc.emit("close", 0, null));
        });
      }
      return proc as unknown as ChildProcessWithoutNullStreams;
    });
    return impl as unknown as typeof spawn & typeof impl;
  }

  function checkpointAuth(opts: { uncertain?: boolean } = {}) {
    const events: string[] = [];
    const finish = vi.fn();
    const dispose = vi.fn();
    const invoke = vi.fn(async <T>(profileId: string, run: (i: ModelInvocation) => Promise<T>): Promise<T> => {
      events.push(`invoke:${profileId}`);
      const out = await run({ env: { PATH: "/bin", CODEX_API_KEY: "synthetic-codex-key-0000" }, strippedKeys: [] });
      events.push("checkpoint");
      if (opts.uncertain) throw Object.assign(new Error("uncertain"), { category: "checkpoint_uncertain" });
      return out;
    });
    return { invoke, finish, dispose, events } as unknown as Pick<ModelAuthClient, "invoke"> & { invoke: typeof invoke; finish: typeof finish; dispose: typeof dispose; events: string[] };
  }

  const make = (auth: ReturnType<typeof checkpointAuth>, spawnImpl: typeof spawn) =>
    createStageExecutor({
      workspaceDir: "/tmp",
      legacy: fakeExec(),
      snapshot,
      auth,
      allowRepositoryWrites: true,
      codexOptions: { spawnImpl, sleepImpl: async () => {}, termWaitMs: 20, killWaitMs: 20 },
    });

  it("pins the snapshot model on argv, sends the prompt verbatim with no turn cap, and wraps auth once per attempt", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const log: Spawned[] = [];
    const auth = checkpointAuth();
    const ex = make(auth, codexSpawn({}, log));
    const res = await ex.invoke({ ...base, prompt: "review this", agentStage: "review", stage: "implement", maxTurns: 7, model: "repo-config-model" });
    expect(log).toHaveLength(1);
    expect(log[0].args[log[0].args.indexOf("--model") + 1]).toBe("gpt-rev");
    expect(log[0].args.join(" ")).not.toMatch(/repo-config-model|caller-model|max-turns/);
    expect(log[0].stdin).toBe("review this");
    expect(log[0].stdin).not.toMatch(/turn/i);
    expect(auth.invoke).toHaveBeenCalledTimes(1);
    expect(auth.events).toEqual(["invoke:p-rev", "checkpoint"]);
    expect(res.attribution).toMatchObject({ agent: "codex", model: "gpt-rev", limit: { kind: "timeout_ms", value: 3000 } });
  });

  it("surfaces child_not_terminated without finishing or disposing the profile", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = checkpointAuth();
    const ex = make(auth, codexSpawn({ hang: true }));
    const err = await ex.invoke({ ...base, agentStage: "review" }).catch((e) => e);
    expect(err).toBeInstanceOf(CodexRecoveryRequiredError);
    expect(err.reason).toBe("child_not_terminated");
    expect(err.attribution).toMatchObject({ outcome: "error", agent: "codex" });
    expect(auth.events).toEqual(["invoke:p-rev"]);
    expect(auth.finish).not.toHaveBeenCalled();
    expect(auth.dispose).not.toHaveBeenCalled();
    // Held: the next call is refused without another auth checkout.
    const again = await ex.invoke({ ...base, agentStage: "review" }).catch((e) => e);
    expect(again).toBeInstanceOf(AgentRecoveryRequiredError);
    expect(again.reason).toBe("held");
    expect(auth.invoke).toHaveBeenCalledTimes(1);
  });

  it("surfaces checkpoint_uncertain without finishing and holds the next call", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const auth = checkpointAuth({ uncertain: true });
    const spawnImpl = codexSpawn();
    const ex = make(auth, spawnImpl);
    const first = await ex.invoke({ ...base, agentStage: "review" }).catch((e) => e);
    expect(first.category).toBe("checkpoint_uncertain");
    const second = await ex.invoke({ ...base, agentStage: "review" }).catch((e) => e);
    expect(second).toBeInstanceOf(AgentRecoveryRequiredError);
    expect(second.reason).toBe("held");
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(auth.finish).not.toHaveBeenCalled();
    expect(auth.dispose).not.toHaveBeenCalled();
  });

  it("refuses a CodexExecutor whose transport does not match the stage before any auth or spawn", async () => {
    const auth = checkpointAuth();
    const spawnImpl = codexSpawn();
    const exec = new CodexExecutor("/tmp", { auth, profileId: "p-plan", spawnImpl, sleepImpl: async () => {} });
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth, createCodex: () => exec });
    const err = await ex.invoke({ ...base, agentStage: "planning" }).catch((e) => e);
    expect(err.code).toBe("CODEX_STAGE_TRANSPORT_MISMATCH");
    expect(err.attribution).toMatchObject({ outcome: "error", agent: "codex", stage: "planning" });
    expect(auth.invoke).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("runs implementation and review on codex exec with the stage sandbox", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const snap = { ...snapshot, stages: { ...snapshot.stages, implementation: { ...snapshot.stages.implementation, agent: "codex" as const, provider: "openai" as const, accountProfileId: "p-rev", model: "gpt-impl" } }, profiles: { ...snapshot.profiles, implementation: { ...snapshot.profiles.review } } };
    const log: Spawned[] = [];
    const auth = checkpointAuth();
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot: snap, auth, allowRepositoryWrites: true, codexOptions: { spawnImpl: codexSpawn({}, log), sleepImpl: async () => {} } });
    await ex.invoke({ ...base, agentStage: "implementation" });
    await ex.invoke({ ...base, agentStage: "review" });
    const sandbox = (a: string[]) => a[a.indexOf("--sandbox") + 1];
    expect(log.map((l) => sandbox(l.args))).toEqual(["workspace-write", "read-only"]);
  });
});

describe("Claude unproven-child hold", () => {
  const live = () => Object.assign(new Error("Process did not exit"), { unresponsive: true, possiblyLive: true, telemetry: { ...ok.telemetry!, outcome: "error" as const } });

  it("gives bounded caller recovery while the auth callback stays pending: no checkpoint, no reuse", async () => {
    const events: string[] = [];
    const auth = fakeAuth(events);
    const claude = fakeExec(live());
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth, createClaude: () => claude as never });
    const err = await ex.invoke({ ...base, agentStage: "implementation" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentRecoveryRequiredError);
    expect(err.reason).toBe("child_not_terminated");
    expect(err.attribution).toMatchObject({ outcome: "error", agent: "claude", profileId: "p-impl" });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(["invoke:p-impl"]);

    const again = await ex.invoke({ ...base, agentStage: "implementation" }).catch((e) => e);
    expect(again).toBeInstanceOf(AgentRecoveryRequiredError);
    expect(again.reason).toBe("held");
    expect(claude.invoke).toHaveBeenCalledTimes(1);
    expect(auth.invoke).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["invoke:p-impl"]);
  });

  it("holds the profile for a Codex stage that shares the same account", async () => {
    const shared = { ...snapshot, stages: { ...snapshot.stages, review: { ...snapshot.stages.review, accountProfileId: "p-impl" } } };
    const createCodex = vi.fn(() => fakeExec());
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot: shared, auth: fakeAuth(), createClaude: () => fakeExec(live()) as never, createCodex });
    await ex.invoke({ ...base, agentStage: "implementation" }).catch(() => {});
    const err = await ex.invoke({ ...base, agentStage: "review" }).catch((e) => e);
    expect(err.reason).toBe("held");
    expect(createCodex).not.toHaveBeenCalled();
  });

  it("does not hold on an ordinary Claude failure; the checkpoint still runs", async () => {
    const events: string[] = [];
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth: fakeAuth(events), createClaude: () => fakeExec(new Error("boom")) as never });
    await expect(ex.invoke({ ...base, agentStage: "implementation" })).rejects.toThrow("boom");
    expect(events).toEqual(["invoke:p-impl", "checkpoint"]);
    await expect(ex.invoke({ ...base, agentStage: "implementation" })).rejects.toThrow("boom");
  });
});

describe("Claude invocation deadline with real process mechanics", () => {
  function realExecutor() {
    // A real `sh` child that ignores nothing: sleeps in its own process group (spawned detached by the executor).
    const dir = mkdtempSync(join(tmpdir(), "stage-claude-"));
    return dir;
  }

  it("terminates the process group at the snapshot deadline, settles only after confirmed stop, then checkpoints", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = realExecutor();
    const pidFile = join(dir, "pids");
    const script = join(dir, "claude");
    writeFileSync(script, `#!/bin/sh\nsleep 30 &\necho "$$ $!" > "${pidFile}"\nwait\n`, { mode: 0o755 });
    const realSpawn = ((_c: string, args: string[], o: object) => nodeSpawn(script, args, o as never)) as unknown as typeof spawn;
    const short = { ...snapshot, stages: { ...snapshot.stages, implementation: { ...snapshot.stages.implementation, invocationTimeoutMs: 300 } } };
    const events: string[] = [];
    const claude = new ClaudeCliExecutor(dir, "summary", true, realSpawn, undefined, undefined, { termMs: 500, killMs: 500 });
    const ex = createStageExecutor({ workspaceDir: dir, legacy: fakeExec(), snapshot: short, auth: fakeAuth(events), createClaude: () => claude });
    const started = Date.now();
    const res = await ex.invoke({ ...base, agentStage: "implementation" });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.failure?.code).toBe("INVOCATION_TIMEOUT");
    expect(events).toEqual(["invoke:p-impl", "checkpoint"]);
    const [leader, child] = readFileSync(pidFile, "utf8").trim().split(" ").map(Number);
    for (const pid of [leader, child]) {
      // Gone, or an unreaped zombie (a container PID 1 may not reap orphans); never a live process.
      let state = "gone";
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      } catch {}
      expect(["gone", "Z"]).toContain(state);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
