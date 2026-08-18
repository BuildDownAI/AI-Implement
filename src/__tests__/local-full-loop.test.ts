import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLocalFullLoop } from "../local/full-loop.js";
import { PipelineRunner } from "../pipeline/runner.js";
import type { LLMExecutor, PipelineDefinition, StepModule } from "../pipeline/types.js";

function makeMockExecutor(exitCode = 0): LLMExecutor {
  return {
    invoke: vi.fn().mockResolvedValue({ stdout: "", exitCode, tokensUsed: 0 }),
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
      planningExecutor: () => ({ status: 0 as const, stdout: "", stderr: "" }),
      llmExecutor: makeMockExecutor(0),
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.classification).toBe("implementation_failed");
    expect(result.implementationExitCode).toBe(1);
    expect(result.reviewApproved).toBe(false);
  });

  it("returns exitCode 1 and classification 'review_unapproved' when approved=false", async () => {
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: false,
        iterations: 2,
        terminationReason: "iterations_exhausted",
        passes: [],
        finalFeedback: "needs more work",
      }),
    });

    const result = await runLocalFullLoop({
      workspaceDir: ws,
      issueIdentifier: "TEST-1",
      issueTitle: "Test issue",
      issueDescription: "Test description",
      planningExecutor: () => ({ status: 0 as const, stdout: "", stderr: "" }),
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
      planningExecutor: () => ({ status: 0 as const, stdout: "", stderr: "" }),
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

  it("exposes phase outcomes, review status, limits, and passes in the result", async () => {
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
      planningExecutor: () => ({ status: 0 as const, stdout: "", stderr: "" }),
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
});
