import { describe, it, expect, vi, beforeEach } from "vitest";
import { pushStep } from "../pipeline/steps/push.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";

function makeContext(): DefaultPipelineContext {
  return new DefaultPipelineContext({
    jobId: 1,
    issueId: "issue-1",
    issueIdentifier: "ENG-42",
    issueTitle: "Test",
    issueDescription: "Desc",
    nonce: "nonce",
    orchestratorUrl: "http://localhost:8080",
    ticketingProvider: "linear",
  });
}

const BASE_INPUTS = {
  workspaceDir: "/tmp/workspace",
  repoOwner: "acme",
  repoRepo: "app",
  githubToken: "gh-token",
  branchName: "ENG-42/feature",
};

function mockPushSuccess(sha = "deadbeef") {
  vi.mocked(spawnSync)
    // rev-parse HEAD (commitSha)
    .mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from(`${sha}\n`),
      stderr: Buffer.from(""),
      pid: 0,
      output: [],
      signal: null,
      error: undefined,
    })
    // git push
    .mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 0,
      output: [],
      signal: null,
      error: undefined,
    });
}

describe("pushStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("creates PR and returns prUrl, prNumber, commitSha on success", async () => {
    mockPushSuccess("abc123");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/7", number: 7 }),
      text: async () => "",
    } as Response);

    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.prUrl).toBe("https://github.com/acme/app/pull/7");
    expect(outputs.prNumber).toBe(7);
    expect(outputs.branchPushed).toBe(true);
    expect(outputs.commitSha).toBe("abc123");
  });

  it("returns existing PR info on 422 (PR already open)", async () => {
    mockPushSuccess("sha999");
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({}),
        text: async () => "Validation Failed",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ html_url: "https://github.com/acme/app/pull/3", number: 3 }],
        text: async () => "",
      } as Response);

    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.prUrl).toBe("https://github.com/acme/app/pull/3");
    expect(outputs.prNumber).toBe(3);
    expect(outputs.branchPushed).toBe(true);
  });

  it("throws on git push failure and redacts token", async () => {
    // rev-parse succeeds, push fails
    vi.mocked(spawnSync)
      .mockReturnValueOnce({
        status: 0,
        stdout: Buffer.from("sha\n"),
        stderr: Buffer.from(""),
        pid: 0,
        output: [],
        signal: null,
        error: undefined,
      })
      .mockReturnValueOnce({
        status: 128,
        stdout: Buffer.from(""),
        stderr: Buffer.from("fatal: gh-token authentication failed"),
        pid: 0,
        output: [],
        signal: null,
        error: undefined,
      });

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/git push failed/);
  });

  it("throws on non-200 non-422 PR creation", async () => {
    mockPushSuccess();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    } as Response);

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/PR creation failed with HTTP 500/);
  });

  it("throws when listing open PRs fails after 422", async () => {
    mockPushSuccess("sha404");
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({}),
        text: async () => "Validation Failed",
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      } as Response);

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/listing open PRs failed with HTTP 503/);
  });

  it("throws when 422 returned but no open PR found for branch", async () => {
    mockPushSuccess("sha405");
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({}),
        text: async () => "Validation Failed",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
        text: async () => "",
      } as Response);

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/no open PR found for branch/);
  });

  it("uses issueIdentifier in default PR title", async () => {
    mockPushSuccess();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/1", number: 1 }),
    } as Response);

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string) as { title: string };
    expect(body.title).toContain("ENG-42");
  });
});
