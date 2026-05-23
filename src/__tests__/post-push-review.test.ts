import { describe, it, expect, vi } from "vitest";
import { postPushReviewStep } from "../pipeline/steps/post-push-review.js";

function makeCtx(execMock: any) {
  return {
    data: { issueIdentifier: "AII-200", issueTitle: "X", issueDescription: "Y", model: "claude-sonnet-4-6" },
    llmExecutor: { invoke: execMock },
    getOutputs: () => ({}),
    setOutputs: () => {},
    resolveInputs: (i: any) => i,
  } as any;
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("postPushReviewStep", () => {
  it("approves on first iteration, posts ✅ comment, returns approved=true", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], score: 9, progress_delta: 0, feedback: "lgtm" });
    const ghComments: string[] = [];
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
        return { stdout: "", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));
    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );
    expect(out.approved).toBe(true);
    expect(out.iterations).toBe(1);
    expect(ghComments.some((c) => c.includes("✅"))).toBe(true);
    expect(ghComments.some((c) => c.includes("**Merge readiness:** Ready to merge."))).toBe(true);
  });

  it("loops to cap then posts ⚠️ comment", async () => {
    const notApproved = JSON.stringify({ approved: false, issues: ["bug"], feedback: "fix the bug", score: 4, progress_delta: 0 });
    const ghComments: string[] = [];
    const gitPushCalls: string[][] = [];
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "push") gitPushCalls.push(args);
      if (args[0] === "status") return { stdout: "M file.ts\n", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--short") return { stdout: "abc1234\n", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "ai-implement/aii-200-x\n", exitCode: 0 };
      if (args[0] === "ls-remote") return { stdout: "beadfeed\trefs/heads/ai-implement/aii-200-x\n", exitCode: 0 };
      if (args[0] === "show") return { stdout: "M\tapp/api/parse/route.ts\nA\tapp/api/parse/route.test.ts\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
        return { stdout: "", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: notApproved, exitCode: 0, tokensUsed: 100 })));
    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );
    expect(out.approved).toBe(false);
    expect(out.iterations).toBe(2);
    expect(gitPushCalls.length).toBe(1); // only one fix-pass-and-push happens before the cap-iteration which doesn't push
    expect(gitPushCalls[0]).toEqual([
      "push",
      "origin",
      "HEAD:refs/heads/ai-implement/aii-200-x",
      "--force-with-lease=refs/heads/ai-implement/aii-200-x:beadfeed",
    ]);
    expect(ghComments.some((c) => c.includes("fix-complete") && c.includes("abc1234"))).toBe(true);
    expect(ghComments.some((c) => c.includes("Changes pushed:") && c.includes("Modified: `app/api/parse/route.ts`"))).toBe(true);
    expect(ghComments.some((c) => c.includes("Added: `app/api/parse/route.test.ts`"))).toBe(true);
    expect(ghComments.some((c) => c.includes("fix-complete") && c.includes("Awaiting follow-up review"))).toBe(true);
    expect(ghComments.some((c) => c.includes("fix-complete") && c.includes("Fix pass 1/1"))).toBe(true);
    expect(ghComments.some((c) => c.includes("fix-complete") && c.includes("Fix pass 1/2"))).toBe(false);
    expect(ghComments.some((c) => c.includes("⚠️") && c.includes("cap"))).toBe(true);
    expect(ghComments.some((c) => c.includes("cap") && c.includes("Not ready to merge"))).toBe(true);
    expect(ghComments.some((c) => c.includes("cap") && c.includes("Blocking issues:\n1. bug"))).toBe(true);
    expect(ctx.llmExecutor.invoke).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ maxTurns: 12 }),
    );
  });

  it("defaults to two fix passes plus a final review", async () => {
    const notApproved = JSON.stringify({ approved: false, issues: ["bug"], feedback: "fix the bug", score: 4, progress_delta: 0 });
    const ghComments: string[] = [];
    const gitPushCalls: string[][] = [];
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "push") gitPushCalls.push(args);
      if (args[0] === "status") return { stdout: "M file.ts\n", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--short") return { stdout: "abc1234\n", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "ai-implement/aii-200-x\n", exitCode: 0 };
      if (args[0] === "ls-remote") return { stdout: "beadfeed\trefs/heads/ai-implement/aii-200-x\n", exitCode: 0 };
      if (args[0] === "show") return { stdout: "M\tfile.ts\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: notApproved, exitCode: 0, tokensUsed: 100 })));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(false);
    expect(out.iterations).toBe(3);
    expect(gitPushCalls.length).toBe(2);
    expect(ghComments.some((c) => c.includes("Reviewer found issues") && c.includes("fix pass 1/2"))).toBe(true);
    expect(ghComments.some((c) => c.includes("Reviewer found issues") && c.includes("fix pass 2/2"))).toBe(true);
    expect(ghComments.some((c) => c.includes("cap") && c.includes("Reached review cap (3 iterations)"))).toBe(true);
  });

  it("runs a fix pass when reviewer approves but reports actionable issues", async () => {
    const approvedWithIssues = JSON.stringify({
      approved: true,
      issues: ["Escape quoted user input"],
      feedback: "Minor issue worth addressing.",
      score: 8,
      progress_delta: 0,
    });
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: approvedWithIssues, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][0].prompt).toContain("1. Escape quoted user input");
  });

  it("runs a fix pass when an external changes-requested review blocks internal approval", async () => {
    const reviewerJson = JSON.stringify({
      approved: true,
      issues: [],
      feedback: "Internal reviewer approves.",
      score: 9,
      progress_delta: 0,
    });
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghComments: string[] = [];
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.includes("repos/:owner/:repo/pulls/42/reviews?per_page=100")) {
        return {
          stdout: JSON.stringify([
            [{ state: "CHANGES_REQUESTED", body: "Missing UUID validation on path params.", user: { login: "reviewer" } }],
          ]),
          exitCode: 0,
        };
      }
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
      }
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
    const fixPrompt = invoke.mock.calls[1][0].prompt;
    expect(fixPrompt).toContain("Required external review findings");
    expect(countOccurrences(fixPrompt, "Missing UUID validation on path params.")).toBe(1);
    const reviewComment = ghComments.find((comment) => comment.includes("Reviewer found issues"));
    expect(reviewComment).toContain("External review findings are blocking this PR.");
    expect(reviewComment).not.toContain("Missing UUID validation on path params.");
  });

  it("deduplicates internal issues that repeat external review findings", async () => {
    const reviewerJson = JSON.stringify({
      approved: false,
      issues: ["Missing UUID validation on path params."],
      feedback: "External blocker is still unresolved.",
      score: 4,
      progress_delta: 0,
    });
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghComments: string[] = [];
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.includes("repos/:owner/:repo/pulls/42/reviews?per_page=100")) {
        return {
          stdout: JSON.stringify([
            [{ state: "CHANGES_REQUESTED", body: "Missing UUID validation on path params.", user: { login: "reviewer" } }],
          ]),
          exitCode: 0,
        };
      }
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
      }
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    const fixPrompt = invoke.mock.calls[1][0].prompt;
    expect(countOccurrences(fixPrompt, "Missing UUID validation on path params.")).toBe(1);
    const reviewComment = ghComments.find((comment) => comment.includes("Reviewer found issues"));
    expect(countOccurrences(reviewComment ?? "", "Missing UUID validation on path params.")).toBe(0);
  });

  it("suppresses duplicate feedback that repeats external review findings", async () => {
    const reviewerJson = JSON.stringify({
      approved: true,
      issues: [],
      feedback: "Missing UUID validation on path params.",
      score: 9,
      progress_delta: 0,
    });
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghComments: string[] = [];
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.includes("repos/:owner/:repo/pulls/42/reviews?per_page=100")) {
        return {
          stdout: JSON.stringify([
            [{ state: "CHANGES_REQUESTED", body: "Missing UUID validation on path params.", user: { login: "reviewer" } }],
          ]),
          exitCode: 0,
        };
      }
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
      }
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    const fixPrompt = invoke.mock.calls[1][0].prompt;
    expect(fixPrompt).toContain("Required external review findings");
    expect(countOccurrences(fixPrompt, "Missing UUID validation on path params.")).toBe(1);
    const reviewComment = ghComments.find((comment) => comment.includes("Reviewer found issues"));
    expect(reviewComment).not.toContain("Reviewer summary:");
    expect(countOccurrences(reviewComment ?? "", "Missing UUID validation on path params.")).toBe(0);
  });

  it("runs a fix pass when approved feedback contains actionable language but issues is empty", async () => {
    const approvedWithFeedback = JSON.stringify({
      approved: true,
      issues: [],
      feedback: "Two minor issues worth addressing: escape quotes and use an enum.",
      score: 8,
      progress_delta: 0,
    });
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: approvedWithFeedback, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][0].prompt).toContain("Two minor issues worth addressing");
  });

  it("does not run a fix pass for deferred future-task concerns", async () => {
    const approvedWithDeferredConcern = JSON.stringify({
      approved: true,
      issues: [],
      feedback: "Clean implementation. One thing to watch in later tasks: prompt injection would need to be addressed at the API call layer, but noting it now so it doesn't get missed as the pipeline grows.",
      score: 8,
      progress_delta: 0,
    });
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: approvedWithDeferredConcern, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(gitSpawn).not.toHaveBeenCalledWith(["status", "--porcelain"]);
  });

  it("does not turn optional cosmetic review notes into blockers", async () => {
    const approvedWithCosmeticNote = JSON.stringify({
      approved: true,
      issues: [],
      feedback: "Clean implementation. Minor cosmetic note for a later cleanup pass: consider hover:bg-stone-200 at some point, but that is not required by this task.",
      score: 9,
      progress_delta: 0,
    });
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: approvedWithCosmeticNote, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(gitSpawn).not.toHaveBeenCalledWith(["status", "--porcelain"]);
  });

  it("approves malformed not-ready reviews when no actionable blocker is present", async () => {
    const notReadyWithoutBlocker = JSON.stringify({
      approved: false,
      issues: ["Clean resolution of the cosmetic note. All core requirements remain correctly in place. No regressions observed."],
      feedback: "Clean resolution of the cosmetic note. All core requirements remain correctly in place. No regressions observed.",
      score: 9,
      progress_delta: 0,
    });
    const ghComments: string[] = [];
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
      }
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: notReadyWithoutBlocker, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(ghComments.some((comment) => comment.includes("Ready to merge"))).toBe(true);
    expect(ghComments.some((comment) => comment.includes("Not ready to merge"))).toBe(false);
  });

  it("does not treat benign should-pass approval language as actionable", async () => {
    const approvedWithShouldPass = JSON.stringify({
      approved: true,
      issues: [],
      feedback: "The implementation is ready; tests should pass and this should be merged as-is.",
      score: 9,
      progress_delta: 0,
    });
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: approvedWithShouldPass, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(gitSpawn).not.toHaveBeenCalledWith(["status", "--porcelain"]);
  });

  it("does not fail the job when post-push reviewer LLM exits non-zero", async () => {
    const ghComments: string[] = [];
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
        return { stdout: "", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    const report = vi.fn(async () => undefined);
    const ctx = makeCtx(vi.fn(async () => ({
      stdout: "",
      stderr: "claude auth temporarily unavailable",
      exitCode: 1,
      tokensUsed: 0,
    })));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn: vi.fn() },
      { report },
    );

    expect(out.approved).toBe(false);
    expect(out.finalFeedback).toContain("claude auth temporarily unavailable");
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      id: "post-push-review.1",
      status: "failed",
    }));
    expect(ghComments.some((comment) => comment.includes("review-failed"))).toBe(true);
    expect(ghComments.some((comment) => comment.includes("No actionable code feedback was produced"))).toBe(true);
    expect(ghComments.some((comment) => comment.includes("Manual review required; automated review did not complete"))).toBe(true);
    expect(ghComments.some((comment) => comment.includes("Not ready to merge until manually reviewed"))).toBe(false);
  });

  it("does not fail the job when a post-push fix-pass LLM exits non-zero", async () => {
    const notApproved = JSON.stringify({ approved: false, issues: ["x"], feedback: "fix", score: 4, progress_delta: 0 });
    const ghComments: string[] = [];
    const gitSpawn = vi.fn();
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
      }
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn()
      .mockResolvedValueOnce({ stdout: notApproved, exitCode: 0, tokensUsed: 100 })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "claude session expired",
        exitCode: 1,
        tokensUsed: 0,
      });
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 3, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(false);
    expect(out.forcePushedRevisions).toBe(0);
    expect(out.finalFeedback).toContain("claude session expired");
    expect(gitSpawn).not.toHaveBeenCalledWith(["add", "-A"]);
    expect(ghComments.some((comment) => comment.includes("fix-failed"))).toBe(true);
    expect(ghComments.some((comment) => comment.includes("No automated fix was pushed"))).toBe(true);
  });

  it("throws on git push --force-with-lease rejection", async () => {
    const notApproved = JSON.stringify({ approved: false, issues: ["x"], feedback: "fix", score: 4, progress_delta: 0 });
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "M file.ts\n", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--short") return { stdout: "abc1234\n", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "ai-implement/aii-200-x\n", exitCode: 0 };
      if (args[0] === "ls-remote") return { stdout: "beadfeed\trefs/heads/ai-implement/aii-200-x\n", exitCode: 0 };
      if (args[0] === "push") return { stdout: "", stderr: "remote rejected: stale info", exitCode: 1 };
      return { stdout: "", exitCode: 0 };
    });
    const ghSpawn = vi.fn(() => ({ stdout: "diff", exitCode: 0 }));
    const ctx = makeCtx(vi.fn(async () => ({ stdout: notApproved, exitCode: 0, tokensUsed: 100 })));
    await expect(
      postPushReviewStep.run(
        ctx,
        { prNumber: "42", workspaceDir: "/tmp", maxIterations: 3, ghSpawn, gitSpawn },
        { report: vi.fn(async () => undefined) },
      ),
    ).rejects.toThrow(/stale info/);
  });

  it("stops without pushing when the fix pass makes no changes", async () => {
    const notApproved = JSON.stringify({ approved: false, issues: ["x"], feedback: "fix", score: 4, progress_delta: 0 });
    const ghComments: string[] = [];
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: notApproved, exitCode: 0, tokensUsed: 100 })));
    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 3, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(false);
    expect(out.forcePushedRevisions).toBe(0);
    expect(gitSpawn).not.toHaveBeenCalledWith(["commit", "-m", "fix: address review feedback (iter 1)"]);
    expect(gitSpawn).not.toHaveBeenCalledWith(["push", "--force-with-lease"]);
    const noChangesComment = ghComments.find((comment) => comment.includes("no-changes"));
    expect(noChangesComment).toContain("completed with no file changes");
    expect(noChangesComment).toContain("Not ready to merge");
    expect(noChangesComment).not.toContain("Outstanding feedback");
  });

  it("reports unresolved external findings when an externally blocked fix pass makes no changes", async () => {
    const reviewerJson = JSON.stringify({
      approved: true,
      issues: [],
      feedback: "Internal reviewer approves.",
      score: 9,
      progress_delta: 0,
    });
    const ghComments: string[] = [];
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.includes("repos/:owner/:repo/pulls/42/reviews?per_page=100")) {
        return {
          stdout: JSON.stringify([
            [{ state: "CHANGES_REQUESTED", body: "Fix UUID validation.", user: { login: "reviewer" } }],
          ]),
          exitCode: 0,
        };
      }
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
      }
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(false);
    expect(out.forcePushedRevisions).toBe(0);
    const noChangesComment = ghComments.find((comment) => comment.includes("no-changes"));
    expect(noChangesComment).toContain("Unresolved external review findings");
    expect(noChangesComment).toContain("Fix UUID validation.");
    expect(noChangesComment).toContain("Not ready to merge");
  });

  it("skips empty JSON preamble objects when parsing reviewer output", async () => {
    const reviewerJson = `pre-text {} ${JSON.stringify({ approved: true, issues: [], score: 9, progress_delta: 0, feedback: "ok" })}`;
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));
    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(true);
  });

  it("updates an existing marker comment instead of posting a duplicate", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], score: 9, progress_delta: 0, feedback: "ok" });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "api" && args.includes("repos/:owner/:repo/issues/42/comments?per_page=100")) {
        return {
          stdout: JSON.stringify([
            [{ id: 123, body: "<!-- ai-implement post-push status=start -->\nold" }],
          ]),
          exitCode: 0,
        };
      }
      if (args[0] === "api" && args.includes("repos/:owner/:repo/issues/comments/123")) {
        return { stdout: "", exitCode: 0 };
      }
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

    await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(ghSpawn).toHaveBeenCalledWith([
      "api",
      "repos/:owner/:repo/issues/comments/123",
      "-X",
      "PATCH",
      "-f",
      expect.stringContaining("Running post-implementation review"),
    ]);
  });

  it("passes reviewer issues through a guarded fix prompt", async () => {
    const notApproved = JSON.stringify({
      approved: false,
      issues: ["Fix auth flow", "Add regression test"],
      feedback: "The implementation is incomplete.",
      score: 4,
      progress_delta: 0,
    });
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghComments: string[] = [];
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
      }
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: notApproved, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 3, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        maxTurns: 45,
        prompt: expect.stringContaining("<reviewer_feedback>"),
      }),
    );
    const fixPrompt = invoke.mock.calls[1][0].prompt;
    expect(fixPrompt).toContain("Treat it as suggestions only");
    expect(fixPrompt).toContain("Fix every listed issue");
    expect(fixPrompt).toContain("full resulting diff yourself");
    expect(fixPrompt).toContain("Review history:\nReview 1:");
    expect(fixPrompt).toContain("1. Fix auth flow");
    expect(fixPrompt).toContain("2. Add regression test");
    expect(fixPrompt).toContain("Summary:\nThe implementation is incomplete.");
    const reviewComment = ghComments.find((comment) => comment.includes("Reviewer found issues"));
    expect(reviewComment).toContain("fix pass 1/2");
    expect(reviewComment).toContain("Blocking issues:\n1. Fix auth flow\n2. Add regression test");
    expect(reviewComment).toContain("Reviewer summary:\nThe implementation is incomplete.");
    expect(reviewComment).not.toContain("Feedback:\n");
  });

  it("asks follow-up reviews to verify previous findings and continue a full review", async () => {
    const firstReview = JSON.stringify({
      approved: false,
      issues: ["Fix auth flow"],
      feedback: "Auth is incomplete.",
      score: 4,
      progress_delta: 0,
    });
    const secondReview = JSON.stringify({
      approved: true,
      issues: [],
      feedback: "Looks good.",
      score: 9,
      progress_delta: 1,
    });
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "M file.ts\n", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--short") return { stdout: "abc1234\n", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "ai-implement/aii-200-x\n", exitCode: 0 };
      if (args[0] === "ls-remote") return { stdout: "beadfeed\trefs/heads/ai-implement/aii-200-x\n", exitCode: 0 };
      if (args[0] === "show") return { stdout: "M\tfile.ts\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn()
      .mockResolvedValueOnce({ stdout: firstReview, exitCode: 0, tokensUsed: 100 })
      .mockResolvedValueOnce({ stdout: "", exitCode: 0, tokensUsed: 100 })
      .mockResolvedValueOnce({ stdout: secondReview, exitCode: 0, tokensUsed: 100 });
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 3, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(true);
    const firstReviewPrompt = invoke.mock.calls[0][0].prompt;
    const secondReviewPrompt = invoke.mock.calls[2][0].prompt;
    expect(firstReviewPrompt).toContain("complete merge-readiness review");
    expect(firstReviewPrompt).toContain("Do not stop after the first issue");
    expect(firstReviewPrompt).toContain("Every issues[] entry must be self-contained");
    expect(secondReviewPrompt).toContain("Review 1:");
    expect(secondReviewPrompt).toContain("1. Fix auth flow");
    expect(secondReviewPrompt).toContain("first verify every previous issue is fixed");
    expect(invoke.mock.calls[1][0]).toEqual(expect.objectContaining({ maxTurns: 45 }));
  });

  it("omits duplicate review summaries and compacts long blocking issues in PR comments", async () => {
    const longIssue = "The parse API error path is missing user-visible error handling in app/page.tsx, so failed parse requests leave the user stuck on the input surface without feedback or a retry path. Add an error state, render it near OpenInput, and reset loading after failures.";
    const notApproved = JSON.stringify({
      approved: false,
      issues: [longIssue],
      feedback: longIssue,
      score: 4,
      progress_delta: 0,
    });
    const ghComments: string[] = [];
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
      }
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: notApproved, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    const reviewComment = ghComments.find((comment) => comment.includes("Reviewer found issues"));
    expect(reviewComment).toContain("Blocking issues:\n1. The parse API error path is missing user-visible error handling");
    expect(reviewComment).not.toContain("Reviewer summary:");
    expect(reviewComment!.length).toBeLessThan(longIssue.length * 2);
  });

  it("posts a concrete fix summary when the fixer reports one", async () => {
    const notApproved = JSON.stringify({
      approved: false,
      issues: ["Update hover affordance"],
      feedback: "Hover state is invisible.",
      score: 4,
      progress_delta: 0,
    });
    const fixStdout = JSON.stringify({
      fixed: ["Changed OpenInput mic and camera button hover states from stone-100 to stone-200 so they are visible on the landing-page surface."],
      testing: ["Not run; CSS-only class update."],
      notes: "No behavior changes.",
    });
    const ghComments: string[] = [];
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "M components/OpenInput.tsx\n", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--short") return { stdout: "abc1234\n", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "ai-implement/aii-200-x\n", exitCode: 0 };
      if (args[0] === "ls-remote") return { stdout: "beadfeed\trefs/heads/ai-implement/aii-200-x\n", exitCode: 0 };
      if (args[0] === "show") return { stdout: "M\tcomponents/OpenInput.tsx\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
      }
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn()
      .mockResolvedValueOnce({ stdout: notApproved, exitCode: 0, tokensUsed: 100 })
      .mockResolvedValueOnce({ stdout: fixStdout, exitCode: 0, tokensUsed: 100 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ approved: true, issues: [], feedback: "Looks good.", score: 9, progress_delta: 1 }),
        exitCode: 0,
        tokensUsed: 100,
      });
    const ctx = makeCtx(invoke);

    await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    const fixComment = ghComments.find((comment) => comment.includes("fix-complete"));
    expect(fixComment).toContain("Fix summary:");
    expect(fixComment).toContain("Changed OpenInput mic and camera button hover states");
    expect(fixComment).toContain("Verification:");
    expect(fixComment).toContain("CSS-only class update");
    expect(fixComment).toContain("Notes:\nNo behavior changes.");
  });
});
