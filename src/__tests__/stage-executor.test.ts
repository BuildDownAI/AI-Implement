import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { AgentRecoveryRequiredError, AgentStageError, createStageExecutor, safeLimitLabel, safeModelLabel } from "../pipeline/stage-executor.js";
import { ClaudeCliExecutor } from "../pipeline/executor.js";
import { CodexRecoveryRequiredError } from "../pipeline/codex-executor.js";
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
    const ex = createStageExecutor({
      workspaceDir: "/tmp",
      legacy: fakeExec(),
      snapshot,
      auth,
      createClaude: () => claude as never,
      createCodex: (id) => codex.set(id, fakeExec()).get(id)!,
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

  it("caches one executor per agent/profile across calls", async () => {
    const createCodex = vi.fn(() => fakeExec());
    const createClaude = vi.fn(() => fakeExec() as never);
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth: fakeAuth(), createClaude, createCodex });
    for (let i = 0; i < 2; i++) {
      await ex.invoke({ ...base, agentStage: "implementation" });
      await ex.invoke({ ...base, agentStage: "review" });
    }
    expect(createClaude).toHaveBeenCalledTimes(1);
    expect(createCodex).toHaveBeenCalledTimes(1);
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
    const ex = createStageExecutor({ createCodex: () => fakeExec(), workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth, createClaude: () => fakeExec() as never });
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
    const ex = createStageExecutor({ createCodex: () => fakeExec(), workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth: fakeAuth(events), createClaude: () => claude });
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

  // Planning is mapped to the implementation selection so these exec-path tests need no protocol driver.
  const execSnapshot: ResolvedAgentSnapshotV1 = {
    ...snapshot,
    stages: { ...snapshot.stages, planning: { ...snapshot.stages.implementation } },
    profiles: { ...snapshot.profiles, planning: { ...snapshot.profiles.implementation } },
  };

  const make = (auth: ReturnType<typeof checkpointAuth>, spawnImpl: typeof spawn) =>
    createStageExecutor({
      workspaceDir: "/tmp",
      legacy: fakeExec(),
      snapshot: execSnapshot,
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
    expect(again).toBeInstanceOf(CodexRecoveryRequiredError);
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
    expect(second).toBeInstanceOf(CodexRecoveryRequiredError);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(auth.finish).not.toHaveBeenCalled();
    expect(auth.dispose).not.toHaveBeenCalled();
  });

  it("routes planning=codex to the app-server planning argv, distinct from implementation and review", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const log: Spawned[] = [];
    const spawnImpl = codexSpawn({ hang: true }, log);
    const run = vi.fn(async (input: { io: { stdin: { end(): void } } }) => {
      input.io.stdin.end();
      return { result: { ...ok, stdout: "plan" }, sawUnsafe: false, stopReason: null as null };
    });
    const auth = checkpointAuth();
    const driverSnapshot: ResolvedAgentSnapshotV1 = {
      ...snapshot,
      stages: { ...snapshot.stages, implementation: { ...snapshot.stages.review, model: "gpt-impl" } },
      profiles: { ...snapshot.profiles, implementation: { ...snapshot.profiles.review } },
    };
    const ex = createStageExecutor({
      workspaceDir: "/tmp",
      legacy: fakeExec(),
      snapshot: driverSnapshot,
      auth,
      allowRepositoryWrites: true,
      codexOptions: { spawnImpl, sleepImpl: async () => {}, termWaitMs: 20, killWaitMs: 20, protocolDriver: { run } as never },
    });
    const planning = await ex.invoke({ ...base, agentStage: "planning" }).catch((e) => e);
    expect(planning.code).not.toBe("CODEX_PLANNING_POLICY_UNPROVEN");
    const planArgs = log[0]?.args ?? [];
    // Implementation/review use the exec path; they reuse the review-style spawn mock that completes.
    const execSpawn = codexSpawn({}, log);
    const exec = createStageExecutor({
      workspaceDir: "/tmp",
      legacy: fakeExec(),
      snapshot: { ...driverSnapshot, stages: { ...driverSnapshot.stages, planning: { ...driverSnapshot.stages.review } }, profiles: { ...driverSnapshot.profiles, planning: { ...driverSnapshot.profiles.review } } },
      auth: checkpointAuth(),
      allowRepositoryWrites: true,
      codexOptions: { spawnImpl: execSpawn, sleepImpl: async () => {}, termWaitMs: 20, killWaitMs: 20 },
    });
    await exec.invoke({ ...base, agentStage: "implementation" });
    await exec.invoke({ ...base, agentStage: "review" });
    const implArgs = log[1].args;
    const reviewArgs = log[2].args;
    expect(planArgs[0]).toBe("app-server");
    expect(planArgs).toContain('sandbox_mode="read-only"');
    expect(planArgs).toContain("features.shell_tool=false");
    expect(implArgs).toContain("workspace-write");
    expect(reviewArgs).toContain("read-only");
    for (const args of [planArgs, implArgs, reviewArgs]) {
      expect(args.join(" ")).not.toMatch(/bypass|dangerously|--yolo|full-access|--max-turns|--allowedTools/);
    }
    expect(planArgs).not.toContain("workspace-write");
    expect(planArgs).not.toEqual(reviewArgs);
    expect(planArgs).not.toEqual(implArgs);
  });
});

describe("static attribution validation", () => {
  const withImplModel = (model: string): ResolvedAgentSnapshotV1 => ({
    ...snapshot,
    stages: { ...snapshot.stages, implementation: { ...snapshot.stages.implementation, model } },
  });
  const withImplProfileId = (id: string): ResolvedAgentSnapshotV1 => ({
    ...snapshot,
    profiles: { ...snapshot.profiles, implementation: { ...snapshot.profiles.implementation, id } },
  });
  const withSnapshotId = (snapshotId: string): ResolvedAgentSnapshotV1 => ({ ...snapshot, snapshotId });

  it.each([
    ["overlong model", withImplModel("m".repeat(300)), "m".repeat(50)],
    ["credential-shaped model", withImplModel("sk-ant-abcdefghijklmnop0123"), "sk-ant-abcdefghijklmnop0123"],
    ["model with whitespace", withImplModel("bad model\nname"), "bad model"],
    ["invalid profile id", withImplProfileId("profile id with spaces"), "profile id with spaces"],
    ["invalid snapshot id", withSnapshotId("snap\u0000id"), "snap"],
  ])("fails closed before auth or spawn for %s without echoing it", async (_name, bad, leaked) => {
    const auth = fakeAuth();
    const claude = fakeExec();
    const ex = createStageExecutor({ createCodex: () => fakeExec(), workspaceDir: "/tmp", legacy: fakeExec(), snapshot: bad, auth, createClaude: () => claude as never });
    const err = await ex.invoke({ ...base, agentStage: "implementation" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentStageError);
    expect(String(err.message).length).toBeLessThan(200);
    expect(String(err.message)).not.toContain(leaked);
    expect(err.attribution).toBeUndefined();
    expect(auth.invoke).not.toHaveBeenCalled();
    expect(claude.invoke).not.toHaveBeenCalled();
  });

  it("strips only usage from a valid static projection when usage is unusable", async () => {
    const bad = { ...ok, telemetry: { ...ok.telemetry!, tokensIn: -5 } } as LLMResult;
    const ex = createStageExecutor({ createCodex: () => fakeExec(), workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth: fakeAuth(), createClaude: () => fakeExec(bad) as never });
    const result = await ex.invoke({ ...base, agentStage: "implementation" });
    expect(result.attribution).toMatchObject({ agent: "claude", model: "claude-impl", profileId: "p-impl", limit: { kind: "max_turns", value: 7 } });
    expect(result.attribution?.usage).toBeNull();
  });
});

describe("held profiles across stages", () => {
  /** A Claude child that never exits and cannot be killed: death stays unproven. */
  function liveChildSpawn() {
    return vi.fn(() => {
      const mk = () => Object.assign(new EventEmitter(), { destroy: () => {} });
      const proc = Object.assign(new EventEmitter(), { stdout: mk(), stderr: mk(), stdin: Object.assign(new PassThrough(), { destroy: () => {} }), kill: () => true, unref: () => {} });
      return proc as unknown as ChildProcessWithoutNullStreams;
    });
  }

  /** Pending-callback auth: records whether the callback ever settled and when a checkpoint would run. */
  function pendingAuth() {
    const events: string[] = [];
    const invoke = vi.fn(async <T>(profileId: string, run: (i: ModelInvocation) => Promise<T>): Promise<T> => {
      events.push(`invoke:${profileId}`);
      try {
        return await run({ env: { PATH: "/bin", ANTHROPIC_API_KEY: "synthetic-selected-key-0000" }, strippedKeys: [] });
      } finally {
        events.push("checkpoint");
      }
    });
    return { invoke, events } as unknown as Pick<ModelAuthClient, "invoke"> & { invoke: typeof invoke; events: string[] };
  }

  it("keeps the Claude auth callback pending for a possibly-live child and refuses every later Claude call", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const spawnMock = liveChildSpawn();
    const claude = new ClaudeCliExecutor("/tmp", "summary", true, spawnMock as unknown as typeof spawn, undefined, undefined, undefined, { termWaitMs: 10, killWaitMs: 10 });
    const auth = pendingAuth();
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth, createClaude: () => claude, createCodex: () => fakeExec() });
    const err = await ex.invoke({ ...base, agentStage: "implementation", invocationTimeoutMs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentRecoveryRequiredError);
    expect(err.reason).toBe("child_possibly_live");
    expect(err.attribution).toMatchObject({ outcome: "error", agent: "claude" });
    // No checkpoint, release or reuse: the callback is still pending.
    await new Promise((r) => setTimeout(r, 30));
    expect(auth.events).toEqual(["invoke:p-impl"]);
    // The profile and the workspace's Claude child are held for every stage.
    const again = await ex.invoke({ ...base, agentStage: "implementation" }).catch((e) => e);
    expect(again).toBeInstanceOf(AgentRecoveryRequiredError);
    expect(auth.invoke).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("holds a shared Codex profile for every stage that selects it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const shared: ResolvedAgentSnapshotV1 = {
      ...snapshot,
      stages: { ...snapshot.stages, implementation: { ...snapshot.stages.review } },
      profiles: { ...snapshot.profiles, implementation: { ...snapshot.profiles.review } },
    };
    const held = new CodexRecoveryRequiredError("child_not_terminated");
    const review = fakeExec(held);
    const auth = pendingAuth();
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot: shared, auth, createClaude: () => ({ invoke: vi.fn() }), createCodex: () => review });
    // Implementation shares review's profile, so the hold applies to it too.
    const first = await ex.invoke({ ...base, agentStage: "review" }).catch((e) => e);
    expect(first).toBe(held);
    const second = await ex.invoke({ ...base, agentStage: "implementation" }).catch((e) => e);
    expect(second).toBeInstanceOf(CodexRecoveryRequiredError);
    expect(second.reason).toBe("held");
    expect(review.invoke).toHaveBeenCalledTimes(1);
  });

  it("holds a Claude profile after an uncertain checkpoint", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const auth = { invoke: vi.fn(async () => { throw Object.assign(new Error("uncertain"), { category: "checkpoint_uncertain" }); }) } as unknown as Pick<ModelAuthClient, "invoke"> & { invoke: ReturnType<typeof vi.fn> };
    const ex = createStageExecutor({ workspaceDir: "/tmp", legacy: fakeExec(), snapshot, auth, createClaude: () => ({ invoke: vi.fn() }), createCodex: () => fakeExec() });
    await ex.invoke({ ...base, agentStage: "implementation" }).catch(() => {});
    const again = await ex.invoke({ ...base, agentStage: "implementation" }).catch((e) => e);
    expect(again).toBeInstanceOf(AgentRecoveryRequiredError);
    expect(auth.invoke).toHaveBeenCalledTimes(1);
  });
});
