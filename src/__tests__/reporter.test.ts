import { describe, expect, it, vi } from "vitest";
import { HttpStepReporter } from "../pipeline/reporter.js";
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
