import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("../pipeline/steps/implement.js", () => ({
  implementStep: { run: vi.fn() },
}));

vi.mock("../pipeline/steps/review.js", () => ({
  reviewStep: { run: vi.fn() },
}));

import { spawnSync } from "node:child_process";
import { implementStep } from "../pipeline/steps/implement.js";
import { reviewStep } from "../pipeline/steps/review.js";
import { feedbackLoopStep } from "../pipeline/steps/feedback-loop.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type { Step, StepReporter } from "../pipeline/types.js";

const APPROVED_REVIEW = {
  approved: true,
  issues: [],
  score: 95,
  progressDelta: 100,
  feedback: "Looks good",
  tokensUsed: 0,
};

const REJECTED_REVIEW = {
  approved: false,
  issues: ["Missing tests"],
  score: 40,
  progressDelta: 50,
  feedback: "Needs improvement",
  tokensUsed: 0,
};

const IMPLEMENT_OUTPUTS = {
  filesChanged: ["src/foo.ts"],
  tokensUsed: 100,
  exitCode: 0,
  subagentCount: 0,
};

function makeContext(): DefaultPipelineContext {
  return new DefaultPipelineContext({
    jobId: 1,
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueTitle: "Test",
    issueDescription: "Description",
    nonce: "nonce",
    orchestratorUrl: "http://localhost:8080",
    ticketingProvider: "linear",
  });
}

const BASE_INPUTS = {
  workspaceDir: "/tmp/workspace",
  issueTitle: "Implement feature X",
  issueDescription: "Add feature X to the codebase",
};

function mockDiff(diff = "diff --git a/foo.ts\n+added line") {
  vi.mocked(spawnSync).mockReturnValue({
    status: 0,
    stdout: Buffer.from(diff),
    stderr: Buffer.from(""),
    pid: 0,
    output: [],
    signal: null,
    error: undefined,
  });
}

describe("feedbackLoopStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(implementStep.run).mockResolvedValue(IMPLEMENT_OUTPUTS);
    mockDiff();
  });

  it("returns approved=true and iterations=1 when reviewer approves on first iteration", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    const outputs = await feedbackLoopStep.run(
      makeContext(),
      BASE_INPUTS,
      new NoopStepReporter(),
    );

    expect(outputs.approved).toBe(true);
    expect(outputs.iterations).toBe(1);
    expect(outputs.finalFeedback).toBe("Looks good");
    expect(implementStep.run).toHaveBeenCalledTimes(1);
    expect(reviewStep.run).toHaveBeenCalledTimes(1);
  });

  it("loops until approved within maxIterations", async () => {
    vi.mocked(reviewStep.run)
      .mockResolvedValueOnce(REJECTED_REVIEW)
      .mockResolvedValueOnce(APPROVED_REVIEW);

    const outputs = await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, maxIterations: 3 },
      new NoopStepReporter(),
    );

    expect(outputs.approved).toBe(true);
    expect(outputs.iterations).toBe(2);
    expect(implementStep.run).toHaveBeenCalledTimes(2);
    expect(reviewStep.run).toHaveBeenCalledTimes(2);
  });

  it("stops at maxIterations when reviewer never approves", async () => {
    vi.mocked(reviewStep.run).mockResolvedValue(REJECTED_REVIEW);

    const outputs = await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, maxIterations: 2 },
      new NoopStepReporter(),
    );

    expect(outputs.approved).toBe(false);
    expect(outputs.iterations).toBe(2);
    expect(implementStep.run).toHaveBeenCalledTimes(2);
  });

  it("defaults to 3 maxIterations when not specified", async () => {
    vi.mocked(reviewStep.run).mockResolvedValue(REJECTED_REVIEW);

    const outputs = await feedbackLoopStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.iterations).toBe(3);
  });

  it("passes diff from getDiff to the review step", async () => {
    mockDiff("diff --git a/src/auth.ts\n+new line");
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    await feedbackLoopStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    const reviewCall = vi.mocked(reviewStep.run).mock.calls[0];
    expect(reviewCall[1]).toMatchObject({
      diff: expect.stringContaining("src/auth.ts"),
    });
  });

  it("passes reviewer feedback to the second implement prompt", async () => {
    vi.mocked(reviewStep.run)
      .mockResolvedValueOnce(REJECTED_REVIEW)
      .mockResolvedValueOnce(APPROVED_REVIEW);

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, maxIterations: 3 },
      new NoopStepReporter(),
    );

    const secondImplementCall = vi.mocked(implementStep.run).mock.calls[1];
    expect(secondImplementCall[1]).toMatchObject({
      prompt: expect.stringContaining("Needs improvement"),
    });
  });

  it("reports implement and review sub-steps via reporter", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    const reportedSteps: Step[] = [];
    const reporter: StepReporter = {
      report: vi.fn(async (step) => {
        reportedSteps.push({ ...step });
      }),
    };

    await feedbackLoopStep.run(makeContext(), BASE_INPUTS, reporter);

    const types = reportedSteps.map((s) => s.type);
    expect(types).toContain("implement");
    expect(types).toContain("review");
    // Each sub-step is reported twice: once when started, once when completed
    expect(reporter.report).toHaveBeenCalledTimes(4);
  });

  it("propagates implement step error and reports the sub-step as failed", async () => {
    vi.mocked(implementStep.run).mockRejectedValueOnce(new Error("LLM timeout"));

    const reportedSteps: Step[] = [];
    const reporter: StepReporter = {
      report: vi.fn(async (step) => {
        reportedSteps.push({ ...step });
      }),
    };

    await expect(
      feedbackLoopStep.run(makeContext(), BASE_INPUTS, reporter),
    ).rejects.toThrow("LLM timeout");

    const failedStep = reportedSteps.find((s) => s.status === "failed");
    expect(failedStep).toBeDefined();
    expect(failedStep?.type).toBe("implement");
  });

  it("propagates review step error and reports the sub-step as failed", async () => {
    vi.mocked(reviewStep.run).mockRejectedValueOnce(new Error("review failed"));

    const reportedSteps: Step[] = [];
    const reporter: StepReporter = {
      report: vi.fn(async (step) => {
        reportedSteps.push({ ...step });
      }),
    };

    await expect(
      feedbackLoopStep.run(makeContext(), BASE_INPUTS, reporter),
    ).rejects.toThrow("review failed");

    const failedStep = reportedSteps.find((s) => s.status === "failed");
    expect(failedStep).toBeDefined();
    expect(failedStep?.type).toBe("review");
  });

  it("passes issueTitle and issueDescription to review step", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    await feedbackLoopStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    const reviewCall = vi.mocked(reviewStep.run).mock.calls[0];
    expect(reviewCall[1]).toMatchObject({
      issueTitle: "Implement feature X",
      issueDescription: "Add feature X to the codebase",
    });
  });

  it("forwards planningContext to implement step", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, planningContext: "Use factory pattern" },
      new NoopStepReporter(),
    );

    const implementCall = vi.mocked(implementStep.run).mock.calls[0];
    expect(implementCall[1]).toMatchObject({ planningContext: "Use factory pattern" });
  });

  it("unified model beats repoImplementModel and repoReviewModel", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, model: "unified-model", repoImplementModel: "repo-impl-model", repoReviewModel: "repo-review-model" },
      new NoopStepReporter(),
    );

    const implementCall = vi.mocked(implementStep.run).mock.calls[0];
    const reviewCall = vi.mocked(reviewStep.run).mock.calls[0];
    expect(implementCall[1]).toMatchObject({ model: "unified-model" });
    expect(reviewCall[1]).toMatchObject({ model: "unified-model" });
  });

  it("passes unified model to both implement and review steps", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, model: "claude-opus-4-7" },
      new NoopStepReporter(),
    );

    const implementCall = vi.mocked(implementStep.run).mock.calls[0];
    const reviewCall = vi.mocked(reviewStep.run).mock.calls[0];
    expect(implementCall[1]).toMatchObject({ model: "claude-opus-4-7" });
    expect(reviewCall[1]).toMatchObject({ model: "claude-opus-4-7" });
  });

  it("uses implementModel for implement and reviewModel for review when set separately", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, implementModel: "claude-opus-4-7", reviewModel: "claude-haiku-4-5-20251001" },
      new NoopStepReporter(),
    );

    const implementCall = vi.mocked(implementStep.run).mock.calls[0];
    const reviewCall = vi.mocked(reviewStep.run).mock.calls[0];
    expect(implementCall[1]).toMatchObject({ model: "claude-opus-4-7" });
    expect(reviewCall[1]).toMatchObject({ model: "claude-haiku-4-5-20251001" });
  });

  it("falls back to repoImplementModel and repoReviewModel when no explicit model set", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, repoImplementModel: "claude-opus-4-7", repoReviewModel: "claude-haiku-4-5-20251001" },
      new NoopStepReporter(),
    );

    const implementCall = vi.mocked(implementStep.run).mock.calls[0];
    const reviewCall = vi.mocked(reviewStep.run).mock.calls[0];
    expect(implementCall[1]).toMatchObject({ model: "claude-opus-4-7" });
    expect(reviewCall[1]).toMatchObject({ model: "claude-haiku-4-5-20251001" });
  });

  it("uses tenant model from ctx.data.model when no other model configured", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    const ctx = new DefaultPipelineContext({
      jobId: 1,
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      issueTitle: "Test",
      issueDescription: "Description",
      nonce: "nonce",
      orchestratorUrl: "http://localhost:8080",
      ticketingProvider: "linear",
      model: "claude-opus-4-7",
    });

    await feedbackLoopStep.run(ctx, BASE_INPUTS, new NoopStepReporter());

    const implementCall = vi.mocked(implementStep.run).mock.calls[0];
    const reviewCall = vi.mocked(reviewStep.run).mock.calls[0];
    expect(implementCall[1]).toMatchObject({ model: "claude-opus-4-7" });
    expect(reviewCall[1]).toMatchObject({ model: "claude-opus-4-7" });
  });

  it("explicit implementModel takes precedence over repoImplementModel and tenant model", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    const ctx = new DefaultPipelineContext({
      jobId: 1,
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      issueTitle: "Test",
      issueDescription: "Description",
      nonce: "nonce",
      orchestratorUrl: "http://localhost:8080",
      ticketingProvider: "linear",
      model: "claude-sonnet-4-6",
    });

    await feedbackLoopStep.run(
      ctx,
      { ...BASE_INPUTS, implementModel: "claude-opus-4-7", repoImplementModel: "claude-haiku-4-5-20251001" },
      new NoopStepReporter(),
    );

    const implementCall = vi.mocked(implementStep.run).mock.calls[0];
    expect(implementCall[1]).toMatchObject({ model: "claude-opus-4-7" });
  });

  it("model is visible in the implement sub-step inputs field", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    const reportedSteps: Step[] = [];
    const reporter: StepReporter = {
      report: vi.fn(async (step) => {
        reportedSteps.push({ ...step });
      }),
    };

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, implementModel: "claude-opus-4-7" },
      reporter,
    );

    const implementStep_ = reportedSteps.find((s) => s.type === "implement");
    expect(implementStep_?.inputs).toMatchObject({ model: "claude-opus-4-7" });
  });

  it("model is visible in the review sub-step inputs field", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    const reportedSteps: Step[] = [];
    const reporter: StepReporter = {
      report: vi.fn(async (step) => {
        reportedSteps.push({ ...step });
      }),
    };

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, reviewModel: "claude-haiku-4-5-20251001" },
      reporter,
    );

    const reviewStep_ = reportedSteps.find((s) => s.type === "review");
    expect(reviewStep_?.inputs).toMatchObject({ model: "claude-haiku-4-5-20251001" });
  });
});
