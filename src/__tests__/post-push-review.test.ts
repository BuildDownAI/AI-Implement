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

  it("submits a native COMMENT review when merge-ready", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], score: 9, progress_delta: 0, feedback: "lgtm" });
    const reviewCalls: string[][] = [];
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.includes("repos/:owner/:repo/pulls/42/reviews")) {
        reviewCalls.push(args);
        return { stdout: "", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

    await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn: vi.fn(() => ({ stdout: "", exitCode: 0 })) },
      { report: vi.fn(async () => undefined) },
    );

    expect(reviewCalls[0]).toContain("event=COMMENT");
    const bodyArg = reviewCalls[0].find((arg) => arg.startsWith("body="));
    expect(bodyArg).toContain("<!-- ai-implement native-review -->");
    expect(bodyArg).toContain("AI-Implement post-push review approved this PR.");
  });

  it("logs native review response details and PR context when submission fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reviewerJson = JSON.stringify({ approved: true, issues: [], score: 9, progress_delta: 0, feedback: "lgtm" });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.includes("repos/:owner/:repo/pulls/42/reviews")) {
        return {
          stdout: JSON.stringify({ message: "Can not approve your own pull request" }),
          stderr: "gh: Unprocessable Entity (HTTP 422)",
          exitCode: 1,
        };
      }
      if (args[0] === "api" && args.includes("repos/:owner/:repo/pulls/42")) {
        return {
          stdout: JSON.stringify({
            html_url: "https://github.com/eudoxus-ai/thrivable-survey-dashboard/pull/42",
            state: "open",
            draft: false,
            user: { login: "ai-implement[bot]" },
            head: {
              ref: "ai-implement/aii-200-x",
              sha: "abc1234567890",
              user: { login: "ai-implement[bot]" },
              repo: { full_name: "eudoxus-ai/thrivable-survey-dashboard" },
            },
            base: {
              ref: "main",
              sha: "def9876543210",
              repo: { full_name: "eudoxus-ai/thrivable-survey-dashboard" },
            },
            mergeable: true,
          }),
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));
    let warnings = "";

    try {
      await postPushReviewStep.run(
        ctx,
        { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn: vi.fn(() => ({ stdout: "", exitCode: 0 })) },
        { report: vi.fn(async () => undefined) },
      );
      warnings = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    } finally {
      warn.mockRestore();
    }

    expect(warnings).toContain("stderr=gh: Unprocessable Entity (HTTP 422)");
    expect(warnings).toContain("stdout={\"message\":\"Can not approve your own pull request\"}");
    expect(warnings).toContain("event=COMMENT");
    expect(warnings).toContain("bodyChars=");
    expect(warnings).toContain("author=ai-implement[bot]");
    expect(warnings).toContain("head=ai-implement/aii-200-x@abc1234");
    expect(warnings).toContain("base=main@def9876");
  });

  it("submits a native COMMENT review when blockers remain", async () => {
    const reviewerJson = JSON.stringify({
      approved: false,
      blocking_issues: [{ title: "Fix validation", problem: "Null owners pass.", required_fix: "Reject null owners." }],
      score: 4,
      progress_delta: 0,
      feedback: "Not ready.",
    });
    const reviewCalls: string[][] = [];
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.includes("repos/:owner/:repo/pulls/42/reviews")) {
        reviewCalls.push(args);
        return { stdout: "", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

    await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn: vi.fn(() => ({ stdout: "", exitCode: 0 })) },
      { report: vi.fn(async () => undefined) },
    );

    expect(reviewCalls[0]).toContain("event=COMMENT");
    expect(reviewCalls[0].find((arg) => arg.startsWith("body="))).toContain("Fix validation");
  });

  it("loops to cap then posts ⚠️ comment", async () => {
    const notApproved = JSON.stringify({ approved: false, issues: ["bug"], feedback: "fix the bug", score: 4, progress_delta: 0 });
    const ghComments: string[] = [];
    const gitPushCalls: string[][] = [];
    const pushOrder: string[] = [];
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "push") {
        gitPushCalls.push(args);
        pushOrder.push("push");
      }
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
    const refreshCredentials = vi.fn(async () => {
      pushOrder.push("refresh");
    });
    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn, refreshCredentials },
      { report: vi.fn(async () => undefined) },
    );
    expect(out.approved).toBe(false);
    expect(out.iterations).toBe(2);
    expect(out.terminationReason).toBe("iterations_exhausted");
    expect(gitPushCalls.length).toBe(1); // only one fix-pass-and-push happens before the cap-iteration which doesn't push
    expect(gitPushCalls[0]).toEqual([
      "push",
      "origin",
      "HEAD:refs/heads/ai-implement/aii-200-x",
      "--force-with-lease=refs/heads/ai-implement/aii-200-x:beadfeed",
    ]);
    expect(refreshCredentials).toHaveBeenCalledTimes(1);
    expect(pushOrder).toEqual(["refresh", "push"]);
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
      expect.objectContaining({
        maxTurns: 12,
        tools: ["Read", "Glob", "Grep", "Bash(curl *)"],
      }),
    );
    expect(ctx.llmExecutor.invoke).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ tools: expect.anything() }),
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

  it("runs a fix pass when reviewer uses the findings alias", async () => {
    const approvedWithFindings = JSON.stringify({
      approved: true,
      findings: [{ title: "Missing guard", problem: "Null input reaches the write path.", required_fix: "Reject null input." }],
      feedback: "One finding remains.",
      score: 7,
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
    const invoke = vi.fn(async () => ({ stdout: approvedWithFindings, exitCode: 0, tokensUsed: 100 }));

    const out = await postPushReviewStep.run(
      makeCtx(invoke),
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][0].prompt).toContain("Missing guard");
    expect(invoke.mock.calls[1][0].prompt).toContain("Reject null input.");
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
    expect(reviewComment).toContain("Unresolved external review findings:");
    expect(reviewComment).toContain("Missing UUID validation on path params.");
  });

  it("runs a fix pass when a Claude issue comment has blocking findings and internal review approves", async () => {
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
        return { stdout: "[]", exitCode: 0 };
      }
      if (args[0] === "api" && args.includes("repos/:owner/:repo/issues/42/comments?per_page=100")) {
        return {
          stdout: JSON.stringify([
            {
              user: { login: "claude" },
              body: "### Code Review\n\n## Blocking\n- Validate path params before database access.",
              html_url: "https://example.com/claude-comment",
            },
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
    expect(fixPrompt).toContain("Validate path params before database access.");
    expect(ghSpawn).toHaveBeenCalledWith([
      "api",
      "--paginate",
      "--slurp",
      "repos/:owner/:repo/issues/42/comments?per_page=100",
    ]);
    const reviewComment = ghComments.find((comment) => comment.includes("Reviewer found issues"));
    expect(reviewComment).toContain("Unresolved external review findings:");
    expect(reviewComment).toContain("Validate path params before database access.");
  });

  it("does not approve when the GitHub Actions Claude review reports a prose blocking finding", async () => {
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
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.includes("repos/:owner/:repo/pulls/42/reviews?per_page=100")) {
        return { stdout: "[]", exitCode: 0 };
      }
      if (args[0] === "api" && args.includes("repos/:owner/:repo/issues/42/comments?per_page=100")) {
        return {
          stdout: JSON.stringify([{
            user: { login: "github-actions[bot]", type: "Bot" },
            body: [
              "**Claude finished the review**",
              "",
              "### Review: PR #42",
              "",
              "### Blocking",
              "",
              "**Missing regression test for the actual vulnerability that was fixed.**",
              "The existing test would pass under the vulnerable implementation.",
              "",
              "### Everything else",
              "",
              "No other changes are required.",
            ].join("\n"),
            html_url: "https://example.com/claude-review",
          }]),
          exitCode: 0,
        };
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
    expect(invoke.mock.calls[1][0].prompt).toContain("Missing regression test for the actual vulnerability that was fixed.");
  });

  it("preserves opportunistic external collection when reviewProviders is undefined", async () => {
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
    expect(ghSpawn).toHaveBeenCalledWith([
      "api",
      "--paginate",
      "--slurp",
      "repos/:owner/:repo/pulls/42/reviews?per_page=100",
    ]);
  });

  it("skips external collection when reviewProviders is an empty array", async () => {
    const reviewerJson = JSON.stringify({
      approved: true,
      issues: [],
      feedback: "Internal reviewer approves.",
      score: 9,
      progress_delta: 0,
    });
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
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
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn, reviewProviders: [] },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(true);
    expect(ghSpawn).not.toHaveBeenCalledWith([
      "api",
      "--paginate",
      "--slurp",
      "repos/:owner/:repo/pulls/42/reviews?per_page=100",
    ]);
  });

  it("collects external findings when github-claude-code-review is configured", async () => {
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
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.includes("repos/:owner/:repo/pulls/42/reviews?per_page=100")) {
        return {
          stdout: JSON.stringify([
            [{ state: "CHANGES_REQUESTED", body: "Configured provider blocker.", user: { login: "reviewer" } }],
          ]),
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      {
        prNumber: "42",
        workspaceDir: "/tmp",
        maxIterations: 2,
        ghSpawn,
        gitSpawn,
        reviewProviders: ["github-claude-code-review"],
      },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(ghSpawn).toHaveBeenCalledWith([
      "api",
      "--paginate",
      "--slurp",
      "repos/:owner/:repo/pulls/42/reviews?per_page=100",
    ]);
    const fixPrompt = invoke.mock.calls[1][0].prompt;
    expect(fixPrompt).toContain("Required external review findings");
    expect(fixPrompt).toContain("Configured provider blocker.");
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
    expect(countOccurrences(reviewComment ?? "", "Missing UUID validation on path params.")).toBe(1);
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
    expect(countOccurrences(reviewComment ?? "", "Missing UUID validation on path params.")).toBe(1);
  });

  it("does not run a fix pass when approved feedback contains actionable language but issues is empty", async () => {
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

    expect(out.approved).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(gitSpawn).not.toHaveBeenCalledWith(["status", "--porcelain"]);
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

  it("requires structured issues when reviewer marks a PR not ready", async () => {
    const notReadyWithoutBlocker = JSON.stringify({
      approved: false,
      issues: [],
      feedback: "There is a bug in the timer restart flow, so this is not ready.",
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

    expect(out.approved).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(gitSpawn).not.toHaveBeenCalledWith(["status", "--porcelain"]);
    expect(ghComments.some((comment) => comment.includes("invalid structured review output"))).toBe(true);
    expect(ghComments.some((comment) => comment.includes("Manual review required"))).toBe(true);
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

  it("does not treat resolved prior blockers in approval feedback as actionable", async () => {
    const approvedWithResolvedBlockers = JSON.stringify({
      approved: true,
      issues: [],
      feedback: "Both Review 1 blockers are resolved. The expired-timer restart bug is fixed and the regression test covers it. Merge readiness: ready to merge.",
      score: 9,
      progress_delta: 0,
    });
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: approvedWithResolvedBlockers, exitCode: 0, tokensUsed: 100 }));
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
      outputs: expect.objectContaining({
        issues: [expect.stringContaining("claude auth temporarily unavailable")],
        blockingIssues: [expect.objectContaining({
          rawText: expect.stringContaining("claude auth temporarily unavailable"),
        })],
      }),
    }));
    expect(ghComments.some((comment) => comment.includes("review-failed"))).toBe(true);
    expect(ghComments.some((comment) => comment.includes("No actionable code feedback was produced"))).toBe(true);
    expect(ghComments.some((comment) => comment.includes("Manual review required; automated review did not complete"))).toBe(true);
    expect(ghComments.some((comment) => comment.includes("Not ready to merge until manually reviewed"))).toBe(false);
  });

  it("reports invalid non-JSON reviewer output with structured blocking issue outputs", async () => {
    const ghComments: string[] = [];
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
      }
      return { stdout: "", exitCode: 0 };
    });
    const report = vi.fn(async () => undefined);
    const ctx = makeCtx(vi.fn(async () => ({
      stdout: "this is not json",
      exitCode: 0,
      tokensUsed: 100,
    })));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn: vi.fn() },
      { report },
    );

    expect(out.approved).toBe(false);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      id: "post-push-review.1",
      status: "failed",
      outputs: expect.objectContaining({
        issues: [expect.stringContaining("Reviewer returned non-JSON output")],
        blockingIssues: [expect.objectContaining({
          rawText: expect.stringContaining("Reviewer returned non-JSON output"),
        })],
      }),
    }));
    expect(ghComments.some((comment) => comment.includes("review-invalid"))).toBe(true);
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
    expect(firstReviewPrompt).toContain("Every blocking_issues[] entry must be self-contained");
    expect(secondReviewPrompt).toContain("Review 1:");
    expect(secondReviewPrompt).toContain("1. Fix auth flow");
    expect(secondReviewPrompt).toContain("first verify every previous issue is fixed");
    expect(invoke.mock.calls[1][0]).toEqual(expect.objectContaining({ maxTurns: 45 }));
  });

  it("includes structured issue details in follow-up review history", async () => {
    const requiredFix = "Move the sessionStorage read into the hydrated effect and keep the dismissed flag synchronized when the first-visit panel is closed.";
    const firstReview = JSON.stringify({
      approved: false,
      blocking_issues: [{
        title: "First-visit hydration state is unsafe",
        location: "src/app/page.tsx",
        problem: "The first render can decide panel visibility before browser-only sessionStorage state is available.",
        required_fix: requiredFix,
      }],
      feedback: "The first-visit state handling still needs one fix.",
      score: 4,
      progress_delta: 0,
    });
    const secondReview = JSON.stringify({
      approved: true,
      blocking_issues: [],
      feedback: "Looks good.",
      score: 9,
      progress_delta: 1,
    });
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "M src/app/page.tsx\n", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--short") return { stdout: "abc1234\n", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "codex/structured-review-feedback\n", exitCode: 0 };
      if (args[0] === "ls-remote") return { stdout: "beadfeed\trefs/heads/codex/structured-review-feedback\n", exitCode: 0 };
      if (args[0] === "show") return { stdout: "M\tsrc/app/page.tsx\n", exitCode: 0 };
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
    const secondReviewPrompt = invoke.mock.calls[2][0].prompt;
    expect(secondReviewPrompt).toContain("Review 1:");
    expect(secondReviewPrompt).toContain("1. First-visit hydration state is unsafe");
    expect(secondReviewPrompt).toContain("Location: src/app/page.tsx");
    expect(secondReviewPrompt).toContain("Problem: The first render can decide panel visibility before browser-only sessionStorage state is available.");
    expect(secondReviewPrompt).toContain(`Required fix: ${requiredFix}`);
  });

  it("posts full structured blocking issues in PR comments and fix prompts", async () => {
    const requiredFix = "Read sessionStorage only after the component has mounted, keep the dismissed flag in sync when the user dismisses the first-visit panel, and preserve the isHydrated guard so server-rendered markup cannot diverge from client-rendered markup.";
    const reviewerJson = JSON.stringify({
      approved: false,
      blocking_issues: [{
        title: "First-visit detection is incomplete",
        location: "src/app/page.tsx",
        problem: "The implementation renders the first-visit panel from a default client value before sessionStorage has been checked, which can show the wrong state during hydration and can re-open a dismissed panel.",
        required_fix: requiredFix,
      }],
      feedback: "The review found one blocker.",
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
    const invoke = vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    const reviewComment = ghComments.find((comment) => comment.includes("Reviewer found issues"));
    expect(reviewComment).toContain("**First-visit detection is incomplete**");
    expect(reviewComment).toContain("Location: `src/app/page.tsx`");
    expect(reviewComment).toContain(requiredFix);

    const fixPrompt = invoke.mock.calls[1][0].prompt;
    expect(fixPrompt).toContain("First-visit detection is incomplete");
    expect(fixPrompt).not.toContain("**First-visit detection is incomplete**");
    expect(fixPrompt).toContain(requiredFix);
    expect(fixPrompt).not.toContain(`${requiredFix.slice(0, 80)}...`);
  });

  it("renders text-only blocking issue objects like legacy string issues", async () => {
    const issueText = "The reviewer returned a legacy text-only object that should stay flat in comments and prompts.";
    const reviewerJson = JSON.stringify({
      approved: false,
      blocking_issues: [{ text: issueText }],
      feedback: issueText,
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
    const invoke = vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    const reviewComment = ghComments.find((comment) => comment.includes("Reviewer found issues"));
    expect(reviewComment).toContain(`Blocking issues:\n1. ${issueText}`);
    expect(reviewComment).not.toContain("**Blocking issue**");

    const fixPrompt = invoke.mock.calls[1][0].prompt;
    expect(fixPrompt).toContain(`Issues:\n1. ${issueText}`);
    expect(fixPrompt).not.toContain("**Blocking issue**");
  });

  it("escapes markdown control characters in structured issue fields", async () => {
    const reviewerJson = JSON.stringify({
      approved: false,
      blocking_issues: [{
        title: "Fix **unsafe** label",
        location: "src/app/`weird`.tsx",
        problem: "Do not render [click me](https://example.com) as a link.",
        required_fix: "Escape *markdown* before posting.",
      }],
      feedback: "Structured fields contain markdown.",
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
    const invoke = vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    const reviewComment = ghComments.find((comment) => comment.includes("Reviewer found issues"));
    expect(reviewComment).toContain("**Fix \\*\\*unsafe\\*\\* label**");
    expect(reviewComment).toContain("Location: `src/app/'weird'.tsx`");
    expect(reviewComment).toContain("Do not render \\[click me\\]\\(https://example.com\\) as a link.");
    expect(reviewComment).toContain("Escape \\*markdown\\* before posting.");

    const fixPrompt = invoke.mock.calls[1][0].prompt;
    expect(fixPrompt).toContain("Fix **unsafe** label");
    expect(fixPrompt).toContain("src/app/`weird`.tsx");
    expect(fixPrompt).toContain("Do not render [click me](https://example.com) as a link.");
    expect(fixPrompt).toContain("Escape *markdown* before posting.");
    expect(fixPrompt).not.toContain("\\[click me\\]\\(https://example.com\\)");
  });

  it("includes unresolved structured issues when a fix pass makes no file changes", async () => {
    const requiredFix = "Persist the dismissed state to sessionStorage before hiding the panel and ensure the initial render waits for the hydrated guard before deciding whether to show the first-visit UI.";
    const reviewerJson = JSON.stringify({
      approved: false,
      blocking_issues: [{
        title: "Dismissed first-visit state is lost",
        location: "src/app/page.tsx",
        problem: "The fix pass must not stop with a generic message because reviewers need the unresolved blocker in the terminal PR comment.",
        required_fix: requiredFix,
      }],
      feedback: "Not ready until the first-visit state is fixed.",
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
    const invoke = vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    const noChangesComment = ghComments.find((comment) => comment.includes("no-changes"));
    expect(noChangesComment).toContain("Unresolved blocking issues:");
    expect(noChangesComment).toContain("Dismissed first-visit state is lost");
    expect(noChangesComment).toContain(requiredFix);
  });

  it("omits duplicate review summaries without truncating legacy blocking issues in PR comments", async () => {
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
    expect(reviewComment).toContain(`Blocking issues:\n1. ${longIssue}`);
    expect(reviewComment).not.toContain("Reviewer summary:");
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

  it("withholds approval and initiates a fix pass when the verdict has only minor[] entries", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "lgtm", score: 9, progress_delta: 0 });
    const ghComments: string[] = [];
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.includes("repos/:owner/:repo/issues/42/comments?per_page=100")) {
        return {
          stdout: JSON.stringify([{
            user: { login: "github-actions[bot]", type: "Bot" },
            body: '<!-- claude-review-verdict {"blocking":[],"minor":[{"body":"Consider extracting this to a helper function"},{"body":"Rename variable for clarity","path":"src/app.ts","line":7}]} -->',
            html_url: "https://example.com/verdict",
          }]),
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
    expect(fixPrompt).toContain("Consider extracting this to a helper function");
    expect(fixPrompt).toContain("Rename variable for clarity");
    const reviewComment = ghComments.find((c) => c.includes("Reviewer found issues"));
    expect(reviewComment).toContain("Unresolved external review findings:");
    expect(reviewComment).toContain("Consider extracting this to a helper function");
    expect(ghComments.some((c) => c.includes("**Merge readiness:** Ready to merge."))).toBe(false);
  });

  it("withholds approval and initiates a fix pass when the verdict has blocking[] entries", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "Internal reviewer approves.", score: 9, progress_delta: 0 });
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghComments: string[] = [];
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.includes("repos/:owner/:repo/issues/42/comments?per_page=100")) {
        return {
          stdout: JSON.stringify([{
            user: { login: "github-actions[bot]", type: "Bot" },
            body: '<!-- claude-review-verdict {"blocking":[{"body":"Missing null guard on path param","path":"src/routes.ts","line":88}],"minor":[]} -->',
            html_url: "https://example.com/verdict",
          }]),
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
    const fixPrompt = (invoke.mock.calls as any[][])[1][0].prompt as string;
    expect(fixPrompt).toContain("Required external review findings");
    expect(fixPrompt).toContain("Missing null guard on path param");
    const reviewComment = ghComments.find((c) => c.includes("Reviewer found issues"));
    expect(reviewComment).toContain("Unresolved external review findings:");
    expect(reviewComment).toContain("Missing null guard on path param");
  });

  it("does not include minor external findings in the approval comment when there are none", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "lgtm", score: 9, progress_delta: 0 });
    const ghComments: string[] = [];
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn: vi.fn(() => ({ stdout: "", exitCode: 0 })) },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(true);
    const approvalComment = ghComments.find((c) => c.includes("✅"));
    expect(approvalComment).not.toContain("non-blocking");
  });

  it("waits for the external review check to complete before approving and ingests its late findings", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "Internal reviewer approves.", score: 9, progress_delta: 0 });
    const sleep = vi.fn(async () => undefined);
    let checkProbes = 0;
    let checkCompleted = false;
    const gitSpawn = vi.fn((args: string[]) => {
      if (args[0] === "status") return { stdout: "", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "deadbeef" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("commits/deadbeef/check-runs"))) {
        checkProbes++;
        // First probe: still running. Second probe: completed.
        if (checkProbes >= 2) checkCompleted = true;
        return {
          stdout: JSON.stringify({
            check_runs: [{ name: "claude-review", status: checkCompleted ? "completed" : "in_progress", conclusion: checkCompleted ? "success" : null }],
          }),
          exitCode: 0,
        };
      }
      if (args[0] === "api" && args.includes("repos/:owner/:repo/pulls/42/reviews?per_page=100")) {
        // Findings only become visible once the external review check has finished.
        return {
          stdout: checkCompleted
            ? JSON.stringify([[{ state: "CHANGES_REQUESTED", body: "Eager createVersion accumulates orphan drafts.", user: { login: "claude" } }]])
            : "[]",
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn, sleep },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled();
    expect(checkProbes).toBeGreaterThanOrEqual(2);
    const fixPrompt = invoke.mock.calls[1][0].prompt;
    expect(fixPrompt).toContain("Eager createVersion accumulates orphan drafts.");
  });

  it("does not auto-approve when the external review check never finishes (fail-closed)", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "Internal reviewer approves.", score: 9, progress_delta: 0 });
    const sleep = vi.fn(async () => undefined);
    const ghComments: string[] = [];
    const reviewCalls: string[][] = [];
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "deadbeef" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("commits/deadbeef/check-runs"))) {
        return { stdout: JSON.stringify({ check_runs: [{ name: "claude-review", status: "in_progress", conclusion: null }] }), exitCode: 0 };
      }
      if (args[0] === "api" && args.includes("repos/:owner/:repo/pulls/42/reviews")) {
        reviewCalls.push(args);
        return { stdout: "[]", exitCode: 0 };
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
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn, sleep, reviewWaitPollMs: 1000, reviewWaitTimeoutMs: 3000 },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(false);
    expect(reviewCalls.some((call) => call.some((arg) => arg.includes("approved this PR")))).toBe(false);
    expect(ghComments.some((c) => c.includes("did not complete") && c.includes("Manual review required"))).toBe(true);
  });

  it("recognizes 'review' and 'code-review-plugin' check names as the external review gate by default", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "ok", score: 9, progress_delta: 0 });
    const sleep = vi.fn(async () => undefined);
    let checkProbes = 0;
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "deadbeef" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("commits/deadbeef/check-runs"))) {
        checkProbes++;
        const done = checkProbes >= 2;
        return {
          stdout: JSON.stringify({
            check_runs: [
              { name: "review", status: done ? "completed" : "in_progress", conclusion: done ? "success" : null },
              { name: "code-review-plugin", status: done ? "completed" : "in_progress", conclusion: done ? "success" : null },
            ],
          }),
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn, sleep },
      { report: vi.fn(async () => undefined) },
    );

    // Both names must be recognised as the external review gate (not absent), causing the step to wait.
    expect(sleep).toHaveBeenCalled();
    expect(checkProbes).toBeGreaterThanOrEqual(2);
    expect(out.approved).toBe(true);
  });

  it("logs a warning when check runs are present but none match the external review gate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "ok", score: 9, progress_delta: 0 });
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "deadbeef" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("commits/deadbeef/check-runs"))) {
        return {
          stdout: JSON.stringify({
            check_runs: [
              { name: "ci", status: "completed" },
              { name: "lint", status: "completed" },
            ],
          }),
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));
    let warnings = "";

    try {
      await postPushReviewStep.run(
        ctx,
        { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn },
        { report: vi.fn(async () => undefined) },
      );
      warnings = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    } finally {
      warn.mockRestore();
    }

    expect(warnings).toContain("No external review check matched");
    expect(warnings).toContain("ci");
    expect(warnings).toContain("lint");
  });

  it("fails open and approves when no external review check exists for the head SHA", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "Internal reviewer approves.", score: 9, progress_delta: 0 });
    const sleep = vi.fn(async () => undefined);
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    let checkRunsQueried = false;
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "deadbeef" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("commits/deadbeef/check-runs"))) {
        checkRunsQueried = true;
        return { stdout: JSON.stringify({ check_runs: [] }), exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 2, ghSpawn, gitSpawn, sleep },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(true);
    expect(checkRunsQueried).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not satisfy the gate when the only matching check concluded 'skipped' (fails closed immediately)", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "ok", score: 9, progress_delta: 0 });
    const sleep = vi.fn(async () => undefined);
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "deadbeef" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("commits/deadbeef/check-runs"))) {
        // code-review-plugin is completed but skipped — bot-authored PR, author_association gate
        return {
          stdout: JSON.stringify({
            check_runs: [{ name: "code-review-plugin", status: "completed", conclusion: "skipped" }],
          }),
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn, sleep, reviewWaitTimeoutMs: 1000, reviewWaitPollMs: 100 },
      { report: vi.fn(async () => undefined) },
    );

    // A skipped check is not a completed review — the gate must fail closed, not auto-approve.
    expect(out.approved).toBe(false);
    // Must fail closed immediately (no-real-verdict path), not after polling to timeout.
    expect(sleep).not.toHaveBeenCalled();
  });

  it("recognizes 'claude-code-review' as the external review gate by default", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "ok", score: 9, progress_delta: 0 });
    const sleep = vi.fn(async () => undefined);
    let checkProbes = 0;
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "deadbeef" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("commits/deadbeef/check-runs"))) {
        checkProbes++;
        const done = checkProbes >= 2;
        return {
          stdout: JSON.stringify({
            check_runs: [{ name: "claude-code-review", status: done ? "completed" : "in_progress", conclusion: done ? "success" : null }],
          }),
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn, sleep },
      { report: vi.fn(async () => undefined) },
    );

    // Must be recognised as the external review gate, causing the step to wait.
    expect(sleep).toHaveBeenCalled();
    expect(checkProbes).toBeGreaterThanOrEqual(2);
    expect(out.approved).toBe(true);
  });

  it("warns with the head SHA when no check runs are present at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "ok", score: 9, progress_delta: 0 });
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "sha1234abc" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("commits/sha1234abc/check-runs"))) {
        return { stdout: JSON.stringify({ check_runs: [] }), exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));
    let warnings = "";

    try {
      await postPushReviewStep.run(
        ctx,
        { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn },
        { report: vi.fn(async () => undefined) },
      );
      warnings = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    } finally {
      warn.mockRestore();
    }

    expect(warnings).toContain("sha1234abc");
  });

  it("does not satisfy the gate when a matching check concluded 'cancelled'", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "ok", score: 9, progress_delta: 0 });
    const sleep = vi.fn(async () => undefined);
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "deadbeef" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("commits/deadbeef/check-runs"))) {
        return {
          stdout: JSON.stringify({
            check_runs: [{ name: "claude-review", status: "completed", conclusion: "cancelled" }],
          }),
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn, sleep, reviewWaitTimeoutMs: 1000, reviewWaitPollMs: 100 },
      { report: vi.fn(async () => undefined) },
    );

    // A cancelled check is not a completed review — the gate must fail closed immediately.
    expect(out.approved).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not satisfy the gate when matching checks concluded 'timed_out' or 'action_required'", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "ok", score: 9, progress_delta: 0 });
    const sleep = vi.fn(async () => undefined);
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));

    for (const conclusion of ["timed_out", "action_required"]) {
      const ghSpawn = vi.fn((args: string[]) => {
        if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
        if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
          return { stdout: JSON.stringify({ head: { sha: "deadbeef" } }), exitCode: 0 };
        }
        if (args[0] === "api" && args.some((a) => a.includes("commits/deadbeef/check-runs"))) {
          return {
            stdout: JSON.stringify({
              check_runs: [{ name: "claude-review", status: "completed", conclusion }],
            }),
            exitCode: 0,
          };
        }
        return { stdout: "", exitCode: 0 };
      });
      const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

      const out = await postPushReviewStep.run(
        ctx,
        { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn, sleep, reviewWaitTimeoutMs: 1000, reviewWaitPollMs: 100 },
        { report: vi.fn(async () => undefined) },
      );

      expect(out.approved).toBe(false);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("does not satisfy the gate when a matching check has an unrecognised novel conclusion", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "ok", score: 9, progress_delta: 0 });
    const sleep = vi.fn(async () => undefined);
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "deadbeef" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("commits/deadbeef/check-runs"))) {
        return {
          stdout: JSON.stringify({
            check_runs: [{ name: "claude-review", status: "completed", conclusion: "future_unknown_conclusion" }],
          }),
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn, sleep, reviewWaitTimeoutMs: 1000, reviewWaitPollMs: 100 },
      { report: vi.fn(async () => undefined) },
    );

    // Unknown conclusions must fail closed, not approve.
    expect(out.approved).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("satisfies the gate when a matching check concluded 'failure'", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "ok", score: 9, progress_delta: 0 });
    const sleep = vi.fn(async () => undefined);
    let checkProbes = 0;
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "deadbeef" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("commits/deadbeef/check-runs"))) {
        checkProbes++;
        const done = checkProbes >= 2;
        return {
          stdout: JSON.stringify({
            check_runs: [{ name: "claude-review", status: done ? "completed" : "in_progress", conclusion: done ? "failure" : null }],
          }),
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn, sleep },
      { report: vi.fn(async () => undefined) },
    );

    // A "failure" conclusion is a real reviewer verdict — the gate should proceed to completion.
    expect(sleep).toHaveBeenCalled();
    expect(checkProbes).toBeGreaterThanOrEqual(2);
    expect(out.approved).toBe(true);
  });

  it("satisfies the gate when a mixed set contains one skipped and one success check", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "ok", score: 9, progress_delta: 0 });
    const sleep = vi.fn(async () => undefined);
    let checkProbes = 0;
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "deadbeef" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("commits/deadbeef/check-runs"))) {
        checkProbes++;
        const done = checkProbes >= 2;
        return {
          stdout: JSON.stringify({
            check_runs: [
              { name: "claude-review", status: "completed", conclusion: "skipped" },
              { name: "code-review-plugin", status: done ? "completed" : "in_progress", conclusion: done ? "success" : null },
            ],
          }),
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn, sleep },
      { report: vi.fn(async () => undefined) },
    );

    // One skipped + one success: the success conclusion satisfies the gate.
    expect(sleep).toHaveBeenCalled();
    expect(checkProbes).toBeGreaterThanOrEqual(2);
    expect(out.approved).toBe(true);
  });

  it("uses configured reviewCheckNames for exact matching, overriding defaults", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], feedback: "ok", score: 9, progress_delta: 0 });
    const sleep = vi.fn(async () => undefined);
    let checkProbes = 0;
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "deadbeef" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("commits/deadbeef/check-runs"))) {
        checkProbes++;
        const done = checkProbes >= 2;
        return {
          stdout: JSON.stringify({
            check_runs: [
              // "review" matches by default but must be ignored when reviewCheckNames is configured.
              { name: "review", status: "completed", conclusion: "success" },
              { name: "my-custom-review", status: done ? "completed" : "in_progress", conclusion: done ? "success" : null },
            ],
          }),
          exitCode: 0,
        };
      }
      return { stdout: "", exitCode: 0 };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn, sleep, reviewCheckNames: ["my-custom-review"] },
      { report: vi.fn(async () => undefined) },
    );

    // "review" must NOT satisfy the gate — only "my-custom-review" is configured.
    // The step must wait for "my-custom-review" to complete.
    expect(sleep).toHaveBeenCalled();
    expect(checkProbes).toBeGreaterThanOrEqual(2);
    expect(out.approved).toBe(true);
  });

  it("T-1 (AII-436): GH Actions bot clean verdict + green review check + zero findings → approved=true", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], score: 9, progress_delta: 0, feedback: "lgtm" });
    const ghComments: string[] = [];
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
        return { stdout: "", exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "abc123def456" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("abc123def456/check-runs"))) {
        return {
          stdout: JSON.stringify({
            check_runs: [{ name: "review", status: "completed", conclusion: "success" }],
          }),
          exitCode: 0,
        };
      }
      if (args[0] === "api" && args.includes("repos/:owner/:repo/pulls/42/reviews?per_page=100")) {
        return { stdout: "[]", exitCode: 0 };
      }
      if (args[0] === "api" && args.includes("repos/:owner/:repo/issues/42/comments?per_page=100")) {
        return {
          stdout: JSON.stringify([{
            user: { login: "github-actions[bot]", type: "Bot" },
            body: "**Claude finished the review**\n\n### Review complete ✅\n\nNo correctness, security, or style issues found.",
            html_url: "https://example.com/review-comment",
          }]),
          exitCode: 0,
        };
      }
      // GraphQL for review threads
      return {
        stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
        exitCode: 0,
      };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn: vi.fn(() => ({ stdout: "", exitCode: 0 })), sleep: async () => {} },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(true);
    expect(ghComments.some((c) => c.includes("✅"))).toBe(true);
    expect(ghComments.some((c) => c.includes("Ready to merge"))).toBe(true);
    // No unavailability note: the clean verdict was parseable
    expect(ghComments.every((c) => !c.includes("findings could not be parsed"))).toBe(true);
  });

  it("T-2 (KGB-9): internal approval + failing CI check → Not ready to merge, check named", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], score: 9, progress_delta: 0, feedback: "lgtm" });
    const ghComments: string[] = [];
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      if (args[0] === "pr" && args[1] === "comment") {
        ghComments.push(args[args.indexOf("--body") + 1]);
        return { stdout: "", exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a === "repos/:owner/:repo/pulls/42")) {
        return { stdout: JSON.stringify({ head: { sha: "def567abc890" } }), exitCode: 0 };
      }
      if (args[0] === "api" && args.some((a) => a.includes("def567abc890/check-runs"))) {
        return {
          stdout: JSON.stringify({
            check_runs: [
              { name: "review", status: "completed", conclusion: "success" },
              { name: "matrix-ubuntu", status: "completed", conclusion: "failure" },
            ],
          }),
          exitCode: 0,
        };
      }
      if (args[0] === "api" && args.includes("repos/:owner/:repo/pulls/42/reviews?per_page=100")) {
        return { stdout: "[]", exitCode: 0 };
      }
      if (args[0] === "api" && args.includes("repos/:owner/:repo/issues/42/comments?per_page=100")) {
        return { stdout: "[]", exitCode: 0 };
      }
      // GraphQL for review threads
      return {
        stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
        exitCode: 0,
      };
    });
    const ctx = makeCtx(vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 })));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn: vi.fn(() => ({ stdout: "", exitCode: 0 })), sleep: async () => {} },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(false);
    const capComment = ghComments.find((c) => c.includes("Not ready to merge"));
    expect(capComment).toBeDefined();
    expect(capComment).toContain("matrix-ubuntu");
  });

  it("exits cleanly with approved=true and pr_merged when PR is already merged at loop start", async () => {
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args[3] === "--json") {
        return { stdout: '{"state":"merged","locked":false}', exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: "", exitCode: 0, tokensUsed: 0 }));
    const ctx = makeCtx(invoke);
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 3, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(true);
    expect(out.terminationReason).toBe("pr_merged");
    expect(out.iterations).toBe(1);
    expect(invoke).not.toHaveBeenCalled();
    expect(gitSpawn).not.toHaveBeenCalled();
  });

  it("exits cleanly with approved=true and pr_merged when PR is locked", async () => {
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args[3] === "--json") {
        return { stdout: '{"state":"open","locked":true}', exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: "", exitCode: 0, tokensUsed: 0 }));
    const ctx = makeCtx(invoke);
    const gitSpawn = vi.fn(() => ({ stdout: "", exitCode: 0 }));

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 3, ghSpawn, gitSpawn },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(true);
    expect(out.terminationReason).toBe("pr_merged");
    expect(out.iterations).toBe(1);
    expect(invoke).not.toHaveBeenCalled();
    expect(gitSpawn).not.toHaveBeenCalled();
  });

  it("continues normally when gh pr view fails (fail-open)", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], score: 9, progress_delta: 0, feedback: "lgtm" });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args[3] === "--json") {
        return { stdout: "", exitCode: 1 };
      }
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn: vi.fn(() => ({ stdout: "", exitCode: 0 })) },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(true);
    expect(out.terminationReason).toBe("approved");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("proceeds normally when PR is open and unlocked (regression guard)", async () => {
    const reviewerJson = JSON.stringify({ approved: true, issues: [], score: 9, progress_delta: 0, feedback: "lgtm" });
    const ghSpawn = vi.fn((args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args[3] === "--json") {
        return { stdout: '{"state":"open","locked":false}', exitCode: 0 };
      }
      if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });
    const invoke = vi.fn(async () => ({ stdout: reviewerJson, exitCode: 0, tokensUsed: 100 }));
    const ctx = makeCtx(invoke);

    const out = await postPushReviewStep.run(
      ctx,
      { prNumber: "42", workspaceDir: "/tmp", maxIterations: 1, ghSpawn, gitSpawn: vi.fn(() => ({ stdout: "", exitCode: 0 })) },
      { report: vi.fn(async () => undefined) },
    );

    expect(out.approved).toBe(true);
    expect(out.terminationReason).toBe("approved");
    expect(invoke).toHaveBeenCalledOnce();
  });
});
