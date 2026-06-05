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

  it("truncates an oversized diff so the prompt stays within the model context window", async () => {
    const executor = makeExecutor(APPROVED_JSON);
    // A regenerated-codegen diff can be hundreds of KB — far past the model's
    // input limit. The review prompt must cap it rather than embed it verbatim.
    const hugeDiff = "+".repeat(500_000);

    await reviewStep.run(makeContext(executor), { diff: hugeDiff }, new NoopStepReporter());

    const call = vi.mocked(executor.invoke).mock.calls[0][0];
    expect(call.prompt.length).toBeLessThan(hugeDiff.length);
    expect(call.prompt).toContain("diff truncated");
  });

  it("truncates an oversized diff at a clean line boundary when one precedes the cap", async () => {
    const executor = makeExecutor(APPROVED_JSON);
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
    expect(call.prompt).not.toContain("x");
  });

  it("does not truncate a normal-sized diff", async () => {
    const executor = makeExecutor(APPROVED_JSON);
    const smallDiff = "diff --git a/foo.ts\n+added line";

    await reviewStep.run(makeContext(executor), { diff: smallDiff }, new NoopStepReporter());

    const call = vi.mocked(executor.invoke).mock.calls[0][0];
    expect(call.prompt).toContain("added line");
    expect(call.prompt).not.toContain("diff truncated");
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
