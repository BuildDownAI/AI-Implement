import { createStageExecutor } from "../pipeline/stage-executor.js";
import { ModelAuthClientError, type ModelInvocation } from "../model-auth-client.js";
import type { ResolvedAgentSnapshotV1 } from "../run-config.js";
import { classifyLlmResult } from "../pipeline/failure-classification.js";
import { DEFAULT_RETRY_POLICY } from "../pipeline/retry-backoff.js";
import { spawnSync } from "node:child_process";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { wrapWithPlanningGuard, assemblePlanningContext } from "../planning-context-assembly.js";
import { makeContext } from "./helpers/builders.js";
import { testDir } from "./helpers/test-dir.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn().mockReturnValue({
    status: 0,
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
  }),
}));

vi.mock("../pipeline/steps/implement.js", () => ({
  implementStep: { run: vi.fn() },
}));

vi.mock("../pipeline/steps/review.js", () => ({
  reviewStep: { run: vi.fn() },
  capDiff: (d: string) => d,
}));

import { feedbackLoopStep, splitPlanningContext } from "../pipeline/steps/feedback-loop.js";
import { implementStep } from "../pipeline/steps/implement.js";
import { reviewStep } from "../pipeline/steps/review.js";

const mockImplementRun = vi.mocked(implementStep.run);
const mockReviewRun = vi.mocked(reviewStep.run);

const IMPLEMENT_SUCCESS = {
  filesChanged: [] as string[],
  tokensUsed: 0,
  exitCode: 0,
  subagentCount: 0,
  telemetry: { outcome: "success" as const, numTurns: 5, costUsd: 0.01, durationMs: 1000, tokensIn: 100, tokensOut: 50 },
  attempts: 1,
};

const REVIEW_APPROVED = {
  approved: true,
  issues: [] as string[],
  score: 90,
  progressDelta: 10,
  feedback: "looks good",
  tokensUsed: 100,
  attempts: 1,
};

const REVIEW_REJECTED = {
  approved: false,
  issues: ["fix it"],
  score: 40,
  progressDelta: 50,
  feedback: "not done yet",
  tokensUsed: 50,
  attempts: 1,
};

const NEW_FORMAT_CONTEXT = [
  "## ✅ AI Planning: Acceptance Bar",
  "",
  "1. Foo.",
  "2. Bar.",
  "",
  "## 🗺 AI Planning: Implementation Map",
  "",
  "Do this step.",
  "",
  "## ⚠️ AI Planning: Risks & Open Questions",
  "",
  "Some risks.",
].join("\n");

const OLD_FORMAT_CONTEXT = "## Planning\n\nSome old-format content here.";

// Uses the "\n\n---\n\n" join separator between sections (the actual fetchPlanningContext
// output also wraps everything in <planning_context> tags and prepends a preamble).
const REAL_SEPARATOR_CONTEXT = [
  "## ✅ AI Planning: Acceptance Bar",
  "",
  "1. Foo.",
  "2. Bar.",
  "",
  "---",
  "",
  "## 🗺 AI Planning: Implementation Map",
  "",
  "Do this step.",
  "",
  "---",
  "",
  "## ⚠️ AI Planning: Risks & Open Questions",
  "",
  "Some risks.",
].join("\n");

// The loop writes cycle summaries and reviewer feedback under the workspace's ai-output/.
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = testDir("feedback-loop");
  vi.clearAllMocks();
  mockImplementRun.mockResolvedValue(IMPLEMENT_SUCCESS);
  mockReviewRun.mockResolvedValue(REVIEW_APPROVED);
});

describe("splitPlanningContext", () => {
  it("returns undefined for both sections when no new-format headers present", () => {
    expect(splitPlanningContext(OLD_FORMAT_CONTEXT)).toEqual({
      acceptanceBar: undefined,
      mapSection: undefined,
    });
  });

  it("returns undefined for both on empty string", () => {
    expect(splitPlanningContext("")).toEqual({ acceptanceBar: undefined, mapSection: undefined });
  });

  it("extracts the acceptance bar section up to the next ## header", () => {
    const { acceptanceBar } = splitPlanningContext(NEW_FORMAT_CONTEXT);
    expect(acceptanceBar).toBe("## ✅ AI Planning: Acceptance Bar\n\n1. Foo.\n2. Bar.");
    expect(acceptanceBar).not.toContain("Implementation Map");
    expect(acceptanceBar).not.toContain("Risks");
  });

  it("extracts the map section up to the next ## header", () => {
    const { mapSection } = splitPlanningContext(NEW_FORMAT_CONTEXT);
    expect(mapSection).toBe("## 🗺 AI Planning: Implementation Map\n\nDo this step.");
    expect(mapSection).not.toContain("Acceptance Bar");
    expect(mapSection).not.toContain("Risks");
  });

  it("extracts map section when it is the last section", () => {
    const context = "## ✅ AI Planning: Acceptance Bar\n\n1. One.\n\n## 🗺 AI Planning: Implementation Map\n\nLast section.";
    const { mapSection } = splitPlanningContext(context);
    expect(mapSection).toBe("## 🗺 AI Planning: Implementation Map\n\nLast section.");
  });

  it("handles context with only an acceptance bar and no other sections", () => {
    const context = "## ✅ AI Planning: Acceptance Bar\n\n1. Only bar.";
    const { acceptanceBar, mapSection } = splitPlanningContext(context);
    expect(acceptanceBar).toBe("## ✅ AI Planning: Acceptance Bar\n\n1. Only bar.");
    expect(mapSection).toBeUndefined();
  });

  it("strips trailing --- separator that real planning context inserts between sections", () => {
    const { acceptanceBar, mapSection } = splitPlanningContext(REAL_SEPARATOR_CONTEXT);
    expect(acceptanceBar).toBe("## ✅ AI Planning: Acceptance Bar\n\n1. Foo.\n2. Bar.");
    expect(mapSection).toBe("## 🗺 AI Planning: Implementation Map\n\nDo this step.");
    expect(acceptanceBar).not.toContain("---");
    expect(mapSection).not.toContain("---");
  });
});

const ASSEMBLY_PREFIXES = [
  "## 🏗️ AI Planning: Architecture Analysis",
  "## 🧪 AI Planning: Test Plan",
  "## 🔗 AI Planning: Cross-Story Context",
  "## 🗺 AI Planning: Implementation Map",
  "## ✅ AI Planning: Acceptance Bar",
  "## ⚠️ AI Planning: Risks & Open Questions",
];

const MAP_WITH_FILES_AND_MACHINE_BLOCK = [
  "## 🗺 AI Planning: Implementation Map",
  "",
  "Do the thing.",
  "",
  "## Files",
  "- Modify: `src/foo.ts`",
  "- Test: `src/__tests__/foo.test.ts`",
  "",
  "<!-- ai-implement-planning",
  "v: 1",
  'files: ["src/foo.ts"]',
  "risk: low",
  "-->",
].join("\n");

const ASSEMBLY_COMMENTS = [
  {
    body: "## ✅ AI Planning: Acceptance Bar\n\n1. Foo must work.\n2. Bar must pass.",
    createdAt: "2026-01-01T00:00:00Z",
  },
  { body: MAP_WITH_FILES_AND_MACHINE_BLOCK, createdAt: "2026-01-01T00:01:00Z" },
  {
    body: "## ⚠️ AI Planning: Risks & Open Questions\n\nSome risks.",
    createdAt: "2026-01-01T00:02:00Z",
  },
];

describe("splitPlanningContext with real assemblePlanningContext output", () => {
  it("extracted Map contains ## Files bullets and machine block", () => {
    const assembled = assemblePlanningContext(ASSEMBLY_COMMENTS, ASSEMBLY_PREFIXES);
    const { mapSection } = splitPlanningContext(assembled);
    expect(mapSection).toBeDefined();
    expect(mapSection).toContain("## Files");
    expect(mapSection).toContain("src/foo.ts");
    expect(mapSection).toContain("<!-- ai-implement-planning");
  });

  it("extracted Bar contains no planning_context tag", () => {
    const assembled = assemblePlanningContext(ASSEMBLY_COMMENTS, ASSEMBLY_PREFIXES);
    const { acceptanceBar } = splitPlanningContext(assembled);
    expect(acceptanceBar).toBeDefined();
    expect(acceptanceBar).not.toMatch(/<\s*\/?\s*planning_context\s*>/i);
  });

  it("extracted Bar does not contain wrapper tags when it is the last section", () => {
    const barLastComments = [
      { body: MAP_WITH_FILES_AND_MACHINE_BLOCK, createdAt: "2026-01-01T00:00:00Z" },
      {
        body: "## ✅ AI Planning: Acceptance Bar\n\n1. Bar is last.",
        createdAt: "2026-01-01T00:01:00Z",
      },
    ];
    const assembled = assemblePlanningContext(barLastComments, ASSEMBLY_PREFIXES);
    const { acceptanceBar } = splitPlanningContext(assembled);
    expect(acceptanceBar).toBeDefined();
    expect(acceptanceBar).not.toContain("planning_context");
  });
});

describe("feedbackLoopStep — planning context routing", () => {
  it("sends full planningContext to implement on pass 1 with new-format context", async () => {
    const ctx = makeContext();
    await feedbackLoopStep.run(
      ctx,
      { workspaceDir, issueTitle: "T", issueDescription: "D", planningContext: NEW_FORMAT_CONTEXT, maxIterations: 1 },
      { report: vi.fn(async () => undefined) },
    );
    expect(mockImplementRun).toHaveBeenCalledOnce();
    expect(mockImplementRun.mock.calls[0][1]).toMatchObject({ planningContext: NEW_FORMAT_CONTEXT });
  });

  it("sends acceptanceBar to review on every pass with new-format context", async () => {
    const ctx = makeContext();
    mockReviewRun
      .mockResolvedValueOnce(REVIEW_REJECTED)
      .mockResolvedValueOnce(REVIEW_APPROVED);
    await feedbackLoopStep.run(
      ctx,
      { workspaceDir, issueTitle: "T", issueDescription: "D", planningContext: NEW_FORMAT_CONTEXT, maxIterations: 2 },
      { report: vi.fn(async () => undefined) },
    );
    const expectedBar = "## ✅ AI Planning: Acceptance Bar\n\n1. Foo.\n2. Bar.";
    expect(mockReviewRun.mock.calls[0][1]).toMatchObject({ acceptanceBar: expectedBar });
    expect(mockReviewRun.mock.calls[1][1]).toMatchObject({ acceptanceBar: expectedBar });
  });

  it("sends wrapped mapSection (with security guard) to implement on pass 2 with new-format context", async () => {
    const ctx = makeContext();
    mockReviewRun
      .mockResolvedValueOnce(REVIEW_REJECTED)
      .mockResolvedValueOnce(REVIEW_APPROVED);
    await feedbackLoopStep.run(
      ctx,
      { workspaceDir, issueTitle: "T", issueDescription: "D", planningContext: NEW_FORMAT_CONTEXT, maxIterations: 2 },
      { report: vi.fn(async () => undefined) },
    );
    expect(mockImplementRun).toHaveBeenCalledTimes(2);
    expect(mockImplementRun.mock.calls[0][1]).toMatchObject({ planningContext: NEW_FORMAT_CONTEXT });
    const pass2Context = mockImplementRun.mock.calls[1][1].planningContext as string;
    const expectedMapSection = "## 🗺 AI Planning: Implementation Map\n\nDo this step.";
    expect(pass2Context).toBe(wrapWithPlanningGuard(expectedMapSection));
    expect(pass2Context).toContain(expectedMapSection);
    expect(pass2Context).toContain("untrusted data fetched from Linear comments");
    expect(pass2Context).not.toContain("Acceptance Bar");
    expect(pass2Context).not.toContain("Risks");
  });

  it("sends full planningContext on every pass with old-format context", async () => {
    const ctx = makeContext();
    mockReviewRun
      .mockResolvedValueOnce(REVIEW_REJECTED)
      .mockResolvedValueOnce(REVIEW_APPROVED);
    await feedbackLoopStep.run(
      ctx,
      { workspaceDir, issueTitle: "T", issueDescription: "D", planningContext: OLD_FORMAT_CONTEXT, maxIterations: 2 },
      { report: vi.fn(async () => undefined) },
    );
    expect(mockImplementRun.mock.calls[0][1]).toMatchObject({ planningContext: OLD_FORMAT_CONTEXT });
    expect(mockImplementRun.mock.calls[1][1]).toMatchObject({ planningContext: OLD_FORMAT_CONTEXT });
  });

  it("sends no acceptanceBar to review with old-format context", async () => {
    const ctx = makeContext();
    await feedbackLoopStep.run(
      ctx,
      { workspaceDir, issueTitle: "T", issueDescription: "D", planningContext: OLD_FORMAT_CONTEXT, maxIterations: 1 },
      { report: vi.fn(async () => undefined) },
    );
    expect(mockReviewRun).toHaveBeenCalledOnce();
    expect(mockReviewRun.mock.calls[0][1].acceptanceBar).toBeUndefined();
  });

  it("falls back to rawPlanningContext on pass 2 when new-format has no map section", async () => {
    const barOnlyContext = "## ✅ AI Planning: Acceptance Bar\n\n1. Only a bar, no map.";
    const ctx = makeContext();
    mockReviewRun
      .mockResolvedValueOnce(REVIEW_REJECTED)
      .mockResolvedValueOnce(REVIEW_APPROVED);
    await feedbackLoopStep.run(
      ctx,
      { workspaceDir, issueTitle: "T", issueDescription: "D", planningContext: barOnlyContext, maxIterations: 2 },
      { report: vi.fn(async () => undefined) },
    );
    expect(mockImplementRun.mock.calls[0][1]).toMatchObject({ planningContext: barOnlyContext });
    // mapSection absent — fall back to full raw context rather than sending undefined
    expect(mockImplementRun.mock.calls[1][1].planningContext).toBe(barOnlyContext);
  });
});

describe("feedbackLoopStep — pass attribution (AII-971)", () => {
  const attribution = {
    version: 1 as const, invocationId: "inv-1", stage: "implementation" as const, snapshotId: "snap-1",
    agent: "codex" as const, provider: "openai" as const, model: "gpt-synthetic", profileId: "p1",
    authMode: "openai-api-key" as const, limit: null, outcome: "success" as const, usage: null,
  };
  const run = async () => {
    const out = await feedbackLoopStep.run(
      makeContext(),
      { workspaceDir, issueTitle: "T", issueDescription: "D", planningContext: "", maxIterations: 1 },
      { report: vi.fn(async () => undefined) },
    );
    return out as { passes: Array<Record<string, unknown>> };
  };

  it("carries the implement telemetry's attribution onto the pass", async () => {
    mockImplementRun.mockResolvedValue({ ...IMPLEMENT_SUCCESS, telemetry: { ...IMPLEMENT_SUCCESS.telemetry, attribution } });
    expect((await run()).passes[0].attribution).toEqual(attribution);
  });

  it("leaves legacy passes without an attribution key", async () => {
    expect(await run()).toSatisfy((o: { passes: Array<Record<string, unknown>> }) => !("attribution" in o.passes[0]));
  });
});

describe("account-switch retries", () => {
  it("stops after an executor-produced fallback checkout failure", async () => {
    const selection = { agent: "claude" as const, provider: "anthropic" as const,
      model: "claude-test", accountProfileId: "A", invocationTimeoutMs: 1000 };
    const profile = { id: "A", identity: "primary", revision: 1, agent: "claude" as const,
      provider: "anthropic" as const, authMode: "anthropic-api-key" as const };
    const snapshot: ResolvedAgentSnapshotV1 = {
      version: 1, snapshotId: "test-snapshot",
      configRevisions: { orchestratorDefault: { configRevisionId: "rev", revision: 1 }, project: { configRevisionId: "rev", revision: 1 } },
      sources: {} as ResolvedAgentSnapshotV1["sources"],
      stages: { planning: selection, implementation: selection, review: selection },
      profiles: { planning: profile, implementation: profile, review: profile },
    };
    const checkout = vi.fn(async (id: string) => {
      if (id === "B") throw new ModelAuthClientError("profile_not_allowed");
    });
    const invoke = vi.fn(async () => ({ stdout: "", exitCode: 0, tokensUsed: 0, failure: classifyLlmResult({
      stdout: "", exitCode: 0, tokensUsed: 0, terminalStatus: { isError: true, subtype: "turn.failed" },
      errorMessage: "You've hit your usage limit.",
    }, { stage: "implement", attempt: 1, expectsStructuredOutput: false }) }));
    const executor = createStageExecutor({ workspaceDir, snapshot, legacy: { invoke },
      auth: { async invoke<T>(id: string, run: (selected: ModelInvocation) => Promise<T>): Promise<T> {
        await checkout(id);
        return run({ env: {}, strippedKeys: [] });
      } },
      createClaude: () => ({ invoke }),
      accountFallbacks: { implementation: ["B", "C"].map(accountProfileId => ({
        ...selection, accountProfileId, profileRevision: 1, authMode: profile.authMode,
      })) },
    });
    mockImplementRun.mockImplementation(async () => {
      const result = await executor.invoke({ prompt: "test", model: selection.model, agentStage: "implementation" });
      return { ...IMPLEMENT_SUCCESS, invocationFailure: result.failure };
    });
    const ctx = makeContext();
    ctx.data.retryPolicy = { ...DEFAULT_RETRY_POLICY, stageRetries: 3 };
    const error = await feedbackLoopStep.run(ctx,
      { workspaceDir, issueTitle: "T", issueDescription: "D", maxIterations: 1, sleep: async () => {} },
      { report: vi.fn(async () => undefined) }).catch((err: unknown) => err);
    expect(error).toMatchObject({
      failure: { code: "MODEL_AUTH_PROFILE_NOT_ALLOWED", retryable: false },
    });
    expect((error as { failure: { accountFallback?: unknown } }).failure.accountFallback).toBeUndefined();
    expect(checkout.mock.calls).toEqual([["A"], ["B"]]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(mockImplementRun).toHaveBeenCalledTimes(2);
    expect(mockReviewRun).not.toHaveBeenCalled();
  });

  it("gives a classified exit-zero usage-limit result an extra attempt for the next account", async () => {
    const failure = classifyLlmResult({
      stdout: "", stderr: "", exitCode: 0, tokensUsed: 0, attempts: 1,
      terminalStatus: { isError: true, subtype: "turn.failed" },
      errorMessage: "You've hit your usage limit.",
    }, { stage: "implement", attempt: 1, expectsStructuredOutput: false });
    expect(failure.code).toBe("ACCOUNT_USAGE_LIMIT");
    failure.accountFallback = { stage: "implementation", from: "A", to: "B" };
    mockImplementRun.mockResolvedValueOnce({ ...IMPLEMENT_SUCCESS, invocationFailure: failure });
    const ctx = makeContext();
    ctx.data.retryPolicy = { ...DEFAULT_RETRY_POLICY, stageRetries: 0 };
    const result = await feedbackLoopStep.run(ctx,
      { workspaceDir, issueTitle: "T", issueDescription: "D", maxIterations: 1, sleep: async () => {} },
      { report: vi.fn(async () => undefined) });
    expect(result.approved).toBe(true);
    expect(mockImplementRun).toHaveBeenCalledTimes(2);
  });

  it.each(["implementation", "review"] as const)("gives successive switches an attempt beyond the retry budget: %s", async stage => {
    const failure = (from: string, to: string) => ({
      category: "auth" as const, code: "ACCOUNT_USAGE_LIMIT", stage, attempt: 1, retryable: false,
      message: "limit", evidence: { truncated: false }, accountFallback: { stage, from, to },
    });
    if (stage === "implementation") {
      mockImplementRun.mockResolvedValueOnce({ ...IMPLEMENT_SUCCESS, invocationFailure: failure("A", "B") })
        .mockResolvedValueOnce({ ...IMPLEMENT_SUCCESS, invocationFailure: failure("B", "C") });
    } else {
      mockReviewRun.mockRejectedValueOnce(Object.assign(new Error("limit"), { failure: failure("A", "B") }))
        .mockRejectedValueOnce(Object.assign(new Error("limit"), { failure: failure("B", "C") }));
    }
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: Buffer.from("M src/file.ts"), stderr: Buffer.from(""), pid: 0, output: [], signal: null });
    const ctx = makeContext();
    ctx.data.retryPolicy = { ...DEFAULT_RETRY_POLICY, stageRetries: 0 };
    const result = await feedbackLoopStep.run(ctx,
      { workspaceDir, issueTitle: "T", issueDescription: "D", maxIterations: 1, sleep: async () => {} },
      { report: vi.fn(async () => undefined) });
    expect(result.approved).toBe(true);
    if (stage === "implementation") expect(mockImplementRun.mock.calls[1][1].prompt).toContain("Continue from the current state; do not revert it.");
    expect(stage === "implementation" ? mockImplementRun : mockReviewRun).toHaveBeenCalledTimes(3);
  });
});

it("preserves a terminal review account failure for the notice", async () => {
  const failure = { category: "auth" as const, code: "ACCOUNT_USAGE_LIMIT", stage: "review", attempt: 1, retryable: false,
    message: "Usage limit reached on every account: A, B, C", evidence: { truncated: false, llmErrorMessage: "Usage limit reached on every account: A, B, C" } };
  mockReviewRun.mockRejectedValueOnce(Object.assign(new Error(failure.message), { failure }));
  const result = await feedbackLoopStep.run(makeContext(),
    { workspaceDir, issueTitle: "T", issueDescription: "D", maxIterations: 1 },
    { report: vi.fn(async () => undefined) });
  expect(result.failure).toMatchObject({ code: failure.code, message: failure.message, evidence: failure.evidence });
});
