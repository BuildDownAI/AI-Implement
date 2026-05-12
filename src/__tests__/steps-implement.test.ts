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
      ticketingProvider: "linear",
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

  it("appends work units section and parallel instructions when workUnits provided", async () => {
    const executor = makeExecutor();
    const ctx = makeContext(executor);

    await implementStep.run(
      ctx,
      {
        workspaceDir: "/tmp/test",
        prompt: "Do it",
        workUnits: [{ id: "WU-1", title: "Auth module", files: ["src/auth.ts"] }],
      },
      new NoopStepReporter(),
    );

    const call = vi.mocked(executor.invoke).mock.calls[0][0];
    expect(call.prompt).toContain("WU-1: Auth module");
    expect(call.prompt).toContain("src/auth.ts");
    expect(call.prompt).toContain("parallel");
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
});
