import { describe, it, expect, vi, beforeEach } from "vitest";
import { testDir } from "./helpers/test-dir.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") }),
}));
vi.mock("../pipeline/steps/implement.js", () => ({ implementStep: { run: vi.fn() } }));
vi.mock("../pipeline/steps/review.js", () => ({ reviewStep: { run: vi.fn() }, capDiff: (d: string) => d }));
vi.mock("../pipeline/steps/hooks.js", async (orig) => ({
  ...(await orig<typeof import("../pipeline/steps/hooks.js")>()),
  runHookScript: vi.fn(),
}));

vi.mock("../pipeline/workspace-guard.js", async (orig) => {
  const actual = await orig<typeof import("../pipeline/workspace-guard.js")>();
  return {
    snapshotWorkspace: vi.fn(actual.snapshotWorkspace),
    restoreWorkspace: vi.fn(actual.restoreWorkspace),
  };
});

import { snapshotWorkspace, restoreWorkspace } from "../pipeline/workspace-guard.js";
import { feedbackLoopStep } from "../pipeline/steps/feedback-loop.js";
import { implementStep } from "../pipeline/steps/implement.js";
import { reviewStep } from "../pipeline/steps/review.js";
import { runHookScript } from "../pipeline/steps/hooks.js";
import { spawnSync } from "node:child_process";
import { readCycleSummaries } from "../pipeline/cycle-summary.js";

const mockImplement = vi.mocked(implementStep.run);
const mockReview = vi.mocked(reviewStep.run);
const mockHook = vi.mocked(runHookScript);
const mockSnapshot = vi.mocked(snapshotWorkspace);
const mockRestore = vi.mocked(restoreWorkspace);

const ctx = {
  data: { issueIdentifier: "TEST-1", model: undefined },
  llmExecutor: { invoke: vi.fn() },
  getOutputs: () => ({}),
  setOutputs: () => {},
  resolveInputs: (i: unknown) => i,
} as never;
const reporter = { report: vi.fn().mockResolvedValue(undefined) } as never;

const IMPLEMENT_OK = {
  filesChanged: [] as string[],
  tokensUsed: 0,
  exitCode: 0,
  subagentCount: 0,
  telemetry: { outcome: "success" as const, numTurns: 5, costUsd: 0.01, durationMs: 1000, tokensIn: 1, tokensOut: 1 },
  attempts: 1,
};
const REVIEW_OK = { approved: true, issues: [] as string[], score: 90, progressDelta: 1, feedback: "ok", tokensUsed: 1, attempts: 1 };
const REVIEW_NO = { ...REVIEW_OK, approved: false, issues: ["x"], feedback: "no" };

function inputs(extra: Record<string, unknown> = {}) {
  return {
    workspaceDir: testDir("fl-verify"),
    issueTitle: "t",
    issueDescription: "d",
    maxIterations: 3,
    verifyScriptPath: "scripts/verify.sh",
    sleep: async () => {},
    ...extra,
  };
}
const prompts = () => mockImplement.mock.calls.map((c) => String((c[1] as { prompt: string }).prompt));

beforeEach(() => {
  vi.clearAllMocks();
  mockImplement.mockResolvedValue(IMPLEMENT_OK);
  mockReview.mockResolvedValue(REVIEW_OK);
});

describe("feedbackLoopStep — verify hook", () => {
  it("passing hook: review runs and result matches the no-hook case", async () => {
    mockHook.mockResolvedValue({ exitCode: 0, output: "" });
    const inp = inputs();
    const out = await feedbackLoopStep.run(ctx, inp, reporter);
    expect(out.approved).toBe(true);
    expect(out.terminationReason).toBe("approved");
    expect(out.iterations).toBe(1);
    expect(mockHook).toHaveBeenCalledTimes(1);
    expect(mockReview).toHaveBeenCalledTimes(1);
    expect(prompts()[0]).toContain("pipeline runs this repo's verify hook");
    const rec = readCycleSummaries(inp.workspaceDir).find((r) => r.id === "feedback-loop.1");
    expect(rec?.verifyHook).toMatchObject({ ran: true, exitCode: 0 });
  });

  it("fails on pass 1, passes on pass 2: no review on pass 1, output in pass 2 prompt", async () => {
    mockHook
      .mockResolvedValueOnce({ exitCode: 3, output: "error CS1002: ; expected" })
      .mockResolvedValueOnce({ exitCode: 0, output: "" });
    const inp = inputs();
    const out = await feedbackLoopStep.run(ctx, inp, reporter);
    expect(out.approved).toBe(true);
    expect(out.iterations).toBe(2);
    expect(mockReview).toHaveBeenCalledTimes(1);
    expect(prompts()[0]).not.toContain("verify hook failed");
    expect(prompts()[1]).toContain("verify hook failed with exit code 3");
    expect(prompts()[1]).toContain("error CS1002");
    // The failure is not repeated once the hook passes.
    const recs = readCycleSummaries(inp.workspaceDir);
    expect(recs.find((r) => r.id === "feedback-loop.1")?.verifyHook?.exitCode).toBe(3);
    expect(recs.find((r) => r.id === "feedback-loop.2")?.verifyHook?.exitCode).toBe(0);
  });

  it("records guarded: false on the pass and the cycle summary when the snapshot fails", async () => {
    // node:child_process is mocked above (empty stdout), so snapshotWorkspace gets no index path and returns null.
    mockHook.mockResolvedValue({ exitCode: 0, output: "" });
    const inp = inputs();
    const out = await feedbackLoopStep.run(ctx, inp, reporter);
    expect(out.passes[0].verifyGuarded).toBe(false);
    const rec = readCycleSummaries(inp.workspaceDir).find((r) => r.id === "feedback-loop.1");
    expect(rec?.verifyHook?.guarded).toBe(false);
  });

  it("records guarded: false on a restore failure, and no guarded field when the guard works", async () => {
    const snap = { workspaceDir: "/ws", tree: "t" };
    mockHook.mockResolvedValue({ exitCode: 0, output: "" });
    mockSnapshot.mockReturnValueOnce(snap);
    mockRestore.mockReturnValueOnce(false);
    const bad = inputs();
    const out = await feedbackLoopStep.run(ctx, bad, reporter);
    expect(out.passes[0].verifyGuarded).toBe(false);
    expect(readCycleSummaries(bad.workspaceDir).find((r) => r.id === "feedback-loop.1")?.verifyHook?.guarded).toBe(false);

    mockSnapshot.mockReturnValueOnce(snap);
    mockRestore.mockReturnValueOnce(true);
    const good = inputs();
    const out2 = await feedbackLoopStep.run(ctx, good, reporter);
    expect(out2.passes[0]).not.toHaveProperty("verifyGuarded");
    expect(readCycleSummaries(good.workspaceDir).find((r) => r.id === "feedback-loop.1")?.verifyHook).not.toHaveProperty("guarded");
  });

  it("fails on every pass: verify_failed, unapproved, finalFeedback has exit code and tail", async () => {
    mockHook.mockResolvedValue({ exitCode: 2, output: "boom" });
    const out = await feedbackLoopStep.run(ctx, inputs(), reporter);
    expect(out.approved).toBe(false);
    expect(out.terminationReason).toBe("verify_failed");
    expect(out.iterations).toBe(3);
    expect(mockReview).not.toHaveBeenCalled();
    expect(out.finalFeedback).toContain("exit code 2");
    expect(out.finalFeedback).toContain("boom");
  });

  it("neutralizes fences in the hook output, so the output cannot close the feedback fence", async () => {
    mockHook.mockResolvedValue({ exitCode: 1, output: "before\n```\nafter" });
    const out = await feedbackLoopStep.run(ctx, inputs({ maxIterations: 1 }), reporter);
    expect(out.finalFeedback).toContain("before\n'''\nafter");
    expect(out.finalFeedback.match(/^```/gm)).toHaveLength(2);
    expect(out.passes[0].verifyExitCode).toBe(1);
  });

  it("caps hook output to the last 200 lines", async () => {
    const output = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    mockHook.mockResolvedValue({ exitCode: 1, output });
    const out = await feedbackLoopStep.run(ctx, inputs({ maxIterations: 2 }), reporter);
    expect(prompts()[1]).toContain("line 499");
    expect(prompts()[1]).toContain("line 300");
    expect(prompts()[1]).not.toContain("line 299\n");
    expect(prompts()[1]).not.toContain("line 0\n");
    expect(out.finalFeedback).not.toContain("line 0\n");
  });

  it("snapshots the workspace before the hook and restores it after, pass or fail", async () => {
    const git = vi.mocked(spawnSync);
    git.mockImplementation(((_cmd: string, args: string[]) => ({
      status: 0,
      stdout: Buffer.from(args[0] === "rev-parse" ? ".git/index\n" : args[0] === "write-tree" ? "tree1\n" : ""),
      stderr: Buffer.from(""),
    })) as never);
    try {
      mockHook.mockResolvedValue({ exitCode: 0, output: "" });
      await feedbackLoopStep.run(ctx, inputs({ maxIterations: 1 }), reporter);
      const writeTreeOrders = git.mock.calls
        .map((c, i) => ({ c, order: git.mock.invocationCallOrder[i] }))
        .filter((x) => x.c[1]?.[0] === "write-tree" && String((x.c[2] as { env?: Record<string, string> }).env?.GIT_INDEX_FILE).includes("ai-implement-"))
        .map((x) => x.order);
      expect(writeTreeOrders.length).toBeGreaterThanOrEqual(2);
      const hookOrder = mockHook.mock.invocationCallOrder[0];
      expect(writeTreeOrders.some((o) => o < hookOrder)).toBe(true);
      expect(writeTreeOrders.some((o) => o > hookOrder)).toBe(true);
    } finally {
      git.mockReset();
      git.mockReturnValue({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as never);
    }
  });

  it("a missing script counts as a hook failure, not a crash", async () => {
    mockHook.mockRejectedValue(new Error("verify hook script not found: scripts/verify.sh"));
    const out = await feedbackLoopStep.run(ctx, inputs({ maxIterations: 1 }), reporter);
    expect(out.terminationReason).toBe("verify_failed");
    expect(out.finalFeedback).toContain("script not found");
  });

  it("a later review rejection replaces verify_failed as the reason", async () => {
    mockHook.mockResolvedValueOnce({ exitCode: 1, output: "x" }).mockResolvedValue({ exitCode: 0, output: "" });
    mockReview.mockResolvedValue(REVIEW_NO);
    const out = await feedbackLoopStep.run(ctx, inputs({ maxIterations: 2 }), reporter);
    expect(out.terminationReason).toBe("iterations_exhausted");
  });

  it("does not run the hook after a max_turns pass", async () => {
    mockImplement.mockResolvedValue({ ...IMPLEMENT_OK, telemetry: { ...IMPLEMENT_OK.telemetry, outcome: "max_turns" as const } });
    const out = await feedbackLoopStep.run(ctx, inputs(), reporter);
    expect(out.terminationReason).toBe("max_turns");
    expect(mockHook).not.toHaveBeenCalled();
  });

  it("no hooks.verify: hook never runs, prompt unchanged, no summary fields", async () => {
    const inp = inputs({ verifyScriptPath: undefined });
    const out = await feedbackLoopStep.run(ctx, inp, reporter);
    expect(out.approved).toBe(true);
    expect(mockHook).not.toHaveBeenCalled();
    expect(prompts()[0]).not.toContain("verify hook");
    expect(readCycleSummaries(inp.workspaceDir)[0]?.verifyHook).toBeUndefined();
  });

  it("installFailed: the hook does not run", async () => {
    const out = await feedbackLoopStep.run(ctx, inputs({ installFailed: true }), reporter);
    expect(out.approved).toBe(true);
    expect(mockHook).not.toHaveBeenCalled();
  });
});
