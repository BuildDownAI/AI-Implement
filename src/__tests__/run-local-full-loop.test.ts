import { describe, expect, it, vi } from "vitest";
import { encodeRunConfig } from "../run-config.js";
import { runLocalFullLoopFromEnv } from "../run-local-full-loop.js";

describe("runLocalFullLoopFromEnv", () => {
  it("runs planning and implementation from the dev-run task envelope", async () => {
    const runFullLoop = vi.fn().mockResolvedValue({
      exitCode: 0,
      classification: "success",
      planningExitCode: 0,
      implementationExitCode: 0,
      reviewApproved: true,
      iterations: 1,
    });
    const output: string[] = [];
    const runConfig = encodeRunConfig({
      v: 1,
      issue: {
        id: "issue-1",
        identifier: "LOCAL-1",
        title: "Add health check",
        description: "Implement the endpoint.",
      },
      runnerPhase: "implementation",
      maxTurns: 25,
      maxIterations: 2,
    });

    const exitCode = await runLocalFullLoopFromEnv(
      {
        AI_IMPLEMENT_RUN_CONFIG: runConfig,
        WORKSPACE_DIR: "/workspace",
        CLAUDE_MODEL: "claude-test-model",
      },
      {
        runFullLoop,
        writeStdout: (text) => output.push(text),
      },
    );

    expect(runFullLoop).toHaveBeenCalledWith(expect.objectContaining({
      workspaceDir: "/workspace",
      issueId: "issue-1",
      issueIdentifier: "LOCAL-1",
      issueTitle: "Add health check",
      issueDescription: "Implement the endpoint.",
      maxTurns: 25,
      maxIterations: 2,
      model: "claude-test-model",
    }));
    expect(exitCode).toBe(0);
    expect(output.join("\n")).toContain("planning -> implementation -> review");
    expect(output.join("\n")).toContain("classification=success");
  });
});
