import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
import { runLocalFullLoop } from "../local/full-loop.js";
import { PipelineRunner } from "../pipeline/runner.js";
import type { LLMExecutor, PipelineDefinition, StepModule } from "../pipeline/types.js";
import { getDiff } from "../pipeline/steps/feedback-loop.js";
import { fakeClient, makeGrant, makeSnapshot } from "./configured-run-fixture.js";
import { encodeTrustedRunConfig, type ResolvedAgentSnapshotV1 } from "../run-config.js";

function makeMockExecutor(exitCode = 0): LLMExecutor {
  return {
    invoke: vi.fn().mockResolvedValue({ stdout: "", exitCode, tokensUsed: 0 }),
  };
}

function planningExecutorWithPlan() {
  return (_prompt: string, _args: string[], cwd: string) => {
    mkdirSync(join(cwd, "ai-output", "comments"), { recursive: true });
    writeFileSync(join(cwd, "ai-output", "comments", "01-plan.md"), "# Plan\nDo the thing");
    return { status: 0 as const, stdout: "", stderr: "" };
  };
}

function makeFeedbackLoopPipeline(mod: StepModule): {
  pipeline: PipelineDefinition;
  runner: PipelineRunner;
} {
  const pipeline: PipelineDefinition = {
    id: "test-local-full-loop",
    steps: [
      {
        id: "feedback-loop",
        type: "custom",
        moduleId: "feedback-loop",
        inputs: (ctx) => ({
          workspaceDir: ctx.data.workspaceDir,
          issueTitle: ctx.data.issueTitle,
          issueDescription: ctx.data.issueDescription,
          implementationPrompt: ctx.data.implementationPrompt,
          planningContext: ctx.data.planningContext,
          provider: ctx.data.provider,
          maxTurns: ctx.data.maxTurns,
          maxIterations: ctx.data.maxIterations,
        }),
      },
    ],
  };
  const runner = new PipelineRunner().register("feedback-loop", mod);
  return { pipeline, runner };
}

function planningSpawnWithPlan(workspaceDir: string): typeof spawn {
  return ((_cmd: string, _args: readonly string[]) => {
    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stream = () => Object.assign(new EventEmitter(), { destroy: () => {}, end: () => {} });
    proc.stdout = stream();
    proc.stderr = stream();
    proc.stdin = Object.assign(stream(), { write: () => undefined, end: () => undefined });
    proc.pid = 0;
    proc.kill = () => true;
    setImmediate(() => {
      mkdirSync(join(workspaceDir, "ai-output", "comments"), { recursive: true });
      writeFileSync(join(workspaceDir, "ai-output", "comments", "01-plan.md"), "# Plan\nUse the configured executor.");
      const line = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1 }) + "\n";
      (proc.stdout as EventEmitter).emit("data", Buffer.from(line));
      proc.emit("close", 0, null);
    });
    return proc;
  }) as unknown as typeof spawn;
}

function makeClaudeSnapshot(): ResolvedAgentSnapshotV1 {
  const snap = makeSnapshot("anthropic-api-key");
  return {
    ...snap,
    stages: {
      planning: snap.stages.planning,
      implementation: { ...snap.stages.implementation, agent: "claude", provider: "anthropic", model: "claude-impl", accountProfileId: "p-impl" },
      review: snap.stages.review,
    },
    profiles: {
      planning: snap.profiles.planning,
      implementation: { id: "p-impl", identity: "b", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" },
      review: snap.profiles.review,
    },
  };
}

describe("runLocalFullLoop", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "full-loop-test-"));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("returns exitCode 0 and classification 'success' when planning and review succeed", async () => {
    const planningExecutor = (_prompt: string, _args: string[], cwd: string) => {
      mkdirSync(join(cwd, "ai-output", "comments"), { recursive: true });
      writeFileSync(join(cwd, "ai-output", "comments", "01-plan.md"), "# Plan\nDo the thing");
      return { status: 0 as const, stdout: "", stderr: "" };
    };

    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: true,
        iterations: 1,
        terminationReason: "approved",
        passes: [],
        finalFeedback: "",
      }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test issue",
      issueDescription: "Test description",
      planningExecutor,
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.classification).toBe("success");
    expect(result.reviewApproved).toBe(true);
    expect(result.planningExitCode).toBe(0);
    expect(result.implementationExitCode).toBe(0);
  });

  it("returns exitCode 1 and classification 'plan_failed' when planning executor fails", async () => {
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({ approved: true }),
    });
    const implRun = runner;

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test issue",
      issueDescription: "Test description",
      planningExecutor: () => ({ status: 1 as const, stdout: "", stderr: "boom" }),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner: implRun,
    });

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe("plan_failed");
    expect(result.planningExitCode).toBe(1);
    expect(result.planningContext).toBe("");
  });

  it("does not call implementation when planning fails", async () => {
    const implRun = vi.fn().mockResolvedValue({ approved: true });
    const { pipeline, runner } = makeFeedbackLoopPipeline({ run: implRun });

    await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      planningExecutor: () => ({ status: 1 as const, stdout: "", stderr: "" }),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(implRun).not.toHaveBeenCalled();
  });

  it("returns exitCode 1 and classification 'implementation_failed' when pipeline throws", async () => {
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockRejectedValue(new Error("pipeline exploded")),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test issue",
      issueDescription: "Test description",
      planningExecutor: planningExecutorWithPlan(),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe("implementation_failed");
    expect(result.implementationExitCode).toBe(1);
    expect(result.reviewApproved).toBe(false);
  });

  it("returns exitCode 1 and classification 'review_unapproved' when approved=false with unknown termination", async () => {
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: false,
        iterations: 2,
        terminationReason: "unknown",
        passes: [],
        finalFeedback: "needs more work",
      }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test issue",
      issueDescription: "Test description",
      planningExecutor: planningExecutorWithPlan(),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe("review_unapproved");
    expect(result.reviewApproved).toBe(false);
    expect(result.finalFeedback).toBe("needs more work");
    expect(result.iterations).toBe(2);
  });

  it("returns exitCode 1 and classification 'max_turns_exhausted' when terminationReason is max_turns", async () => {
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: false,
        iterations: 1,
        terminationReason: "max_turns",
        passes: [],
        finalFeedback: "ran out of turns",
      }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test issue",
      issueDescription: "Test description",
      planningExecutor: planningExecutorWithPlan(),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe("max_turns_exhausted");
  });

  it("passes planning context from planning phase into the implementation phase", async () => {
    const planningExecutor = (_prompt: string, _args: string[], cwd: string) => {
      mkdirSync(join(cwd, "ai-output", "comments"), { recursive: true });
      writeFileSync(join(cwd, "ai-output", "comments", "01-plan.md"), "## Planning\nContext data");
      return { status: 0 as const, stdout: "", stderr: "" };
    };

    let capturedPlanningContext: unknown;
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockImplementation(async (ctx) => {
        capturedPlanningContext = ctx.data.planningContext;
        return {
          approved: true,
          iterations: 1,
          terminationReason: "approved",
          passes: [],
          finalFeedback: "",
        };
      }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      planningExecutor,
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(result.planningContext).toContain("Context data");
    expect(capturedPlanningContext).toContain("Context data");
  });

  it("keeps planning scratch files out of the implementation review diff", async () => {
    spawnSync("git", ["init"], { cwd: ws });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: ws });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: ws });
    writeFileSync(join(ws, "source.txt"), "original\n");
    spawnSync("git", ["add", "source.txt"], { cwd: ws });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: ws });

    let reviewedDiff = "";
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockImplementation(async (ctx) => {
        reviewedDiff = getDiff(String(ctx.data.workspaceDir));
        return {
          approved: true,
          iterations: 1,
          terminationReason: "approved",
          passes: [],
          finalFeedback: "",
        };
      }),
    });

    await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      planningExecutor: planningExecutorWithPlan(),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(reviewedDiff).not.toContain("ai-output/comments");
  });

  it("exposes phase outcomes, review status, limits, passes, and tokenSummary in the result", async () => {
    const passes = [
      { iteration: 1, implementTurns: 8, implementOutcome: "ok", costUsd: 0.02, reviewApproved: true },
    ];
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: true,
        iterations: 1,
        terminationReason: "approved",
        passes,
        finalFeedback: "",
      }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      maxTurns: 20,
      maxIterations: 3,
      planningExecutor: planningExecutorWithPlan(),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.reviewApproved).toBe(true);
    expect(result.reviewTerminationReason).toBe("approved");
    expect(result.iterations).toBe(1);
    expect(result.passes).toEqual(passes);
    expect(result.planningExitCode).toBe(0);
    expect(result.implementationExitCode).toBe(0);
    expect(result.effectiveMaxTurns).toBe(20);
    expect(result.effectiveMaxIterations).toBe(3);
    expect(result.tokenSummary).toMatchObject({ costUsd: 0.02 });
    expect(result.planFound).toBe(true);
  });

  it("sets reviewTerminationReason to null when not provided (plan_failed short-circuit)", async () => {
    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      planningExecutor: () => ({ status: 1 as const, stdout: "", stderr: "" }),
      llmExecutor: makeMockExecutor(0),
    });

    expect(result.classification).toBe("plan_failed");
    expect(result.reviewTerminationReason).toBeNull();
  });

  it("returns plan_failed when planning exits 0 but writes no plan files", async () => {
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({ approved: true, iterations: 1, terminationReason: "approved", passes: [], finalFeedback: "" }),
    });
    const implRun = runner;

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      planningExecutor: () => ({ status: 0 as const, stdout: "", stderr: "" }),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner: implRun,
    });

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe("plan_failed");
    expect(result.planFound).toBe(false);
    expect(result.planDiagnostics).toContain("no readable Markdown plan");
  });

  it("does not call implementation when planning exits 0 but writes no plan files", async () => {
    const implRun = vi.fn();
    const { pipeline, runner } = makeFeedbackLoopPipeline({ run: implRun });

    await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      planningExecutor: () => ({ status: 0 as const, stdout: "", stderr: "" }),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(implRun).not.toHaveBeenCalled();
  });

  it("returns iterations_exhausted when terminationReason is iterations_exhausted", async () => {
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: false,
        iterations: 3,
        terminationReason: "iterations_exhausted",
        passes: [],
        finalFeedback: "all iterations used",
      }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      planningExecutor: planningExecutorWithPlan(),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe("iterations_exhausted");
    expect(result.reviewApproved).toBe(false);
  });

  it("returns review_error when terminationReason is review_error", async () => {
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: false,
        iterations: 1,
        terminationReason: "review_error",
        passes: [],
        finalFeedback: "review threw an exception",
      }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      planningExecutor: planningExecutorWithPlan(),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe("review_error");
  });

  it("returns effectiveMaxTurns and effectiveMaxIterations using defaults when not specified", async () => {
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: true,
        iterations: 1,
        terminationReason: "approved",
        passes: [],
        finalFeedback: "",
      }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      planningExecutor: planningExecutorWithPlan(),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(result.effectiveMaxTurns).toBe(50);
    expect(result.effectiveMaxIterations).toBe(3);
  });

  it("returns tokenSummary with aggregated costUsd from passes", async () => {
    const passes = [
      { iteration: 1, implementTurns: 5, implementOutcome: "ok", costUsd: 0.10, reviewApproved: false },
      { iteration: 2, implementTurns: 5, implementOutcome: "ok", costUsd: 0.15, reviewApproved: true },
    ];
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: true,
        iterations: 2,
        terminationReason: "approved",
        passes,
        finalFeedback: "",
      }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      planningExecutor: planningExecutorWithPlan(),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(result.tokenSummary).not.toBeNull();
    expect(result.tokenSummary!.costUsd).toBeCloseTo(0.25);
    expect(result.tokenSummary!.tokensIn).toBeNull();
    expect(result.tokenSummary!.tokensOut).toBeNull();
  });

  it.skipIf(isWindows)("returns verification_failed when verify hook exits nonzero", async () => {
    writeFileSync(join(ws, "WORKFLOW.md"), "---\nverify: verify.sh\n---\nImplement the issue.\n");
    writeFileSync(join(ws, "verify.sh"), "exit 1\n");

    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: true,
        iterations: 1,
        terminationReason: "approved",
        passes: [],
        finalFeedback: "",
      }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      planningExecutor: planningExecutorWithPlan(),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe("verification_failed");
  });

  it("plan_failed short-circuit exposes effectiveMaxTurns and effectiveMaxIterations from opts", async () => {
    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      maxTurns: 30,
      maxIterations: 5,
      planningExecutor: () => ({ status: 1 as const, stdout: "", stderr: "planning failed" }),
      llmExecutor: makeMockExecutor(0),
    });

    expect(result.classification).toBe("plan_failed");
    expect(result.effectiveMaxTurns).toBe(30);
    expect(result.effectiveMaxIterations).toBe(5);
    expect(result.tokenSummary).toBeNull();
  });

  it("does not fall back to legacy planning when configured env has a grant but no snapshot", async () => {
    const snapshot = makeSnapshot();
    const planningExecutor = vi.fn(() => ({ status: 0 as const, stdout: "", stderr: "" }));
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({ approved: true, iterations: 1, terminationReason: "approved", passes: [], finalFeedback: "" }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      planningExecutor,
      configuredEnv: {
        AI_IMPLEMENT_RUN_CONFIG: encodeTrustedRunConfig({
          v: 1,
          issue: { id: "issue-1", identifier: "LOCAL-1", title: "T", description: "D" },
          runnerPhase: "implementation",
          credentials: { version: 1, modelAuthGrant: makeGrant(snapshot) },
        }),
      } as NodeJS.ProcessEnv,
      pipeline,
      runner,
    });

    expect(result.classification).toBe("plan_failed");
    expect(result.planDiagnostics).toContain("snapshot_incomplete");
    expect(planningExecutor).not.toHaveBeenCalled();
  });

  it("does not fall back to legacy planning when configured env only has a local bootstrap pointer", async () => {
    const planningExecutor = vi.fn(() => ({ status: 0 as const, stdout: "", stderr: "" }));
    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      planningExecutor,
      configuredEnv: {
        AI_IMPLEMENT_LOCAL_AUTH_BOOTSTRAP_FILE: "/private/bootstrap-secret.json",
      } as NodeJS.ProcessEnv,
    });

    expect(result.classification).toBe("plan_failed");
    expect(result.planDiagnostics).toContain("bootstrap_missing");
    expect(planningExecutor).not.toHaveBeenCalled();
  });

  it("logs a static category when configured finish callback fails", async () => {
    const snapshot = makeClaudeSnapshot();
    const client = fakeClient();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({ approved: true, iterations: 1, terminationReason: "approved", passes: [], finalFeedback: "" }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      agentConfig: snapshot,
      configured: {
        agentConfig: snapshot,
        localCredentialPort: { load: vi.fn() },
        modelAuthClient: client,
      },
      onConfiguredFinish: vi.fn().mockRejectedValue(new Error("secret callback detail")),
      spawnImpl: planningSpawnWithPlan(ws),
      pipeline,
      runner,
    });

    expect(result.classification).toBe("provider_unavailable");
    expect(log).toHaveBeenCalledWith("[dev:run] configured finish callback failed: callback_error");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret callback detail");
    log.mockRestore();
  });

  it("prepares one configured run for planning, implementation, and review, then finishes it once", async () => {
    const snapshot = makeClaudeSnapshot();
    const client = fakeClient();
    const onConfiguredFinish = vi.fn(async () => undefined);
    const llmExecutor = makeMockExecutor(0);
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockImplementation(async (ctx) => {
        await ctx.llmExecutor.invoke({ prompt: "implement", model: "caller", agentStage: "implementation" });
        await ctx.llmExecutor.invoke({ prompt: "review", model: "caller", agentStage: "review" });
        return { approved: true, iterations: 1, terminationReason: "approved", passes: [], finalFeedback: "" };
      }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      agentConfig: snapshot,
      configured: {
        agentConfig: snapshot,
        localCredentialPort: { load: vi.fn() },
        modelAuthClient: client,
      },
      llmExecutor,
      onConfiguredFinish,
      spawnImpl: planningSpawnWithPlan(ws),
      pipeline,
      runner,
    });

    expect(result.classification).toBe("success");
    expect(client.invoke.mock.calls.map((c) => c[0])).toEqual(["p-plan", "p-impl", "p-rev"]);
    expect(client.checkout.mock.calls.map((c) => c[0].profileId)).toEqual(["p-plan", "p-impl", "p-rev"]);
    expect(client.finish.mock.calls.map((c) => c[0])).toEqual(["p-plan", "p-impl", "p-rev"]);
    expect(client.dispose).toHaveBeenCalledTimes(1);
    expect(onConfiguredFinish).toHaveBeenCalledWith(true);
  });

  it("holds configured cleanup when a selected child may still be live", async () => {
    const snapshot = makeClaudeSnapshot();
    const client = fakeClient();
    const onConfiguredFinish = vi.fn(async () => undefined);
    const llmExecutor: LLMExecutor = { invoke: vi.fn().mockRejectedValue(Object.assign(new Error("child still running"), { possiblyLive: true })) };
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockImplementation(async (ctx) => {
        await ctx.llmExecutor.invoke({ prompt: "implement", model: "caller", agentStage: "implementation" });
        return { approved: true, iterations: 1, terminationReason: "approved", passes: [], finalFeedback: "" };
      }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      agentConfig: snapshot,
      configured: {
        agentConfig: snapshot,
        localCredentialPort: { load: vi.fn() },
        modelAuthClient: client,
      },
      llmExecutor,
      onConfiguredFinish,
      spawnImpl: planningSpawnWithPlan(ws),
      pipeline,
      runner,
    });

    expect(result.classification).toBe("implementation_failed");
    expect(client.finish).not.toHaveBeenCalled();
    expect(client.dispose).not.toHaveBeenCalled();
    expect(onConfiguredFinish).toHaveBeenCalledWith(false);
  });
});
