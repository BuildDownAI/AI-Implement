import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const isWindows = process.platform === "win32";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAutonomous, resolveLogLevel, waitForContainerRemoval, runAutonomousLocally } from "../run-autonomous.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import { encodeRunConfig } from "../run-config.js";
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

// Outcome derivation (Task 4) reads context.getOutputs("feedback-loop") and
// context.getOutputs("push"), so tests that need to land on the "success"
// path must register both steps rather than a single "push" stand-in.
function makeStepsPipeline(entries: Array<[string, StepModule]>): {
  pipeline: PipelineDefinition;
  runner: PipelineRunner;
} {
  const pipeline: PipelineDefinition = {
    id: "test",
    steps: entries.map(([stepId]) => ({ id: stepId, type: "custom", moduleId: stepId })),
  };
  let runner = new PipelineRunner();
  for (const [stepId, mod] of entries) runner = runner.register(stepId, mod);
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
    vi.stubEnv("AI_IMPLEMENT_RUN_CONFIG", "");
    vi.stubEnv("AI_IMPLEMENT_UNTIL_STEP", "");
    vi.stubEnv("AI_IMPLEMENT_SHELL_MODE", "");
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

  it("uses run_config.baseBranch as branch for non-gap-fill runs, overriding GITHUB_DEFAULT_BRANCH", async () => {
    vi.stubEnv("GITHUB_DEFAULT_BRANCH", "main");
    vi.stubEnv(
      "AI_IMPLEMENT_RUN_CONFIG",
      encodeRunConfig({
        v: 1,
        issue: { id: "issue-abc", identifier: "AII-1", title: "Test issue", description: "Issue description" },
        baseBranch: "ai-implement/feature/ool-126",
      }),
    );

    let capturedBranch: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedBranch = ctx.data.branch;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-branch", mod);

    await runAutonomous({ workspaceDir, pipeline, runner, reporter: new NoopStepReporter(), llmExecutor: makeMockExecutor(0) });

    expect(capturedBranch).toBe("ai-implement/feature/ool-126");
  });

  it("falls back to GITHUB_DEFAULT_BRANCH when run_config.baseBranch is absent", async () => {
    vi.stubEnv("GITHUB_DEFAULT_BRANCH", "main");
    vi.stubEnv(
      "AI_IMPLEMENT_RUN_CONFIG",
      encodeRunConfig({
        v: 1,
        issue: { id: "issue-abc", identifier: "AII-1", title: "Test issue", description: "Issue description" },
      }),
    );

    let capturedBranch: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedBranch = ctx.data.branch;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-branch", mod);

    await runAutonomous({ workspaceDir, pipeline, runner, reporter: new NoopStepReporter(), llmExecutor: makeMockExecutor(0) });

    expect(capturedBranch).toBe("main");
  });

  it("does not use run_config.baseBranch for gap-fill runs — uses GITHUB_DEFAULT_BRANCH (PR checkout branch)", async () => {
    vi.stubEnv("GITHUB_DEFAULT_BRANCH", "ai-implement/ai-implement-aii-1-fix-something");
    vi.stubEnv(
      "AI_IMPLEMENT_RUN_CONFIG",
      encodeRunConfig({
        v: 1,
        issue: { id: "issue-abc", identifier: "AII-1", title: "Test issue", description: "Issue description" },
        baseBranch: "ai-implement/feature/ool-126",
        prNumber: "42",
      }),
    );
    vi.stubEnv("PR_NUMBER", "42");

    let capturedBranch: string | undefined;
    const mod: StepModule = {
      run: vi.fn(async (ctx) => {
        capturedBranch = ctx.data.branch;
        return {};
      }),
    };
    const { pipeline, runner } = makeSingleStepPipeline("check-branch", mod);

    await runAutonomous({ workspaceDir, pipeline, runner, reporter: new NoopStepReporter(), llmExecutor: makeMockExecutor(0) });

    // Gap-fill: uses the PR checkout branch (GITHUB_DEFAULT_BRANCH), not envelope baseBranch
    expect(capturedBranch).toBe("ai-implement/ai-implement-aii-1-fix-something");
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

  it("appends a credential refresh command for gap-fill pushes", async () => {
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
    expect(capturedPrompt).toContain("Runner GitHub credential refresh");
    expect(capturedPrompt).toContain("refresh-runner-github-credentials.js");
    expect(capturedPrompt).toContain("Immediately before every `git push`");
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
      .register("feedback-loop", { run: vi.fn().mockResolvedValue({ approved: false }) })
      // Push no longer skips on an unapproved feedback-loop result — it opens a
      // draft PR instead — so the default pipeline needs a push module here too.
      .register("push", {
        run: vi.fn().mockResolvedValue({ prUrl: null, prNumber: null, branchPushed: false, commitSha: null, draft: true }),
      });

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
    const { pipeline, runner } = makeStepsPipeline([
      ["feedback-loop", { run: vi.fn().mockResolvedValue({ approved: true }) }],
      ["push", { run: vi.fn().mockResolvedValue({ prUrl: "https://github.com/acme/app/pull/1" }) }],
    ]);

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
    expect(body.comments).toEqual(expect.arrayContaining([{ body: "first" }, { body: "second" }]));
    expect(body.comments.some((c: { body: string }) => c.body.includes("Run stats"))).toBe(true);
  });

  it("posts the implementation callback using the AI_IMPLEMENT_RUN_CONFIG envelope's runnerCallbackUrl (GHA mode, RUNNER_CALLBACK_URL unset)", async () => {
    // GHA workflows never set RUNNER_CALLBACK_URL directly — only RUN_TOKEN — and carry the
    // callback URL inside the envelope. Regression test for the bug where postRunnerResult
    // silently no-op'd because it only ever read the legacy env var. The envelope takes
    // precedence over the flat ISSUE_ID/etc env vars stubbed by stubRequiredEnv() above.
    vi.stubEnv(
      "AI_IMPLEMENT_RUN_CONFIG",
      encodeRunConfig({
        v: 1,
        issue: { id: "issue-abc", identifier: "AII-1", title: "Test issue", description: "Issue description" },
        runnerCallbackUrl: "https://orchestrator.example",
      }),
    );
    vi.stubEnv("RUN_TOKEN", "run-token");

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
    const { pipeline, runner } = makeStepsPipeline([
      ["feedback-loop", { run: vi.fn().mockResolvedValue({ approved: true }) }],
      ["push", { run: vi.fn().mockResolvedValue({ prUrl: "https://github.com/acme/app/pull/42" }) }],
    ]);

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
    const { pipeline, runner } = makeStepsPipeline([
      ["feedback-loop", { run: vi.fn().mockResolvedValue({ approved: true }) }],
      ["push", { run: vi.fn().mockResolvedValue({ prUrl: "https://github.com/acme/app/pull/99" }) }],
    ]);

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

  it("reports a coded failure (not success) when push produces no PR URL", async () => {
    // The old behavior silently skipped the callback here. Task 4 makes this
    // an honest coded failure instead: the callback is always sent, carrying
    // failureCode REVIEW_UNAPPROVED (no feedback-loop step ran, so approved
    // defaults to false) — the job still exits 0 (warning only).
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
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      phase: string;
      outcome: string;
      failureCode: string;
      prUrl?: string;
    };
    expect(body).toMatchObject({
      phase: "implementation",
      outcome: "failure",
      failureCode: "REVIEW_UNAPPROVED",
    });
    expect(body.prUrl).toBeUndefined();
  });

  it("reports failure with REVIEW_UNAPPROVED and the draft PR url when the loop never approved", async () => {
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example");
    vi.stubEnv("RUN_TOKEN", "run-token");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const { pipeline, runner } = makeStepsPipeline([
      [
        "feedback-loop",
        {
          run: vi.fn().mockResolvedValue({
            approved: false,
            iterations: 3,
            finalFeedback: "nope",
            terminationReason: "iterations_exhausted",
            passes: [],
          }),
        },
      ],
      [
        "push",
        {
          run: vi.fn().mockResolvedValue({
            prUrl: "https://github.com/o/r/pull/9",
            prNumber: 9,
            branchPushed: true,
            draft: true,
          }),
        },
      ],
    ]);

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
      fetchImpl: mockFetch,
    });

    expect(result.exitCode).toBe(0); // job stays green — warning only
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      outcome: string;
      failureCode: string;
      failureReason: string;
      prUrl: string;
    };
    expect(body.outcome).toBe("failure");
    expect(body.failureCode).toBe("REVIEW_UNAPPROVED");
    expect(body.failureReason).toContain("iterations_exhausted");
    expect(body.prUrl).toBe("https://github.com/o/r/pull/9");
  });

  it("gap-fill run (prNumber set, unapproved) skips push — outcome derivation still reports a coded failure with no prUrl", async () => {
    // Mirrors pipeline-loader.ts's push skip condition for gap-fill runs: Claude owns git on
    // the existing PR branch there, so a gap-fill run must not run push against an
    // already-clean tree (it would throw "Nothing to commit"). This verifies the skip and the
    // outcome-derivation fallback compose correctly for the unapproved case.
    vi.stubEnv("PR_NUMBER", "42");
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example");
    vi.stubEnv("RUN_TOKEN", "run-token");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const pushRun = vi.fn().mockResolvedValue({ prUrl: "https://github.com/o/r/pull/1", prNumber: 1, branchPushed: true });
    const pipeline: PipelineDefinition = {
      id: "test",
      steps: [
        { id: "feedback-loop", type: "custom", moduleId: "feedback-loop" },
        {
          id: "push",
          type: "custom",
          moduleId: "push",
          skip: (ctx) => Boolean(ctx.data.prNumber),
        },
      ],
    };
    const runner = new PipelineRunner()
      .register("feedback-loop", {
        run: vi.fn().mockResolvedValue({
          approved: false,
          iterations: 2,
          finalFeedback: "still missing tests",
          terminationReason: "iterations_exhausted",
          passes: [],
        }),
      })
      .register("push", { run: pushRun });

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
      fetchImpl: mockFetch,
    });

    expect(pushRun).not.toHaveBeenCalled(); // push was skipped, not run against a clean tree
    expect(result.exitCode).toBe(0); // job stays green — warning only
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      outcome: string;
      failureCode: string;
      prUrl?: string;
    };
    expect(body.outcome).toBe("failure");
    expect(body.failureCode).toBe("REVIEW_UNAPPROVED");
    expect(body.prUrl).toBeUndefined();
  });

  it("gap-fill run (prNumber set, approved) with push skipped posts a gap-analysis success callback and exits 0", async () => {
    // Approved gap-fill: Claude already committed and pushed to the existing PR branch
    // itself, so push is skipped and there are no push outputs (no prUrl). That is a
    // successful gap-analysis run — it must NOT fall down the REVIEW_UNAPPROVED path.
    vi.stubEnv("PR_NUMBER", "42");
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example");
    vi.stubEnv("RUN_TOKEN", "run-token");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const pushRun = vi.fn().mockResolvedValue({ prUrl: "https://github.com/o/r/pull/1", prNumber: 1, branchPushed: true });
    const pipeline: PipelineDefinition = {
      id: "test",
      steps: [
        { id: "feedback-loop", type: "custom", moduleId: "feedback-loop" },
        {
          id: "push",
          type: "custom",
          moduleId: "push",
          skip: (ctx) => Boolean(ctx.data.prNumber),
        },
      ],
    };
    const runner = new PipelineRunner()
      .register("feedback-loop", {
        run: vi.fn().mockResolvedValue({ approved: true, iterations: 2, terminationReason: "approved", passes: [] }),
      })
      .register("push", { run: pushRun });

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
      fetchImpl: mockFetch,
    });

    expect(pushRun).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      phase: string;
      outcome: string;
      failureCode?: string;
      prUrl?: string;
    };
    expect(body.phase).toBe("gap-analysis");
    expect(body.outcome).toBe("success");
    expect(body.failureCode).toBeUndefined();
    expect(body.prUrl).toBeUndefined();
  });

  it("uses MAX_TURNS_EXHAUSTED when terminationReason is max_turns", async () => {
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example");
    vi.stubEnv("RUN_TOKEN", "run-token");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const postPushReviewRun = vi.fn().mockRejectedValue(new Error("skipped step must not run"));
    const { pipeline, runner } = makeStepsPipeline([
      [
        "feedback-loop",
        {
          run: vi.fn().mockResolvedValue({
            approved: false,
            iterations: 1,
            finalFeedback: "ran out of turns",
            terminationReason: "max_turns",
            passes: [],
          }),
        },
      ],
      [
        "push",
        {
          run: vi.fn().mockResolvedValue({
            prUrl: "https://github.com/o/r/pull/10",
            prNumber: 10,
            branchPushed: true,
            draft: true,
          }),
        },
      ],
      ["post-push-review", { run: postPushReviewRun }],
    ]);
    pipeline.steps[2].skip = () => true;

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
      failureCode: string;
      failureReason: string;
    };
    expect(postPushReviewRun).not.toHaveBeenCalled();
    expect(body.failureCode).toBe("MAX_TURNS_EXHAUSTED");
    expect(body.failureReason).toContain("ran out of turns");
  });

  it("writes the autopsy comment file on unapproved runs", async () => {
    const { pipeline, runner } = makeStepsPipeline([
      [
        "feedback-loop",
        {
          run: vi.fn().mockResolvedValue({
            approved: false,
            iterations: 2,
            finalFeedback: "nope",
            terminationReason: "iterations_exhausted",
            passes: [],
          }),
        },
      ],
      ["push", { run: vi.fn().mockResolvedValue({ prUrl: null, prNumber: null, branchPushed: false, draft: true }) }],
    ]);

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
    });

    expect(result.exitCode).toBe(0);
    const autopsyPath = join(workspaceDir, "ai-output", "comments", "90-run-autopsy.md");
    expect(existsSync(autopsyPath)).toBe(true);
    expect(readFileSync(autopsyPath, "utf-8")).toContain("nope");
  });

  it("still reports plain success with prUrl when approved", async () => {
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example");
    vi.stubEnv("RUN_TOKEN", "run-token");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const { pipeline, runner } = makeStepsPipeline([
      ["feedback-loop", { run: vi.fn().mockResolvedValue({ approved: true, iterations: 1, terminationReason: "approved" }) }],
      ["push", { run: vi.fn().mockResolvedValue({ prUrl: "https://github.com/o/r/pull/11", prNumber: 11, branchPushed: true, draft: false }) }],
    ]);

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
      outcome: string;
      prUrl: string;
      failureCode?: string;
    };
    expect(body.outcome).toBe("success");
    expect(body.prUrl).toBe("https://github.com/o/r/pull/11");
    expect(body.failureCode).toBeUndefined();
  });

  it("does not report success when the post-push review rejects an internally approved PR", async () => {
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example");
    vi.stubEnv("RUN_TOKEN", "run-token");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const { pipeline, runner } = makeStepsPipeline([
      ["feedback-loop", { run: vi.fn().mockResolvedValue({ approved: true, iterations: 1, terminationReason: "approved" }) }],
      ["push", { run: vi.fn().mockResolvedValue({ prUrl: "https://github.com/o/r/pull/12", prNumber: 12, branchPushed: true, draft: false }) }],
      ["post-push-review", { run: vi.fn().mockResolvedValue({
        approved: false,
        iterations: 2,
        finalFeedback: "External Claude finding remains.",
        terminationReason: "iterations_exhausted",
      }) }],
    ]);

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
      outcome: string;
      failureCode?: string;
      failureReason?: string;
      prUrl?: string;
    };
    expect(body.outcome).toBe("failure");
    expect(body.failureCode).toBe("REVIEW_UNAPPROVED");
    expect(body.failureReason).toContain("iterations_exhausted");
    expect(body.prUrl).toBe("https://github.com/o/r/pull/12");
  });

  it("approved mounted run exits 0, posts success with no prUrl, writes no autopsy", async () => {
    vi.stubEnv("AI_IMPLEMENT_MODE", "local");
    vi.stubEnv("AI_IMPLEMENT_WORKSPACE_MODE", "mounted");
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example");
    vi.stubEnv("RUN_TOKEN", "run-token");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const { pipeline, runner } = makeStepsPipeline([
      [
        "feedback-loop",
        {
          run: vi.fn().mockResolvedValue({
            approved: true,
            iterations: 1,
            terminationReason: "approved",
            passes: [],
          }),
        },
      ],
    ]);

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
      outcome: string;
      failureCode?: string;
      prUrl?: string;
    };
    expect(body.outcome).toBe("success");
    expect(body.failureCode).toBeUndefined();
    expect(body.prUrl).toBeUndefined();
    const autopsyPath = join(workspaceDir, "ai-output", "comments", "90-run-autopsy.md");
    expect(existsSync(autopsyPath)).toBe(false);
  });

  it("unapproved mounted run reports REVIEW_UNAPPROVED failure", async () => {
    vi.stubEnv("AI_IMPLEMENT_MODE", "local");
    vi.stubEnv("AI_IMPLEMENT_WORKSPACE_MODE", "mounted");
    vi.stubEnv("RUNNER_CALLBACK_URL", "https://orchestrator.example");
    vi.stubEnv("RUN_TOKEN", "run-token");

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    const { pipeline, runner } = makeStepsPipeline([
      [
        "feedback-loop",
        {
          run: vi.fn().mockResolvedValue({
            approved: false,
            iterations: 2,
            terminationReason: "iterations_exhausted",
            finalFeedback: "implementation incomplete",
            passes: [],
          }),
        },
      ],
    ]);

    const result = await runAutonomous({
      workspaceDir,
      pipeline,
      runner,
      reporter: new NoopStepReporter(),
      llmExecutor: makeMockExecutor(0),
      fetchImpl: mockFetch,
    });

    expect(result.exitCode).toBe(0); // job stays green — warning only
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      outcome: string;
      failureCode: string;
    };
    expect(body.outcome).toBe("failure");
    expect(body.failureCode).toBe("REVIEW_UNAPPROVED");
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

  describe("AI_IMPLEMENT_UNTIL_STEP staged execution", () => {
    beforeEach(() => {
      vi.stubEnv("AI_IMPLEMENT_MODE", "local");
      vi.stubEnv("AI_IMPLEMENT_WORKSPACE_MODE", "mounted");
    });

    it("stops after the named step and returns exitCode 0 without running later steps", async () => {
      vi.stubEnv("AI_IMPLEMENT_UNTIL_STEP", "setup");

      const setupMod: StepModule = { run: vi.fn().mockResolvedValue({}) };
      const feedbackMod: StepModule = { run: vi.fn().mockResolvedValue({ approved: true }) };

      const { pipeline, runner } = makeStepsPipeline([
        ["setup", setupMod],
        ["feedback-loop", feedbackMod],
        ["push", { run: vi.fn().mockResolvedValue({ prUrl: "https://github.com/pr/1" }) }],
      ]);

      const result = await runAutonomous({
        workspaceDir,
        pipeline,
        runner,
        reporter: new NoopStepReporter(),
        llmExecutor: makeMockExecutor(0),
      });

      expect(result.exitCode).toBe(0);
      expect(setupMod.run).toHaveBeenCalledOnce();
      expect(feedbackMod.run).not.toHaveBeenCalled();
    });

    it("returns exitCode 1 when the named step fails (hook error)", async () => {
      vi.stubEnv("AI_IMPLEMENT_UNTIL_STEP", "setup");

      const setupMod: StepModule = {
        run: vi.fn().mockRejectedValue(new Error("hook exploded")),
      };
      const feedbackMod: StepModule = { run: vi.fn().mockResolvedValue({}) };

      const { pipeline, runner } = makeStepsPipeline([
        ["setup", setupMod],
        ["feedback-loop", feedbackMod],
      ]);

      const result = await runAutonomous({
        workspaceDir,
        pipeline,
        runner,
        reporter: new NoopStepReporter(),
        llmExecutor: makeMockExecutor(0),
      });

      expect(result.exitCode).toBe(1);
      expect(feedbackMod.run).not.toHaveBeenCalled();
    });

    it.skipIf(isWindows)("teardown still runs when stopped at a staged step", async () => {
      vi.stubEnv("AI_IMPLEMENT_UNTIL_STEP", "setup");
      writeFileSync(join(workspaceDir, "WORKFLOW.md"), "---\nteardown: teardown.sh\n---\nbody\n");
      writeFileSync(join(workspaceDir, "teardown.sh"), 'printf "" > teardown-ran.marker\n');

      const { pipeline, runner } = makeStepsPipeline([
        ["setup", { run: vi.fn().mockResolvedValue({}) }],
        ["feedback-loop", { run: vi.fn().mockResolvedValue({ approved: true }) }],
      ]);

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

    it("ignores staged execution env outside the local mounted dev harness", async () => {
      vi.stubEnv("AI_IMPLEMENT_MODE", "fly");
      vi.stubEnv("AI_IMPLEMENT_WORKSPACE_MODE", "cloned");
      vi.stubEnv("AI_IMPLEMENT_UNTIL_STEP", "setup");
      vi.stubEnv("AI_IMPLEMENT_SHELL_MODE", "true");
      const feedbackMod: StepModule = { run: vi.fn().mockResolvedValue({ approved: true, iterations: 1 }) };
      const pushMod: StepModule = { run: vi.fn().mockResolvedValue({ prUrl: "https://github.com/pr/1" }) };
      const { pipeline, runner } = makeStepsPipeline([
        ["setup", { run: vi.fn().mockResolvedValue({}) }],
        ["feedback-loop", feedbackMod],
        ["push", pushMod],
      ]);

      const result = await runAutonomous({
        workspaceDir,
        pipeline,
        runner,
        reporter: new NoopStepReporter(),
        llmExecutor: makeMockExecutor(0),
      });

      expect(result.exitCode).toBe(0);
      expect(feedbackMod.run).toHaveBeenCalledOnce();
      expect(pushMod.run).toHaveBeenCalledOnce();
    });
  });
});

describe("waitForContainerRemoval", () => {
  it("registers a referenced timer so an unresolved promise cannot let Node exit", () => {
    const schedule = vi.fn();

    void waitForContainerRemoval(schedule);

    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 60_000);
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

describe("runAutonomousLocally", () => {
  let workspaceDir: string;

  function makeFeedbackLoopPipeline(mod: StepModule): {
    pipeline: PipelineDefinition;
    runner: PipelineRunner;
  } {
    const pipeline: PipelineDefinition = {
      id: "test-local",
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

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "local-auto-test-"));
  });

  afterEach(() => {
    try {
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("returns exitCode 0 and approved=true when feedback-loop approves", async () => {
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: true,
        iterations: 2,
        terminationReason: "approved",
        passes: [],
        finalFeedback: "",
      }),
    });

    const result = await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test issue",
      issueDescription: "Test description",
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.approved).toBe(true);
    expect(result.terminationReason).toBe("approved");
    expect(result.iterations).toBe(2);
  });

  it("returns exitCode 1 and approved=false when pipeline throws", async () => {
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockRejectedValue(new Error("implementation failed")),
    });

    const result = await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test issue",
      issueDescription: "Test description",
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.approved).toBe(false);
    expect(result.terminationReason).toBe("error");
  });

  it("passes planningContext to the feedback-loop via context data", async () => {
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

    await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      planningContext: "## Planning\nSome context",
      pipeline,
      runner,
    });

    expect(capturedPlanningContext).toBe("## Planning\nSome context");
  });

  it("defaults planningContext to empty string when not provided", async () => {
    let capturedPlanningContext: unknown;
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockImplementation(async (ctx) => {
        capturedPlanningContext = ctx.data.planningContext;
        return { approved: true, iterations: 1, terminationReason: "approved", passes: [], finalFeedback: "" };
      }),
    });

    await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(capturedPlanningContext).toBe("");
  });

  it("passes maxTurns and maxIterations to feedback-loop inputs", async () => {
    let capturedInputs: Record<string, unknown> | undefined;
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockImplementation(async (_ctx, inputs: Record<string, unknown>) => {
        capturedInputs = inputs;
        return { approved: true, iterations: 1, terminationReason: "approved", passes: [], finalFeedback: "" };
      }),
    });

    await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      maxTurns: 30,
      maxIterations: 4,
      pipeline,
      runner,
    });

    expect(capturedInputs?.maxTurns).toBe(30);
    expect(capturedInputs?.maxIterations).toBe(4);
  });

  it("reads model from WORKFLOW.md front matter", async () => {
    writeFileSync(
      join(workspaceDir, "WORKFLOW.md"),
      "---\nmodel: claude-opus-4-7\n---\nDo the thing\n",
    );

    let capturedModel: unknown;
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockImplementation(async (ctx) => {
        capturedModel = ctx.data.model;
        return { approved: true, iterations: 1, terminationReason: "approved", passes: [], finalFeedback: "" };
      }),
    });

    await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(capturedModel).toBe("claude-opus-4-7");
  });

  it("model option overrides WORKFLOW.md model", async () => {
    writeFileSync(
      join(workspaceDir, "WORKFLOW.md"),
      "---\nmodel: claude-opus-4-7\n---\nDo the thing\n",
    );

    let capturedModel: unknown;
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockImplementation(async (ctx) => {
        capturedModel = ctx.data.model;
        return { approved: true, iterations: 1, terminationReason: "approved", passes: [], finalFeedback: "" };
      }),
    });

    await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      model: "claude-override",
      pipeline,
      runner,
    });

    expect(capturedModel).toBe("claude-override");
  });

  it("returns approved=false and passes from feedback-loop outputs", async () => {
    const passes = [
      { iteration: 1, implementTurns: 10, implementOutcome: "partial", costUsd: 0.05, reviewApproved: false },
    ];
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: false,
        iterations: 1,
        terminationReason: "iterations_exhausted",
        passes,
        finalFeedback: "needs more tests",
      }),
    });

    const result = await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.approved).toBe(false);
    expect(result.terminationReason).toBe("iterations_exhausted");
    expect(result.finalFeedback).toBe("needs more tests");
    expect(result.passes).toEqual(passes);
  });

  it.skipIf(isWindows)("runs teardown hook even when pipeline throws", async () => {
    writeFileSync(join(workspaceDir, "WORKFLOW.md"), "---\nteardown: teardown.sh\n---\nbody\n");
    writeFileSync(join(workspaceDir, "teardown.sh"), 'printf "" > teardown-ran.marker\n');

    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockRejectedValue(new Error("step exploded")),
    });

    const result = await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(existsSync(join(workspaceDir, "teardown-ran.marker"))).toBe(true);
  });

  it("returns effectiveMaxTurns and effectiveMaxIterations in result", async () => {
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: true,
        iterations: 1,
        terminationReason: "approved",
        passes: [],
        finalFeedback: "",
      }),
    });

    const result = await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      maxTurns: 25,
      maxIterations: 4,
      pipeline,
      runner,
    });

    expect(result.effectiveMaxTurns).toBe(25);
    expect(result.effectiveMaxIterations).toBe(4);
  });

  it("uses default effectiveMaxTurns=50 and effectiveMaxIterations=3 when not specified", async () => {
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: true,
        iterations: 1,
        terminationReason: "approved",
        passes: [],
        finalFeedback: "",
      }),
    });

    const result = await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(result.effectiveMaxTurns).toBe(50);
    expect(result.effectiveMaxIterations).toBe(3);
  });

  it("returns tokenSummary with summed costUsd from passes; token fields null when passes lack them", async () => {
    const passes = [
      { iteration: 1, implementTurns: 5, implementOutcome: "ok", costUsd: 0.05, reviewApproved: true },
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

    const result = await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(result.tokenSummary).not.toBeNull();
    expect(result.tokenSummary!.costUsd).toBeCloseTo(0.05);
    expect(result.tokenSummary!.tokensIn).toBeNull();
    expect(result.tokenSummary!.tokensOut).toBeNull();
    expect(result.tokenSummary!.cacheReadTokens).toBeNull();
    expect(result.tokenSummary!.cacheCreationTokens).toBeNull();
  });

  it("returns tokenSummary null when no passes ran", async () => {
    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockRejectedValue(new Error("boom")),
    });

    const result = await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.tokenSummary).toBeNull();
  });

  it("aggregates token counters across passes and preserves numeric zero", async () => {
    const passes = [
      { iteration: 1, implementTurns: 5, implementOutcome: "ok", costUsd: 0.05, reviewApproved: false,
        tokensIn: 100, tokensOut: 50, cacheReadTokens: 20, cacheCreationTokens: 10 },
      { iteration: 2, implementTurns: 5, implementOutcome: "ok", costUsd: 0,    reviewApproved: true,
        tokensIn: 200, tokensOut: 75, cacheReadTokens: 0,  cacheCreationTokens: 5 },
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

    const result = await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(result.tokenSummary).not.toBeNull();
    expect(result.tokenSummary!.costUsd).toBeCloseTo(0.05);
    expect(result.tokenSummary!.tokensIn).toBe(300);
    expect(result.tokenSummary!.tokensOut).toBe(125);
    expect(result.tokenSummary!.cacheReadTokens).toBe(20);
    expect(result.tokenSummary!.cacheCreationTokens).toBe(15);
  });

  it("preserves zero cost and token counts as numeric zero, not null", async () => {
    const passes = [
      { iteration: 1, implementTurns: 5, implementOutcome: "ok", costUsd: 0, reviewApproved: true,
        tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
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

    const result = await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(result.tokenSummary).not.toBeNull();
    expect(result.tokenSummary!.costUsd).toBe(0);
    expect(result.tokenSummary!.tokensIn).toBe(0);
    expect(result.tokenSummary!.tokensOut).toBe(0);
    expect(result.tokenSummary!.cacheReadTokens).toBe(0);
    expect(result.tokenSummary!.cacheCreationTokens).toBe(0);
  });

  it("returns null for token metrics absent from every pass", async () => {
    const passes = [
      { iteration: 1, implementTurns: 5, implementOutcome: "ok", costUsd: 0.05, reviewApproved: true,
        tokensIn: 100, tokensOut: 50 },
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

    const result = await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(result.tokenSummary).not.toBeNull();
    expect(result.tokenSummary!.tokensIn).toBe(100);
    expect(result.tokenSummary!.tokensOut).toBe(50);
    expect(result.tokenSummary!.cacheReadTokens).toBeNull();
    expect(result.tokenSummary!.cacheCreationTokens).toBeNull();
  });

  it.skipIf(isWindows)("setup failure returns exitCode 1 with terminationReason setup_failed", async () => {
    writeFileSync(join(workspaceDir, "WORKFLOW.md"), "---\nsetup: setup.sh\n---\nbody\n");
    writeFileSync(join(workspaceDir, "setup.sh"), "exit 1\n");

    const implRun = vi.fn();
    const { pipeline, runner } = makeFeedbackLoopPipeline({ run: implRun });

    const result = await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.terminationReason).toBe("setup_failed");
    expect(implRun).not.toHaveBeenCalled();
  });

  it.skipIf(isWindows)("teardown does not run when setup fails", async () => {
    writeFileSync(
      join(workspaceDir, "WORKFLOW.md"),
      "---\nsetup: setup.sh\nteardown: teardown.sh\n---\nbody\n",
    );
    writeFileSync(join(workspaceDir, "setup.sh"), "exit 1\n");
    writeFileSync(join(workspaceDir, "teardown.sh"), 'printf "" > teardown-ran.marker\n');

    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: true,
        iterations: 1,
        terminationReason: "approved",
        passes: [],
        finalFeedback: "",
      }),
    });

    await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(existsSync(join(workspaceDir, "teardown-ran.marker"))).toBe(false);
  });

  it.skipIf(isWindows)("verify failure returns exitCode 1 with terminationReason verify_failed", async () => {
    writeFileSync(join(workspaceDir, "WORKFLOW.md"), "---\nverify: verify.sh\n---\nbody\n");
    writeFileSync(join(workspaceDir, "verify.sh"), "exit 1\n");

    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: true,
        iterations: 1,
        terminationReason: "approved",
        passes: [],
        finalFeedback: "",
      }),
    });

    const result = await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.terminationReason).toBe("verify_failed");
    expect(result.approved).toBe(false);
  });

  it.skipIf(isWindows)("verify does not run when review did not approve", async () => {
    writeFileSync(join(workspaceDir, "WORKFLOW.md"), "---\nverify: verify.sh\n---\nbody\n");
    writeFileSync(join(workspaceDir, "verify.sh"), 'printf "" > verify-ran.marker\n');

    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockResolvedValue({
        approved: false,
        iterations: 2,
        terminationReason: "iterations_exhausted",
        passes: [],
        finalFeedback: "",
      }),
    });

    await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(existsSync(join(workspaceDir, "verify-ran.marker"))).toBe(false);
  });

  it.skipIf(isWindows)("teardown runs when setup succeeds and pipeline throws", async () => {
    writeFileSync(
      join(workspaceDir, "WORKFLOW.md"),
      "---\nsetup: setup.sh\nteardown: teardown.sh\n---\nbody\n",
    );
    writeFileSync(join(workspaceDir, "setup.sh"), "exit 0\n");
    writeFileSync(join(workspaceDir, "teardown.sh"), 'printf "" > teardown-ran.marker\n');

    const { pipeline, runner } = makeFeedbackLoopPipeline({
      run: vi.fn().mockRejectedValue(new Error("step exploded")),
    });

    const result = await runAutonomousLocally({
      workspaceDir,
      issueIdentifier: "TEST-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      pipeline,
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(existsSync(join(workspaceDir, "teardown-ran.marker"))).toBe(true);
  });
});
