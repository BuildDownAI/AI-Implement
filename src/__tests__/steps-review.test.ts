import { describe, it, expect, vi, beforeEach } from "vitest";
import { reviewStep } from "../pipeline/steps/review.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type { LLMExecutor, LLMResult } from "../pipeline/types.js";

function makeExecutor(structuredOutput: unknown = undefined, exitCode = 0, tokensUsed = 0, stdout = "Review complete"): LLMExecutor {
  return {
    invoke: vi.fn().mockResolvedValue({ stdout, exitCode, tokensUsed, structuredOutput, terminalStatus: { subtype: "success", isError: false } } satisfies LLMResult),
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
