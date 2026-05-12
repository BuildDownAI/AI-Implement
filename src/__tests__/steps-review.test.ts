import { describe, it, expect, vi, beforeEach } from "vitest";
import { reviewStep } from "../pipeline/steps/review.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import type { LLMExecutor, LLMResult } from "../pipeline/types.js";

function makeExecutor(stdout = "", exitCode = 0, tokensUsed = 0): LLMExecutor {
  return {
    invoke: vi.fn().mockResolvedValue({ stdout, exitCode, tokensUsed } satisfies LLMResult),
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
      ticketingProvider: "linear",
    },
    executor,
  );
}

const APPROVED_JSON = JSON.stringify({
  approved: true,
  issues: [],
  score: 95,
  progress_delta: 100,
  feedback: "Looks good",
});

const REJECTED_JSON = JSON.stringify({
  approved: false,
  issues: ["Missing tests", "No error handling"],
  score: 40,
  progress_delta: 50,
  feedback: "Needs improvement",
});

describe("reviewStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses approved=true from structured JSON response", async () => {
    const executor = makeExecutor(APPROVED_JSON);
    const outputs = await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    expect(outputs.approved).toBe(true);
    expect(outputs.score).toBe(95);
    expect(outputs.progressDelta).toBe(100);
    expect(outputs.issues).toEqual([]);
    expect(outputs.feedback).toBe("Looks good");
  });

  it("parses approved=false with issues from JSON response", async () => {
    const executor = makeExecutor(REJECTED_JSON);
    const outputs = await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    expect(outputs.approved).toBe(false);
    expect(outputs.issues).toEqual(["Missing tests", "No error handling"]);
    expect(outputs.score).toBe(40);
    expect(outputs.progressDelta).toBe(50);
  });

  it("extracts JSON embedded in surrounding text", async () => {
    const stdout = `Here is my review:\n${APPROVED_JSON}\nEnd of review.`;
    const executor = makeExecutor(stdout);
    const outputs = await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    expect(outputs.approved).toBe(true);
  });

  it("defaults to approved=false when JSON cannot be parsed", async () => {
    const executor = makeExecutor("not valid json at all");
    const outputs = await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    expect(outputs.approved).toBe(false);
    expect(outputs.feedback).toBe("not valid json at all");
  });

  it("includes diff in prompt when provided", async () => {
    const executor = makeExecutor(APPROVED_JSON);
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

  it("includes iteration number in prompt", async () => {
    const executor = makeExecutor(APPROVED_JSON);
    await reviewStep.run(
      makeContext(executor),
      { iteration: 3 },
      new NoopStepReporter(),
    );

    const call = vi.mocked(executor.invoke).mock.calls[0][0];
    expect(call.prompt).toContain("iteration 3");
  });

  it("uses provided model", async () => {
    const executor = makeExecutor(APPROVED_JSON);
    await reviewStep.run(
      makeContext(executor),
      { model: "claude-opus-4-7" },
      new NoopStepReporter(),
    );

    expect(executor.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-7" }),
    );
  });

  it("throws when executor returns non-zero exit code", async () => {
    const executor = makeExecutor("", 1);
    await expect(
      reviewStep.run(makeContext(executor), {}, new NoopStepReporter()),
    ).rejects.toThrow("exit code 1");
  });

  it("returns tokensUsed from executor", async () => {
    const executor = makeExecutor(APPROVED_JSON, 0, 200);
    const outputs = await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    expect(outputs.tokensUsed).toBe(200);
  });

  it("correctly extracts JSON when preamble contains stray braces", async () => {
    // Greedy regex would match from first '{' in preamble to last '}' → invalid JSON.
    // Balanced-brace scanner skips the empty preamble '{}' and finds the real object.
    const stdout = `Result: {} — here is the JSON: ${APPROVED_JSON}`;
    const executor = makeExecutor(stdout);
    const outputs = await reviewStep.run(makeContext(executor), {}, new NoopStepReporter());

    expect(outputs.approved).toBe(true);
    expect(outputs.score).toBe(95);
  });
});
