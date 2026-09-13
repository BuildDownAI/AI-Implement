import { describe, it, expect, vi, beforeEach } from "vitest";
import { reviewStep } from "../pipeline/steps/review.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import { DEFAULT_RETRY_POLICY } from "../pipeline/retry-backoff.js";
import type { LLMExecutor, LLMResult } from "../pipeline/types.js";

function makeExecutor(structuredOutput: unknown = undefined, exitCode = 0, tokensUsed = 0, stdout = "Review complete"): LLMExecutor {
  return {
    invoke: vi.fn().mockResolvedValue({
      stdout,
      exitCode,
      tokensUsed,
      attempts: 1,
      structuredOutput,
      terminalStatus: { subtype: "success", isError: false },
    } satisfies LLMResult),
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
    },
    executor,
  );
}

const APPROVED_VERDICT = {
  approved: true,
  blocking_issues: [],
  score: 95,
  progress_delta: 100,
  feedback: "Looks good",
};

const REJECTED_VERDICT = {
  approved: false,
  blocking_issues: [
    { title: "Missing tests", problem: "Error paths lack coverage", required_fix: "Add regression tests" },
    { title: "No error handling", problem: "Failures escape uncaught", required_fix: "Handle request errors" },
  ],
  score: 40,
  progress_delta: 50,
  feedback: "Needs improvement",
};

describe("reviewStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a negative verdict without actionable implementation issues", async () => {
    const executor = makeExecutor({ ...APPROVED_VERDICT, approved: false });
    await expect(reviewStep.run(makeContext(executor), {}, new NoopStepReporter()))
      .rejects.toThrow("approved=false requires at least one blocking_issues entry");
  });

  it("attaches a classified failure and telemetry to a negative verdict with no blocking issues (BAC-27201)", async () => {
    const telemetry = { outcome: "success" as const, numTurns: 4, durationMs: 500, costUsd: 0.07, tokensIn: 10, tokensOut: 20 };
    const executor: LLMExecutor = {
      invoke: vi.fn().mockResolvedValue({
        stdout: "Review complete",
        exitCode: 0,
        tokensUsed: 0,
        attempts: 1,
        structuredOutput: { ...APPROVED_VERDICT, approved: false },
        terminalStatus: { subtype: "success", isError: false },
        telemetry,
      } satisfies LLMResult),
    };

    const err = await reviewStep
      .run(makeContext(executor), {}, new NoopStepReporter())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const failure = (err as Error & { failure?: { category?: string; code?: string; message?: string } }).failure;
    expect(failure).toBeDefined();
    expect(failure?.category).toBe("invalid_output");
    expect(failure?.code).toBe("INVALID_STRUCTURED_OUTPUT");
    expect(failure?.message).toContain("approved=false requires at least one blocking_issues entry");
    // reviewCostUsd (feedback-loop.ts) is read straight off this attached telemetry — a
    // malformed verdict must not leave it null just because the throw was a bare Error.
    expect((err as Error & { telemetry?: typeof telemetry }).telemetry).toEqual(telemetry);
  });

  it.each([
    ["missing terminal event", { terminalStatus: undefined }, "did not return a terminal result event"],
    ["error terminal event", { terminalStatus: { subtype: "success", isError: true } }, "error terminal result"],
    ["unsuccessful subtype", { terminalStatus: { subtype: "error_max_turns", isError: false } }, "without a successful terminal result"],
    ["unsuccessful telemetry", { telemetry: { outcome: "max_turns" } }, "without a successful terminal result"],
  ])("rejects approval with %s", async (_name, overrides, message) => {
    const executor: LLMExecutor = {
      invoke: vi.fn().mockResolvedValue({
        stdout: "Review complete", exitCode: 0, tokensUsed: 0,
        structuredOutput: APPROVED_VERDICT,
        terminalStatus: { subtype: "success", isError: false },
        ...overrides,
      }),
    };
    await expect(reviewStep.run(makeContext(executor), {}, new NoopStepReporter()))
      .rejects.toThrow(message);
  });

  it("throws (never returns an approved verdict) when telemetry.outcome mismatches despite a parseable approved verdict, and surfaces the executor's LLM_OUTCOME_MISMATCH failure", async () => {
    // exit 0, terminal event says success, and structured_output parses to an
    // approved verdict — but the run's own telemetry outcome disagrees (e.g.
    // max_turns). The executor would classify this as invalid_output/
    // LLM_OUTCOME_MISMATCH and attach it to `result.failure`; reviewStep must
    // throw on it rather than returning the parsed approval, and must pass the
    // executor's failure record through rather than dropping it.
    const executor: LLMExecutor = {
      invoke: vi.fn().mockResolvedValue({
        stdout: "",
        exitCode: 0,
        tokensUsed: 0,
        attempts: 1,
        structuredOutput: APPROVED_VERDICT,
        terminalStatus: { subtype: "success", isError: false },
        telemetry: { outcome: "max_turns", numTurns: 50, durationMs: null, costUsd: null, tokensIn: null, tokensOut: null },
        failure: {
          category: "invalid_output",
          code: "LLM_OUTCOME_MISMATCH",
          stage: "review",
          attempt: 1,
          retryable: false,
          message: "m",
          evidence: { truncated: false },
        },
      } satisfies LLMResult),
    };

    const err = await reviewStep
      .run(makeContext(executor), {}, new NoopStepReporter())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const failure = (err as Error & { failure?: { category?: string; code?: string } }).failure;
    expect(failure?.category).toBe("invalid_output");
    expect(failure?.code).toBe("LLM_OUTCOME_MISMATCH");
  });

  it("parses approved=true from structured JSON response", async () => {
    const executor = makeExecutor(APPROVED_VERDICT);
    const outputs = await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    expect(outputs.approved).toBe(true);
    expect(outputs.score).toBe(95);
    expect(outputs.progressDelta).toBe(100);
    expect(outputs.issues).toEqual([]);
    expect(outputs.feedback).toBe("Looks good");
  });

  it("parses approved=false with issues from JSON response", async () => {
    const executor = makeExecutor(REJECTED_VERDICT);
    const outputs = await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    expect(outputs.approved).toBe(false);
    expect(outputs.issues).toEqual([
      "Missing tests\nProblem: Error paths lack coverage\nRequired fix: Add regression tests",
      "No error handling\nProblem: Failures escape uncaught\nRequired fix: Handle request errors",
    ]);
    expect(outputs.score).toBe(40);
    expect(outputs.progressDelta).toBe(50);
  });

  it("fails closed when reviewer returns approved=true with non-empty issues", async () => {
    const executor = makeExecutor({
      approved: true,
      blocking_issues: [{ title: "Still missing a regression test", problem: "No error-path coverage", required_fix: "Add a regression test" }],
      score: 79,
      progress_delta: 85,
      feedback: "Nearly ready, but one blocker remains.",
    });

    const outputs = await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    expect(outputs.approved).toBe(false);
    expect(outputs.issues).toHaveLength(1);
    expect(outputs.issues[0]).toContain("Still missing a regression test");
    expect(outputs.feedback).toContain("Nearly ready");
  });

  it("does not recover an approval from prose when structured output is absent", async () => {
    const stdout = `Here is my review:\n${JSON.stringify(APPROVED_VERDICT)}\nEnd of review.`;
    const executor = makeExecutor(undefined, 0, 0, stdout);
    await expect(reviewStep.run(makeContext(executor), {}, new NoopStepReporter()))
      .rejects.toThrow("structured_output");
  });

  it("throws on malformed output instead of returning actionable review feedback", async () => {
    const executor = makeExecutor("not valid json at all");
    await expect(reviewStep.run(makeContext(executor), {}, new NoopStepReporter()))
      .rejects.toThrow("structured review output");
  });

  it("attaches a classified failure and telemetry when parseReviewVerdict itself throws (BAC-27201)", async () => {
    const telemetry = { outcome: "success" as const, numTurns: 2, durationMs: 250, costUsd: 0.03, tokensIn: 5, tokensOut: 8 };
    const executor: LLMExecutor = {
      invoke: vi.fn().mockResolvedValue({
        stdout: "Review complete",
        exitCode: 0,
        tokensUsed: 0,
        attempts: 1,
        structuredOutput: "not valid json at all",
        terminalStatus: { subtype: "success", isError: false },
        telemetry,
      } satisfies LLMResult),
    };

    const err = await reviewStep
      .run(makeContext(executor), {}, new NoopStepReporter())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("structured review output");
    const failure = (err as Error & { failure?: { category?: string; code?: string; message?: string } }).failure;
    expect(failure).toBeDefined();
    // A malformed verdict has a concrete, known cause — the parser's own message — so it must
    // not fall back to classifyLlmResult's generic "unknown"/"UNKNOWN" (with the reviewer's raw
    // prose as the message), which is what an exit-0, schema-valid result would otherwise
    // classify as (BAC-27201).
    expect(failure!.category).toBe("invalid_output");
    expect(failure!.code).toBe("INVALID_STRUCTURED_OUTPUT");
    expect(failure!.message).toContain("expected structured review output to be an object");
    expect((err as Error & { telemetry?: typeof telemetry }).telemetry).toEqual(telemetry);
  });

  it("includes diff in prompt when provided", async () => {
    const executor = makeExecutor(APPROVED_VERDICT);
    const ctx = makeContext(executor);

    await reviewStep.run(
      ctx,
      { diff: "diff --git a/foo.ts\n+added line" },
      new NoopStepReporter(),
    );

    const call = vi.mocked(executor.invoke).mock.calls[0][0];
    expect(call.prompt).toContain("Implementation Diff");
    expect(call.prompt).toContain("added line");
  });

  it("tells reviewers that any listed issue blocks approval", async () => {
    const executor = makeExecutor(APPROVED_VERDICT);

    await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    const call = vi.mocked(executor.invoke).mock.calls[0][0];
    expect(call.prompt).toContain("If blocking_issues[] is non-empty, approved must be false");
    expect(call.prompt).toContain("Do not set approved=true while listing unresolved issues");
  });

  it("includes iteration number in prompt", async () => {
    const executor = makeExecutor(APPROVED_VERDICT);
    await reviewStep.run(
      makeContext(executor),
      { iteration: 3 },
      new NoopStepReporter(),
    );

    const call = vi.mocked(executor.invoke).mock.calls[0][0];
    expect(call.prompt).toContain("iteration 3");
  });

  it("uses provided model", async () => {
    const executor = makeExecutor(APPROVED_VERDICT);
    await reviewStep.run(
      makeContext(executor),
      { model: "claude-opus-4-7" },
      new NoopStepReporter(),
    );

    expect(executor.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-7" }),
    );
  });

  it("constrains review sessions to read-only tools", async () => {
    const executor = makeExecutor(APPROVED_VERDICT);

    await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    expect(executor.invoke).toHaveBeenCalledWith(expect.objectContaining({
      tools: ["Read", "Glob", "Grep", "Bash(curl *)"],
    }));
  });

  it("throws when executor returns non-zero exit code", async () => {
    const executor = makeExecutor("", 1);
    await expect(
      reviewStep.run(makeContext(executor), {}, new NoopStepReporter()),
    ).rejects.toThrow("exit code 1");
  });

  it("falls back to classifying the failure itself when a custom executor's non-zero exit carries no pre-computed failure record", async () => {
    // Round-four review follow-up (BAC-27114): a custom LLMExecutor (this test's
    // own opts.llmExecutor-style seam) may settle a non-zero exit without ever
    // attaching `result.failure` — reviewStep must not leave failure_json empty
    // in that case, so it derives one via classifyLlmResult itself.
    const executor: LLMExecutor = {
      invoke: vi.fn().mockResolvedValue({
        stdout: "",
        stderr: "boom, nothing recognisable here",
        exitCode: 1,
        tokensUsed: 0,
        attempts: 1,
      } satisfies LLMResult),
    };

    const err = await reviewStep
      .run(makeContext(executor), {}, new NoopStepReporter())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const failure = (err as Error & { failure?: { category?: string; code?: string; stage?: string } }).failure;
    expect(failure?.category).toBe("crash");
    expect(failure?.code).toBe("PROCESS_EXIT_NONZERO");
    expect(failure?.stage).toBe("review");
  });

  it("surfaces the executor's pre-computed failure record on the thrown error (terminal error)", async () => {
    // The executor — not reviewStep — classifies the failure now (BAC-27114 follow-up):
    // that classification logic is covered directly in failure-classification.test.ts
    // and executor.test.ts; this only checks that reviewStep passes `result.failure`
    // through as-is rather than re-deriving it.
    const executor: LLMExecutor = {
      invoke: vi.fn().mockResolvedValue({
        stdout: "",
        exitCode: 0,
        tokensUsed: 0,
        attempts: 1,
        structuredOutput: undefined,
        terminalStatus: { subtype: "error_during_execution", isError: true },
        failure: {
          category: "invalid_output",
          code: "LLM_TERMINAL_ERROR",
          stage: "review",
          attempt: 1,
          retryable: false,
          message: "m",
          evidence: { truncated: false },
        },
      } satisfies LLMResult),
    };

    const err = await reviewStep
      .run(makeContext(executor), {}, new NoopStepReporter())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const failure = (err as Error & { failure?: { category?: string; code?: string } }).failure;
    expect(failure?.category).toBe("invalid_output");
    expect(failure?.code).toBe("LLM_TERMINAL_ERROR");
  });

  it("surfaces the executor's failure.elapsedMs on the thrown error", async () => {
    const executor: LLMExecutor = {
      invoke: vi.fn().mockResolvedValue({
        stdout: "",
        exitCode: 0,
        tokensUsed: 0,
        attempts: 1,
        structuredOutput: undefined,
        terminalStatus: { subtype: "error_during_execution", isError: true },
        telemetry: { outcome: "error", numTurns: 1, durationMs: 7500, costUsd: null, tokensIn: null, tokensOut: null },
        failure: {
          category: "invalid_output",
          code: "LLM_TERMINAL_ERROR",
          stage: "review",
          attempt: 1,
          retryable: false,
          elapsedMs: 7500,
          message: "m",
          evidence: { truncated: false },
        },
      } satisfies LLMResult),
    };

    const err = await reviewStep
      .run(makeContext(executor), {}, new NoopStepReporter())
      .catch((e: unknown) => e);

    const failure = (err as Error & { failure?: { elapsedMs?: number } }).failure;
    expect(failure?.elapsedMs).toBe(7500);
  });

  it("forwards context.data.retryPolicy as retry with the review-specific flags", async () => {
    const executor = makeExecutor(APPROVED_VERDICT);
    const ctx = new DefaultPipelineContext(
      {
        jobId: 1,
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        issueTitle: "Test",
        issueDescription: "Description",
        nonce: "nonce",
        orchestratorUrl: "http://localhost:8080",
        retryPolicy: DEFAULT_RETRY_POLICY,
      },
      executor,
    );

    await reviewStep.run(ctx, {}, new NoopStepReporter());

    expect(executor.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "review",
        expectsStructuredOutput: true,
        retry: {
          policy: DEFAULT_RETRY_POLICY,
          toolUseIsSafe: true,
        },
      }),
    );
  });

  it("omits retry when context.data.retryPolicy is absent", async () => {
    const executor = makeExecutor(APPROVED_VERDICT);

    await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    const call = vi.mocked(executor.invoke).mock.calls[0][0];
    expect(call.retry).toBeUndefined();
  });

  it("returns tokensUsed from executor", async () => {
    const executor = makeExecutor(APPROVED_VERDICT, 0, 200);
    const outputs = await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    expect(outputs.tokensUsed).toBe(200);
  });

  it("truncates an oversized diff so the prompt stays within the model context window", async () => {
    const executor = makeExecutor(APPROVED_VERDICT);
    // A regenerated-codegen diff can be hundreds of KB — far past the model's
    // input limit. The review prompt must cap it rather than embed it verbatim.
    const hugeDiff = "+".repeat(500_000);

    await reviewStep.run(makeContext(executor), { diff: hugeDiff }, new NoopStepReporter());

    const call = vi.mocked(executor.invoke).mock.calls[0][0];
    expect(call.prompt.length).toBeLessThan(hugeDiff.length);
    expect(call.prompt).toContain("diff truncated");
  });

  it("truncates an oversized diff at a clean line boundary when one precedes the cap", async () => {
    const executor = makeExecutor(APPROVED_VERDICT);
    // Oversized diff whose only newline sits before the 200k char cap, so the
    // cut should land on that newline (the `cut > 0` branch) rather than the
    // hard cap. Lengths chosen so the boundary is unambiguous: 150_000.
    // Distinct head/tail chars so the tail assertion is meaningful (a run of
    // "+" would be a substring of an all-"+" head).
    const head = "+".repeat(150_000);
    const tail = "x".repeat(100_000);
    const diff = `${head}\n${tail}`;

    await reviewStep.run(makeContext(executor), { diff }, new NoopStepReporter());

    const call = vi.mocked(executor.invoke).mock.calls[0][0];
    // Marker reports the line-boundary cut (150_000), not the hard cap (200_000).
    expect(call.prompt).toContain(`showing first 150000 of ${diff.length} characters`);
    // The tail past the newline must not be embedded.
    expect(call.prompt).not.toContain(tail.slice(0, 100));
  });

  it("does not truncate a normal-sized diff", async () => {
    const executor = makeExecutor(APPROVED_VERDICT);
    const smallDiff = "diff --git a/foo.ts\n+added line";

    await reviewStep.run(makeContext(executor), { diff: smallDiff }, new NoopStepReporter());

    const call = vi.mocked(executor.invoke).mock.calls[0][0];
    expect(call.prompt).toContain("added line");
    expect(call.prompt).not.toContain("diff truncated");
  });

  it("uses structured output independently of stray braces in prose", async () => {
    const stdout = "Result: {broken prose";
    const executor = makeExecutor(APPROVED_VERDICT, 0, 0, stdout);
    const outputs = await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    expect(outputs.approved).toBe(true);
    expect(outputs.score).toBe(95);
  });
  it("appends reviewRubric to prompt when supplied", async () => {
    const executor = makeExecutor(APPROVED_VERDICT);
    await reviewStep.run(
      makeContext(executor),
      { reviewRubric: "CUSTOM RUBRIC TEXT FOR THIS RUN TYPE" },
      new NoopStepReporter(),
    );

    const call = vi.mocked(executor.invoke).mock.calls[0][0];
    expect(call.prompt).toContain("Run-specific review rubric");
    expect(call.prompt).toContain("CUSTOM RUBRIC TEXT FOR THIS RUN TYPE");
  });

  it("does not include rubric section when reviewRubric is undefined", async () => {
    const executor = makeExecutor(APPROVED_VERDICT);
    await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    const call = vi.mocked(executor.invoke).mock.calls[0][0];
    expect(call.prompt).not.toContain("Run-specific review rubric");
    // Approval contract must always appear regardless
    expect(call.prompt).toContain("Approval contract");
  });
});
