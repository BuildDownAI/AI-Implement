import { describe, it, expect } from "vitest";
import { loadPipelineDefinition, dependenciesMissing } from "../pipeline/pipeline-loader.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type { PipelineContextData, StepModule } from "../pipeline/types.js";
import type { ReviewerDefinition } from "../pipeline/reviewers/registry.js";

const CUSTOM_PIPELINE_YAML = `id: custom-loop
steps:
  - id: clone
    type: clone
  - id: install
    type: install
  - id: feedback-loop
    type: custom
    moduleId: feedback-loop
  - id: preflight
    type: preflight
  - id: push
    type: push
  - id: notify
    type: custom
    moduleId: notify
`;

const BUILTIN_PIPELINE_YAML = `id: autonomous-loop
steps:
  - id: clone
    type: clone
  - id: install-skills
    type: custom
    moduleId: install-skills
  - id: install
    type: install
  - id: setup
    type: custom
    moduleId: setup
  - id: feedback-loop
    type: custom
    moduleId: feedback-loop
  - id: install-retry
    type: install
  - id: preflight
    type: preflight
  - id: push
    type: push
  - id: verify
    type: custom
    moduleId: verify
  - id: post-push-review
    type: custom
    moduleId: post-push-review
`;

function makeModule(outputs: Record<string, unknown> = {}): StepModule {
  return { run: async () => outputs };
}

function makeContext(overrides: Partial<PipelineContextData> = {}): DefaultPipelineContext {
  return new DefaultPipelineContext({
    jobId: 1,
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueTitle: "Test",
    issueDescription: "Desc",
    nonce: "nonce",
    orchestratorUrl: "http://localhost:8080",
    ...overrides,
  });
}

describe("loadPipelineDefinition", () => {
  it("loads the built-in pipeline when no custom override exists", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    expect(pipeline.id).toBe("autonomous-loop");
    expect(pipeline.steps.map((s) => s.id)).toEqual([
      "clone",
      "install-skills",
      "install",
      "setup",
      "feedback-loop",
      "install-retry",
      "preflight",
      "push",
      "verify",
      "post-push-review",
    ]);
  });

  it("uses custom/pipelines/autonomous.yml when present", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: (p) => p.includes("custom"),
      readFileSyncImpl: (_path, _enc) => CUSTOM_PIPELINE_YAML,
    });

    expect(pipeline.id).toBe("custom-loop");
    expect(pipeline.steps.map((s) => s.id)).toEqual([
      "clone",
      "install",
      "feedback-loop",
      "preflight",
      "push",
      "notify",
    ]);
  });

  it("resolves to the custom path when the override file exists", () => {
    let resolvedPath = "";
    loadPipelineDefinition("pipelines/autonomous.yml", {
      customRoot: "/workspace",
      existsSyncImpl: (p) => p.includes("custom"),
      readFileSyncImpl: (path, _enc) => {
        resolvedPath = path;
        return CUSTOM_PIPELINE_YAML;
      },
    });

    expect(resolvedPath.replace(/\\/g, "/")).toContain("custom/pipelines/autonomous.yml");
  });

  it("uses a baked-root custom/pipelines/autonomous.yml when the workspace has none", () => {
    let resolvedPath = "";
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      customRoot: "/workspace",
      bakedRoot: "/baked",
      existsSyncImpl: (p) => p.replace(/\\/g, "/").startsWith("/baked/"),
      readFileSyncImpl: (path, _enc) => {
        resolvedPath = path;
        return CUSTOM_PIPELINE_YAML;
      },
    });

    expect(resolvedPath.replace(/\\/g, "/")).toBe("/baked/custom/pipelines/autonomous.yml");
    expect(pipeline.id).toBe("custom-loop");
    expect(pipeline.steps.map((s) => s.id)).toEqual([
      "clone",
      "install",
      "feedback-loop",
      "preflight",
      "push",
      "notify",
    ]);
  });

  it("resolves to the builtin path when no custom override exists", () => {
    let resolvedPath = "";
    loadPipelineDefinition("pipelines/autonomous.yml", {
      builtinRoot: "/app",
      existsSyncImpl: () => false,
      readFileSyncImpl: (path, _enc) => {
        resolvedPath = path;
        return BUILTIN_PIPELINE_YAML;
      },
    });

    expect(resolvedPath.replace(/\\/g, "/")).toBe("/app/pipelines/autonomous.yml");
  });

  it("skips install-skills when skillsRepo is unset, runs it when set", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const step = pipeline.steps.find((s) => s.id === "install-skills")!;

    const ctxNoSkills = makeContext();
    ctxNoSkills.setOutputs("clone", { githubToken: "tok" });
    expect(step.skip?.(ctxNoSkills)).toBe(true);

    const ctxWithSkills = makeContext({ skillsRepo: "https://github.com/org/skills" });
    ctxWithSkills.setOutputs("clone", { githubToken: "tok" });
    expect(step.skip?.(ctxWithSkills)).toBe(false);

    const inputs = ctxWithSkills.resolveInputs(step.inputs);
    expect(inputs.skillsRepoUrl).toBe("https://github.com/org/skills");
    expect(inputs.githubToken).toBe("tok");
  });

  it("applies install input wiring from clone outputs", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: "/tmp/repo" });

    const installStep = pipeline.steps.find((s) => s.id === "install")!;
    const inputs = ctx.resolveInputs(installStep.inputs);
    expect(inputs.workspaceDir).toBe("/tmp/repo");
  });

  it("applies clone input wiring from context data", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const ctx = makeContext({
      githubOwner: "acme",
      githubRepo: "api",
      githubToken: "tok",
      branch: "main",
      workspaceDir: "/tmp/repo",
    });

    const step = pipeline.steps.find((s) => s.id === "clone")!;
    const inputs = ctx.resolveInputs(step.inputs);
    expect(inputs.repoOwner).toBe("acme");
    expect(inputs.repoRepo).toBe("api");
    expect(inputs.githubToken).toBe("tok");
    expect(inputs.branch).toBe("main");
    expect(inputs.workspaceDir).toBe("/tmp/repo");
    expect(inputs.orchestratorUrl).toBe("http://localhost:8080");
    expect(inputs.machineNonce).toBe("nonce");
  });

  it("applies feedback-loop input wiring from clone, install, and ctx.data", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const ctx = makeContext({
      implementationPrompt: "Use the workflow body",
      planningContext: "Use the planning comments",
    });
    ctx.setOutputs("clone", { workspaceDir: "/tmp/repo" });
    ctx.setOutputs("install", {
      repoModels: { implement: "claude-opus-4-7", review: "claude-haiku-4-5" },
    });

    const step = pipeline.steps.find((s) => s.id === "feedback-loop")!;
    const inputs = ctx.resolveInputs(step.inputs);
    expect(inputs.workspaceDir).toBe("/tmp/repo");
    expect(inputs.issueTitle).toBe("Test");
    expect(inputs.issueDescription).toBe("Desc");
    expect(inputs.implementationPrompt).toBe("Use the workflow body");
    expect(inputs.planningContext).toBe("Use the planning comments");
    expect(inputs.repoImplementModel).toBe("claude-opus-4-7");
    expect(inputs.repoReviewModel).toBe("claude-haiku-4-5");
  });

  it("applies preflight input wiring from clone and install outputs", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: "/tmp/repo" });
    ctx.setOutputs("install", { packageManager: "npm" });

    const step = pipeline.steps.find((s) => s.id === "preflight")!;
    const inputs = ctx.resolveInputs(step.inputs);
    expect(inputs.workspaceDir).toBe("/tmp/repo");
    expect(inputs.packageManager).toBe("npm");
  });

  it("applies install-retry input wiring from clone and install outputs", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: "/tmp/repo" });
    ctx.setOutputs("install", { packageManager: "yarn", installFailed: true });

    const step = pipeline.steps.find((s) => s.id === "install-retry")!;
    const inputs = ctx.resolveInputs(step.inputs);
    expect(inputs.workspaceDir).toBe("/tmp/repo");
    expect(inputs.packageManager).toBe("yarn");
    expect(inputs.retry).toBe(true);
  });

  it("skips install-retry when the first install succeeded, runs it when it failed", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const step = pipeline.steps.find((s) => s.id === "install-retry")!;

    const ctxSucceeded = makeContext();
    ctxSucceeded.setOutputs("install", { installFailed: false });
    expect(step.skip?.(ctxSucceeded)).toBe("first install succeeded");

    const ctxFailed = makeContext();
    ctxFailed.setOutputs("install", { installFailed: true });
    expect(step.skip?.(ctxFailed)).toBe(false);
  });

  it("applies preflight skip condition based on feedback-loop approval", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const preflightStep = pipeline.steps.find((s) => s.id === "preflight")!;

    const ctxApproved = makeContext();
    ctxApproved.setOutputs("feedback-loop", { approved: true });
    expect(preflightStep.skip?.(ctxApproved)).toBe(false);

    const ctxRejected = makeContext();
    ctxRejected.setOutputs("feedback-loop", { approved: false });
    expect(preflightStep.skip?.(ctxRejected)).toBe(true);
  });

  it("applies push input wiring with an issue-scoped implementation branch", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const ctx = makeContext({
      issueIdentifier: "ENG-42",
      issueTitle: "Add profile page",
      callbackUrl: "https://orchestrator.example/callback",
    });
    ctx.setOutputs("clone", {
      workspaceDir: "/tmp/repo",
      repoOwner: "acme",
      repoRepo: "api",
      githubToken: "tok",
      branch: "main",
      clonedRef: "base-sha",
    });

    const step = pipeline.steps.find((s) => s.id === "push")!;
    const inputs = ctx.resolveInputs(step.inputs);
    expect(inputs.workspaceDir).toBe("/tmp/repo");
    expect(inputs.repoOwner).toBe("acme");
    expect(inputs.repoRepo).toBe("api");
    expect(inputs.githubToken).toBe("tok");
    expect(inputs.orchestratorUrl).toBe("http://localhost:8080");
    expect(inputs.machineNonce).toBe("nonce");
    expect(inputs.callbackUrl).toBe("https://orchestrator.example/callback");
    expect(inputs).not.toHaveProperty("publicationToken");
    expect(inputs.existingPrNumber).toBeUndefined();
    expect(inputs.branchName).toBe("ai-implement/eng-42-add-profile-page");
    expect(inputs.baseBranch).toBe("main");
    expect(inputs.baseRef).toBe("base-sha");
    expect(inputs.prTitle).toBe("ENG-42: Add profile page");
  });

  it("appends the assignee name in parentheses to the PR title when present", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const ctx = makeContext({ issueIdentifier: "ENG-42", issueTitle: "Add profile page", assigneeName: "Paz" });
    ctx.setOutputs("clone", {
      workspaceDir: "/tmp/repo",
      repoOwner: "acme",
      repoRepo: "api",
      githubToken: "tok",
      branch: "main",
    });

    const step = pipeline.steps.find((s) => s.id === "push")!;
    const inputs = ctx.resolveInputs(step.inputs);
    expect(inputs.prTitle).toBe("ENG-42: Add profile page (Paz)");
  });

  it("applies post-push-review input wiring from clone and push outputs", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: "/tmp/repo" });
    const trustedDefinitions = new Map<string, ReviewerDefinition>([
      ["gap-analysis", { id: "gap-analysis", buildPrompt: () => "prompt", outputSchema: { type: "object" } }],
    ]);
    const selectedReviewers = [{ id: "gap-analysis", gates: true }];
    const repoReviewerDefinitions = [{ id: "repo-reviewer" }];
    const trustedConfigReviewerDefinitions = [{ id: "domain-reviewer" }];
    ctx.data.reviewers = selectedReviewers;
    ctx.data.trustedReviewerDefinitions = trustedDefinitions;
    ctx.setOutputs("install", {
      reviewProviders: ["github-claude-code-review"],
      reviewers: repoReviewerDefinitions,
      trustedConfigReviewers: trustedConfigReviewerDefinitions,
    });
    ctx.setOutputs("push", { prNumber: 42, branchPushed: true });

    const step = pipeline.steps.find((s) => s.id === "post-push-review")!;
    const inputs = ctx.resolveInputs(step.inputs);
    expect(inputs.workspaceDir).toBe("/tmp/repo");
    expect(inputs.prNumber).toBe("42");
    expect(inputs.reviewProviders).toEqual(["github-claude-code-review"]);
    expect(inputs.reviewers).toBe(selectedReviewers);
    expect(inputs.trustedReviewerDefinitions).toBe(trustedDefinitions);
    expect(inputs.reviewerDefinitions).toBe(repoReviewerDefinitions);
    expect(inputs.trustedConfigReviewerDefinitions).toBe(trustedConfigReviewerDefinitions);
  });

  it("wires the push step's commitSha through as post-push-review's pushedSha lease seed", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: "/tmp/repo" });
    ctx.setOutputs("install", { reviewProviders: ["github-claude-code-review"] });
    ctx.setOutputs("push", { prNumber: 42, branchPushed: true, commitSha: "deadbeef" });

    const step = pipeline.steps.find((s) => s.id === "post-push-review")!;
    const inputs = ctx.resolveInputs(step.inputs);
    expect(inputs.pushedSha).toBe("deadbeef");
  });

  it("leaves post-push-review's pushedSha undefined when the push step reports a null commitSha", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: "/tmp/repo" });
    ctx.setOutputs("install", { reviewProviders: ["github-claude-code-review"] });
    ctx.setOutputs("push", { prNumber: 42, branchPushed: true, commitSha: null });

    const step = pipeline.steps.find((s) => s.id === "post-push-review")!;
    const inputs = ctx.resolveInputs(step.inputs);
    expect(inputs.pushedSha).toBeUndefined();
  });

  it("preserves an explicit empty reviewer selection for post-push-review", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const ctx = makeContext();
    ctx.data.reviewers = [];
    ctx.setOutputs("clone", { workspaceDir: "/tmp/repo" });
    ctx.setOutputs("install", { reviewProviders: ["github-claude-code-review"] });
    ctx.setOutputs("push", { prNumber: 42, branchPushed: true });

    const step = pipeline.steps.find((s) => s.id === "post-push-review")!;
    const inputs = ctx.resolveInputs(step.inputs);
    expect(inputs.reviewers).toEqual([]);
  });

  it("applies post-push-review skip condition based on push output", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const step = pipeline.steps.find((s) => s.id === "post-push-review")!;

    const ctxPushed = makeContext();
    ctxPushed.setOutputs("feedback-loop", { approved: true });
    ctxPushed.setOutputs("push", { branchPushed: true, prNumber: 42 });
    expect(step.skip?.(ctxPushed)).toBe(false);

    const ctxSkipped = makeContext();
    ctxSkipped.setOutputs("feedback-loop", { approved: true });
    ctxSkipped.setOutputs("push", { branchPushed: false });
    expect(step.skip?.(ctxSkipped)).toBe(true);

    const ctxMissingPr = makeContext();
    ctxMissingPr.setOutputs("feedback-loop", { approved: true });
    ctxMissingPr.setOutputs("push", { branchPushed: true, prNumber: null });
    expect(step.skip?.(ctxMissingPr)).toBe(true);

    const ctxGapFill = makeContext({ prNumber: "42" });
    ctxGapFill.setOutputs("feedback-loop", { approved: true });
    ctxGapFill.setOutputs("push", { branchPushed: true, prNumber: 42 });
    expect(step.skip?.(ctxGapFill)).toBe(true);
  });

  it("post-push-review skips when feedback-loop was not approved, even with a valid push", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const step = pipeline.steps.find((s) => s.id === "post-push-review")!;

    const ctx = makeContext();
    ctx.setOutputs("feedback-loop", { approved: false });
    ctx.setOutputs("push", { branchPushed: true, prNumber: 9 });
    expect(step.skip?.(ctx)).toBe(true);
  });

  it("skips setup when no setup hook, runs it (with scriptPath) when present", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const step = pipeline.steps.find((s) => s.id === "setup")!;

    const ctxNoHook = makeContext();
    ctxNoHook.setOutputs("clone", { workspaceDir: "/tmp/repo" });
    expect(step.skip?.(ctxNoHook)).toBe(true);

    const ctxWithHook = makeContext({ hooks: { setup: "scripts/setup.sh" } });
    ctxWithHook.setOutputs("clone", { workspaceDir: "/tmp/repo" });
    expect(step.skip?.(ctxWithHook)).toBe(false);
    const inputs = ctxWithHook.resolveInputs(step.inputs);
    expect(inputs.workspaceDir).toBe("/tmp/repo");
    expect(inputs.scriptPath).toBe("scripts/setup.sh");
  });

  it("skips verify when no verify hook, or when feedback-loop not approved", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const step = pipeline.steps.find((s) => s.id === "verify")!;

    // No hook -> skip even if approved.
    const ctxNoHook = makeContext();
    ctxNoHook.setOutputs("feedback-loop", { approved: true });
    expect(step.skip?.(ctxNoHook)).toBe(true);

    // Hook present but loop not approved -> skip.
    const ctxNotApproved = makeContext({ hooks: { verify: "scripts/verify.sh" } });
    ctxNotApproved.setOutputs("feedback-loop", { approved: false });
    expect(step.skip?.(ctxNotApproved)).toBe(true);

    // Hook present and approved -> run, with scriptPath wired.
    const ctxRun = makeContext({ hooks: { verify: "scripts/verify.sh" } });
    ctxRun.setOutputs("clone", { workspaceDir: "/tmp/repo" });
    ctxRun.setOutputs("feedback-loop", { approved: true });
    expect(step.skip?.(ctxRun)).toBe(false);
    const inputs = ctxRun.resolveInputs(step.inputs);
    expect(inputs.workspaceDir).toBe("/tmp/repo");
    expect(inputs.scriptPath).toBe("scripts/verify.sh");
  });

  it("custom pipeline with extra step is used by the pipeline runner", async () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: (p) => p.includes("custom"),
      readFileSyncImpl: (_path, _enc) => CUSTOM_PIPELINE_YAML,
    });

    const executedSteps: string[] = [];

    const trackingModule = (id: string): StepModule => ({
      run: async () => {
        executedSteps.push(id);
        return {};
      },
    });

    const runner = new PipelineRunner()
      .register("clone", makeModule({ workspaceDir: "/tmp", repoOwner: "o", repoRepo: "r", githubToken: "t", branch: "b" }))
      .register("install", trackingModule("install"))
      .register("feedback-loop", makeModule({ approved: true }))
      .register("preflight", trackingModule("preflight"))
      .register("push", trackingModule("push"))
      .register("notify", trackingModule("notify"));

    await runner.run(pipeline, makeContext(), new NoopStepReporter());

    expect(executedSteps).toContain("notify");
    expect(executedSteps.indexOf("push")).toBeLessThan(executedSteps.indexOf("notify"));
  });

  describe("unapproved wiring", () => {
    it("push on an initial run (no prNumber) never skips, and wires draft + reviewSummary from feedback-loop outputs", () => {
      const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
        existsSyncImpl: () => false,
        readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
      });

      const push = pipeline.steps.find((s) => s.id === "push")!;

      const ctx = makeContext();
      ctx.setOutputs("feedback-loop", {
        approved: false,
        iterations: 3,
        finalFeedback: "nope",
        terminationReason: "iterations_exhausted",
        passes: [{ iteration: 1, implementTurns: 98, implementOutcome: "success", costUsd: 1, reviewApproved: false }],
      });
      expect(push.skip?.(ctx)).toBe(false);
      const inputs = ctx.resolveInputs(push.inputs);
      expect(inputs.draft).toBe(true);
      expect((inputs.reviewSummary as { finalFeedback: string }).finalFeedback).toBe("nope");
      expect((inputs.reviewSummary as { terminationReason: string }).terminationReason).toBe("iterations_exhausted");
      expect((inputs.reviewSummary as { iterations: number }).iterations).toBe(3);
      expect((inputs.reviewSummary as { passes: unknown[] }).passes).toHaveLength(1);
    });

    it("push wires draft=false and no reviewSummary when approved", () => {
      const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
        existsSyncImpl: () => false,
        readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
      });

      const push = pipeline.steps.find((s) => s.id === "push")!;
      const ctx = makeContext();
      ctx.setOutputs("feedback-loop", { approved: true, iterations: 1, finalFeedback: "ok", terminationReason: "approved", passes: [] });
      const inputs = ctx.resolveInputs(push.inputs);
      expect(inputs.draft).toBe(false);
      expect(inputs.reviewSummary).toBeUndefined();
    });

    it("post-push-review skips when feedback-loop was not approved", () => {
      const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
        existsSyncImpl: () => false,
        readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
      });

      const ppr = pipeline.steps.find((s) => s.id === "post-push-review")!;
      const ctx = makeContext();
      ctx.setOutputs("feedback-loop", { approved: false });
      ctx.setOutputs("push", { branchPushed: true, prNumber: 9 });
      expect(ppr.skip!(ctx)).toBe(true);
    });
  });

  describe("pipeline-owned push for gap-fill runs", () => {
    it("skips push when a gap-fill is unapproved", () => {
      const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
        existsSyncImpl: () => false,
        readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
      });

      const push = pipeline.steps.find((s) => s.id === "push")!;
      const ctx = makeContext({ prNumber: "42" });
      ctx.setOutputs("feedback-loop", { approved: false });
      expect(push.skip?.(ctx)).toBe(true);
    });

    it("falls back to the requested context branch when a custom gap-fill clone omits branch output", () => {
      const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
        existsSyncImpl: (p) => p.includes("custom"),
        readFileSyncImpl: (_path, _enc) => CUSTOM_PIPELINE_YAML,
      });

      const push = pipeline.steps.find((s) => s.id === "push")!;
      const ctx = makeContext({ prNumber: "42", branch: "feature/custom-existing-pr" });
      ctx.setOutputs("feedback-loop", { approved: true });
      ctx.setOutputs("clone", {
        workspaceDir: "/tmp/repo",
        repoOwner: "acme",
        repoRepo: "api",
        githubToken: "tok",
        clonedRef: "pr-head-sha",
      });

      const inputs = ctx.resolveInputs(push.inputs);
      expect(inputs.existingPrNumber).toBe("42");
      expect(inputs.branchName).toBe("feature/custom-existing-pr");
      expect(inputs.baseBranch).toBe("feature/custom-existing-pr");
      expect(inputs.baseRef).toBe("pr-head-sha");
    });

    it("fails clearly when a custom gap-fill clone omits branch output and no context branch exists", () => {
      const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
        existsSyncImpl: (p) => p.includes("custom"),
        readFileSyncImpl: (_path, _enc) => CUSTOM_PIPELINE_YAML,
      });

      const push = pipeline.steps.find((s) => s.id === "push")!;
      const ctx = makeContext({ prNumber: "42" });
      ctx.setOutputs("feedback-loop", { approved: true });
      ctx.setOutputs("clone", {
        workspaceDir: "/tmp/repo",
        repoOwner: "acme",
        repoRepo: "api",
        githubToken: "tok",
        clonedRef: "pr-head-sha",
      });

      expect(() => ctx.resolveInputs(push.inputs)).toThrow(
        /Missing checked-out branch for gap-fill push/,
      );
    });

    it("runs push when a gap-fill is approved", () => {
      const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
        existsSyncImpl: () => false,
        readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
      });

      const push = pipeline.steps.find((s) => s.id === "push")!;
      const ctx = makeContext({ prNumber: "42" });
      ctx.setOutputs("feedback-loop", { approved: true });
      expect(push.skip?.(ctx)).toBe(false);
    });

    it("does not skip push on an initial run (no prNumber) even when feedback-loop was not approved", () => {
      const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
        existsSyncImpl: () => false,
        readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
      });

      const push = pipeline.steps.find((s) => s.id === "push")!;
      const ctx = makeContext();
      ctx.setOutputs("feedback-loop", { approved: false });
      expect(push.skip?.(ctx)).toBe(false);
    });
  });

  describe("dependenciesMissing", () => {
    it("is true only when both install and install-retry report installFailed", () => {
      const bothFailed = makeContext();
      bothFailed.setOutputs("install", { installFailed: true });
      bothFailed.setOutputs("install-retry", { installFailed: true });
      expect(dependenciesMissing(bothFailed)).toBe(true);

      const retrySkipped = makeContext();
      retrySkipped.setOutputs("install", { installFailed: true });
      // install-retry never ran (first install succeeded elsewhere in this test) — empty outputs.
      expect(dependenciesMissing(retrySkipped)).toBe(false);

      const retrySucceeded = makeContext();
      retrySucceeded.setOutputs("install", { installFailed: true });
      retrySucceeded.setOutputs("install-retry", { installFailed: false });
      expect(dependenciesMissing(retrySucceeded)).toBe(false);

      const neitherFailed = makeContext();
      neitherFailed.setOutputs("install", { installFailed: false });
      expect(dependenciesMissing(neitherFailed)).toBe(false);
    });
  });

  describe("dependenciesMissing gates (AII-826 state table)", () => {
    function buildPipeline() {
      return loadPipelineDefinition("pipelines/autonomous.yml", {
        existsSyncImpl: () => false,
        readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
      });
    }

    function setInstallOutputs(
      ctx: DefaultPipelineContext,
      opts: { installFailed: boolean; retryFailed?: boolean },
    ) {
      ctx.setOutputs("install", { installFailed: opts.installFailed, packageManager: "npm" });
      if (opts.retryFailed !== undefined) {
        ctx.setOutputs("install-retry", { installFailed: opts.retryFailed });
      }
    }

    it("row: install ok, approved -> preflight/verify run, post-push-review as today, draft=false", () => {
      const pipeline = buildPipeline();
      const ctx = makeContext({ hooks: { verify: "scripts/verify.sh" } });
      setInstallOutputs(ctx, { installFailed: false });
      ctx.setOutputs("feedback-loop", { approved: true });
      ctx.setOutputs("push", { branchPushed: true, prNumber: 1 });

      expect(pipeline.steps.find((s) => s.id === "preflight")!.skip?.(ctx)).toBe(false);
      expect(pipeline.steps.find((s) => s.id === "verify")!.skip?.(ctx)).toBe(false);
      expect(pipeline.steps.find((s) => s.id === "post-push-review")!.skip?.(ctx)).toBe(false);
      const pushInputs = ctx.resolveInputs(pipeline.steps.find((s) => s.id === "push")!.inputs);
      expect(pushInputs.draft).toBe(false);
    });

    it("row: install ok, unapproved -> preflight/verify/post-push-review skip, draft=true", () => {
      const pipeline = buildPipeline();
      const ctx = makeContext({ hooks: { verify: "scripts/verify.sh" } });
      setInstallOutputs(ctx, { installFailed: false });
      ctx.setOutputs("feedback-loop", { approved: false });
      ctx.setOutputs("push", { branchPushed: true, prNumber: 1 });

      expect(pipeline.steps.find((s) => s.id === "preflight")!.skip?.(ctx)).toBe(true);
      expect(pipeline.steps.find((s) => s.id === "verify")!.skip?.(ctx)).toBe(true);
      expect(pipeline.steps.find((s) => s.id === "post-push-review")!.skip?.(ctx)).toBe(true);
      const pushInputs = ctx.resolveInputs(pipeline.steps.find((s) => s.id === "push")!.inputs);
      expect(pushInputs.draft).toBe(true);
    });

    it("row: install skipped (no package.json), approved -> preflight/verify run, draft=false", () => {
      const pipeline = buildPipeline();
      const ctx = makeContext({ hooks: { verify: "scripts/verify.sh" } });
      ctx.setOutputs("install", { installFailed: false, installMethod: "skipped: no package.json" });
      ctx.setOutputs("feedback-loop", { approved: true });
      ctx.setOutputs("push", { branchPushed: true, prNumber: 1 });

      expect(pipeline.steps.find((s) => s.id === "preflight")!.skip?.(ctx)).toBe(false);
      expect(pipeline.steps.find((s) => s.id === "verify")!.skip?.(ctx)).toBe(false);
      expect(pipeline.steps.find((s) => s.id === "post-push-review")!.skip?.(ctx)).toBe(false);
      const pushInputs = ctx.resolveInputs(pipeline.steps.find((s) => s.id === "push")!.inputs);
      expect(pushInputs.draft).toBe(false);
    });

    it("row: install failed, retry ok, approved -> preflight/verify run, draft=false", () => {
      const pipeline = buildPipeline();
      const ctx = makeContext({ hooks: { verify: "scripts/verify.sh" } });
      setInstallOutputs(ctx, { installFailed: true, retryFailed: false });
      ctx.setOutputs("feedback-loop", { approved: true });
      ctx.setOutputs("push", { branchPushed: true, prNumber: 1 });

      expect(pipeline.steps.find((s) => s.id === "preflight")!.skip?.(ctx)).toBe(false);
      expect(pipeline.steps.find((s) => s.id === "verify")!.skip?.(ctx)).toBe(false);
      expect(pipeline.steps.find((s) => s.id === "post-push-review")!.skip?.(ctx)).toBe(false);
      const pushInputs = ctx.resolveInputs(pipeline.steps.find((s) => s.id === "push")!.inputs);
      expect(pushInputs.draft).toBe(false);
    });

    it("row: install failed, retry ok, unapproved -> preflight/verify/post-push-review skip, draft=true", () => {
      const pipeline = buildPipeline();
      const ctx = makeContext({ hooks: { verify: "scripts/verify.sh" } });
      setInstallOutputs(ctx, { installFailed: true, retryFailed: false });
      ctx.setOutputs("feedback-loop", { approved: false });
      ctx.setOutputs("push", { branchPushed: true, prNumber: 1 });

      expect(pipeline.steps.find((s) => s.id === "preflight")!.skip?.(ctx)).toBe(true);
      expect(pipeline.steps.find((s) => s.id === "verify")!.skip?.(ctx)).toBe(true);
      expect(pipeline.steps.find((s) => s.id === "post-push-review")!.skip?.(ctx)).toBe(true);
      const pushInputs = ctx.resolveInputs(pipeline.steps.find((s) => s.id === "push")!.inputs);
      expect(pushInputs.draft).toBe(true);
    });

    it("row: both install attempts failed, approved -> preflight skips with reason string, verify/post-push-review skip, draft=true", () => {
      const pipeline = buildPipeline();
      const ctx = makeContext({ hooks: { verify: "scripts/verify.sh" } });
      setInstallOutputs(ctx, { installFailed: true, retryFailed: true });
      ctx.setOutputs("feedback-loop", { approved: true });
      ctx.setOutputs("push", { branchPushed: true, prNumber: 1 });

      expect(pipeline.steps.find((s) => s.id === "preflight")!.skip?.(ctx)).toBe("dependency install failed");
      expect(pipeline.steps.find((s) => s.id === "verify")!.skip?.(ctx)).toBe(true);
      expect(pipeline.steps.find((s) => s.id === "post-push-review")!.skip?.(ctx)).toBe(true);
      const pushInputs = ctx.resolveInputs(pipeline.steps.find((s) => s.id === "push")!.inputs);
      expect(pushInputs.draft).toBe(true);
    });

    it("row: both install attempts failed, unapproved -> preflight/verify/post-push-review skip (not the reason string), draft=true", () => {
      const pipeline = buildPipeline();
      const ctx = makeContext({ hooks: { verify: "scripts/verify.sh" } });
      setInstallOutputs(ctx, { installFailed: true, retryFailed: true });
      ctx.setOutputs("feedback-loop", { approved: false });
      ctx.setOutputs("push", { branchPushed: true, prNumber: 1 });

      expect(pipeline.steps.find((s) => s.id === "preflight")!.skip?.(ctx)).toBe(true);
      expect(pipeline.steps.find((s) => s.id === "verify")!.skip?.(ctx)).toBe(true);
      expect(pipeline.steps.find((s) => s.id === "post-push-review")!.skip?.(ctx)).toBe(true);
      const pushInputs = ctx.resolveInputs(pipeline.steps.find((s) => s.id === "push")!.inputs);
      expect(pushInputs.draft).toBe(true);
    });

    it("gap-fill run: both install attempts failed and approved -> push is not skipped", () => {
      const pipeline = buildPipeline();
      const ctx = makeContext({ prNumber: "42" });
      setInstallOutputs(ctx, { installFailed: true, retryFailed: true });
      ctx.setOutputs("feedback-loop", { approved: true });

      const push = pipeline.steps.find((s) => s.id === "push")!;
      expect(push.skip?.(ctx)).toBe(false);
    });

    it("gap-fill run: preflight/verify/post-push-review still skip when dependencies are missing", () => {
      const pipeline = buildPipeline();
      const ctx = makeContext({ prNumber: "42", hooks: { verify: "scripts/verify.sh" } });
      setInstallOutputs(ctx, { installFailed: true, retryFailed: true });
      ctx.setOutputs("feedback-loop", { approved: true });
      ctx.setOutputs("push", { branchPushed: true, prNumber: 42 });

      expect(pipeline.steps.find((s) => s.id === "preflight")!.skip?.(ctx)).toBe("dependency install failed");
      expect(pipeline.steps.find((s) => s.id === "verify")!.skip?.(ctx)).toBe(true);
      // Gap-fill runs always skip post-push-review (existing prNumber check), independent
      // of dependenciesMissing.
      expect(pipeline.steps.find((s) => s.id === "post-push-review")!.skip?.(ctx)).toBe(true);
    });
  });
});
