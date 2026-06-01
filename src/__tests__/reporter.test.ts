import { describe, expect, it, vi } from "vitest";
import { HttpStepReporter, TokenStepReporter } from "../pipeline/reporter.js";
import type { Step } from "../pipeline/types.js";

const STEP: Step = {
  id: "implement.1",
  type: "implement",
  status: "running",
  started_at: "2026-05-19T00:00:00.000Z",
  ended_at: null,
  parent_step_id: "feedback-loop",
  inputs: {},
  outputs: {},
  logs_url: null,
};

function response(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

describe("HttpStepReporter", () => {
  it("retries transient fetch failures before reporting a step", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(response(200));
    const reporter = new HttpStepReporter("http://orchestrator.test", "nonce", {
      fetchImpl,
      retryDelaysMs: [0],
    });

    await reporter.report(STEP);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries retryable HTTP responses", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));
    const reporter = new HttpStepReporter("http://orchestrator.test", "nonce", {
      fetchImpl,
      retryDelaysMs: [0],
    });

    await reporter.report(STEP);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable HTTP responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(403));
    const reporter = new HttpStepReporter("http://orchestrator.test", "nonce", {
      fetchImpl,
      retryDelaysMs: [0, 0],
    });

    await reporter.report(STEP);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("TokenStepReporter", () => {
  it("posts step reports with a bearer progress token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const reporter = new TokenStepReporter("https://orchestrator.example", "progress-token", {
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return response(200);
      },
      retryDelaysMs: [],
    });

    await reporter.report(STEP);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://orchestrator.example/runner/progress");
    expect(calls[0].init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer progress-token",
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ step: STEP });
  });
});
