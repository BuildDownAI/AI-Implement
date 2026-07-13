import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const isWindows = process.platform === "win32";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAutonomous, resolveLogLevel } from "../run-autonomous.js";
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

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

describe("runAutonomous", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "run-autonomous-test-"));
    stubRequiredEnv();
    vi.stubEnv("LINEAR_API_KEY", "");
    vi.stubEnv("ORCHESTRATOR_URL", "");
    vi.stubEnv("MACHINE_NONCE", "");
    vi.stubEnv("RUNNER_CALLBACK_URL", "");
    vi.stubEnv("RUN_TOKEN", "");
    vi.stubEnv("RUN_PROGRESS_TOKEN", "");
    vi.stubEnv("RUNNER_PHASE", "");
    vi.stubEnv("CLAUDE_MODEL", "");
    vi.stubEnv("GITHUB_DEFAULT_BRANCH", "main");
    vi.stubEnv("GITHUB_REF_NAME", "");
    vi.stubEnv("PR_NUMBER", "");
    vi.stubEnv("AI_IMPLEMENT_COMMENT_INSTRUCTION", "");
    vi.stubEnv("AI_IMPLEMENT_SKILLS_REPO", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // On Windows, bash-created files may be locked briefly after the process exits
    }
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

  it("uses the checked-out branch when GITHUB_DEFAULT_BRANCH is not set", async () => {
    vi.stubEnv("GITHUB_DEFAULT_BRANCH", "");
    vi.stubEnv("GITHUB_REF_NAME", "orchestrator-branch");
    git(["init"], workspaceDir);
    git(["checkout", "-b", "development"], workspaceDir);

    let capturedBranch: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedBranch = ctx.data.branch;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-branch", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(capturedBranch).toBe("development");
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
    expect(capturedPrompt).not.toContain("Operator instruction for this run");
  });

  it("threads a non-empty operator instruction into the gap-fill prompt as an authoritative block", async () => {
    vi.stubEnv("PR_NUMBER", "42");
    vi.stubEnv("AI_IMPLEMENT_COMMENT_INSTRUCTION", "fix the implementation, do NOT weaken the test");

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

    expect(capturedPrompt).toContain("Operator instruction for this run (authoritative)");
    expect(capturedPrompt).toContain("fix the implementation, do NOT weaken the test");
    expect(capturedPrompt).toContain("Gap-fill run");
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

  it("fetches planning context from the orchestrator using the progress token", async () => {
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orch.example.com");
    vi.stubEnv("RUN_PROGRESS_TOKEN", "ptok");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ planningContext: "" }),
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
      "https://orch.example.com/runner/planning-context",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer ptok" }),
      }),
    );
  });

  it("does not fetch planning context when no callback token is present", async () => {
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

  it("stores fetched planning context on the pipeline context", async () => {
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orch.example.com");
    vi.stubEnv("RUN_PROGRESS_TOKEN", "ptok");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        planningContext: "## Planning Context\n\nUse the service layer",
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

  it("posts implementation callback comments after successful push", async () => {
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example");
    vi.stubEnv("RUN_TOKEN", "run-token");
    mkdirSync(join(workspaceDir, "ai-output", "comments"), { recursive: true });
    writeFileSync(join(workspaceDir, "ai-output", "comments", "02-second.md"), "second");
    writeFileSync(join(workspaceDir, "ai-output", "comments", "01-first.md"), "first");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const mod: StepModule = { run: vi.fn().mockResolvedValue({ prUrl: "https://github.com/acme/app/pull/1" }) };
    const { pipeline, runner } = makeSingleStepPipeline("push", mod);

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
      fetchImpl: mockFetch,
    });

    expect(result.exitCode).toBe(0);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://orchestrator.example/runner/result",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer run-token" }),
      }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      phase: string;
      outcome: string;
      prUrl: string;
      comments: Array<{ body: string }>;
    };
    expect(body).toMatchObject({
      phase: "implementation",
      outcome: "success",
      prUrl: "https://github.com/acme/app/pull/1",
    });
    expect(body.comments).toEqual([{ body: "first" }, { body: "second" }]);
  });

  it("uses token-backed progress reporting when a progress token is present", async () => {
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example");
    vi.stubEnv("RUN_PROGRESS_TOKEN", "progress-token");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const mod: StepModule = {
      run: vi.fn(async (_ctx, _inputs, reporter) => {
        await reporter.report({
          id: "do-work",
          type: "custom",
          status: "running",
          started_at: "2026-05-27T00:00:00.000Z",
          ended_at: null,
          parent_step_id: null,
          inputs: {},
          outputs: {},
          logs_url: null,
        });
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("do-work", mod);

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      llmExecutor: makeMockExecutor(0),
      fetchImpl: mockFetch,
    });

    expect(result.exitCode).toBe(0);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://orchestrator.example/runner/progress",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer progress-token" }),
      }),
    );
  });

  it("posts implementation failure callback when pipeline fails", async () => {
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example/");
    vi.stubEnv("RUN_TOKEN", "run-token");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const mod: StepModule = { run: vi.fn().mockRejectedValue(new Error("push failed")) };
    const { pipeline, runner } = makeSingleStepPipeline("push", mod);

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
      fetchImpl: mockFetch,
    });

    expect(result.exitCode).toBe(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      phase: string;
      outcome: string;
      failureReason: string;
    };
    expect(body).toMatchObject({
      phase: "implementation",
      outcome: "failure",
      failureReason: "push failed",
    });
  });

  it("posts gap-analysis callback phase for PR_NUMBER runs", async () => {
    vi.stubEnv("PR_NUMBER", "42");
    vi.stubEnv("RUNNER_PHASE", "gap-analysis");
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example");
    vi.stubEnv("RUN_TOKEN", "run-token");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const mod: StepModule = { run: vi.fn().mockResolvedValue({}) };
    const { pipeline, runner } = makeSingleStepPipeline("push", mod);

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
      fetchImpl: mockFetch,
    });

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      phase: string;
      outcome: string;
    };
    expect(body).toMatchObject({
      phase: "gap-analysis",
      outcome: "success",
    });
  });

  it("uses RUNNER_PHASE instead of inferring callback phase from PR_NUMBER", async () => {
    vi.stubEnv("PR_NUMBER", "42");
    vi.stubEnv("RUNNER_PHASE", "implementation");
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example");
    vi.stubEnv("RUN_TOKEN", "run-token");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const mod: StepModule = { run: vi.fn().mockResolvedValue({ prUrl: "https://github.com/acme/app/pull/99" }) };
    const { pipeline, runner } = makeSingleStepPipeline("push", mod);

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
      fetchImpl: mockFetch,
    });

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      phase: string;
      outcome: string;
    };
    expect(body).toMatchObject({
      phase: "implementation",
      outcome: "success",
    });
  });

  it("skips success callback when push produces no PR URL", async () => {
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example");
    vi.stubEnv("RUN_TOKEN", "run-token");

    const mockFetch = vi.fn();
    const mod: StepModule = { run: vi.fn().mockResolvedValue({}) };
    const { pipeline, runner } = makeSingleStepPipeline("push", mod);

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
      fetchImpl: mockFetch,
    });

    expect(result.exitCode).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("continues callback with empty comments when comment collection fails", async () => {
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example");
    vi.stubEnv("RUN_TOKEN", "run-token");
    mkdirSync(join(workspaceDir, "ai-output"), { recursive: true });
    writeFileSync(join(workspaceDir, "ai-output", "comments"), "not a directory");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const mod: StepModule = { run: vi.fn().mockResolvedValue({ prUrl: "https://github.com/acme/app/pull/1" }) };
    const { pipeline, runner } = makeSingleStepPipeline("push", mod);

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
      fetchImpl: mockFetch,
    });

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      comments: Array<{ body: string }>;
    };
    expect(body.comments).toEqual([]);
  });

  it("throws when a required env var is missing", async () => {
    vi.stubEnv("ISSUE_ID", "");

    const { pipeline, runner } = makeSingleStepPipeline("noop", { run: vi.fn().mockResolvedValue({}) });

    await expect(
      runAutonomous({ workspaceDir, pipeline, runner, reporter: new NoopStepReporter() }),
    ).rejects.toThrow("Missing required env var: ISSUE_ID");
  });

  it.skipIf(isWindows)("runs the teardown hook even when the pipeline fails", async () => {
    writeFileSync(join(workspaceDir, "WORKFLOW.md"), "---\nteardown: teardown.sh\n---\nbody\n");
    writeFileSync(join(workspaceDir, "teardown.sh"), 'printf "" > teardown-ran.marker\n');
    const { pipeline, runner } = makeSingleStepPipeline("bad-step", {
      run: vi.fn().mockRejectedValue(new Error("step exploded")),
    });

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(result.exitCode).toBe(1);
    expect(existsSync(join(workspaceDir, "teardown-ran.marker"))).toBe(true);
  });

  it.skipIf(isWindows)("runs the teardown hook on a successful run", async () => {
    writeFileSync(join(workspaceDir, "WORKFLOW.md"), "---\nteardown: teardown.sh\n---\nbody\n");
    writeFileSync(join(workspaceDir, "teardown.sh"), 'printf "" > teardown-ran.marker\n');
    const { pipeline, runner } = makeSingleStepPipeline("ok-step", { run: vi.fn().mockResolvedValue({}) });

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(workspaceDir, "teardown-ran.marker"))).toBe(true);
  });

  it.skipIf(isWindows)("a failing teardown does not mask the run outcome or throw", async () => {
    writeFileSync(join(workspaceDir, "WORKFLOW.md"), "---\nteardown: teardown.sh\n---\nbody\n");
    // Teardown runs (marker) but exits non-zero — its failure must not change the
    // pipeline's exitCode 1 nor surface as an unhandled rejection.
    writeFileSync(join(workspaceDir, "teardown.sh"), 'printf "" > teardown-ran.marker\nexit 1\n');
    const { pipeline, runner } = makeSingleStepPipeline("bad-step", {
      run: vi.fn().mockRejectedValue(new Error("step exploded")),
    });

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(result.exitCode).toBe(1);
    expect(existsSync(join(workspaceDir, "teardown-ran.marker"))).toBe(true);
  });

  it("reads AI_IMPLEMENT_SKILLS_REPO into context data skillsRepo", async () => {
    vi.stubEnv("AI_IMPLEMENT_SKILLS_REPO", "https://github.com/org/skills");

    let capturedSkillsRepo: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedSkillsRepo = ctx.data.skillsRepo;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-skills", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(capturedSkillsRepo).toBe("https://github.com/org/skills");
  });

  it("leaves skillsRepo undefined when AI_IMPLEMENT_SKILLS_REPO is not set", async () => {
    let capturedSkillsRepo: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedSkillsRepo = ctx.data.skillsRepo;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-skills", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(capturedSkillsRepo).toBeUndefined();
  });

  it("parses AI_IMPLEMENT_PROFILES into context data profiles: splits on comma, trims, drops empties", async () => {
    vi.stubEnv("AI_IMPLEMENT_PROFILES", "backend , ,webapp");

    let capturedProfiles: string[] | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedProfiles = ctx.data.profiles;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-profiles", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(capturedProfiles).toEqual(["backend", "webapp"]);
  });

  it("sets profiles to an empty array when AI_IMPLEMENT_PROFILES is absent", async () => {
    let capturedProfiles: string[] | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedProfiles = ctx.data.profiles;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-profiles", mod);

    await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(capturedProfiles).toEqual([]);
  });
});

describe("resolveLogLevel", () => {
  it("returns stream when set to stream", () => {
    expect(resolveLogLevel("stream")).toBe("stream");
  });
  it("defaults to summary when unset", () => {
    expect(resolveLogLevel(undefined)).toBe("summary");
  });
  it("defaults to summary for an unrecognized value", () => {
    expect(resolveLogLevel("loud")).toBe("summary");
  });
});
