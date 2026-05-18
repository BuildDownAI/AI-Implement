import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAutonomous } from "../run-autonomous.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type { LLMExecutor, PipelineDefinition, StepModule } from "../pipeline/types.js";

const REQUIRED_ENV: Record<string, string> = {
  ISSUE_ID: "issue-abc",
  ISSUE_IDENTIFIER: "AII-1",
  ISSUE_TITLE: "Test issue",
  ISSUE_DESCRIPTION: "Issue description",
  GITHUB_OWNER: "acme",
  GITHUB_REPO: "app",
  GITHUB_TOKEN: "ghs_test",
};

function stubRequiredEnv() {
  for (const [k, v] of Object.entries(REQUIRED_ENV)) {
    vi.stubEnv(k, v);
  }
}

function makeMockExecutor(exitCode = 0): LLMExecutor {
  return {
    invoke: vi.fn().mockResolvedValue({ stdout: "", exitCode, tokensUsed: 0 }),
  };
}

function makeSingleStepPipeline(stepId: string, mod: StepModule): {
  pipeline: PipelineDefinition;
  runner: PipelineRunner;
} {
  const pipeline: PipelineDefinition = {
    id: "test",
    steps: [{ id: stepId, type: "custom", moduleId: stepId }],
  };
  const runner = new PipelineRunner().register(stepId, mod);
  return { pipeline, runner };
}

describe("runAutonomous", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "run-autonomous-test-"));
    stubRequiredEnv();
    vi.stubEnv("LINEAR_API_KEY", "");
    vi.stubEnv("ORCHESTRATOR_URL", "");
    vi.stubEnv("MACHINE_NONCE", "");
    vi.stubEnv("CLAUDE_MODEL", "");
    vi.stubEnv("PR_NUMBER", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("returns exitCode 0 on successful pipeline run", async () => {
    const mod: StepModule = { run: vi.fn().mockResolvedValue({}) };
    const { pipeline, runner } = makeSingleStepPipeline("do-work", mod);

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(result.exitCode).toBe(0);
  });

  it("returns exitCode 1 when pipeline step throws", async () => {
    const mod: StepModule = {
      run: vi.fn().mockRejectedValue(new Error("step exploded")),
    };
    const { pipeline, runner } = makeSingleStepPipeline("bad-step", mod);

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(result.exitCode).toBe(1);
  });

  it("reads model from WORKFLOW.md front matter and passes it through context", async () => {
    writeFileSync(join(workspaceDir, "WORKFLOW.md"), "---\nmodel: claude-opus-4-7\n---\nDo the thing\n");

    let capturedModel: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedModel = ctx.data.model;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-model", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(capturedModel).toBe("claude-opus-4-7");
  });

  it("uses CLAUDE_MODEL env var over WORKFLOW.md front matter", async () => {
    vi.stubEnv("CLAUDE_MODEL", "anthropic.claude-sonnet-bedrock-v1:0");
    writeFileSync(join(workspaceDir, "WORKFLOW.md"), "---\nmodel: claude-opus-4-7\n---\nDo the thing\n");

    let capturedModel: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedModel = ctx.data.model;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-model", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(capturedModel).toBe("anthropic.claude-sonnet-bedrock-v1:0");
  });

  it("uses WORKFLOW.md body as the implementation prompt", async () => {
    writeFileSync(
      join(workspaceDir, "WORKFLOW.md"),
      "---\nmodel: claude-opus-4-7\n---\nCustom prompt for ${ISSUE_IDENTIFIER}: ${ISSUE_TITLE}\n",
    );

    let capturedPrompt: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedPrompt = ctx.data.implementationPrompt;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-prompt", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(capturedPrompt).toContain("Custom prompt for AII-1: Test issue");
    expect(capturedPrompt).toContain("Pipeline-owned Git and PR handling");
  });

  it("appends pipeline-owned git instructions to custom implementation prompts", async () => {
    writeFileSync(
      join(workspaceDir, "WORKFLOW.md"),
      "Create a branch and open a PR for ${ISSUE_IDENTIFIER}\n",
    );

    let capturedPrompt: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedPrompt = ctx.data.implementationPrompt;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-prompt", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(capturedPrompt).toContain("Create a branch and open a PR for AII-1");
    expect(capturedPrompt).toContain("Do NOT create or switch branches");
    expect(capturedPrompt).toContain("Do NOT commit, push, or open a pull request");
  });

  it("does not append new-implementation git instructions for gap-fill runs", async () => {
    vi.stubEnv("PR_NUMBER", "42");

    let capturedPrompt: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedPrompt = ctx.data.implementationPrompt;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-prompt", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(capturedPrompt).toContain("Gap-fill run");
    expect(capturedPrompt).not.toContain("Pipeline-owned Git and PR handling");
  });

  it("does not duplicate pipeline-owned git instructions from custom prompts", async () => {
    writeFileSync(
      join(workspaceDir, "WORKFLOW.md"),
      "Do the work\n\n## Pipeline-owned Git and PR handling\n\nDo NOT create or switch branches.\n",
    );

    let capturedPrompt: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedPrompt = ctx.data.implementationPrompt;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-prompt", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(capturedPrompt?.match(/Pipeline-owned Git and PR handling/g)).toHaveLength(1);
  });

  it("falls back to CLAUDE_MODEL env var when WORKFLOW.md has no model", async () => {
    vi.stubEnv("CLAUDE_MODEL", "claude-haiku-4-5");
    writeFileSync(join(workspaceDir, "WORKFLOW.md"), "---\n---\nNo model here\n");

    let capturedModel: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedModel = ctx.data.model;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-model", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(capturedModel).toBe("claude-haiku-4-5");
  });

  it("falls back to claude-sonnet-4-6 when no model configured", async () => {
    let capturedModel: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedModel = ctx.data.model;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-model", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(capturedModel).toBe("claude-sonnet-4-6");
  });

  it("invokes the provided llmExecutor when step calls it", async () => {
    const executor = makeMockExecutor(0);
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        await ctx.llmExecutor.invoke({ prompt: "hello", model: ctx.data.model! });
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("run-llm", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: executor,
    });

    expect(executor.invoke).toHaveBeenCalledOnce();
    expect((executor.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0].model).toBe("claude-sonnet-4-6");
  });

  it("fetches planning context when LINEAR_API_KEY is set", async () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_api_test");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          issue: { comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        },
      }),
    });

    const mod: StepModule = { run: vi.fn().mockResolvedValue({}) };
    const { pipeline, runner } = makeSingleStepPipeline("noop", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
      fetchImpl: mockFetch,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("stores fetched planning context on the pipeline context", async () => {
    vi.stubEnv("LINEAR_API_KEY", "lin_api_test");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            comments: {
              nodes: [
                {
                  body: "## 🏗️ AI Planning: Architecture Analysis\nUse the service layer",
                  createdAt: "2026-05-15T00:00:00.000Z",
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    });

    let capturedPlanningContext: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedPlanningContext = ctx.data.planningContext;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-planning", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
      fetchImpl: mockFetch,
    });

    expect(capturedPlanningContext).toContain("Use the service layer");
  });

  it("runs the default autonomous pipeline with clone inputs from context", async () => {
    let cloneInputs: Record<string, unknown> | undefined;
    const runner = new PipelineRunner()
      .register("clone", {
        run: vi.fn(async (_ctx, inputs) => {
          cloneInputs = inputs;
          return {
            workspaceDir: inputs.workspaceDir,
            repoOwner: inputs.repoOwner,
            repoRepo: inputs.repoRepo,
            githubToken: inputs.githubToken,
            branch: inputs.branch,
          };
        }),
      })
      .register("install", { run: vi.fn().mockResolvedValue({}) })
      .register("feedback-loop", { run: vi.fn().mockResolvedValue({ approved: false }) });

    const result = await runAutonomous({
      workspaceDir,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(result.exitCode).toBe(0);
    expect(cloneInputs).toMatchObject({
      repoOwner: "acme",
      repoRepo: "app",
      githubToken: "ghs_test",
      branch: "main",
      workspaceDir,
    });
  });

  it("skips planning context fetch when LINEAR_API_KEY is absent", async () => {
    const mockFetch = vi.fn();
    const mod: StepModule = { run: vi.fn().mockResolvedValue({}) };
    const { pipeline, runner } = makeSingleStepPipeline("noop", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
      fetchImpl: mockFetch,
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sets context extras (workspaceDir, githubOwner, githubRepo, prNumber)", async () => {
    vi.stubEnv("PR_NUMBER", "42");

    let extras: Record<string, unknown> = {};
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        const d = ctx.data as Record<string, unknown>;
        extras = {
          workspaceDir: d.workspaceDir,
          githubOwner: d.githubOwner,
          githubRepo: d.githubRepo,
          prNumber: d.prNumber,
        };
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-extras", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(extras.workspaceDir).toBe(workspaceDir);
    expect(extras.githubOwner).toBe("acme");
    expect(extras.githubRepo).toBe("app");
    expect(extras.prNumber).toBe("42");
  });

  it("throws when a required env var is missing", async () => {
    vi.stubEnv("ISSUE_ID", "");

    const { pipeline, runner } = makeSingleStepPipeline("noop", { run: vi.fn().mockResolvedValue({}) });

    await expect(
      runAutonomous({ workspaceDir, pipeline, runner, reporter: new NoopStepReporter() }),
    ).rejects.toThrow("Missing required env var: ISSUE_ID");
  });
});
