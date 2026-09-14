import { describe, expect, it, vi } from "vitest";
import { postPushReviewStep } from "../pipeline/steps/post-push-review.js";
import type { PipelineContext } from "../pipeline/types.js";

const checks = [{
  check: "Pulse speed matches the requested behavior",
  result: "passed",
  evidence: "src/jellyfish.ts: pulseDuration changes from 1s to 3s.",
}, {
  check: "Browser animation",
  result: "not_verified",
  evidence: "Inspected the CSS; no browser was launched.",
}];
const summary = "The requested animation change is implemented in the shared pulse setting.";

async function runReview(verdict: Record<string, unknown>, externalPending = false, maxIterations = 1) {
  const ghSpawn = vi.fn((args: string[]) => {
    if (args[0] === "pr" && args[1] === "diff") return { stdout: "diff", exitCode: 0 };
    if (args.includes("repos/:owner/:repo/pulls/42")) {
      return { stdout: JSON.stringify({ state: "open", head: { sha: "head123" } }), exitCode: 0 };
    }
    if (args.some(arg => arg.includes("/check-runs"))) {
      return { stdout: JSON.stringify({ check_runs: [{ name: "review", status: "in_progress", conclusion: null }] }), exitCode: 0 };
    }
    return { stdout: "[]", exitCode: 0 };
  });
  const invoke = vi.fn(async () => ({
    stdout: "", exitCode: 0, tokensUsed: 100, structuredOutput: verdict,
    terminalStatus: { subtype: "success", isError: false },
  }));
  const context = {
    data: { issueId: "filesystem:SAN:SAN-1", issueIdentifier: "SAN-1", issueTitle: "Slow the pulse", issueDescription: "Slow the animation" },
    llmExecutor: { invoke }, getOutputs: () => ({}), setOutputs: () => {}, resolveInputs: (i: unknown) => i,
  } as unknown as PipelineContext;
  const report = vi.fn(async (_row: Record<string, any>) => {});
  const result = await postPushReviewStep.run(context, {
    prNumber: "42", workspaceDir: "/tmp", maxIterations, ghSpawn,
    gitSpawn: () => ({ stdout: "", exitCode: 0 }),
    reviewProviders: externalPending ? ["github-claude-code-review"] : [],
    sleep: async () => {}, reviewWaitPollMs: 1, reviewWaitTimeoutMs: 2,
    reviewers: [{ id: "code-review", gates: true }],
    trustedReviewerDefinitions: new Map([["code-review", { id: "code-review", buildPrompt: () => "Review", outputSchema: { type: "object" } }]]),
  }, { report });
  const nativeBodies = ghSpawn.mock.calls.filter(([args]) => args.includes("event=COMMENT"))
    .map(([args]) => args.find(arg => arg.startsWith("body=")) || "");
  const comments = ghSpawn.mock.calls.filter(([args]) => args[0] === "pr" && args[1] === "comment")
    .map(([args]) => args[args.indexOf("--body") + 1]);
  return { result, report, nativeBodies, comments };
}

describe("reviewer evidence reports", () => {
  it("publishes and persists checked behavior and limitations on approval", async () => {
    const { result, report, nativeBodies, comments } = await runReview({ approved: true, findings: [], summary, checks });
    expect(result.approved).toBe(true);
    for (const bodies of [nativeBodies, comments]) {
      expect(bodies.join("\n")).toContain(summary);
      expect(bodies.join("\n")).toContain(checks[0].check);
      expect(bodies.join("\n")).toContain(checks[0].evidence);
      expect(bodies.join("\n")).toContain("Not verified");
      expect(bodies.join("\n")).toContain(checks[1].evidence);
    }
    const child = report.mock.calls.find(([row]) => row.id.includes("reviewer.0"))![0];
    expect(child.outputs).toMatchObject({ approved: true, summary, checks, findings: [] });
  });

  it.each([false, true])("publishes the evidence when approval is blocked (external pending: %s)", async externalPending => {
    const findings = externalPending ? [] : [{ severity: "blocking", body: "Duration is ignored by the render loop." }];
    const { result, nativeBodies } = await runReview({ approved: externalPending, findings, summary, checks }, externalPending);
    expect(result.approved).toBe(false);
    expect(result.terminationReason).toBe(externalPending ? "external_review_pending" : "iterations_exhausted");
    expect(nativeBodies.join("\n")).toContain(summary);
    expect(nativeBodies.join("\n")).toContain(checks[0].evidence);
  });

  it("keeps legacy custom reviewer verdicts compatible without inventing evidence", async () => {
    const { result, report } = await runReview({ approved: true, findings: [] });
    expect(result.approved).toBe(true);
    const child = report.mock.calls.find(([row]) => row.id.includes("reviewer.0"))![0];
    expect(child.outputs.checks).toBeUndefined();
  });

  it("does not let a positive report override actionable findings", async () => {
    const { result } = await runReview({
      approved: true, summary: "Everything looks good", checks,
      findings: [{ severity: "blocking", body: "The renderer ignores the new setting." }],
    });
    expect(result.approved).toBe(false);
    expect(result.terminationReason).toBe("iterations_exhausted");
  });

  it("retains the report when a fix pass makes no changes", async () => {
    const { result, nativeBodies } = await runReview({
      approved: false, summary, checks,
      findings: [{ severity: "blocking", body: "The renderer ignores the new setting." }],
    }, false, 2);
    expect(result.terminationReason).toBe("no_changes");
    expect(nativeBodies.join("\n")).toContain(summary);
    expect(nativeBodies.join("\n")).toContain(checks[0].evidence);
  });

  it.each([
    { summary: 42 },
    { checks: "All passed" },
    { checks: [{ check: "Tests", result: "invented", evidence: "None" }] },
    { checks: [{ check: "Tests", result: "passed" }] },
  ])("rejects malformed report fields: %j", async fields => {
    const { result } = await runReview({ approved: true, findings: [], ...fields });
    expect(result.approved).toBe(false);
    expect(result.terminationReason).toBe("invalid_review");
  });
});
