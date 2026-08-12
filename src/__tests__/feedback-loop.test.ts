import { describe, it, expect, vi, beforeEach } from "vitest";
import { wrapWithPlanningGuard } from "../linear-planning-fetch.js";

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

function makeCtx() {
  return {
    data: { issueIdentifier: "AII-374", model: undefined },
    llmExecutor: { invoke: vi.fn() },
    getOutputs: () => ({}),
    setOutputs: () => {},
    resolveInputs: (i: unknown) => i,
  } as never;
}

const IMPLEMENT_SUCCESS = {
  filesChanged: [] as string[],
  tokensUsed: 0,
  exitCode: 0,
  subagentCount: 0,
  telemetry: { outcome: "success" as const, numTurns: 5, costUsd: 0.01, durationMs: 1000, tokensIn: 100, tokensOut: 50 },
};

const REVIEW_APPROVED = {
  approved: true,
  issues: [] as string[],
  score: 90,
  progressDelta: 10,
  feedback: "looks good",
  tokensUsed: 100,
};

const REVIEW_REJECTED = {
  approved: false,
  issues: ["fix it"],
  score: 40,
  progressDelta: 50,
  feedback: "not done yet",
  tokensUsed: 50,
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
  "## ⚠️ AI Planning: Risks",
  "",
  "Some risks.",
].join("\n");

const OLD_FORMAT_CONTEXT = "## Planning\n\nSome old-format content here.";

// Mirrors the actual format produced by fetchPlanningContext: sections joined with "\n\n---\n\n"
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
  "## ⚠️ AI Planning: Risks",
  "",
  "Some risks.",
].join("\n");

beforeEach(() => {
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

describe("feedbackLoopStep — planning context routing", () => {
  it("sends full planningContext to implement on pass 1 with new-format context", async () => {
    const ctx = makeCtx();
    await feedbackLoopStep.run(
      ctx,
      { workspaceDir: "/tmp", issueTitle: "T", issueDescription: "D", planningContext: NEW_FORMAT_CONTEXT, maxIterations: 1 },
      { report: vi.fn(async () => undefined) },
    );
    expect(mockImplementRun).toHaveBeenCalledOnce();
    expect(mockImplementRun.mock.calls[0][1]).toMatchObject({ planningContext: NEW_FORMAT_CONTEXT });
  });

  it("sends acceptanceBar to review on every pass with new-format context", async () => {
    const ctx = makeCtx();
    mockReviewRun
      .mockResolvedValueOnce(REVIEW_REJECTED)
      .mockResolvedValueOnce(REVIEW_APPROVED);
    await feedbackLoopStep.run(
      ctx,
      { workspaceDir: "/tmp", issueTitle: "T", issueDescription: "D", planningContext: NEW_FORMAT_CONTEXT, maxIterations: 2 },
      { report: vi.fn(async () => undefined) },
    );
    const expectedBar = "## ✅ AI Planning: Acceptance Bar\n\n1. Foo.\n2. Bar.";
    expect(mockReviewRun.mock.calls[0][1]).toMatchObject({ acceptanceBar: expectedBar });
    expect(mockReviewRun.mock.calls[1][1]).toMatchObject({ acceptanceBar: expectedBar });
  });

  it("sends wrapped mapSection (with security guard) to implement on pass 2 with new-format context", async () => {
    const ctx = makeCtx();
    mockReviewRun
      .mockResolvedValueOnce(REVIEW_REJECTED)
      .mockResolvedValueOnce(REVIEW_APPROVED);
    await feedbackLoopStep.run(
      ctx,
      { workspaceDir: "/tmp", issueTitle: "T", issueDescription: "D", planningContext: NEW_FORMAT_CONTEXT, maxIterations: 2 },
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
    const ctx = makeCtx();
    mockReviewRun
      .mockResolvedValueOnce(REVIEW_REJECTED)
      .mockResolvedValueOnce(REVIEW_APPROVED);
    await feedbackLoopStep.run(
      ctx,
      { workspaceDir: "/tmp", issueTitle: "T", issueDescription: "D", planningContext: OLD_FORMAT_CONTEXT, maxIterations: 2 },
      { report: vi.fn(async () => undefined) },
    );
    expect(mockImplementRun.mock.calls[0][1]).toMatchObject({ planningContext: OLD_FORMAT_CONTEXT });
    expect(mockImplementRun.mock.calls[1][1]).toMatchObject({ planningContext: OLD_FORMAT_CONTEXT });
  });

  it("sends no acceptanceBar to review with old-format context", async () => {
    const ctx = makeCtx();
    await feedbackLoopStep.run(
      ctx,
      { workspaceDir: "/tmp", issueTitle: "T", issueDescription: "D", planningContext: OLD_FORMAT_CONTEXT, maxIterations: 1 },
      { report: vi.fn(async () => undefined) },
    );
    expect(mockReviewRun).toHaveBeenCalledOnce();
    expect(mockReviewRun.mock.calls[0][1].acceptanceBar).toBeUndefined();
  });

  it("falls back to rawPlanningContext on pass 2 when new-format has no map section", async () => {
    const barOnlyContext = "## ✅ AI Planning: Acceptance Bar\n\n1. Only a bar, no map.";
    const ctx = makeCtx();
    mockReviewRun
      .mockResolvedValueOnce(REVIEW_REJECTED)
      .mockResolvedValueOnce(REVIEW_APPROVED);
    await feedbackLoopStep.run(
      ctx,
      { workspaceDir: "/tmp", issueTitle: "T", issueDescription: "D", planningContext: barOnlyContext, maxIterations: 2 },
      { report: vi.fn(async () => undefined) },
    );
    expect(mockImplementRun.mock.calls[0][1]).toMatchObject({ planningContext: barOnlyContext });
    // mapSection absent — fall back to full raw context rather than sending undefined
    expect(mockImplementRun.mock.calls[1][1].planningContext).toBe(barOnlyContext);
  });
});
