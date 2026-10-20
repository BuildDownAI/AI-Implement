import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { HttpStepReporter, TokenStepReporter } from "../pipeline/reporter.js";
import type { Step } from "../pipeline/types.js";
import { fakeFetch, type Reply } from "./helpers/fake-fetch.js";

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

const networkError: Reply = () => {
  throw new TypeError("fetch failed");
};

describe("HttpStepReporter", () => {
  it("retries transient fetch failures before reporting a step", async () => {
    const orchestrator = fakeFetch({ "POST /api/step-report": [networkError, { status: 200 }] });
    const reporter = new HttpStepReporter("http://orchestrator.test", "nonce", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [0],
    });

    await reporter.report(STEP);

    expect(orchestrator.calls).toHaveLength(2);
  });

  it("retries retryable HTTP responses", async () => {
    const orchestrator = fakeFetch({ "POST /api/step-report": [{ status: 503 }, { status: 200 }] });
    const reporter = new HttpStepReporter("http://orchestrator.test", "nonce", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [0],
    });

    await reporter.report(STEP);

    expect(orchestrator.calls).toHaveLength(2);
  });

  it("does not retry non-retryable HTTP responses", async () => {
    const orchestrator = fakeFetch({ "POST /api/step-report": [{ status: 403 }] });
    const reporter = new HttpStepReporter("http://orchestrator.test", "nonce", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [0, 0],
    });

    await reporter.report(STEP);

    expect(orchestrator.calls).toHaveLength(1);
  });
});

describe("TokenStepReporter", () => {
  beforeEach(() => {
    delete process.env.GITHUB_RUN_ID;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("posts step reports with a bearer progress token", async () => {
    const orchestrator = fakeFetch({ "POST /runner/progress": { status: 200 } });
    const reporter = new TokenStepReporter("https://orchestrator.example", "progress-token", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
    });

    await reporter.report(STEP);

    expect(orchestrator.calls).toHaveLength(1);
    expect(orchestrator.calls[0].url.href).toBe("https://orchestrator.example/runner/progress");
    expect(Object.fromEntries(orchestrator.calls[0].headers)).toEqual({
      "content-type": "application/json",
      authorization: "Bearer progress-token",
    });
    expect(JSON.parse(orchestrator.calls[0].body)).toEqual({ step: STEP });
  });

  it("includes the GitHub run ID when the workflow provides one", async () => {
    vi.stubEnv("GITHUB_RUN_ID", "32595525188");
    const orchestrator = fakeFetch({ "POST /runner/progress": { status: 200 } });
    const reporter = new TokenStepReporter("https://orchestrator.example", "progress-token", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
    });

    await reporter.report(STEP);

    expect(JSON.parse(orchestrator.calls[0].body)).toEqual({
      step: STEP,
      githubRunId: 32595525188,
    });
  });

  it("posts no githubToken or machineNonce in inputs or outputs", async () => {
    const orchestrator = fakeFetch({ "POST /runner/progress": { status: 200 } });
    const reporter = new TokenStepReporter("https://orchestrator.example", "progress-token", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [],
    });

    await reporter.report({
      ...STEP,
      inputs: { githubToken: "ghs_secret", machineNonce: "nonce-secret", repoOwner: "org" },
      outputs: { githubToken: "ghs_secret", workspaceDir: "/w" },
    });

    const body = orchestrator.calls[0].body;
    expect(body).not.toContain("ghs_secret");
    expect(body).not.toContain("nonce-secret");
    expect(JSON.parse(body).step.inputs).toEqual({ repoOwner: "org" });
    expect(JSON.parse(body).step.outputs).toEqual({ workspaceDir: "/w" });
  });

  it("never throws when every attempt fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const orchestrator = fakeFetch({
      "POST /runner/progress": () => {
        throw new Error("network down");
      },
    });
    const reporter = new TokenStepReporter("https://orchestrator.example", "progress-token", {
      fetchImpl: orchestrator.fetch,
      retryDelaysMs: [0],
    });

    await expect(reporter.report(STEP)).resolves.toBeUndefined();
    expect(orchestrator.calls).toHaveLength(2);
  });
});
