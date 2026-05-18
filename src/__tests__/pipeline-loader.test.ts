import { describe, it, expect } from "vitest";
import { loadPipelineDefinition } from "../pipeline/pipeline-loader.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type { PipelineContextData, StepModule } from "../pipeline/types.js";

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
  - id: install
    type: install
  - id: feedback-loop
    type: custom
    moduleId: feedback-loop
  - id: preflight
    type: preflight
  - id: push
    type: push
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
    ticketingProvider: "linear",
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
      "install",
      "feedback-loop",
      "preflight",
      "push",
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

    expect(resolvedPath).toContain("custom/pipelines/autonomous.yml");
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

    expect(resolvedPath).toBe("/app/pipelines/autonomous.yml");
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

    const ctx = makeContext({ issueIdentifier: "ENG-42", issueTitle: "Add profile page" });
    ctx.setOutputs("clone", {
      workspaceDir: "/tmp/repo",
      repoOwner: "acme",
      repoRepo: "api",
      githubToken: "tok",
      branch: "main",
    });

    const step = pipeline.steps.find((s) => s.id === "push")!;
    const inputs = ctx.resolveInputs(step.inputs);
    expect(inputs.workspaceDir).toBe("/tmp/repo");
    expect(inputs.repoOwner).toBe("acme");
    expect(inputs.repoRepo).toBe("api");
    expect(inputs.githubToken).toBe("tok");
    expect(inputs.branchName).toBe("ai-implement/eng-42-add-profile-page");
    expect(inputs.baseBranch).toBe("main");
    expect(inputs.prTitle).toBe("ENG-42: Add profile page");
  });

  it("applies push skip condition based on feedback-loop approval", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const pushStep = pipeline.steps.find((s) => s.id === "push")!;

    const ctxApproved = makeContext();
    ctxApproved.setOutputs("feedback-loop", { approved: true });
    expect(pushStep.skip?.(ctxApproved)).toBe(false);

    const ctxRejected = makeContext();
    ctxRejected.setOutputs("feedback-loop", { approved: false });
    expect(pushStep.skip?.(ctxRejected)).toBe(true);
  });

  it("applies post-push-review input wiring from clone and push outputs", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: "/tmp/repo" });
    ctx.setOutputs("push", { prNumber: 42, branchPushed: true });

    const step = pipeline.steps.find((s) => s.id === "post-push-review")!;
    const inputs = ctx.resolveInputs(step.inputs);
    expect(inputs.workspaceDir).toBe("/tmp/repo");
    expect(inputs.prNumber).toBe("42");
  });

  it("applies post-push-review skip condition based on push output", () => {
    const pipeline = loadPipelineDefinition("pipelines/autonomous.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: (_path, _enc) => BUILTIN_PIPELINE_YAML,
    });

    const step = pipeline.steps.find((s) => s.id === "post-push-review")!;

    const ctxPushed = makeContext();
    ctxPushed.setOutputs("push", { branchPushed: true, prNumber: 42 });
    expect(step.skip?.(ctxPushed)).toBe(false);

    const ctxSkipped = makeContext();
    ctxSkipped.setOutputs("push", { branchPushed: false });
    expect(step.skip?.(ctxSkipped)).toBe(true);

    const ctxMissingPr = makeContext();
    ctxMissingPr.setOutputs("push", { branchPushed: true, prNumber: null });
    expect(step.skip?.(ctxMissingPr)).toBe(true);
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
});
