import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import { createPostToLinearStep } from "../pipeline/steps/post-to-linear.js";
import type { HttpRequestFn } from "../pipeline/steps/post-to-linear.js";
import type { PipelineContextData } from "../pipeline/types.js";

function makeContext(overrides: Partial<PipelineContextData> = {}): DefaultPipelineContext {
  return new DefaultPipelineContext({
    jobId: 1,
    issueId: "issue-xyz",
    issueIdentifier: "ENG-99",
    issueTitle: "Test issue",
    issueDescription: "Test description",
    nonce: "test-nonce",
    orchestratorUrl: "http://localhost:8080",
    ...overrides,
  });
}

const ANALYSIS = "## 🏗️ AI Planning: Architecture Analysis\nContent";
const TEST_PLAN = "## 🧪 AI Planning: Test Plan\nContent";
const WORK_UNITS = "## 🔧 AI Planning: Work Units\nContent";
const CROSS_STORY = "## 🔗 AI Planning: Cross-Story Context\nContent";

type MockReq = EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

function makeRequest(): MockReq {
  const req = new EventEmitter() as MockReq;
  req.write = vi.fn();
  req.end = vi.fn();
  req.setTimeout = vi.fn();
  req.destroy = vi.fn();
  return req;
}

function makeResponse(statusCode: number, body: string): EventEmitter & { statusCode: number } {
  const res = new EventEmitter() as EventEmitter & { statusCode: number };
  res.statusCode = statusCode;
  return res;
}

/**
 * Creates a mock HttpRequestFn that returns responses in sequence.
 * Each element in `responses` is used for the corresponding call.
 */
function makeHttpRequestFn(
  responses: Array<{ statusCode: number; body: string } | "network-error">,
): { fn: HttpRequestFn; calls: number } {
  const state = { calls: 0 };
  const fn: HttpRequestFn = (_url, _opts, callback) => {
    const req = makeRequest();
    const idx = state.calls++;
    const response = responses[idx] ?? { statusCode: 200, body: '{"data":{}}' };
    if (response === "network-error") {
      setImmediate(() => req.emit("error", new Error("ECONNRESET")));
    } else {
      const { statusCode, body } = response;
      setImmediate(() => {
        const res = makeResponse(statusCode, body);
        callback(res as unknown as IncomingMessage);
        setImmediate(() => {
          res.emit("data", Buffer.from(body));
          res.emit("end");
        });
      });
    }
    return req as unknown as ClientRequest;
  };
  return { fn, calls: state.calls };
}

describe("postToLinearStep (via createPostToLinearStep)", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.LINEAR_API_KEY = "lin_api_testkey";
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("posts 3 comments when crossStoryMarkdown is empty", async () => {
    const requestCallCount = vi.fn();
    const { fn: requestFn } = makeHttpRequestFn([
      { statusCode: 200, body: '{"data":{}}' },
      { statusCode: 200, body: '{"data":{}}' },
      { statusCode: 200, body: '{"data":{}}' },
    ]);
    const wrappedFn: HttpRequestFn = (...args) => { requestCallCount(); return requestFn(...args); };

    const step = createPostToLinearStep(wrappedFn);
    const result = await step.run(
      makeContext(),
      { analysisMarkdown: ANALYSIS, testPlanMarkdown: TEST_PLAN, workUnitsMarkdown: WORK_UNITS, crossStoryMarkdown: "" },
      new NoopStepReporter(),
    );

    expect(result.commentCount).toBe(3);
    expect(requestCallCount).toHaveBeenCalledTimes(3);
  });

  it("posts 4 comments when crossStoryMarkdown is non-empty", async () => {
    const requestCallCount = vi.fn();
    const { fn: requestFn } = makeHttpRequestFn([
      { statusCode: 200, body: '{"data":{}}' },
      { statusCode: 200, body: '{"data":{}}' },
      { statusCode: 200, body: '{"data":{}}' },
      { statusCode: 200, body: '{"data":{}}' },
    ]);
    const wrappedFn: HttpRequestFn = (...args) => { requestCallCount(); return requestFn(...args); };

    const step = createPostToLinearStep(wrappedFn);
    const result = await step.run(
      makeContext(),
      { analysisMarkdown: ANALYSIS, testPlanMarkdown: TEST_PLAN, workUnitsMarkdown: WORK_UNITS, crossStoryMarkdown: CROSS_STORY },
      new NoopStepReporter(),
    );

    expect(result.commentCount).toBe(4);
    expect(requestCallCount).toHaveBeenCalledTimes(4);
  });

  it("throws when LINEAR_API_KEY is absent", async () => {
    delete process.env.LINEAR_API_KEY;
    const step = createPostToLinearStep(vi.fn() as unknown as HttpRequestFn);

    await expect(
      step.run(
        makeContext(),
        { analysisMarkdown: ANALYSIS, testPlanMarkdown: TEST_PLAN, workUnitsMarkdown: WORK_UNITS, crossStoryMarkdown: "" },
        new NoopStepReporter(),
      ),
    ).rejects.toThrow("LINEAR_API_KEY");
  });

  it("throws when analysisMarkdown is empty", async () => {
    const step = createPostToLinearStep(vi.fn() as unknown as HttpRequestFn);

    await expect(
      step.run(
        makeContext(),
        { analysisMarkdown: "", testPlanMarkdown: TEST_PLAN, workUnitsMarkdown: WORK_UNITS, crossStoryMarkdown: "" },
        new NoopStepReporter(),
      ),
    ).rejects.toThrow("analysisMarkdown");
  });

  it("throws when testPlanMarkdown is empty", async () => {
    const step = createPostToLinearStep(vi.fn() as unknown as HttpRequestFn);

    await expect(
      step.run(
        makeContext(),
        { analysisMarkdown: ANALYSIS, testPlanMarkdown: "", workUnitsMarkdown: WORK_UNITS, crossStoryMarkdown: "" },
        new NoopStepReporter(),
      ),
    ).rejects.toThrow("testPlanMarkdown");
  });

  it("throws when workUnitsMarkdown is empty", async () => {
    const step = createPostToLinearStep(vi.fn() as unknown as HttpRequestFn);

    await expect(
      step.run(
        makeContext(),
        { analysisMarkdown: ANALYSIS, testPlanMarkdown: TEST_PLAN, workUnitsMarkdown: "", crossStoryMarkdown: "" },
        new NoopStepReporter(),
      ),
    ).rejects.toThrow("workUnitsMarkdown");
  });

  it("throws on HTTP 4xx response", async () => {
    // 4xx responses are retried 3 times; provide enough to exhaust all attempts
    const { fn: requestFn } = makeHttpRequestFn([
      { statusCode: 403, body: "Forbidden" },
      { statusCode: 403, body: "Forbidden" },
      { statusCode: 403, body: "Forbidden" },
    ]);
    const step = createPostToLinearStep(requestFn);

    await expect(
      step.run(
        makeContext(),
        { analysisMarkdown: ANALYSIS, testPlanMarkdown: TEST_PLAN, workUnitsMarkdown: WORK_UNITS, crossStoryMarkdown: "" },
        new NoopStepReporter(),
      ),
    ).rejects.toThrow("403");
  });

  it("throws on GraphQL errors field", async () => {
    // GraphQL errors are retried 3 times; provide enough to exhaust all attempts
    const { fn: requestFn } = makeHttpRequestFn([
      { statusCode: 200, body: '{"errors":[{"message":"Not found"}]}' },
      { statusCode: 200, body: '{"errors":[{"message":"Not found"}]}' },
      { statusCode: 200, body: '{"errors":[{"message":"Not found"}]}' },
    ]);
    const step = createPostToLinearStep(requestFn);

    await expect(
      step.run(
        makeContext(),
        { analysisMarkdown: ANALYSIS, testPlanMarkdown: TEST_PLAN, workUnitsMarkdown: WORK_UNITS, crossStoryMarkdown: "" },
        new NoopStepReporter(),
      ),
    ).rejects.toThrow("Not found");
  });

  it("retries on transient network error and succeeds", async () => {
    const requestCallCount = vi.fn();
    // First request for comment 1 fails with network error; retry succeeds.
    // Comments 2 and 3 succeed on first attempt.
    const { fn: requestFn } = makeHttpRequestFn([
      "network-error",
      { statusCode: 200, body: '{"data":{}}' },
      { statusCode: 200, body: '{"data":{}}' },
      { statusCode: 200, body: '{"data":{}}' },
    ]);
    const wrappedFn: HttpRequestFn = (...args) => { requestCallCount(); return requestFn(...args); };

    const step = createPostToLinearStep(wrappedFn);
    const result = await step.run(
      makeContext(),
      { analysisMarkdown: ANALYSIS, testPlanMarkdown: TEST_PLAN, workUnitsMarkdown: WORK_UNITS, crossStoryMarkdown: "" },
      new NoopStepReporter(),
    );

    expect(result.commentCount).toBe(3);
    // 4 total HTTP requests: 1 failed + 1 retry for comment 1, then 1 each for comments 2 & 3
    expect(requestCallCount).toHaveBeenCalledTimes(4);
  });
});

