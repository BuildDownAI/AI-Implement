import { describe, expect, it, vi } from "vitest";
import { postPushReviewStep } from "../pipeline/steps/post-push-review.js";
import type { PipelineContext } from "../pipeline/types.js";

function fixture({ failingCi = "", pendingReview = "", issueId = "filesystem:SAN2:SAN2-001" } = {}) {
  let selectedReviewers = false;
  const ghSpawn = vi.fn((args: string[]) => {
    if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
    if (args[0] === "api" && args[1] === "repos/:owner/:repo/pulls/42") {
      return { stdout: JSON.stringify({ state: "open", merged: false, head: { sha: "head123" } }), exitCode: 0 };
    }
    if (args.some(arg => arg.includes("/check-runs"))) {
      const check_runs = failingCi
        ? [{ name: failingCi, status: "completed", conclusion: "failure" }]
        : pendingReview ? [{ name: pendingReview, status: "in_progress", conclusion: null }] : [];
      return { stdout: JSON.stringify({ check_runs }), exitCode: 0 };
    }
    return { stdout: "[]", exitCode: 0 };
  });
  const invoke = vi.fn(async () => ({
    stdout: "", exitCode: 0, tokensUsed: 100,
    structuredOutput: selectedReviewers
      ? { approved: true, findings: [] }
      : { approved: true, blocking_issues: [], feedback: "No issues found.", score: 9, progress_delta: 0 },
    terminalStatus: { subtype: "success", isError: false },
    telemetry: { outcome: "success" as const, numTurns: 1, durationMs: 10, costUsd: null, tokensIn: 1, tokensOut: 1 },
  }));
  const ctx = {
    data: { issueId, issueIdentifier: "TEST-1", issueTitle: "Test", issueDescription: "Test", model: "claude-sonnet-4-6" },
    llmExecutor: { invoke }, getOutputs: () => ({}), setOutputs: () => {}, resolveInputs: (i: unknown) => i,
  } as unknown as PipelineContext;
  const sleep = vi.fn(async () => {});
  const run = (extra: Record<string, unknown> = {}) => {
    selectedReviewers = extra.reviewers !== undefined;
    return postPushReviewStep.run(ctx, {
      prNumber: "42", workspaceDir: "/tmp", maxIterations: 1,
      ghSpawn, gitSpawn: () => ({ stdout: "", exitCode: 0 }), sleep,
      trustedReviewerDefinitions: new Map(["gap-analysis", "code-review"].map(id => [
        id, { id, buildPrompt: () => "Review the diff", outputSchema: { type: "object" } },
      ])),
      reviewWaitPollMs: 1, reviewWaitTimeoutMs: 2, ...extra,
    }, { report: vi.fn(async () => {}) });
  };
  return { run, ghSpawn, sleep, invoke };
}

describe("filesystem external review opt-in", () => {
  it("approves from internal review without waiting or collecting external reviews when nothing is configured", async () => {
    const { run, ghSpawn, sleep, invoke } = fixture();
    const result = await run();
    expect(result.approved).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(ghSpawn.mock.calls.some(([args]) => args.includes("repos/:owner/:repo/pulls/42/reviews?per_page=100"))).toBe(false);
  });

  it("runs both selected internal reviewers without opting into external review", async () => {
    const { run, sleep, invoke } = fixture();
    const result = await run({ reviewers: [{ id: "gap-analysis", gates: true }, { id: "code-review", gates: true }] });
    expect(result.approved).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(["unit-tests", "review"])("still blocks on failed CI named %s without an external provider", async name => {
    const { run, sleep, ghSpawn } = fixture({ failingCi: name });
    const result = await run();
    expect(result.approved).toBe(false);
    expect(ghSpawn.mock.calls.some(([args]) => args.some(arg => arg.includes(`CI check '${name}' is failing`)))).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    { reviewProviders: ["github-claude-code-review"] },
    { reviewCheckNames: ["custom-security-review"] },
    { reviewers: [{ id: "code-review", gates: true }, { id: "claude-review-summary", gates: true }] },
  ])("keeps an explicitly configured external review pending while its check runs: %j", async config => {
    const { run, sleep } = fixture({ pendingReview: "reviewCheckNames" in config ? "custom-security-review" : "review" });
    const result = await run(config);
    expect(result.approved).toBe(false);
    expect(result.terminationReason).toBe("external_review_pending");
    expect(sleep).toHaveBeenCalled();
  });

  it("preserves the implicit external gate for hosted tracker issues", async () => {
    const { run, sleep } = fixture({ issueId: "linear-issue-id", pendingReview: "review" });
    const result = await run();
    expect(result.approved).toBe(false);
    expect(result.terminationReason).toBe("external_review_pending");
    expect(sleep).toHaveBeenCalled();
  });

  it("honors an explicit empty provider list even when check-name hints remain", async () => {
    const { run, sleep } = fixture();
    const result = await run({ reviewProviders: [], reviewCheckNames: ["custom-security-review"] });
    expect(result.approved).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });
});
