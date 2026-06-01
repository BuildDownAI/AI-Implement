import { describe, it, expect, vi, beforeEach } from "vitest";
import { pushStep } from "../pipeline/steps/push.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";

function makeContext(overrides: Record<string, unknown> = {}): DefaultPipelineContext {
  return new DefaultPipelineContext({
    jobId: 1,
    issueId: "issue-1",
    issueIdentifier: "ENG-42",
    issueTitle: "Test",
    issueDescription: "Desc",
    nonce: "nonce",
    orchestratorUrl: "http://localhost:8080",
    ticketingProvider: "linear",
    ...overrides,
  });
}

const BASE_INPUTS = {
  workspaceDir: "/tmp/workspace",
  repoOwner: "acme",
  repoRepo: "app",
  githubToken: "gh-token",
  branchName: "ai-implement/eng-42-feature",
  baseBranch: "main",
};

function spawnResult(status: number, stdout = "", stderr = ""): ReturnType<typeof spawnSync> {
  return {
    status,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    pid: 0,
    output: [],
    signal: null,
    error: undefined,
  };
}

function mockGitSuccess(sha = "deadbeef", dirty = true) {
  vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
    const gitArgs = args as string[];
    if (gitArgs[0] === "status") return spawnResult(0, dirty ? " M src/app.ts\n" : "");
    if (gitArgs[0] === "rev-parse") return spawnResult(0, `${sha}\n`);
    if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\nA\tsrc/app.test.ts\n");
    if (gitArgs[0] === "ls-remote") {
      return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-feature\n");
    }
    return spawnResult(0);
  });
}

describe("pushStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("creates PR and returns prUrl, prNumber, commitSha on success", async () => {
    mockGitSuccess("abc123");
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

  it("uses the context branch as the PR base when baseBranch input is omitted", async () => {
    mockGitSuccess("abc123");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/7", number: 7 }),
      text: async () => "",
    } as Response);

    await pushStep.run(
      makeContext({ branch: "development" }),
      { ...BASE_INPUTS, baseBranch: undefined },
      new NoopStepReporter(),
    );

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string) as { base: string };
    expect(body.base).toBe("development");
  });

  it("returns existing PR info on 422 (PR already open)", async () => {
    mockGitSuccess("sha999");
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
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "sha\n");
      if (gitArgs[0] === "ls-remote") {
        return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-feature\n");
      }
      if (gitArgs[0] === "push") {
        return spawnResult(128, "", "fatal: gh-token authentication failed");
      }
      return spawnResult(0);
    });

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/git push failed/);
  });

  it("throws on non-200 non-422 PR creation", async () => {
    mockGitSuccess();
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
    mockGitSuccess("sha404");
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
    mockGitSuccess("sha405");
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
    mockGitSuccess();
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

  it("creates a concise PR body with summary, approach, and test plan sections", async () => {
    mockGitSuccess();
    const ctx = makeContext();
    ctx.setOutputs("feedback-loop", { approved: true });
    ctx.setOutputs("preflight", { summary: "typecheck: passed, tests: passed (12 assertions)" });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/1", number: 1 }),
    } as Response);

    await pushStep.run(ctx, BASE_INPUTS, new NoopStepReporter());

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string) as { body: string };
    expect(body.body).toContain("## Summary");
    expect(body.body).toContain("Implemented the requested work for ENG-42: Test.");
    expect(body.body).toContain("## Approach");
    expect(body.body).toContain("Implements ENG-42: Test.");
    expect(body.body).toContain("Fixes ENG-42");
    expect(body.body).toContain("- Modified: `src/app.ts`");
    expect(body.body).toContain("- Added: `src/app.test.ts`");
    expect(body.body).toContain("## Test plan");
    expect(body.body).toContain("- [x] typecheck: passed");
    expect(body.body).toContain("typecheck: passed");
    expect(body.body).toContain("- [ ] Manual: review the changed behavior against the ticket acceptance criteria.");
    expect(body.body).toContain("Generated with AI-Implement");
    expect(body.body).not.toContain("## What was implemented");
    expect(body.body).not.toContain("## AI review");
  });

  it("checks out implementation branch and commits working tree changes before pushing", async () => {
    mockGitSuccess("abc123");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/1", number: 1 }),
    } as Response);

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["checkout", "-B", "ai-implement/eng-42-feature"],
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["commit", "-m", "ENG-42: Test"],
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "push",
        expect.any(String),
        "HEAD:refs/heads/ai-implement/eng-42-feature",
        "--force-with-lease=refs/heads/ai-implement/eng-42-feature:beadfeed",
      ]),
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
  });

  it("uses an empty explicit lease when the remote implementation branch does not exist", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "sha\n");
      if (gitArgs[0] === "ls-remote") return spawnResult(0, "");
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/1", number: 1 }),
    } as Response);

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "push",
        expect.any(String),
        "HEAD:refs/heads/ai-implement/eng-42-feature",
        "--force-with-lease=refs/heads/ai-implement/eng-42-feature:",
      ]),
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
  });

  it("throws when remote lease lookup fails", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "sha\n");
      if (gitArgs[0] === "ls-remote") return spawnResult(128, "", "fatal: gh-token auth failed");
      return spawnResult(0);
    });

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/git ls-remote failed after 3 attempts/);
    const lsRemoteCalls = vi.mocked(spawnSync).mock.calls.filter(
      (call) => (call[1] as string[])[0] === "ls-remote",
    );
    expect(lsRemoteCalls).toHaveLength(3);
  });

  it("retries transient remote lease lookup failures", async () => {
    let lsRemoteAttempts = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "sha\n");
      if (gitArgs[0] === "ls-remote") {
        lsRemoteAttempts++;
        if (lsRemoteAttempts < 3) return spawnResult(128, "", "temporary DNS failure");
        return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-feature\n");
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/1", number: 1 }),
    } as Response);

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(lsRemoteAttempts).toBe(3);
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "push",
        expect.any(String),
        "HEAD:refs/heads/ai-implement/eng-42-feature",
        "--force-with-lease=refs/heads/ai-implement/eng-42-feature:beadfeed",
      ]),
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
  });

  it("looks up the exact implementation branch ref for the remote lease", async () => {
    mockGitSuccess();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/1", number: 1 }),
    } as Response);

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["ls-remote", expect.any(String), "refs/heads/ai-implement/eng-42-feature"],
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
  });

  it("throws when Claude leaves no working tree changes", async () => {
    mockGitSuccess("abc123", false);

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/Nothing to commit/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws when git status fails", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") {
        return spawnResult(128, "", "fatal: not a git repository");
      }
      return spawnResult(0);
    });

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/git status failed/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to push over the base branch", async () => {
    await expect(
      pushStep.run(
        makeContext(),
        { ...BASE_INPUTS, branchName: "main", baseBranch: "main" },
        new NoopStepReporter(),
      ),
    ).rejects.toThrow(/Refusing to push implementation branch/);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
