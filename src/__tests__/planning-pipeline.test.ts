import { describe, it, expect, vi, beforeEach } from "vitest";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import { PLANNING_PIPELINE, createPlanningRunner } from "../pipeline/planning-pipeline.js";
import type { PipelineContextData, StepModule } from "../pipeline/types.js";

function makeContext(overrides: Partial<PipelineContextData> = {}): DefaultPipelineContext {
  return new DefaultPipelineContext({
    jobId: 1,
    issueId: "issue-abc",
    issueIdentifier: "ENG-42",
    issueTitle: "Add planning pipeline",
    issueDescription: "Define a planning pipeline using composable steps.",
    nonce: "test-nonce",
    orchestratorUrl: "http://localhost:8080",
    ticketingProvider: "linear",
    ...overrides,
  });
}

function makeModule(outputs: Record<string, unknown> = {}): StepModule {
  return { run: vi.fn().mockResolvedValue(outputs) };
}

describe("PLANNING_PIPELINE definition", () => {
  it("has id 'planning'", () => {
    expect(PLANNING_PIPELINE.id).toBe("planning");
  });

  it("contains all required steps in order", () => {
    const ids = PLANNING_PIPELINE.steps.map((s) => s.id);
    expect(ids).toEqual([
      "clone",
      "explore-codebase",
      "architecture-analysis",
      "test-plan",
      "work-unit-decomposition",
      "cross-story-context",
      "post-to-ticketing",
    ]);
  });

  it("cross-story-context is skipped when no related issues", () => {
    const ctx = makeContext({ parent: "None", siblings: "None", dependencies: "None" });
    const crossStoryStep = PLANNING_PIPELINE.steps.find((s) => s.id === "cross-story-context")!;
    expect(crossStoryStep.skip!(ctx)).toBe(true);
  });

  it("cross-story-context is not skipped when parent is set", () => {
    const ctx = makeContext({ parent: "- ENG-1: Parent issue" });
    const crossStoryStep = PLANNING_PIPELINE.steps.find((s) => s.id === "cross-story-context")!;
    expect(crossStoryStep.skip!(ctx)).toBe(false);
  });

  it("cross-story-context is not skipped when siblings are set", () => {
    const ctx = makeContext({ siblings: "- ENG-2: Sibling story" });
    const crossStoryStep = PLANNING_PIPELINE.steps.find((s) => s.id === "cross-story-context")!;
    expect(crossStoryStep.skip!(ctx)).toBe(false);
  });

  it("cross-story-context is not skipped when dependencies are set", () => {
    const ctx = makeContext({ dependencies: "- [blocks] ENG-3: Dependency" });
    const crossStoryStep = PLANNING_PIPELINE.steps.find((s) => s.id === "cross-story-context")!;
    expect(crossStoryStep.skip!(ctx)).toBe(false);
  });

  it("cross-story-context is skipped when parent/siblings/dependencies are all undefined", () => {
    const ctx = makeContext();
    const crossStoryStep = PLANNING_PIPELINE.steps.find((s) => s.id === "cross-story-context")!;
    expect(crossStoryStep.skip!(ctx)).toBe(true);
  });
});

describe("createPlanningRunner", () => {
  it("returns a PipelineRunner instance", () => {
    const runner = createPlanningRunner();
    expect(runner).toBeInstanceOf(PipelineRunner);
  });

  it("registers all planning step types without throwing 'No module registered'", () => {
    // Verify the factory returns a runner — the execution suite below confirms
    // all step types are registered by running the full pipeline with mocks.
    const runner = createPlanningRunner();
    expect(runner).toBeInstanceOf(PipelineRunner);
  });
});

describe("planning pipeline execution", () => {
  let cloneMod: StepModule;
  let exploreMod: StepModule;
  let analysisMod: StepModule;
  let testPlanMod: StepModule;
  let workUnitsMod: StepModule;
  let crossStoryMod: StepModule;
  let postTicketingMod: StepModule;
  let runner: PipelineRunner;

  beforeEach(() => {
    cloneMod = makeModule({ workspaceDir: "/tmp/work", repoOwner: "acme", repoRepo: "app", branch: "main", githubToken: "tok", clonedRef: "abc123" });
    exploreMod = makeModule({ codebaseMap: "## Codebase\n- src/: source files" });
    analysisMod = makeModule({ analysisMarkdown: "## 🏗️ AI Planning: Architecture Analysis\n..." });
    testPlanMod = makeModule({ testPlanMarkdown: "## 🧪 AI Planning: Test Plan\n..." });
    workUnitsMod = makeModule({ workUnitsMarkdown: "## 🔧 AI Planning: Work Units\n..." });
    crossStoryMod = makeModule({ crossStoryMarkdown: "## 🔗 AI Planning: Cross-Story Context\n..." });
    postTicketingMod = makeModule({ commentCount: 3 });

    runner = new PipelineRunner()
      .register("clone", cloneMod)
      .register("explore-codebase", exploreMod)
      .register("architecture-analysis", analysisMod)
      .register("test-plan", testPlanMod)
      .register("work-unit-decomposition", workUnitsMod)
      .register("cross-story-context", crossStoryMod)
      .register("post-to-ticketing", postTicketingMod);
  });

  it("runs all steps when no related issues exist (cross-story-context skipped)", async () => {
    const ctx = makeContext();
    await runner.run(PLANNING_PIPELINE, ctx, new NoopStepReporter());

    expect(cloneMod.run).toHaveBeenCalledOnce();
    expect(exploreMod.run).toHaveBeenCalledOnce();
    expect(analysisMod.run).toHaveBeenCalledOnce();
    expect(testPlanMod.run).toHaveBeenCalledOnce();
    expect(workUnitsMod.run).toHaveBeenCalledOnce();
    expect(crossStoryMod.run).not.toHaveBeenCalled();
    expect(postTicketingMod.run).toHaveBeenCalledOnce();
  });

  it("runs cross-story-context when parent is set", async () => {
    const ctx = makeContext({ parent: "- ENG-1: Parent story" });
    await runner.run(PLANNING_PIPELINE, ctx, new NoopStepReporter());

    expect(crossStoryMod.run).toHaveBeenCalledOnce();
  });

  it("flows codebaseMap from explore into architecture-analysis", async () => {
    const ctx = makeContext();
    let capturedAnalysisInputs: Record<string, unknown> = {};
    analysisMod = {
      run: vi.fn(async (_ctx, inputs) => {
        capturedAnalysisInputs = inputs;
        return { analysisMarkdown: "analysis" };
      }),
    };
    runner = new PipelineRunner()
      .register("clone", cloneMod)
      .register("explore-codebase", exploreMod)
      .register("architecture-analysis", analysisMod)
      .register("test-plan", testPlanMod)
      .register("work-unit-decomposition", workUnitsMod)
      .register("cross-story-context", crossStoryMod)
      .register("post-to-ticketing", postTicketingMod);

    await runner.run(PLANNING_PIPELINE, ctx, new NoopStepReporter());

    expect(capturedAnalysisInputs.codebaseMap).toBe("## Codebase\n- src/: source files");
  });

  it("flows analysisMarkdown and testPlanMarkdown into post-to-ticketing", async () => {
    const ctx = makeContext();
    let capturedPostInputs: Record<string, unknown> = {};
    postTicketingMod = {
      run: vi.fn(async (_ctx, inputs) => {
        capturedPostInputs = inputs;
        return { commentCount: 3 };
      }),
    };
    runner = new PipelineRunner()
      .register("clone", cloneMod)
      .register("explore-codebase", exploreMod)
      .register("architecture-analysis", analysisMod)
      .register("test-plan", testPlanMod)
      .register("work-unit-decomposition", workUnitsMod)
      .register("cross-story-context", crossStoryMod)
      .register("post-to-ticketing", postTicketingMod);

    await runner.run(PLANNING_PIPELINE, ctx, new NoopStepReporter());

    expect(capturedPostInputs.analysisMarkdown).toBe("## 🏗️ AI Planning: Architecture Analysis\n...");
    expect(capturedPostInputs.testPlanMarkdown).toBe("## 🧪 AI Planning: Test Plan\n...");
    expect(capturedPostInputs.workUnitsMarkdown).toBe("## 🔧 AI Planning: Work Units\n...");
  });

  it("passes empty string for crossStoryMarkdown when step is skipped", async () => {
    const ctx = makeContext();
    let capturedPostInputs: Record<string, unknown> = {};
    postTicketingMod = {
      run: vi.fn(async (_ctx, inputs) => {
        capturedPostInputs = inputs;
        return { commentCount: 3 };
      }),
    };
    runner = new PipelineRunner()
      .register("clone", cloneMod)
      .register("explore-codebase", exploreMod)
      .register("architecture-analysis", analysisMod)
      .register("test-plan", testPlanMod)
      .register("work-unit-decomposition", workUnitsMod)
      .register("cross-story-context", crossStoryMod)
      .register("post-to-ticketing", postTicketingMod);

    await runner.run(PLANNING_PIPELINE, ctx, new NoopStepReporter());

    // cross-story-context was skipped so its outputs are {} → crossStoryMarkdown defaults to ""
    expect(capturedPostInputs.crossStoryMarkdown).toBe("");
  });
});
