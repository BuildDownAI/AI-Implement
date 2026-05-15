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
  });

  it("loops to cap then posts ⚠️ comment", async () => {
    const notApproved = JSON.stringify({ approved: false, issues: ["bug"], feedback: "fix the bug", score: 4, progress_delta: 0 });
    const ghComments: string[] = [];
    const gitPushCalls: string[][] = [];
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "push") gitPushCalls.push(args);
      if (args[0] === "status") return { stdout: "M file.ts\n", exitCode: 0 };
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
    expect(ghComments.some((c) => c.includes("⚠️") && c.includes("cap"))).toBe(true);
  });

  it("throws on git push --force-with-lease rejection", async () => {
    const notApproved = JSON.stringify({ approved: false, issues: ["x"], feedback: "fix", score: 4, progress_delta: 0 });
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "M file.ts\n", exitCode: 0 };
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
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
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
});
