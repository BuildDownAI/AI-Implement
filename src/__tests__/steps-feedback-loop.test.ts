import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("../pipeline/steps/implement.js", () => ({
  implementStep: { run: vi.fn() },
}));

vi.mock("../pipeline/steps/review.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pipeline/steps/review.js")>();
  return {
    ...actual,
    reviewStep: { run: vi.fn() },
  };
});

// Wraps the real implementation so its RETURN VALUE stays authentic (backoff math,
// jitter and all) while still being a spy — lets a test assert sleep() was invoked
// with exactly what computeBackoffMs produced, without needing to know that value
// in advance (BAC-27134).
vi.mock("../pipeline/retry-backoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pipeline/retry-backoff.js")>();
  return { ...actual, computeBackoffMs: vi.fn(actual.computeBackoffMs) };
});

import { spawnSync } from "node:child_process";
import { implementStep } from "../pipeline/steps/implement.js";
import { reviewStep } from "../pipeline/steps/review.js";
import { feedbackLoopStep } from "../pipeline/steps/feedback-loop.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import { DEFAULT_RETRY_POLICY, computeBackoffMs } from "../pipeline/retry-backoff.js";
import type { LLMExecutor, Step, StepReporter } from "../pipeline/types.js";

/** No-op sleep so a retry test never actually waits out the real backoff delay. */
const NO_SLEEP = async () => {};

/** A message classifyThrown recognises as PROVIDER_OVERLOADED (transient). */
const TRANSIENT_ERROR_MESSAGE = "upstream returned 529 overloaded_error";

const APPROVED_REVIEW = {
  approved: true,
  issues: [],
  score: 95,
  progressDelta: 100,
  feedback: "Looks good",
  tokensUsed: 0,
  attempts: 1,
};

const REJECTED_REVIEW = {
  approved: false,
  issues: ["Missing tests"],
  score: 40,
  progressDelta: 50,
  feedback: "Needs improvement",
  tokensUsed: 0,
  attempts: 1,
};

const IMPLEMENT_OUTPUTS = {
  filesChanged: ["src/foo.ts"],
  tokensUsed: 100,
  exitCode: 0,
  subagentCount: 0,
  attempts: 1,
};

function makeContext(overrides: Record<string, unknown> = {}): DefaultPipelineContext {
  return new DefaultPipelineContext({
    jobId: 1,
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueTitle: "Test",
    issueDescription: "Description",
    nonce: "nonce",
    orchestratorUrl: "http://localhost:8080",
    ...overrides,
  });
}

const BASE_INPUTS = {
  workspaceDir: "/tmp/workspace",
  issueTitle: "Implement feature X",
  issueDescription: "Add feature X to the codebase",
};

/** Every non-"status" git call returns `diff`; `git status --porcelain` always reports a
 *  clean tree (BAC-27134: dirty tests override this to distinguish clean from dirty). */
function mockDiff(diff = "diff --git a/foo.ts\n+added line") {
  vi.mocked(spawnSync).mockImplementation((_cmd: unknown, args?: readonly string[] | null) => {
    const argv = (args ?? []) as string[];
    const isStatus = argv[0] === "status";
    return {
      status: 0,
      stdout: Buffer.from(isStatus ? "" : diff),
      stderr: Buffer.from(""),
      pid: 0,
      output: [],
      signal: null,
      error: undefined,
    };
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

  it("uses implementationPrompt for the implement step", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, implementationPrompt: "Follow WORKFLOW.md instructions" },
      new NoopStepReporter(),
    );

    const implementCall = vi.mocked(implementStep.run).mock.calls[0];
    expect(implementCall[1]).toMatchObject({ prompt: "Follow WORKFLOW.md instructions" });
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

  it("passes reviewer issues and feedback to the second implement prompt", async () => {
    vi.mocked(reviewStep.run)
      .mockResolvedValueOnce({
        ...REJECTED_REVIEW,
        issues: ["Missing route matrix test", "Pagination can exceed page size"],
        feedback: "The implementation is close, but the blockers remain.",
      })
      .mockResolvedValueOnce(APPROVED_REVIEW);

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, maxIterations: 2 },
      new NoopStepReporter(),
    );

    const secondImplementCall = vi.mocked(implementStep.run).mock.calls[1];
    expect(secondImplementCall[1].prompt).toContain("Missing route matrix test");
    expect(secondImplementCall[1].prompt).toContain("Pagination can exceed page size");
    expect(secondImplementCall[1].prompt).toContain("The implementation is close");
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

  it("re-stamps the iteration-qualified stage on an already-classified implement failure", async () => {
    // implementStep (the real module, not this mock) attaches err.failure with
    // stage "implement". Passed through feedback-loop's classifyThrown as-is,
    // that stage would never become the iteration-qualified
    // "feedback-loop/implement-1" — this asserts the sub-step output and the
    // rethrown error both carry the qualified stage instead.
    const err = Object.assign(new Error("LLM invocation failed with exit code 1"), {
      failure: {
        category: "crash" as const,
        code: "PROCESS_EXIT_NONZERO",
        stage: "implement",
        attempt: 1,
        retryable: false,
        message: "boom",
        evidence: { truncated: false },
      },
    });
    vi.mocked(implementStep.run).mockRejectedValueOnce(err);

    const reportedSteps: Step[] = [];
    const reporter: StepReporter = {
      report: vi.fn(async (step) => {
        reportedSteps.push({ ...step });
      }),
    };

    const thrown = await feedbackLoopStep
      .run(makeContext(), BASE_INPUTS, reporter)
      .catch((e: unknown) => e);

    const failedStep = reportedSteps.find((s) => s.status === "failed" && s.type === "implement");
    expect(failedStep).toBeDefined();
    expect((failedStep?.outputs as { failure?: { stage?: string } }).failure?.stage).toBe(
      "feedback-loop/implement-1",
    );
    expect((thrown as Error & { failure?: { stage?: string } }).failure?.stage).toBe(
      "feedback-loop/implement-1",
    );
  });

  it("carries telemetry stamped on a rejected implement error onto the failed sub-step report (BAC-27136)", async () => {
    // The executor (a spawn-level rejection where every attempt fails) and
    // implement.ts (a settled-but-failing LLMResult) both stamp `err.telemetry`
    // now — feedback-loop must surface it on the failed implement sub-step's
    // outputs, not just the failure record, or the tokens/cost that attempt
    // burned are lost from the run's evidence.
    const telemetry = {
      outcome: "unknown" as const,
      numTurns: 3,
      durationMs: 1500,
      costUsd: 0.05,
      tokensIn: 60,
      tokensOut: 6,
    };
    const err = Object.assign(new Error("LLM invocation failed with exit code 1"), {
      failure: {
        category: "crash" as const,
        code: "PROCESS_EXIT_NONZERO",
        stage: "implement",
        attempt: 3,
        retryable: false,
        message: "boom",
        evidence: { truncated: false },
      },
      telemetry,
    });
    vi.mocked(implementStep.run).mockRejectedValueOnce(err);

    const reportedSteps: Step[] = [];
    const reporter: StepReporter = {
      report: vi.fn(async (step) => {
        reportedSteps.push({ ...step });
      }),
    };

    await feedbackLoopStep.run(makeContext(), BASE_INPUTS, reporter).catch((e: unknown) => e);

    const failedStep = reportedSteps.find((s) => s.status === "failed" && s.type === "implement");
    expect(failedStep).toBeDefined();
    expect((failedStep?.outputs as { telemetry?: typeof telemetry }).telemetry).toEqual(telemetry);
  });

  it("carries telemetry stamped on a rejected review error onto the failed sub-step report (BAC-27136)", async () => {
    // Mirrors the implement-side test above: the executor stamps `err.telemetry`
    // on every give-up rejection, including a review call — feedback-loop must
    // surface it on the failed review sub-step's outputs too.
    const telemetry = {
      outcome: "unknown" as const,
      numTurns: 2,
      durationMs: 900,
      costUsd: 0.02,
      tokensIn: 30,
      tokensOut: 4,
    };
    const err = Object.assign(new Error("Prompt is too long"), { telemetry });
    vi.mocked(reviewStep.run).mockRejectedValueOnce(err);

    const reportedSteps: Step[] = [];
    const reporter: StepReporter = {
      report: vi.fn(async (step) => {
        reportedSteps.push({ ...step });
      }),
    };

    const outputs = await feedbackLoopStep.run(makeContext(), BASE_INPUTS, reporter);

    const failedStep = reportedSteps.find((s) => s.status === "failed" && s.type === "review");
    expect(failedStep).toBeDefined();
    expect((failedStep?.outputs as { telemetry?: typeof telemetry }).telemetry).toEqual(telemetry);
    expect(outputs.passes[0]!.reviewCostUsd).toBe(0.02);
  });

  it("sets reviewCostUsd from the review outputs' telemetry on a successful pass", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce({
      ...APPROVED_REVIEW,
      telemetry: { outcome: "success", numTurns: 3, durationMs: 500, costUsd: 0.05, tokensIn: 10, tokensOut: 5 },
    });

    const outputs = await feedbackLoopStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.passes[0]!.reviewCostUsd).toBe(0.05);
  });

  it("does not throw when the review step fails, so the pipeline can still push", async () => {
    vi.mocked(reviewStep.run).mockRejectedValueOnce(new Error("Prompt is too long"));

    const outputs = await feedbackLoopStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    // A review failure must not discard a successful implementation. The loop
    // ends, approved stays false, and the reason is surfaced in finalFeedback.
    expect(outputs.approved).toBe(false);
    expect(outputs.finalFeedback).toContain("Prompt is too long");
    expect(implementStep.run).toHaveBeenCalledTimes(1);
  });

  it("reports the review sub-step as failed and stops the loop when review throws", async () => {
    vi.mocked(reviewStep.run).mockRejectedValueOnce(new Error("review failed"));

    const reportedSteps: Step[] = [];
    const reporter: StepReporter = {
      report: vi.fn(async (step) => {
        reportedSteps.push({ ...step });
      }),
    };

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, maxIterations: 3 },
      reporter,
    );

    const failedStep = reportedSteps.find((s) => s.status === "failed");
    expect(failedStep).toBeDefined();
    expect(failedStep?.type).toBe("review");
    // The loop must not retry implementation after an infrastructure-level
    // review failure — retrying would burn another implement pass for nothing.
    expect(implementStep.run).toHaveBeenCalledTimes(1);
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

describe("feedbackLoopStep caps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(implementStep.run).mockResolvedValue(IMPLEMENT_OUTPUTS);
    vi.mocked(reviewStep.run).mockResolvedValue(APPROVED_REVIEW);
    mockDiff();
  });

  it("passes maxTurns=50 by default to the implement invocation", async () => {
    await feedbackLoopStep.run(makeContext(), { ...BASE_INPUTS }, new NoopStepReporter());

    const implementCall = vi.mocked(implementStep.run).mock.calls[0];
    expect(implementCall[1]).toMatchObject({ maxTurns: 50 });
  });

  it("honors an explicit maxTurns input", async () => {
    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, maxTurns: 25 },
      new NoopStepReporter(),
    );

    const implementCall = vi.mocked(implementStep.run).mock.calls[0];
    expect(implementCall[1]).toMatchObject({ maxTurns: 25 });
  });

  it("defaults to 2 maxIterations when provider=bedrock", async () => {
    vi.mocked(reviewStep.run).mockResolvedValue(REJECTED_REVIEW);

    const outputs = await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, provider: "bedrock" },
      new NoopStepReporter(),
    );

    expect(outputs.iterations).toBe(2);
  });

  it("defaults to 3 maxIterations when provider is not bedrock", async () => {
    vi.mocked(reviewStep.run).mockResolvedValue(REJECTED_REVIEW);

    const outputs = await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, provider: "anthropic" },
      new NoopStepReporter(),
    );

    expect(outputs.iterations).toBe(3);
  });

  it("honors an explicit maxIterations even when provider=bedrock", async () => {
    vi.mocked(reviewStep.run).mockResolvedValue(REJECTED_REVIEW);

    const outputs = await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, provider: "bedrock", maxIterations: 5 },
      new NoopStepReporter(),
    );

    expect(outputs.iterations).toBe(5);
  });
});

const MAX_TURNS_TELEMETRY = {
  outcome: "max_turns" as const, numTurns: 50, durationMs: 60000,
  costUsd: 2.5, tokensIn: 1000, tokensOut: 500,
  toolTrace: ["Bash npm test", "Read /src/app.ts"],
};

function makeContextWithExecutor(invoke: LLMExecutor["invoke"]): DefaultPipelineContext {
  return new DefaultPipelineContext(
    {
      jobId: 1, issueId: "issue-1", issueIdentifier: "ENG-1", issueTitle: "Test",
      issueDescription: "Description", nonce: "nonce", orchestratorUrl: "http://localhost:8080",
    },
    { invoke },
  );
}

describe("feedbackLoopStep termination reasons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(implementStep.run).mockResolvedValue(IMPLEMENT_OUTPUTS);
    mockDiff();
  });

  it("reports terminationReason=approved with per-pass stats", async () => {
    vi.mocked(implementStep.run).mockResolvedValue({
      ...IMPLEMENT_OUTPUTS,
      telemetry: { outcome: "success", numTurns: 12, durationMs: 1, costUsd: 0.3, tokensIn: 1, tokensOut: 1, toolTrace: [] },
    });
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    const outputs = await feedbackLoopStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.terminationReason).toBe("approved");
    expect(outputs.passes).toEqual([
      {
        iteration: 1, implementTurns: 12, implementOutcome: "success", costUsd: 0.3, reviewCostUsd: null, reviewApproved: true,
        tokensIn: 1, tokensOut: 1, cacheReadTokens: null, cacheCreationTokens: null, attempts: 1, reviewAttempts: 1,
      },
    ]);
  });

  it("reports terminationReason=iterations_exhausted when all reviews reject", async () => {
    vi.mocked(reviewStep.run).mockResolvedValue(REJECTED_REVIEW);

    const outputs = await feedbackLoopStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.approved).toBe(false);
    expect(outputs.terminationReason).toBe("iterations_exhausted");
    expect(outputs.passes).toHaveLength(3);
    expect(outputs.passes[0].reviewApproved).toBe(false);
  });

  it("reports terminationReason=review_error when the review step throws", async () => {
    vi.mocked(reviewStep.run).mockRejectedValueOnce(new Error("Prompt is too long"));

    const outputs = await feedbackLoopStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.approved).toBe(false);
    expect(outputs.terminationReason).toBe("review_error");
    expect(outputs.iterations).toBe(1);
  });

  it("stops on max_turns, skips review, runs the post-mortem, and returns it", async () => {
    vi.mocked(implementStep.run).mockResolvedValue({ ...IMPLEMENT_OUTPUTS, telemetry: MAX_TURNS_TELEMETRY });
    const invoke = vi.fn().mockResolvedValue({ stdout: "## Post-mortem\nRan out of turns wiring X.", exitCode: 0, tokensUsed: 10 });

    const outputs = await feedbackLoopStep.run(makeContextWithExecutor(invoke), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.approved).toBe(false);
    expect(outputs.terminationReason).toBe("max_turns");
    expect(outputs.iterations).toBe(1);
    expect(reviewStep.run).not.toHaveBeenCalled();
    expect(outputs.postMortem).toContain("Ran out of turns");
    // Post-mortem is read-only and capped
    const call = invoke.mock.calls[0][0];
    expect(call.tools).toEqual(["Read", "Glob", "Grep", "Bash(curl *)"]);
    expect(call.maxTurns).toBe(15);
    expect(call.prompt).toContain("Bash npm test"); // tool trace embedded
  });

  it("reports telemetry on the post-mortem sub-step so report-card can price it (BAC-27201)", async () => {
    vi.mocked(implementStep.run).mockResolvedValue({ ...IMPLEMENT_OUTPUTS, telemetry: MAX_TURNS_TELEMETRY });
    const postMortemTelemetry = { outcome: "success" as const, numTurns: 8, durationMs: 4000, costUsd: 0.42, tokensIn: 1, tokensOut: 1 };
    const invoke = vi.fn().mockResolvedValue({
      stdout: "## Post-mortem\nRan out of turns wiring X.",
      exitCode: 0,
      tokensUsed: 10,
      telemetry: postMortemTelemetry,
    });
    const reportedSteps: Step[] = [];
    const reporter: StepReporter = { report: vi.fn(async (step) => { reportedSteps.push({ ...step }); }) };

    await feedbackLoopStep.run(makeContextWithExecutor(invoke), BASE_INPUTS, reporter);

    const postMortemStep = reportedSteps.find((s) => s.id === "post-mortem.1" && s.status === "passed");
    expect(postMortemStep).toBeDefined();
    expect((postMortemStep!.outputs as { telemetry?: unknown }).telemetry).toEqual(postMortemTelemetry);
  });

  it("proceeds to review when a SUCCESSFUL pass reports numTurns above the configured cap", async () => {
    // result.num_turns counts conversation messages, not the agent turns
    // --max-turns bounds — a real production run reported subtype "success" at
    // num_turns 104 under the default 50 cap (7b74bf6). Success above the cap is
    // a normal completed pass and must reach review, not fail as max_turns.
    vi.mocked(implementStep.run).mockResolvedValue({
      ...IMPLEMENT_OUTPUTS,
      telemetry: { ...MAX_TURNS_TELEMETRY, outcome: "success", numTurns: 104 },
    });
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    const outputs = await feedbackLoopStep.run(
      makeContextWithExecutor(vi.fn()),
      { ...BASE_INPUTS, maxTurns: 50, maxIterations: 3 },
      new NoopStepReporter(),
    );

    expect(reviewStep.run).toHaveBeenCalledTimes(1);
    expect(outputs.terminationReason).not.toBe("max_turns");
    expect(outputs.approved).toBe(true);
  });

  it("post-mortem failure is non-fatal", async () => {
    vi.mocked(implementStep.run).mockResolvedValue({ ...IMPLEMENT_OUTPUTS, telemetry: MAX_TURNS_TELEMETRY });
    const invoke = vi.fn().mockRejectedValue(new Error("boom"));

    const outputs = await feedbackLoopStep.run(makeContextWithExecutor(invoke), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.terminationReason).toBe("max_turns");
    expect(outputs.postMortem).toBeUndefined();
  });
});

describe("feedbackLoopStep — reviewer feedback file", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(implementStep.run).mockResolvedValue(IMPLEMENT_OUTPUTS);
    mockDiff();
    tmpDir = mkdtempSync(join(tmpdir(), "fl-feedback-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes finalFeedback to ai-output/comments/80-reviewer-feedback.md on approval", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce({
      ...APPROVED_REVIEW,
      feedback: "All checks pass. Great ingest.",
    });

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, workspaceDir: tmpDir },
      new NoopStepReporter(),
    );

    const feedbackFile = join(tmpDir, "ai-output", "comments", "80-reviewer-feedback.md");
    expect(existsSync(feedbackFile)).toBe(true);
    expect(readFileSync(feedbackFile, "utf-8")).toContain("All checks pass. Great ingest.");
  });

  it("writes finalFeedback to the feedback file even when loop ends unapproved", async () => {
    vi.mocked(reviewStep.run).mockResolvedValue({
      ...REJECTED_REVIEW,
      feedback: "Missing embeddings.stamp file.",
    });

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, workspaceDir: tmpDir, maxIterations: 1 },
      new NoopStepReporter(),
    );

    const feedbackFile = join(tmpDir, "ai-output", "comments", "80-reviewer-feedback.md");
    expect(existsSync(feedbackFile)).toBe(true);
    expect(readFileSync(feedbackFile, "utf-8")).toContain("Missing embeddings.stamp file.");
  });

  it("does not throw when the feedback file write fails", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    // Use a path where mkdirSync will fail (a file in the way)
    const { writeFileSync: realWriteFileSync } = await import("node:fs");
    realWriteFileSync(join(tmpDir, "ai-output"), "NOT A DIR");

    await expect(
      feedbackLoopStep.run(
        makeContext(),
        { ...BASE_INPUTS, workspaceDir: tmpDir },
        new NoopStepReporter(),
      ),
    ).resolves.toBeDefined();
  });
});

describe("feedbackLoopStep — reviewRubric forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(implementStep.run).mockResolvedValue(IMPLEMENT_OUTPUTS);
    mockDiff();
  });

  it("forwards reviewRubric to the review step", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, reviewRubric: "Only approve if snapshot/embeddings.stamp exists." },
      new NoopStepReporter(),
    );

    const reviewCall = vi.mocked(reviewStep.run).mock.calls[0];
    expect(reviewCall[1]).toMatchObject({
      reviewRubric: "Only approve if snapshot/embeddings.stamp exists.",
    });
  });

  it("does not pass reviewRubric to review step when not set", async () => {
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    await feedbackLoopStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    const reviewCall = vi.mocked(reviewStep.run).mock.calls[0];
    expect(reviewCall[1].reviewRubric).toBeUndefined();
  });
});

describe("feedbackLoopStep stage-level retry (BAC-27134)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(implementStep.run).mockResolvedValue(IMPLEMENT_OUTPUTS);
    mockDiff();
  });

  it("implement succeeds, review transient once then approves: one PR, reviewAttempts=2, implement ran once", async () => {
    vi.mocked(reviewStep.run)
      .mockRejectedValueOnce(new Error(TRANSIENT_ERROR_MESSAGE))
      .mockResolvedValueOnce(APPROVED_REVIEW);

    const outputs = await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, sleep: NO_SLEEP },
      new NoopStepReporter(),
    );

    expect(outputs.approved).toBe(true);
    expect(outputs.terminationReason).toBe("approved");
    expect(outputs.passes[0]!.reviewAttempts).toBe(2);
    expect(implementStep.run).toHaveBeenCalledTimes(1);
    expect(reviewStep.run).toHaveBeenCalledTimes(2);
  });

  it("review transient on every attempt with stageRetries=1: two review attempts, terminationReason=provider_unavailable", async () => {
    vi.mocked(reviewStep.run).mockRejectedValue(new Error(TRANSIENT_ERROR_MESSAGE));

    const outputs = await feedbackLoopStep.run(
      makeContext({ retryPolicy: { ...DEFAULT_RETRY_POLICY, stageRetries: 1 } }),
      { ...BASE_INPUTS, sleep: NO_SLEEP },
      new NoopStepReporter(),
    );

    expect(outputs.approved).toBe(false);
    expect(outputs.terminationReason).toBe("provider_unavailable");
    expect(outputs.failure?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(outputs.failure?.stage).toBe("review");
    expect(outputs.failure?.retryable).toBe(false);
    expect(reviewStep.run).toHaveBeenCalledTimes(2);
    expect(implementStep.run).toHaveBeenCalledTimes(1);
  });

  it("implement transient after partial edits: the second attempt receives the continuation prefix", async () => {
    // git status --porcelain reports the partial edit the interrupted run left behind
    // for the whole run (BAC-27134: dirty is evaluated against runStartHead, not a
    // per-pass snapshot) — every other git call returns diff content.
    vi.mocked(spawnSync).mockImplementation((_cmd: unknown, args?: readonly string[] | null) => {
      const argv = (args ?? []) as string[];
      const isStatus = argv[0] === "status";
      const stdout = isStatus ? "M src/foo.ts\n" : "diff --git a/foo.ts\n+added line";
      return {
        status: 0,
        stdout: Buffer.from(stdout),
        stderr: Buffer.from(""),
        pid: 0,
        output: [],
        signal: null,
        error: undefined,
      };
    });

    vi.mocked(implementStep.run)
      .mockRejectedValueOnce(new Error(TRANSIENT_ERROR_MESSAGE))
      .mockResolvedValueOnce(IMPLEMENT_OUTPUTS);
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, sleep: NO_SLEEP },
      new NoopStepReporter(),
    );

    expect(implementStep.run).toHaveBeenCalledTimes(2);
    const secondCall = vi.mocked(implementStep.run).mock.calls[1];
    expect(secondCall[1].prompt).toContain(
      "A previous attempt was interrupted by a provider error. The working tree contains its partial changes. Continue from the current state; do not revert it.",
    );
    // No reset/checkout/clean was ever issued — the partial edit is never discarded.
    const destructiveGitCalls = vi.mocked(spawnSync).mock.calls.filter(([cmd, args]) => {
      const argv = (args ?? []) as string[];
      return cmd === "git" && ["reset", "checkout", "clean"].includes(argv[0]);
    });
    expect(destructiveGitCalls).toHaveLength(0);
  });

  it("implement transient with stageRetries left and a clean tree: retries with the same prompt, no continuation note", async () => {
    // git status --porcelain is empty on every read — the failed attempt left
    // nothing behind, so the retry must reuse the original prompt verbatim.
    mockDiff();

    vi.mocked(implementStep.run)
      .mockRejectedValueOnce(new Error(TRANSIENT_ERROR_MESSAGE))
      .mockResolvedValueOnce(IMPLEMENT_OUTPUTS);
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    await feedbackLoopStep.run(
      makeContext(),
      { ...BASE_INPUTS, sleep: NO_SLEEP },
      new NoopStepReporter(),
    );

    expect(implementStep.run).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(implementStep.run).mock.calls[0];
    const secondCall = vi.mocked(implementStep.run).mock.calls[1];
    expect(secondCall[1].prompt).toBe(firstCall[1].prompt);
    expect(secondCall[1].prompt).not.toContain("A previous attempt was interrupted");
  });

  it("implement transient, exhausted, dirty tree: stops without throwing, terminationReason=provider_unavailable, draft-eligible", async () => {
    // git status --porcelain reports the partial edit the interrupted run left behind —
    // with stageRetries=0 there is no retry left, so the loop must preserve it rather
    // than throw (the BAC-26878 scenario).
    vi.mocked(spawnSync).mockImplementation((_cmd: unknown, args?: readonly string[] | null) => {
      const argv = (args ?? []) as string[];
      const isStatus = argv[0] === "status";
      const stdout = isStatus ? "M src/foo.ts\n" : "diff --git a/foo.ts\n+added line";
      return {
        status: 0,
        stdout: Buffer.from(stdout),
        stderr: Buffer.from(""),
        pid: 0,
        output: [],
        signal: null,
        error: undefined,
      };
    });

    vi.mocked(implementStep.run).mockRejectedValueOnce(new Error(TRANSIENT_ERROR_MESSAGE));

    const outputs = await feedbackLoopStep.run(
      makeContext({ retryPolicy: { ...DEFAULT_RETRY_POLICY, stageRetries: 0 } }),
      { ...BASE_INPUTS, sleep: NO_SLEEP },
      new NoopStepReporter(),
    );

    expect(outputs.approved).toBe(false);
    expect(outputs.terminationReason).toBe("provider_unavailable");
    expect(outputs.failure?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(outputs.failure?.stage).toBe("implement");
    expect(outputs.failure?.retryable).toBe(false);
    expect(implementStep.run).toHaveBeenCalledTimes(1);
    expect(reviewStep.run).not.toHaveBeenCalled();
    // No reset/checkout/clean was ever issued — the partial edit is never discarded.
    const destructiveGitCalls = vi.mocked(spawnSync).mock.calls.filter(([cmd, args]) => {
      const argv = (args ?? []) as string[];
      return cmd === "git" && ["reset", "checkout", "clean"].includes(argv[0]);
    });
    expect(destructiveGitCalls).toHaveLength(0);
  });

  it("implement transient with a clean tree and stageRetries=0: PROVIDER_UNAVAILABLE, no PR", async () => {
    vi.mocked(implementStep.run).mockRejectedValueOnce(new Error(TRANSIENT_ERROR_MESSAGE));

    const thrown = await feedbackLoopStep
      .run(
        makeContext({ retryPolicy: { ...DEFAULT_RETRY_POLICY, stageRetries: 0 } }),
        { ...BASE_INPUTS, sleep: NO_SLEEP },
        new NoopStepReporter(),
      )
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error & { failure?: { code?: string; stage?: string } }).failure?.code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    expect((thrown as Error & { failure?: { code?: string; stage?: string } }).failure?.stage).toBe("implement");
    expect(implementStep.run).toHaveBeenCalledTimes(1);
    expect(reviewStep.run).not.toHaveBeenCalled();
  });

  it("iteration-2 transient failure with no new edits but iteration-1 work present: draft PR with PROVIDER_UNAVAILABLE (BAC-27134)", async () => {
    // git status --porcelain reports iteration 1's leftover uncommitted changes for the
    // WHOLE run — iteration 2's implement call fails before making any edit of its own.
    // A per-pass snapshot would compare this reading against itself (captured fresh at the
    // top of iteration 2, already showing iteration 1's files) and see no difference,
    // misreading the tree as clean and discarding iteration 1's work; the whole-run
    // runStartHead comparison must not make that mistake.
    vi.mocked(spawnSync).mockImplementation((_cmd: unknown, args?: readonly string[] | null) => {
      const argv = (args ?? []) as string[];
      const isStatus = argv[0] === "status";
      return {
        status: 0,
        stdout: Buffer.from(isStatus ? "M src/foo.ts\n" : "diff --git a/foo.ts\n+added line"),
        stderr: Buffer.from(""),
        pid: 0,
        output: [],
        signal: null,
        error: undefined,
      };
    });

    vi.mocked(implementStep.run)
      .mockResolvedValueOnce(IMPLEMENT_OUTPUTS)
      .mockRejectedValueOnce(new Error(TRANSIENT_ERROR_MESSAGE));
    vi.mocked(reviewStep.run).mockResolvedValueOnce(REJECTED_REVIEW);

    const outputs = await feedbackLoopStep.run(
      makeContext({ retryPolicy: { ...DEFAULT_RETRY_POLICY, stageRetries: 0 } }),
      { ...BASE_INPUTS, sleep: NO_SLEEP },
      new NoopStepReporter(),
    );

    expect(outputs.approved).toBe(false);
    expect(outputs.terminationReason).toBe("provider_unavailable");
    expect(outputs.failure?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(outputs.failure?.stage).toBe("implement");
    expect(implementStep.run).toHaveBeenCalledTimes(2);
    expect(reviewStep.run).toHaveBeenCalledTimes(1);
  });

  it("agent-committed work with a clean tree: draft PR (HEAD moved past runStartHead) (BAC-27134)", async () => {
    // git status --porcelain is clean throughout, but git rev-parse HEAD reports a
    // different SHA once the agent's own commit (e.g. a hook or the agent itself)
    // has landed — a hook/template committing on its own must not be misread as "no
    // work to preserve" just because the working tree itself is clean.
    let headCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd: unknown, args?: readonly string[] | null) => {
      const argv = (args ?? []) as string[];
      if (argv[0] === "status") {
        return {
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 0,
          output: [],
          signal: null,
          error: undefined,
        };
      }
      if (argv[0] === "rev-parse" && argv[1] === "HEAD") {
        headCalls++;
        return {
          status: 0,
          stdout: Buffer.from(headCalls === 1 ? "sha1\n" : "sha2\n"),
          stderr: Buffer.from(""),
          pid: 0,
          output: [],
          signal: null,
          error: undefined,
        };
      }
      return {
        status: 0,
        stdout: Buffer.from("diff --git a/foo.ts\n+added line"),
        stderr: Buffer.from(""),
        pid: 0,
        output: [],
        signal: null,
        error: undefined,
      };
    });

    vi.mocked(implementStep.run).mockRejectedValueOnce(new Error(TRANSIENT_ERROR_MESSAGE));

    const outputs = await feedbackLoopStep.run(
      makeContext({ retryPolicy: { ...DEFAULT_RETRY_POLICY, stageRetries: 0 } }),
      { ...BASE_INPUTS, sleep: NO_SLEEP },
      new NoopStepReporter(),
    );

    expect(outputs.approved).toBe(false);
    expect(outputs.terminationReason).toBe("provider_unavailable");
    expect(outputs.failure?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(outputs.failure?.stage).toBe("implement");
    expect(implementStep.run).toHaveBeenCalledTimes(1);
    expect(reviewStep.run).not.toHaveBeenCalled();
  });

  it("keeps every attempt's evidence: a retried attempt reports under its own id, not the canonical row (BAC-27134)", async () => {
    mockDiff();
    const transientErrWithTelemetry = Object.assign(new Error(TRANSIENT_ERROR_MESSAGE), {
      telemetry: { outcome: "error", numTurns: 5, costUsd: 1.23 },
    });
    vi.mocked(implementStep.run)
      .mockRejectedValueOnce(transientErrWithTelemetry)
      .mockResolvedValueOnce(IMPLEMENT_OUTPUTS);
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    const reportedSteps: Step[] = [];
    const reporter: StepReporter = {
      report: vi.fn(async (step) => {
        reportedSteps.push({ ...step });
      }),
    };

    await feedbackLoopStep.run(
      makeContext({ retryPolicy: { ...DEFAULT_RETRY_POLICY, stageRetries: 1 } }),
      { ...BASE_INPUTS, sleep: NO_SLEEP },
      reporter,
    );

    const implementSteps = reportedSteps.filter((s) => s.type === "implement");
    const ids = new Set(implementSteps.map((s) => s.id));
    expect(ids).toEqual(new Set(["implement.1", "implement.1.retry1"]));

    const retryRow = implementSteps.find((s) => s.id === "implement.1.retry1");
    expect(retryRow?.status).toBe("failed");
    expect((retryRow?.outputs as { failure?: { category?: string } }).failure?.category).toBe("transient");
    expect((retryRow?.outputs as { telemetry?: unknown }).telemetry).toEqual(transientErrWithTelemetry.telemetry);

    // The canonical row's only terminal report is the final, successful attempt.
    const canonicalTerminal = implementSteps.filter((s) => s.id === "implement.1" && s.status !== "running");
    expect(canonicalTerminal).toHaveLength(1);
    expect(canonicalTerminal[0]!.status).toBe("passed");
  });

  it("sums a superseded retry attempt's cost into extraCostUsd, not into the pass itself (BAC-27201)", async () => {
    mockDiff();
    const transientErrWithTelemetry = Object.assign(new Error(TRANSIENT_ERROR_MESSAGE), {
      telemetry: { outcome: "error", numTurns: 5, costUsd: 1.23 },
    });
    vi.mocked(implementStep.run)
      .mockRejectedValueOnce(transientErrWithTelemetry)
      .mockResolvedValueOnce(IMPLEMENT_OUTPUTS);
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    const outputs = await feedbackLoopStep.run(
      makeContext({ retryPolicy: { ...DEFAULT_RETRY_POLICY, stageRetries: 1 } }),
      { ...BASE_INPUTS, sleep: NO_SLEEP },
      new NoopStepReporter(),
    );

    expect(outputs.extraCostUsd).toBeCloseTo(1.23);
    // The pass itself only ever reflects the attempt that actually succeeded.
    expect(outputs.passes[0]!.costUsd).toBeNull();
  });

  it("calls the injected sleep with exactly the value computeBackoffMs returns", async () => {
    mockDiff();
    vi.mocked(implementStep.run)
      .mockRejectedValueOnce(new Error(TRANSIENT_ERROR_MESSAGE))
      .mockResolvedValueOnce(IMPLEMENT_OUTPUTS);
    vi.mocked(reviewStep.run).mockResolvedValueOnce(APPROVED_REVIEW);

    const sleep = vi.fn(async () => {});

    await feedbackLoopStep.run(
      makeContext({ retryPolicy: { ...DEFAULT_RETRY_POLICY, stageRetries: 1 } }),
      { ...BASE_INPUTS, sleep },
      new NoopStepReporter(),
    );

    expect(computeBackoffMs).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(vi.mocked(computeBackoffMs).mock.results[0]!.value);
  });

  it("a non-transient implement failure is not retried, even with stage retries available", async () => {
    mockDiff();
    const nonTransientErr = Object.assign(new Error("boom"), {
      failure: {
        category: "crash" as const,
        code: "PROCESS_EXIT_NONZERO",
        stage: "implement",
        attempt: 1,
        retryable: false,
        message: "boom",
        evidence: { truncated: false },
      },
    });
    vi.mocked(implementStep.run).mockRejectedValueOnce(nonTransientErr);

    const thrown = await feedbackLoopStep
      .run(
        makeContext({ retryPolicy: { ...DEFAULT_RETRY_POLICY, stageRetries: 1 } }),
        { ...BASE_INPUTS, sleep: NO_SLEEP },
        new NoopStepReporter(),
      )
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("boom");
    expect(implementStep.run).toHaveBeenCalledTimes(1);
    expect(reviewStep.run).not.toHaveBeenCalled();
  });
});
