import { describe, it, expect, vi, beforeEach } from "vitest";
import { implementStep } from "../pipeline/steps/implement.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type { LLMExecutor, LLMResult } from "../pipeline/types.js";

function makeExecutor(overrides: Partial<LLMResult> = {}): LLMExecutor {
  return {
    invoke: vi.fn().mockResolvedValue({
      stdout: "",
      exitCode: 0,
      tokensUsed: 100,
      ...overrides,
    }),
  };
}

function makeContext(executor?: LLMExecutor): DefaultPipelineContext {
  return new DefaultPipelineContext(
    {
      jobId: 1,
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      issueTitle: "Test",
      issueDescription: "Description",
      nonce: "nonce",
      orchestratorUrl: "http://localhost:8080",
    },
    executor ?? makeExecutor(),
  );
}

describe("implementStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes executor with provided prompt and model", async () => {
    const executor = makeExecutor();
    const ctx = makeContext(executor);

    await implementStep.run(
      ctx,
      { workspaceDir: "/tmp/test", prompt: "Implement feature X", model: "claude-sonnet-4-5" },
      new NoopStepReporter(),
    );

    expect(executor.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Implement feature X", model: "claude-sonnet-4-5" }),
    );
  });

  it("defaults model to claude-sonnet-4-6 when not specified", async () => {
    const executor = makeExecutor();
    const ctx = makeContext(executor);

    await implementStep.run(
      ctx,
      { workspaceDir: "/tmp/test", prompt: "Do it" },
      new NoopStepReporter(),
    );

    expect(executor.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6" }),
    );
  });

  it("appends planning context to prompt when provided", async () => {
    const executor = makeExecutor();
    const ctx = makeContext(executor);

    await implementStep.run(
      ctx,
      { workspaceDir: "/tmp/test", prompt: "Do it", planningContext: "Use factory pattern" },
      new NoopStepReporter(),
    );

    const call = vi.mocked(executor.invoke).mock.calls[0][0];
    expect(call.prompt).toContain("Planning Context");
    expect(call.prompt).toContain("Use factory pattern");
  });

  it("returns tokensUsed from executor result", async () => {
    const executor = makeExecutor({ tokensUsed: 500 });
    const ctx = makeContext(executor);

    const outputs = await implementStep.run(
      ctx,
      { workspaceDir: "/tmp/test", prompt: "Do it" },
      new NoopStepReporter(),
    );

    expect(outputs.tokensUsed).toBe(500);
    expect(outputs.exitCode).toBe(0);
    expect(outputs.subagentCount).toBe(0);
  });

  it("throws when executor returns non-zero exit code", async () => {
    const executor = makeExecutor({ exitCode: 1 });
    const ctx = makeContext(executor);

    await expect(
      implementStep.run(ctx, { workspaceDir: "/tmp/test", prompt: "Do it" }, new NoopStepReporter()),
    ).rejects.toThrow("exit code 1");
  });

  it("propagates executor rejection", async () => {
    const executor: LLMExecutor = {
      invoke: vi.fn().mockRejectedValue(new Error("network error")),
    };
    const ctx = makeContext(executor);

    await expect(
      implementStep.run(ctx, { workspaceDir: "/tmp/test", prompt: "Do it" }, new NoopStepReporter()),
    ).rejects.toThrow("network error");
  });

  it("passes maxTurns to executor", async () => {
    const executor = makeExecutor();
    const ctx = makeContext(executor);

    await implementStep.run(
      ctx,
      { workspaceDir: "/tmp/test", prompt: "Do it", maxTurns: 5 },
      new NoopStepReporter(),
    );

    expect(executor.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ maxTurns: 5 }),
    );
  });

  it("includes executor telemetry in outputs", async () => {
    const telemetry = {
      outcome: "success" as const,
      numTurns: 12,
      durationMs: 1000,
      costUsd: 0.5,
      tokensIn: 100,
      tokensOut: 50,
      toolTrace: ["Bash npm test"],
    };
    const executor = makeExecutor({ stdout: "done", exitCode: 0, tokensUsed: 150, telemetry });
    const ctx = makeContext(executor);

    const outputs = await implementStep.run(
      ctx,
      { workspaceDir: "/tmp/test", prompt: "Do it" },
      new NoopStepReporter(),
    );

    expect(outputs.telemetry).toEqual(telemetry);
  });

  it("does not throw on non-zero exit when the outcome is max_turns", async () => {
    const telemetry = {
      outcome: "max_turns" as const,
      numTurns: 50,
      durationMs: 1000,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
      toolTrace: [],
    };
    const executor = makeExecutor({ stdout: "", exitCode: 1, tokensUsed: 0, telemetry });
    const ctx = makeContext(executor);

    const outputs = await implementStep.run(
      ctx,
      { workspaceDir: "/tmp/test", prompt: "Do it" },
      new NoopStepReporter(),
    );

    expect(outputs.telemetry?.outcome).toBe("max_turns");
  });
});
