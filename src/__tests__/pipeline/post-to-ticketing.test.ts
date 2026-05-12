import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { postToTicketingStep } from "../../pipeline/steps/post-to-ticketing.js";
import { DefaultPipelineContext } from "../../pipeline/context.js";
import type { PipelineContextData } from "../../pipeline/types.js";

const baseData: PipelineContextData = {
  jobId: 1,
  issueId: "issue-1",
  issueIdentifier: "I-1",
  issueTitle: "t",
  issueDescription: "d",
  nonce: "n",
  orchestratorUrl: "http://localhost",
  ticketingProvider: "linear",
};

const noopReporter = { report: async () => {} };

describe("post-to-ticketing step", () => {
  const originalLinear = process.env.LINEAR_API_KEY;

  beforeEach(() => {
    process.env.LINEAR_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ data: { commentCreate: { success: true } } }),
        text: async () => "",
      } as unknown as Response),
    );
  });

  afterEach(() => {
    if (originalLinear === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = originalLinear;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("throws if analysisMarkdown is empty", async () => {
    const ctx = new DefaultPipelineContext(baseData);
    await expect(
      postToTicketingStep.run(
        ctx,
        {
          analysisMarkdown: "",
          testPlanMarkdown: "x",
          workUnitsMarkdown: "y",
          crossStoryMarkdown: "",
        },
        noopReporter,
      ),
    ).rejects.toThrow(/analysisMarkdown is required/);
  });

  it("throws if testPlanMarkdown is empty", async () => {
    const ctx = new DefaultPipelineContext(baseData);
    await expect(
      postToTicketingStep.run(
        ctx,
        {
          analysisMarkdown: "a",
          testPlanMarkdown: "",
          workUnitsMarkdown: "y",
          crossStoryMarkdown: "",
        },
        noopReporter,
      ),
    ).rejects.toThrow(/testPlanMarkdown is required/);
  });

  it("throws if workUnitsMarkdown is empty", async () => {
    const ctx = new DefaultPipelineContext(baseData);
    await expect(
      postToTicketingStep.run(
        ctx,
        {
          analysisMarkdown: "a",
          testPlanMarkdown: "b",
          workUnitsMarkdown: "",
          crossStoryMarkdown: "",
        },
        noopReporter,
      ),
    ).rejects.toThrow(/workUnitsMarkdown is required/);
  });

  it("posts 3 comments when crossStoryMarkdown is empty", async () => {
    const ctx = new DefaultPipelineContext(baseData);
    const result = await postToTicketingStep.run(
      ctx,
      {
        analysisMarkdown: "a",
        testPlanMarkdown: "b",
        workUnitsMarkdown: "c",
        crossStoryMarkdown: "",
      },
      noopReporter,
    );
    expect(result.commentCount).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("throws UnknownProviderError when context.data.ticketingProvider is unrecognized", async () => {
    const ctx = new DefaultPipelineContext({
      ...baseData,
      ticketingProvider: "bogus" as never,
    });
    await expect(
      postToTicketingStep.run(
        ctx,
        {
          analysisMarkdown: "a",
          testPlanMarkdown: "b",
          workUnitsMarkdown: "c",
          crossStoryMarkdown: "",
        },
        noopReporter,
      ),
    ).rejects.toThrow(/Unknown ticketing provider/);
  });

  it("posts 4 comments when crossStoryMarkdown is set", async () => {
    const ctx = new DefaultPipelineContext(baseData);
    const result = await postToTicketingStep.run(
      ctx,
      {
        analysisMarkdown: "a",
        testPlanMarkdown: "b",
        workUnitsMarkdown: "c",
        crossStoryMarkdown: "d",
      },
      noopReporter,
    );
    expect(result.commentCount).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
