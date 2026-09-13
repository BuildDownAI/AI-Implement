import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pushStep } from "../pipeline/steps/push.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import { __resetPublicationCredentialForTests } from "../publication-credential.js";
import { DEFAULT_RETRY_POLICY } from "../pipeline/retry-backoff.js";
import type { FailureRecord } from "../pipeline/failure-classification.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("../pipeline/retry-backoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pipeline/retry-backoff.js")>();
  // Wraps the real implementation (so backoff math and every other test's timing-
  // insensitive behavior is unchanged) purely so a test can assert what it was called
  // with, rather than inferring timing from NODE_ENV=test's sleepSync no-op.
  return { ...actual, computeBackoffMs: vi.fn(actual.computeBackoffMs) };
});

import { spawnSync } from "node:child_process";
import { computeBackoffMs } from "../pipeline/retry-backoff.js";

function makeContext(overrides: Record<string, unknown> = {}): DefaultPipelineContext {
  return new DefaultPipelineContext({
    jobId: 1,
    issueId: "issue-1",
    issueIdentifier: "ENG-42",
    issueTitle: "Test",
    issueDescription: "Desc",
    nonce: "nonce",
    orchestratorUrl: "http://localhost:8080",
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
  baseRef: "main",
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
      return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
    }
    if (gitArgs[0] === "merge-base") return spawnResult(1); // not an ancestor (foreign work)
    return spawnResult(0);
  });
}

describe("pushStep", () => {
  beforeEach(() => {
    __resetPublicationCredentialForTests();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    __resetPublicationCredentialForTests();
    vi.unstubAllEnvs();
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

  it("uses a freshly vended token for remote lookup, push, and PR creation", async () => {
    mockGitSuccess("abc123");
    vi.stubEnv("GITHUB_TOKEN", "gh-token");
    vi.stubEnv("GH_TOKEN", "gh-token");
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: "fresh-token", expires_at: "2026-08-07T01:00:00Z" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ html_url: "https://github.com/acme/app/pull/7", number: 7 }),
        text: async () => "",
      } as Response);

    try {
      await pushStep.run(
        makeContext(),
        {
          ...BASE_INPUTS,
          orchestratorUrl: "https://orchestrator.example",
          machineNonce: "machine-nonce",
        },
        new NoopStepReporter(),
      );

      const tokenRequest = vi.mocked(fetch).mock.calls[0];
      expect(tokenRequest[0]).toBe("https://orchestrator.example/api/token");

      const remoteCalls = vi.mocked(spawnSync).mock.calls.filter(([, args]) =>
        ["ls-remote", "push"].includes((args as string[])[0]),
      );
      expect(remoteCalls).toHaveLength(2);
      for (const [, args] of remoteCalls) {
        expect((args as string[]).join(" ")).toContain("fresh-token");
        expect((args as string[]).join(" ")).not.toContain("gh-token");
      }

      expect(spawnSync).toHaveBeenCalledWith(
        "git",
        [
          "remote",
          "set-url",
          "origin",
          "https://x-access-token:fresh-token@github.com/acme/app.git",
        ],
        expect.objectContaining({ cwd: "/tmp/workspace" }),
      );
      expect(process.env.GITHUB_TOKEN).toBe("fresh-token");
      expect(process.env.GH_TOKEN).toBe("fresh-token");

      const prRequest = vi.mocked(fetch).mock.calls[1];
      expect(prRequest[1]?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer fresh-token" }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("exchanges the process-only publication credential immediately before GHA remote writes", async () => {
    mockGitSuccess("abc123");
    vi.stubEnv("GITHUB_TOKEN", "workflow-token");
    vi.stubEnv("GH_TOKEN", "workflow-token");
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-publication-token");
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: "fresh-token", expires_at: "2030-01-01T00:00:00Z" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ html_url: "https://github.com/acme/app/pull/7", number: 7 }),
        text: async () => "",
      } as Response);

    try {
      await pushStep.run(
        makeContext({ orchestratorUrl: "", callbackUrl: "https://orchestrator.example" }),
        {
          ...BASE_INPUTS,
          orchestratorUrl: "",
          machineNonce: "",
          callbackUrl: "https://orchestrator.example",
        },
        new NoopStepReporter(),
      );

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
        "https://orchestrator.example/api/runner/publication-token",
      );
      expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toEqual({
        Authorization: "Bearer one-use-publication-token",
      });
      expect(process.env.RUN_PUBLICATION_TOKEN).toBeUndefined();

      const remoteCalls = vi.mocked(spawnSync).mock.calls.filter(([, args]) =>
        ["ls-remote", "push"].includes((args as string[])[0]),
      );
      expect(remoteCalls).toHaveLength(2);
      for (const [, args] of remoteCalls) {
        expect((args as string[]).join(" ")).toContain("fresh-token");
        expect((args as string[]).join(" ")).not.toContain("one-use-publication-token");
      }
      const prRequest = vi.mocked(fetch).mock.calls[1];
      expect(prRequest[1]?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer fresh-token" }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("updates an existing PR branch with a freshly vended token without creating another PR", async () => {
    mockGitSuccess("abc123");
    vi.stubEnv("GITHUB_TOKEN", "workflow-token");
    vi.stubEnv("GH_TOKEN", "workflow-token");
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-publication-token");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "fresh-token", expires_at: "2030-01-01T00:00:00Z" }),
    } as Response);

    const outputs = await pushStep.run(
      makeContext({ callbackUrl: "https://orchestrator.example", prNumber: "42" }),
      {
        ...BASE_INPUTS,
        branchName: "feature/existing-pr",
        baseBranch: "feature/existing-pr",
        baseRef: "beadfeed",
        existingPrNumber: "42",
        callbackUrl: "https://orchestrator.example",
      },
      new NoopStepReporter(),
    );

    expect(outputs).toEqual({
      prUrl: null,
      prNumber: 42,
      branchPushed: true,
      commitSha: "abc123",
      draft: false,
      pushAttempts: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["checkout", "feature/existing-pr"],
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
    expect(spawnSync).not.toHaveBeenCalledWith(
      "git",
      ["checkout", "-B", "feature/existing-pr"],
      expect.anything(),
    );
  });

  it("pushes an existing PR gap-fill with the original branch head as the force-with-lease", async () => {
    mockGitSuccess("abc123");
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-publication-token");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "fresh-token", expires_at: "2030-01-01T00:00:00Z" }),
    } as Response);

    const outputs = await pushStep.run(
      makeContext({ callbackUrl: "https://orchestrator.example", prNumber: "42" }),
      {
        ...BASE_INPUTS,
        branchName: "feature/existing-pr",
        baseBranch: "feature/existing-pr",
        baseRef: "beadfeed",
        existingPrNumber: "42",
        callbackUrl: "https://orchestrator.example",
      },
      new NoopStepReporter(),
    );

    expect(outputs.prUrl).toBeNull();
    expect(outputs.prNumber).toBe(42);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "push",
        expect.any(String),
        "HEAD:refs/heads/feature/existing-pr",
        "--force-with-lease=refs/heads/feature/existing-pr:beadfeed",
      ]),
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
  });

  it("refuses to overwrite an existing PR branch that changed during the run", async () => {
    mockGitSuccess("abc123");

    await expect(pushStep.run(
      makeContext({ prNumber: "42" }),
      {
        ...BASE_INPUTS,
        branchName: "feature/existing-pr",
        baseBranch: "feature/existing-pr",
        baseRef: "original-pr-head",
        existingPrNumber: "42",
      },
      new NoopStepReporter(),
    )).rejects.toThrow(/refusing to overwrite concurrent work/);

    expect(spawnSync).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["push"]),
      expect.anything(),
    );
  });

  it("treats an already-satisfied existing PR gap-fill as a clean no-op", async () => {
    mockGitSuccess("abc123", false);

    const outputs = await pushStep.run(
      makeContext({ prNumber: "42" }),
      {
        ...BASE_INPUTS,
        branchName: "feature/existing-pr",
        baseBranch: "feature/existing-pr",
        existingPrNumber: "42",
      },
      new NoopStepReporter(),
    );

    expect(outputs).toEqual({
      prUrl: null,
      prNumber: 42,
      branchPushed: false,
      commitSha: "abc123",
      draft: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("completes the push with the boot token when credential vending returns 403", async () => {
    mockGitSuccess("abc123");
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ html_url: "https://github.com/acme/app/pull/7", number: 7 }),
        text: async () => "",
      } as Response);

    const outputs = await pushStep.run(
      makeContext(),
      {
        ...BASE_INPUTS,
        orchestratorUrl: "https://orchestrator.example",
        machineNonce: "machine-nonce",
      },
      new NoopStepReporter(),
    );

    expect(outputs.prNumber).toBe(7);
    const remoteCalls = vi.mocked(spawnSync).mock.calls.filter(([, args]) =>
      ["ls-remote", "push"].includes((args as string[])[0]),
    );
    expect(remoteCalls).toHaveLength(2);
    for (const [, args] of remoteCalls) {
      expect((args as string[]).join(" ")).toContain("gh-token");
    }
    const prRequest = vi.mocked(fetch).mock.calls[1];
    expect(prRequest[1]?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer gh-token" }));
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

  it("attaches a classified failure record to the git push error", async () => {
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

    let caught: (Error & { failure?: import("../pipeline/failure-classification.js").FailureRecord }) | undefined;
    try {
      await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(caught?.failure).toBeDefined();
    expect(caught?.failure?.category).toBe("auth");
    expect(caught?.failure?.code).toBe("GIT_AUTH");
    // The token was already redacted by push.ts before classifyGitFailure ran.
    expect(caught?.failure?.message).not.toContain("gh-token");
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

  it("footer includes harness, model, and provider with explicit values", async () => {
    mockGitSuccess();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/1", number: 1 }),
    } as Response);

    await pushStep.run(makeContext({ model: "claude-opus-4-5", provider: "bedrock" }), BASE_INPUTS, new NoopStepReporter());

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string) as { body: string };
    expect(body.body).toContain("Generated with AI-Implement · harness: Claude Code · model: claude-opus-4-5 · provider: bedrock");
  });

  it("footer degrades to model: unknown when model is absent", async () => {
    mockGitSuccess();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/1", number: 1 }),
    } as Response);

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string) as { body: string };
    expect(body.body).toContain("Generated with AI-Implement");
    expect(body.body).toContain("model: unknown");
  });

  it("footer defaults to provider: anthropic when provider is absent", async () => {
    mockGitSuccess();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/1", number: 1 }),
    } as Response);

    await pushStep.run(makeContext({ model: "claude-sonnet-4-6" }), BASE_INPUTS, new NoopStepReporter());

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string) as { body: string };
    expect(body.body).toContain("provider: anthropic");
  });

  it("footer includes Bedrock ARN-style model ID verbatim", async () => {
    mockGitSuccess();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/1", number: 1 }),
    } as Response);

    const bedrockModel = "anthropic.claude-opus-4-5-20260101-v1:0";
    await pushStep.run(makeContext({ model: bedrockModel, provider: "bedrock" }), BASE_INPUTS, new NoopStepReporter());

    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]?.body as string) as { body: string };
    expect(body.body).toContain(`model: ${bedrockModel}`);
    expect(body.body).toContain("provider: bedrock");
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

  it("blocks the push when a sensitive file is staged", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "diff") return spawnResult(0, "src/app.ts\n.env\n");
      return spawnResult(0);
    });

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/Push blocked/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not block a staged deletion of a sensitive file", async () => {
    // git itself omits deletions when --diff-filter=d is passed; simulate that:
    // the deleted .env only shows up if the filter flag is missing.
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " D .env\n M src/app.ts\n");
      if (gitArgs[0] === "diff") {
        return gitArgs.includes("--diff-filter=d")
          ? spawnResult(0, "src/app.ts\n")
          : spawnResult(0, "src/app.ts\n.env\n");
      }
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\nD\t.env\n");
      if (gitArgs[0] === "ls-remote") {
        return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-feature\n");
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/9", number: 9 }),
    } as Response);

    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.prUrl).toBe("https://github.com/acme/app/pull/9");
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=d"],
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
  });

  it("throws when listing staged files fails instead of skipping the sensitive-file guard", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "diff") return spawnResult(128, "", "fatal: bad revision");
      return spawnResult(0);
    });

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/git diff --cached failed/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("(c1) allow-list suppresses a default sensitive-file hit", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M .env\n");
      if (gitArgs[0] === "diff") return spawnResult(0, ".env\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\t.env\n");
      if (gitArgs[0] === "ls-remote") {
        return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-feature\n");
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/9", number: 9 }),
    } as Response);

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, sensitiveFiles: { allow: [".env"] } },
      new NoopStepReporter(),
    );
    expect(outputs.prUrl).toBe("https://github.com/acme/app/pull/9");
  });

  it("(c2) allow-list does not suppress an unrelated sensitive-file hit", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M id_rsa\n");
      if (gitArgs[0] === "diff") return spawnResult(0, "id_rsa\n");
      return spawnResult(0);
    });

    await expect(
      pushStep.run(
        makeContext(),
        { ...BASE_INPUTS, sensitiveFiles: { allow: [".env"] } },
        new NoopStepReporter(),
      ),
    ).rejects.toThrow(/Push blocked/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("(c3) no sensitiveFiles config → existing default behavior unchanged", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M .env\n");
      if (gitArgs[0] === "diff") return spawnResult(0, ".env\n");
      return spawnResult(0);
    });

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/Push blocked/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("add-pattern hit carries client-configured pattern description", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M config.secret\n");
      if (gitArgs[0] === "diff") return spawnResult(0, "config.secret\n");
      return spawnResult(0);
    });

    await expect(
      pushStep.run(
        makeContext(),
        { ...BASE_INPUTS, sensitiveFiles: { add: ["*.secret"] } },
        new NoopStepReporter(),
      ),
    ).rejects.toThrow(/client-configured pattern \(\*\.secret\)/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allow-list glob suppresses a matching variant (.env.local)", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M .env.local\n");
      if (gitArgs[0] === "diff") return spawnResult(0, ".env.local\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\t.env.local\n");
      if (gitArgs[0] === "ls-remote") {
        return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-feature\n");
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/9", number: 9 }),
    } as Response);

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, sensitiveFiles: { allow: [".env.*"] } },
      new NoopStepReporter(),
    );
    expect(outputs.prUrl).toBe("https://github.com/acme/app/pull/9");
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

  it("fails closed when the immutable clone ref is missing", async () => {
    const { baseRef: _baseRef, ...missingBaseRef } = BASE_INPUTS;

    await expect(
      pushStep.run(makeContext(), missingBaseRef, new NoopStepReporter()),
    ).rejects.toThrow(/Missing immutable base ref/);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("logs a token-redacted push trace at stream log level", async () => {
    const prev = process.env.AI_IMPLEMENT_LOG_LEVEL;
    process.env.AI_IMPLEMENT_LOG_LEVEL = "stream";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Trace output echoes the tokenized remote URL on both streams; stdout has
      // no trailing newline so the separator fix is exercised too.
      const tokenizedUrl = `https://x-access-token:gh-token@github.com/acme/app.git`;
      vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
        const gitArgs = args as string[];
        if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
        if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
        if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
        if (gitArgs[0] === "ls-remote") {
          return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-feature\n");
        }
        if (gitArgs[0] === "push") {
          return spawnResult(
            0,
            `Pushing to ${tokenizedUrl}`,
            `region_enter send-pack ${tokenizedUrl}\n`,
          );
        }
        return spawnResult(0);
      });
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ html_url: "https://github.com/acme/app/pull/7", number: 7 }),
        text: async () => "",
      } as Response);

      await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

      const traceCall = errorSpy.mock.calls
        .map((c) => String(c[0]))
        .find((msg) => msg.includes("[git-push trace]"));
      expect(traceCall).toBeDefined();
      expect(traceCall).not.toContain("gh-token");
      expect(traceCall).toContain("***");
      // stdout and stderr are separated by a newline, not run together.
      expect(traceCall).toMatch(/Pushing to[^\n]*\nregion_enter/);
    } finally {
      errorSpy.mockRestore();
      if (prev === undefined) delete process.env.AI_IMPLEMENT_LOG_LEVEL;
      else process.env.AI_IMPLEMENT_LOG_LEVEL = prev;
    }
  });
});

const REVIEW_SUMMARY = {
  terminationReason: "iterations_exhausted",
  iterations: 3,
  finalFeedback: "Missing tests for the retry path.",
  passes: [
    { iteration: 1, implementTurns: 98, implementOutcome: "success", costUsd: 3.21, reviewApproved: false },
  ],
  postMortem: "## Post-mortem\nScope too broad.",
};

describe("pushStep draft PRs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("creates a draft PR with an unapproved section in the body", async () => {
    mockGitSuccess("abc123");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/9", number: 9 }),
      text: async () => "",
    } as Response);

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, draft: true, reviewSummary: REVIEW_SUMMARY },
      new NoopStepReporter(),
    );

    expect(outputs.draft).toBe(true);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.draft).toBe(true);
    expect(body.body).toContain("Automated review did not approve");
    expect(body.body).toContain("Missing tests for the retry path.");
    expect(body.body).toContain("iterations_exhausted");
    expect(body.body).toContain("Post-mortem");
    // The test-plan line must not contradict the unapproved section above it: no
    // testsSummary/preflight summary was supplied, so the fallback must say
    // verification was skipped (unchecked box), not that it ran (checked box).
    expect(body.body).toContain("- [ ] Automated verification was skipped — the review loop did not approve this change.");
    expect(body.body).not.toContain("Automated verification was run by the AI-Implement pipeline before opening this PR.");
  });

  it("heads a provider_unavailable draft PR as a provider outage, not a review rejection", async () => {
    mockGitSuccess("abc123");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/9", number: 9 }),
      text: async () => "",
    } as Response);

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, draft: true, reviewSummary: { ...REVIEW_SUMMARY, terminationReason: "provider_unavailable", finalFeedback: "Model provider was unavailable during implementation after 2 attempt(s); partial changes were preserved.", postMortem: undefined } },
      new NoopStepReporter(),
    );

    expect(outputs.draft).toBe(true);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.draft).toBe(true);
    expect(body.body).toContain("The model provider was unavailable during this run");
    expect(body.body).not.toContain("Automated review did not approve");
    expect(body.body).not.toContain("Reviewer's final feedback");
    expect(body.body).not.toContain("unapproved run");
    expect(body.body).toContain("Run notes");
    expect(body.body).toContain("partial changes were preserved");
    // The column is specifically the implement call's spawn attempts (not review's).
    expect(body.body).toContain("| Pass | Implement outcome | Turns | Implement attempts | Cost | Review |");
    // The test-plan line must not read as a review rejection on a provider outage — the
    // reviewer may never have run at all (BAC-27201).
    expect(body.body).toContain("- [ ] Automated verification was skipped — the model provider was unavailable and the run was interrupted.");
    expect(body.body).not.toContain("the review loop did not approve this change");
    expect(body.body).not.toContain("Automated verification was run by the AI-Implement pipeline before opening this PR.");
  });

  it("titles a provider_unavailable 422 non-draft fallback as an interruption, not an unapproved rejection", async () => {
    mockGitSuccess("abc123");
    vi.mocked(fetch)
      // draft create → 422
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}), text: async () => "draft not supported" } as Response)
      // list open PRs → none
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [], text: async () => "" } as Response)
      // retry without draft → created
      .mockResolvedValueOnce({
        ok: true, status: 201,
        json: async () => ({ html_url: "https://github.com/acme/app/pull/10", number: 10 }),
        text: async () => "",
      } as Response);

    const outputs = await pushStep.run(
      makeContext(),
      {
        ...BASE_INPUTS,
        prTitle: "ENG-42: Test",
        draft: true,
        reviewSummary: { ...REVIEW_SUMMARY, terminationReason: "provider_unavailable" },
      },
      new NoopStepReporter(),
    );

    expect(outputs.draft).toBe(false);
    expect(outputs.prNumber).toBe(10);
    const [, retryInit] = vi.mocked(fetch).mock.calls[2];
    const retryBody = JSON.parse(String(retryInit?.body));
    expect(retryBody.draft).toBeUndefined();
    expect(retryBody.title).toBe("[INTERRUPTED — provider outage] ENG-42: Test");
  });

  it("falls back to a titled normal PR when the draft flag is rejected (422, no existing PR)", async () => {
    mockGitSuccess("abc123");
    vi.mocked(fetch)
      // draft create → 422
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}), text: async () => "draft not supported" } as Response)
      // list open PRs → none
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [], text: async () => "" } as Response)
      // retry without draft → created
      .mockResolvedValueOnce({
        ok: true, status: 201,
        json: async () => ({ html_url: "https://github.com/acme/app/pull/10", number: 10 }),
        text: async () => "",
      } as Response);

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, prTitle: "ENG-42: Test", draft: true, reviewSummary: REVIEW_SUMMARY },
      new NoopStepReporter(),
    );

    expect(outputs.draft).toBe(false);
    expect(outputs.prNumber).toBe(10);
    const [, retryInit] = vi.mocked(fetch).mock.calls[2];
    const retryBody = JSON.parse(String(retryInit?.body));
    expect(retryBody.draft).toBeUndefined();
    expect(retryBody.title).toBe("[NEEDS REVIEW — unapproved] ENG-42: Test");
  });

  it("still resolves an already-open PR on 422 when drafting", async () => {
    mockGitSuccess("abc123");
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}), text: async () => "exists" } as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => [{ html_url: "https://github.com/acme/app/pull/8", number: 8, draft: true }],
        text: async () => "",
      } as Response);

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, draft: true, reviewSummary: REVIEW_SUMMARY },
      new NoopStepReporter(),
    );

    expect(outputs.prNumber).toBe(8);
    expect(outputs.draft).toBe(true);
  });

  it("reports draft=false when the 422-resolved existing PR is not a draft", async () => {
    mockGitSuccess("abc123");
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}), text: async () => "exists" } as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => [{ html_url: "https://github.com/acme/app/pull/8", number: 8, draft: false }],
        text: async () => "",
      } as Response);

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, draft: true, reviewSummary: REVIEW_SUMMARY },
      new NoopStepReporter(),
    );

    expect(outputs.draft).toBe(false);
  });

  it("non-draft pushes send no draft flag and no unapproved section", async () => {
    mockGitSuccess("abc123");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/7", number: 7 }),
      text: async () => "",
    } as Response);

    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.draft).toBe(false);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.draft).toBeUndefined();
    expect(body.body).not.toContain("Automated review did not approve");
  });
});

// ---- Case A: agent committed its own changes ----

describe("pushStep — Case A (agent-committed changes)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  function mockAgentCommitted(sha = "abc123") {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, ""); // clean working tree
      if (gitArgs[0] === "rev-list") return spawnResult(0, "1\n"); // 1 commit ahead
      if (gitArgs[0] === "diff" && gitArgs[1] === "--diff-filter=d") {
        // Committed file list for sensitive-file guard
        return spawnResult(0, "src/app.ts\n");
      }
      if (gitArgs[0] === "diff" && gitArgs[1] === "--name-status") {
        // PR body summary (range diff)
        return spawnResult(0, "M\tsrc/app.ts\n");
      }
      if (gitArgs[0] === "rev-parse") return spawnResult(0, `${sha}\n`);
      if (gitArgs[0] === "ls-remote") {
        return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-feature\n");
      }
      return spawnResult(0);
    });
  }

  it("pushes agent-committed work without throwing 'Nothing to commit'", async () => {
    mockAgentCommitted("commitA");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/11", number: 11 }),
      text: async () => "",
    } as Response);

    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.prUrl).toBe("https://github.com/acme/app/pull/11");
    expect(outputs.branchPushed).toBe(true);
    expect(outputs.commitSha).toBe("commitA");
    // Must NOT have called git add or git commit — agent already committed
    expect(spawnSync).not.toHaveBeenCalledWith("git", ["add", "-A"], expect.anything());
    expect(spawnSync).not.toHaveBeenCalledWith(
      "git", expect.arrayContaining(["commit"]), expect.anything(),
    );
  });

  it("uses the immutable clone ref when the agent committed on the checked-out grouped base", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, "");
      if (gitArgs[0] === "rev-list") {
        return spawnResult(0, gitArgs.includes("clone-sha..HEAD") ? "1\n" : "0\n");
      }
      if (gitArgs[0] === "diff" && gitArgs[1] === "--diff-filter=d") {
        return spawnResult(0, "src/app.ts\n");
      }
      if (gitArgs[0] === "diff" && gitArgs[1] === "--name-status") {
        return spawnResult(0, "M\tsrc/app.ts\n");
      }
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "agent-commit\n");
      if (gitArgs[0] === "ls-remote") return spawnResult(0, "");
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/21", number: 21 }),
      text: async () => "",
    } as Response);

    await pushStep.run(
      makeContext(),
      {
        ...BASE_INPUTS,
        branchName: "ai-implement/ans-901-field-links",
        baseBranch: "ai-implement/feature/ans-899",
        baseRef: "clone-sha",
      },
      new NoopStepReporter(),
    );

    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["rev-list", "--count", "clone-sha..HEAD"],
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
    const [, request] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(request?.body))).toEqual(expect.objectContaining({
      head: "ai-implement/ans-901-field-links",
      base: "ai-implement/feature/ans-899",
    }));
  });

  it("runs the sensitive-file guard against the committed diff in Case A", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, ""); // clean working tree
      if (gitArgs[0] === "rev-list") return spawnResult(0, "1\n");
      if (gitArgs[0] === "diff" && gitArgs[1] === "--diff-filter=d") {
        // Guard list: committed a sensitive file
        return spawnResult(0, "src/app.ts\n.env\n");
      }
      return spawnResult(0);
    });

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/Push blocked/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the range diff for the PR body summary in Case A", async () => {
    mockAgentCommitted();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/12", number: 12 }),
      text: async () => "",
    } as Response);

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    // Should use git diff --name-status main..HEAD (not git show HEAD)
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-status", "main..HEAD"],
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
    expect(spawnSync).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["show"]),
      expect.anything(),
    );
  });
});

// ---- Case B: grouping parent with no own work ----

describe("pushStep — Case B (grouping parent no-op)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  function mockNoChanges() {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, ""); // clean working tree
      if (gitArgs[0] === "rev-list") return spawnResult(0, "0\n"); // no commits ahead
      return spawnResult(0);
    });
  }

  it("returns a clean no-op (no PR, branchPushed=false) for a grouping parent with no changes", async () => {
    mockNoChanges();

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, groupingParent: true },
      new NoopStepReporter(),
    );

    expect(outputs.prUrl).toBeNull();
    expect(outputs.prNumber).toBeNull();
    expect(outputs.branchPushed).toBe(false);
    expect(outputs.commitSha).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does NOT create a PR (never calls fetch) on a grouping-parent no-op", async () => {
    mockNoChanges();

    await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, groupingParent: true },
      new NoopStepReporter(),
    );

    expect(fetch).not.toHaveBeenCalled();
    // No git commit or push either
    expect(spawnSync).not.toHaveBeenCalledWith("git", ["add", "-A"], expect.anything());
    expect(spawnSync).not.toHaveBeenCalledWith(
      "git", expect.arrayContaining(["push"]), expect.anything(),
    );
  });

  it("still throws 'Nothing to commit' for a leaf run with no changes (groupingParent unset)", async () => {
    mockNoChanges();

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/Nothing to commit/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still throws 'Nothing to commit' for a leaf run with groupingParent=false", async () => {
    mockNoChanges();

    await expect(
      pushStep.run(
        makeContext(),
        { ...BASE_INPUTS, groupingParent: false },
        new NoopStepReporter(),
      ),
    ).rejects.toThrow(/Nothing to commit/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("pushes normally when a grouping parent DOES have working-tree changes", async () => {
    // groupingParent=true but the agent left uncommitted changes → standard path
    mockGitSuccess("sha-gp");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/13", number: 13 }),
      text: async () => "",
    } as Response);

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, groupingParent: true },
      new NoopStepReporter(),
    );

    expect(outputs.prUrl).toBe("https://github.com/acme/app/pull/13");
    expect(outputs.branchPushed).toBe(true);
  });
});

// ---- Review hardening: fail-closed git checks + mixed-state sensitive scan ----

describe("pushStep — hardening (review findings)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("fails CLOSED when git rev-list errors on a grouping-parent run (never silently no-ops)", async () => {
    // Regression: hasCommitsAheadOfBase used to return false on git error, which would make a
    // grouping-parent run take the Case-B no-op → markMerged → silently discard committed work.
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, ""); // clean working tree
      if (gitArgs[0] === "rev-list") return spawnResult(128, "", "fatal: bad revision 'main..HEAD'");
      return spawnResult(0);
    });

    await expect(
      pushStep.run(makeContext(), { ...BASE_INPUTS, groupingParent: true }, new NoopStepReporter()),
    ).rejects.toThrow(/git rev-list .*failed/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("catches a committed secret in a MIXED commit+working-tree state (unified committed-diff scan)", async () => {
    // The agent committed a secret earlier in the run AND left other uncommitted edits. The
    // dirty path's --cached scan only sees newly-staged files (no secret); the unified
    // baseBranch..HEAD scan must still catch the already-committed .env.
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n"); // dirty working tree
      if (gitArgs[0] === "diff" && gitArgs.includes("--cached")) {
        return spawnResult(0, "src/app.ts\n"); // staged files — no secret here
      }
      if (gitArgs[0] === "diff" && gitArgs.includes("main..HEAD")) {
        return spawnResult(0, "src/app.ts\n.env\n"); // full committed diff — secret committed earlier
      }
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "sha\n");
      return spawnResult(0);
    });

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/Push blocked/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("pushStep — push failure classification and retry (BAC-27116)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats a push failure as landed when ls-remote shows the local commit already on the remote", async () => {
    let lsRemoteCalls = 0;
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") {
        lsRemoteCalls++;
        // 1st call: pre-push lease lookup. 2nd call: post-failure inspection —
        // the remote is already at local HEAD (the commit landed despite the error).
        return lsRemoteCalls === 1
          ? spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`)
          : spawnResult(0, `abc123\t${gitArgs.at(-1)}\n`);
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/50", number: 50 }),
      text: async () => "",
    } as Response);

    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(pushCalls).toBe(1);
    expect(lsRemoteCalls).toBe(2);
    expect(outputs.prNumber).toBe(50);
    expect(outputs.landedDespiteError).toBe(true);
    expect(outputs.pushAttempts).toBe(1);
  });

  it("retries a transient push failure once when the remote is unchanged, then succeeds", async () => {
    let lsRemoteCalls = 0;
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") {
        lsRemoteCalls++;
        return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return spawnResult(128, "", "fatal: internal server error");
        return spawnResult(0);
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/51", number: 51 }),
      text: async () => "",
    } as Response);

    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(pushCalls).toBe(2);
    // One lease lookup before the first attempt, one remote inspection after the failure.
    expect(lsRemoteCalls).toBe(2);
    expect(outputs.prNumber).toBe(51);
    expect(outputs.pushAttempts).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops without retrying when the remote has advanced to a foreign SHA", async () => {
    let lsRemoteCalls = 0;
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      if (gitArgs[0] === "ls-remote") {
        lsRemoteCalls++;
        return lsRemoteCalls === 1
          ? spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`)
          : spawnResult(0, `someone-elses-sha\t${gitArgs.at(-1)}\n`);
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(1);
    expect(caught?.failure?.category).toBe("conflict");
    expect(caught?.failure?.code).toBe("GIT_REMOTE_ADVANCED");
    // No git-bundle artifact exists for unpublished commits — the thrown message
    // must carry the local commit SHA and a diff --stat so the evidence names
    // what would be lost.
    expect(caught?.message).toContain("Unpublished local commit: abc123");
    expect(caught?.message).toContain("1 file changed, 1 insertion(+), 1 deletion(-)");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never retries an authentication failure", async () => {
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "fatal: Authentication failed for 'https://github.com/acme/app.git/'");
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(1);
    expect(caught?.failure?.category).toBe("auth");
    expect(caught?.message).toContain("Unpublished local commit: abc123");
    expect(caught?.message).toContain("1 file changed, 1 insertion(+), 1 deletion(-)");
  });

  it("exhausts retries on a transient failure that never resolves, preserving the original stderr text", async () => {
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      // The remote never moves: every post-failure inspection matches the lease still.
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext({ retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries: 2 } }),
        BASE_INPUTS,
        new NoopStepReporter(),
      );
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(3);
    expect(caught?.failure?.category).toBe("transient");
    expect(caught?.failure?.attempt).toBe(3);
    // Exhaustion gets its own code and is never retryable — an orchestrator rail
    // keying off `retryable` must not re-dispatch a run that already spent its budget.
    expect(caught?.failure?.code).toBe("GIT_PUSH_RETRIES_EXHAUSTED");
    expect(caught?.failure?.retryable).toBe(false);
    expect(caught?.failure?.message).toContain("exhausted after 3 attempts");
    // The BAC-27048 fixture's real cause is unestablished — the original git text
    // must survive classification even though the category is a best-effort guess.
    expect(caught?.failure?.message).toContain("commit_refs");
    // Retries-exhausted also names the local commit and diff --stat, since this is
    // a terminal throw with no git-bundle artifact backing it.
    expect(caught?.message).toContain("Unpublished local commit: abc123");
    expect(caught?.message).toContain("1 file changed, 1 insertion(+), 1 deletion(-)");
    // err.message backs the tracker comment and failure_json is persisted from
    // err.failure — both must agree that retries ran out, not just that the last
    // push attempt failed.
    expect(caught?.message).toContain("exhausted after 3 attempts");
  });

  it("a retried gap-fill push still returns the existing PR number and never creates a PR", async () => {
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-publication-token");
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return spawnResult(128, "", "fatal: internal server error");
        return spawnResult(0);
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "fresh-token", expires_at: "2030-01-01T00:00:00Z" }),
    } as Response);

    const outputs = await pushStep.run(
      makeContext({ callbackUrl: "https://orchestrator.example", prNumber: "42" }),
      {
        ...BASE_INPUTS,
        branchName: "feature/existing-pr",
        baseBranch: "feature/existing-pr",
        baseRef: "beadfeed",
        existingPrNumber: "42",
        callbackUrl: "https://orchestrator.example",
      },
      new NoopStepReporter(),
    );

    expect(pushCalls).toBe(2);
    expect(outputs.prNumber).toBe(42);
    expect(outputs.prUrl).toBeNull();
    expect(outputs.pushAttempts).toBe(2);
    // Only the one-time token exchange — the retry's credential refresh must not
    // re-spend the already-consumed publication credential, and no PR create call.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rethrows the original push failure record when ls-remote fails after a push failure", async () => {
    let lsRemoteCalls = 0;
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      if (gitArgs[0] === "ls-remote") {
        lsRemoteCalls++;
        if (lsRemoteCalls === 1) return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
        return spawnResult(128, "", "fatal: unable to access remote");
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(1);
    expect(caught?.failure?.category).toBe("transient");
    expect(caught?.message).toContain("git push failed");
    expect(caught?.message).toContain("remote could not be inspected");
    // The push record is what carries the evidence here too — the local commit
    // and diff --stat must survive even though the inspection itself failed.
    expect(caught?.message).toContain("Unpublished local commit: abc123");
    expect(caught?.message).toContain("1 file changed, 1 insertion(+), 1 deletion(-)");
  });
});

describe("pushStep — conflict-on-retry re-inspection (BAC-27116 follow-up)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the immediate throw for a conflict on the first attempt (never re-inspects the remote)", async () => {
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(
          128,
          "",
          "! [rejected] ai-implement/eng-42-feature -> ai-implement/eng-42-feature (stale info)",
        );
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(1);
    expect(caught?.failure?.category).toBe("conflict");
    expect(caught?.failure?.code).toBe("GIT_LEASE_REJECTED");
    const lsRemoteCalls = vi.mocked(spawnSync).mock.calls.filter((c) => (c[1] as string[])[0] === "ls-remote");
    expect(lsRemoteCalls).toHaveLength(1); // only the pre-push lease lookup
  });

  it("treats a conflict on the second attempt as landed when the remote now holds our own commit", async () => {
    let lsRemoteCalls = 0;
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") {
        lsRemoteCalls++;
        // 1: pre-push lease lookup. 2: post-attempt-1 transient-failure inspection
        // (unchanged, so it retries). 3: post-attempt-2 conflict inspection — a lagging
        // ls-remote replica read the stale lease on the retry's pre-push lookup, but the
        // attempt-1 commit actually landed, so this rejection is against our own commit.
        if (lsRemoteCalls === 3) return spawnResult(0, `abc123\t${gitArgs.at(-1)}\n`);
        return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return spawnResult(128, "", "fatal: internal server error");
        return spawnResult(
          128,
          "",
          "! [rejected] ai-implement/eng-42-feature -> ai-implement/eng-42-feature (stale info)",
        );
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/70", number: 70 }),
      text: async () => "",
    } as Response);

    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(pushCalls).toBe(2);
    expect(lsRemoteCalls).toBe(3);
    expect(outputs.prNumber).toBe(70);
    expect(outputs.landedDespiteError).toBe(true);
    expect(outputs.pushAttempts).toBe(2);
  });

  it("treats an unclassified (\"unknown\") failure on the second attempt as landed when the remote now holds our own commit, mirroring the conflict case", async () => {
    let lsRemoteCalls = 0;
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") {
        lsRemoteCalls++;
        // 1: pre-push lease lookup. 2: post-attempt-1 transient-failure inspection
        // (unchanged, so it retries). 3: post-attempt-2 unknown-failure inspection —
        // the attempt-1 commit actually landed, so this rejection is against our own
        // commit even though the classifier could not recognize attempt 2's git text
        // at all (category "unknown", not "conflict").
        if (lsRemoteCalls === 3) return spawnResult(0, `abc123\t${gitArgs.at(-1)}\n`);
        return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return spawnResult(128, "", "fatal: internal server error");
        // Matches no GIT_SIGNATURES row — classifies as category "unknown".
        return spawnResult(128, "", "fatal: something completely unrecognized happened");
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/71", number: 71 }),
      text: async () => "",
    } as Response);

    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(pushCalls).toBe(2);
    expect(lsRemoteCalls).toBe(3);
    expect(outputs.prNumber).toBe(71);
    expect(outputs.landedDespiteError).toBe(true);
    expect(outputs.pushAttempts).toBe(2);
  });

  it("throws GIT_REMOTE_ADVANCED for a conflict on the second attempt against a foreign SHA", async () => {
    let lsRemoteCalls = 0;
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      if (gitArgs[0] === "ls-remote") {
        lsRemoteCalls++;
        if (lsRemoteCalls === 3) return spawnResult(0, `someone-elses-sha\t${gitArgs.at(-1)}\n`);
        return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return spawnResult(128, "", "fatal: internal server error");
        return spawnResult(
          128,
          "",
          "! [rejected] ai-implement/eng-42-feature -> ai-implement/eng-42-feature (stale info)",
        );
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(2);
    expect(caught?.failure?.category).toBe("conflict");
    expect(caught?.failure?.code).toBe("GIT_REMOTE_ADVANCED");
    expect(caught?.failure?.retryable).toBe(false);
    expect(caught?.failure?.message).toContain("beadfeed");
    expect(caught?.failure?.message).toContain("someone-elses-sha");
    expect(caught?.message).toContain("Unpublished local commit: abc123");
    expect(caught?.message).toContain("1 file changed, 1 insertion(+), 1 deletion(-)");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the original unknown category and message (not GIT_REMOTE_ADVANCED) when a retried unknown failure finds the remote advanced to a foreign SHA", async () => {
    let lsRemoteCalls = 0;
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      if (gitArgs[0] === "ls-remote") {
        lsRemoteCalls++;
        if (lsRemoteCalls === 3) return spawnResult(0, `someone-elses-sha\t${gitArgs.at(-1)}\n`);
        return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return spawnResult(128, "", "fatal: internal server error");
        // Matches no GIT_SIGNATURES row — classifies as category "unknown".
        return spawnResult(128, "", "fatal: something completely unrecognized happened");
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(2);
    // An incoming "unknown" failure is never reclassified as GIT_REMOTE_ADVANCED — only a
    // genuine conflict is. The real (if unrecognized) git error is preserved, with a note
    // appended that the remote advanced past the lease SHA during this attempt.
    expect(caught?.failure?.category).toBe("unknown");
    expect(caught?.failure?.code).not.toBe("GIT_REMOTE_ADVANCED");
    expect(caught?.failure?.message).toContain("fatal: something completely unrecognized happened");
    expect(caught?.failure?.message).toContain("Remote ai-implement/eng-42-feature advanced past the lease SHA during this attempt.");
    expect(caught?.message).toContain("Unpublished local commit: abc123");
  });

  it("throws the original transient record instead of concluding GIT_REMOTE_ADVANCED when the local commit SHA is unknown", async () => {
    let lsRemoteCalls = 0;
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      // resolveCommitSha fails: commitSha stays null.
      if (gitArgs[0] === "rev-parse") return spawnResult(128, "", "fatal: not a valid object name HEAD");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) return spawnResult(0, "(no diff)\n");
      if (gitArgs[0] === "ls-remote") {
        lsRemoteCalls++;
        // 1st call: pre-push lease lookup (the leased/expected SHA). 2nd call:
        // post-failure inspection — the remote has genuinely moved to a foreign SHA.
        // This would read as GIT_REMOTE_ADVANCED if commitSha weren't null.
        return lsRemoteCalls === 1
          ? spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`)
          : spawnResult(0, `someone-elses-sha\t${gitArgs.at(-1)}\n`);
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(1);
    expect(caught?.failure?.category).toBe("transient");
    expect(caught?.failure?.code).not.toBe("GIT_REMOTE_ADVANCED");
    expect(caught?.message).toContain("Unpublished local commit: unknown");
    expect(caught?.message).toContain("landed check was skipped");
  });

  it("throws the original conflict record, not GIT_REMOTE_ADVANCED, when a retried conflict finds the remote still at the lease", async () => {
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      // The remote never moves off the leased SHA on any lookup — a conflict here
      // is a genuine lease rejection, not our own attempt-1 push landing elsewhere.
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return spawnResult(128, "", "fatal: internal server error");
        return spawnResult(
          128,
          "",
          "! [rejected] ai-implement/eng-42-feature -> ai-implement/eng-42-feature (stale info)",
        );
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(2);
    expect(caught?.failure?.category).toBe("conflict");
    expect(caught?.failure?.code).toBe("GIT_LEASE_REJECTED");
    expect(caught?.failure?.retryable).toBe(false);
    expect(caught?.message).not.toContain("advanced to");
  });
});

describe("pushStep — retry resilience and guards (BAC-27116 follow-up)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the new token from the environment when the mid-retry credential refresh throws applying it", async () => {
    let pushCalls = 0;
    let setUrlCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "remote" && gitArgs[1] === "set-url") {
        setUrlCalls++;
        // 1st call: the pre-push exchange — must succeed so the run reaches the push loop.
        // 2nd call: the mid-retry refresh — fails, exercising the wrapping try/catch. By
        // this point refreshRunnerGithubCredentials has already written the new token to
        // process.env.GITHUB_TOKEN, so the retry must use it despite this failure.
        if (setUrlCalls === 1) return spawnResult(0);
        return spawnResult(128, "", "fatal: not a git repository");
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return spawnResult(128, "", "fatal: internal server error");
        return spawnResult(0);
      }
      return spawnResult(0);
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: "fresh-token", expires_at: "2030-01-01T00:00:00Z" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: "fresher-token", expires_at: "2030-01-01T00:00:00Z" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ html_url: "https://github.com/acme/app/pull/71", number: 71 }),
        text: async () => "",
      } as Response);

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, orchestratorUrl: "https://orchestrator.example", machineNonce: "machine-nonce" },
      new NoopStepReporter(),
    );

    expect(pushCalls).toBe(2);
    expect(outputs.prNumber).toBe(71);
    // The mid-retry refresh's token fetch succeeded and updated process.env.GITHUB_TOKEN
    // before the subsequent git remote set-url failed — the retry must use that new
    // token rather than the stale pre-refresh one, and must not throw or lose the
    // classified push failure that triggered the retry.
    const pushCallArgs = vi.mocked(spawnSync).mock.calls.filter((c) => (c[1] as string[])[0] === "push");
    expect(pushCallArgs).toHaveLength(2);
    expect((pushCallArgs[1][1] as string[]).join(" ")).toContain("fresher-token");
    expect((pushCallArgs[1][1] as string[]).join(" ")).not.toContain("fresh-token");
  });

  it("redacts unpublished-work evidence against the current token, not the original dispatch token", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        // Simulates git error text that happens to embed the tokenized remote URL —
        // this must be redacted against the CURRENT (refreshed) token.
        return spawnResult(
          128,
          "",
          "fatal: unable to access 'https://x-access-token:fresh-token@github.com/acme/app.git/'",
        );
      }
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        return spawnResult(128, "", "fatal: Authentication failed for 'https://github.com/acme/app.git/'");
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "fresh-token", expires_at: "2030-01-01T00:00:00Z" }),
    } as Response);

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext(),
        { ...BASE_INPUTS, orchestratorUrl: "https://orchestrator.example", machineNonce: "machine-nonce" },
        new NoopStepReporter(),
      );
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(caught?.message).not.toContain("fresh-token");
    expect(caught?.message).toContain("***");
  });

  it("falls back to the default pushRetries when the value is undefined, instead of retrying forever", async () => {
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext({
          retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries: undefined as unknown as number },
        }),
        BASE_INPUTS,
        new NoopStepReporter(),
      );
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(1 + DEFAULT_RETRY_POLICY.pushRetries);
    expect(caught?.failure?.code).toBe("GIT_PUSH_RETRIES_EXHAUSTED");
    expect(caught?.failure?.retryable).toBe(false);
  });

  it("falls back to the default pushRetries when the value is a numeric string, instead of retrying forever", async () => {
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext({
          retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries: "3" as unknown as number },
        }),
        BASE_INPUTS,
        new NoopStepReporter(),
      );
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(1 + DEFAULT_RETRY_POLICY.pushRetries);
    expect(caught?.failure?.code).toBe("GIT_PUSH_RETRIES_EXHAUSTED");
  });

  it("attempts exactly once when pushRetries is 0", async () => {
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext({ retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries: 0 } }),
        BASE_INPUTS,
        new NoopStepReporter(),
      );
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(1);
    expect(caught?.failure?.category).toBe("transient");
    expect(caught?.failure?.code).toBe("GIT_PUSH_RETRIES_EXHAUSTED");
    expect(caught?.failure?.retryable).toBe(false);
    expect(caught?.failure?.attempt).toBe(1);
  });

  it("carries a mid-retry credential-refresh-failure note through to the exhausted-retries terminal record", async () => {
    let pushCalls = 0;
    let setUrlCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      // The remote never moves: every push attempt stays genuinely transient.
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "remote" && gitArgs[1] === "set-url") {
        setUrlCalls++;
        // 1st call: the pre-push exchange — must succeed to reach the push loop.
        // 2nd call: the mid-retry refresh before the final attempt — fails, and that
        // failure's note must still be attached to the terminal exhausted-retries record.
        if (setUrlCalls === 1) return spawnResult(0);
        return spawnResult(128, "", "fatal: not a git repository");
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: "fresh-token", expires_at: "2030-01-01T00:00:00Z" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: "fresher-token", expires_at: "2030-01-01T00:00:00Z" }),
      } as Response);

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext({
          orchestratorUrl: "https://orchestrator.example",
          retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries: 1 },
        }),
        { ...BASE_INPUTS, orchestratorUrl: "https://orchestrator.example", machineNonce: "machine-nonce" },
        new NoopStepReporter(),
      );
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(2);
    expect(caught?.failure?.code).toBe("GIT_PUSH_RETRIES_EXHAUSTED");
    // failure_json (persisted from err.failure) and the tracker comment (built from
    // err.message) must not disagree — the credential-refresh note lands on both.
    expect(caught?.failure?.message).toContain("credential refresh before retry failed");
    expect(caught?.failure?.message).toContain("git remote set-url failed");
  });

  it("collapses an identical mid-retry credential-refresh-failure note recurring across attempts into one copy with a count", async () => {
    let pushCalls = 0;
    let setUrlCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      // The remote never moves: every push attempt stays genuinely transient.
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "remote" && gitArgs[1] === "set-url") {
        setUrlCalls++;
        // 1st call: the pre-push exchange — must succeed to reach the push loop.
        // 2nd and 3rd calls: the two mid-retry refreshes — both fail with the exact
        // same reason, which must collapse to one note with a count rather than
        // repeating the identical text twice.
        if (setUrlCalls === 1) return spawnResult(0);
        return spawnResult(128, "", "fatal: not a git repository");
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: "fresh-token", expires_at: "2030-01-01T00:00:00Z" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: "fresher-token", expires_at: "2030-01-01T00:00:00Z" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: "freshest-token", expires_at: "2030-01-01T00:00:00Z" }),
      } as Response);

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext({
          orchestratorUrl: "https://orchestrator.example",
          retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries: 2 },
        }),
        { ...BASE_INPUTS, orchestratorUrl: "https://orchestrator.example", machineNonce: "machine-nonce" },
        new NoopStepReporter(),
      );
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(3);
    expect(caught?.failure?.code).toBe("GIT_PUSH_RETRIES_EXHAUSTED");
    const note = "credential refresh before retry failed: git remote set-url failed (exit 128): fatal: not a git repository";
    const occurrences = caught?.failure?.message?.split(note).length ?? 1;
    // Exactly one copy of the note text, not one per retry.
    expect(occurrences - 1).toBe(1);
    expect(caught?.failure?.message).toContain(`${note} (×2)`);
  });

  it("redacts and one-lines an ls-remote inspection-failure reason before appending it to the message", async () => {
    vi.stubEnv("AI_IMPLEMENT_SIDE_CHANNEL_TOKEN", "leaked-secret-value-1234567890");
    let lsRemoteCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      if (gitArgs[0] === "ls-remote") {
        lsRemoteCalls++;
        // 1st call: the pre-push lookup — must succeed to reach the push loop.
        if (lsRemoteCalls === 1) return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
        // Every post-failure inspection attempt fails, carrying a secret that only
        // envSecrets() (not the push token redaction) would ever catch.
        return spawnResult(
          128,
          "",
          `fatal: unable to access remote: leaked-secret-value-1234567890 ${"x".repeat(600)}`,
        );
      }
      if (gitArgs[0] === "push") {
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(caught?.message).toContain("remote could not be inspected");
    // The env secret is redacted via the same envSecrets()/oneLinerMessage contract
    // FailureRecord.message itself is held to, not spliced in raw.
    expect(caught?.message).not.toContain("leaked-secret-value-1234567890");
    expect(caught?.message).toContain("***");
    // Only the first line is kept, and it is capped at 500 chars (plus the "…"
    // truncation marker) — the 600-char second line must not appear in full.
    expect(caught?.message).not.toContain("x".repeat(600));
  });

  it("appends nothing to failure.message when an ls-remote inspection failure carries only a whitespace reason", async () => {
    let lsRemoteCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      if (gitArgs[0] === "ls-remote") {
        lsRemoteCalls++;
        // 1st call: the pre-push lookup — must succeed to reach the push loop.
        if (lsRemoteCalls === 1) return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
        // Every post-failure inspection attempt throws synchronously with a
        // whitespace-only message. Distinct from resolveRemoteBranchSha's own
        // "git ls-remote failed after N attempts" wrapper (used when spawnSync merely
        // returns a non-zero status): that wrapper always carries a non-blank literal
        // prefix and so can never itself produce a genuinely blank reason.
        throw new Error("   ");
      }
      if (gitArgs[0] === "push") {
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(caught?.failure).toBeDefined();
    // The whole "(remote could not be inspected: ...)" parenthetical is skipped, not
    // rendered with an empty reason inside it.
    expect(caught?.failure?.message).not.toContain("remote could not be inspected");
    expect(caught?.message).not.toContain("remote could not be inspected");
  });

  it("collapses ten identical mid-retry credential-refresh-failure notes into one copy with a count of 10", async () => {
    let pushCalls = 0;
    let setUrlCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      // The remote never moves: every push attempt stays genuinely transient.
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "remote" && gitArgs[1] === "set-url") {
        setUrlCalls++;
        // 1st call: the pre-push exchange — must succeed to reach the push loop.
        // Every mid-retry refresh after it fails with the exact same reason.
        if (setUrlCalls === 1) return spawnResult(0);
        return spawnResult(128, "", "fatal: not a git repository");
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "fresh-token", expires_at: "2030-01-01T00:00:00Z" }),
    } as Response);

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext({
          orchestratorUrl: "https://orchestrator.example",
          retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries: 10 },
        }),
        { ...BASE_INPUTS, orchestratorUrl: "https://orchestrator.example", machineNonce: "machine-nonce" },
        new NoopStepReporter(),
      );
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(11); // 1 + pushRetries(10)
    expect(caught?.failure?.code).toBe("GIT_PUSH_RETRIES_EXHAUSTED");
    const note = "credential refresh before retry failed: git remote set-url failed (exit 128): fatal: not a git repository";
    const occurrences = caught?.failure?.message?.split(note).length ?? 1;
    // Exactly one copy of the note text, not one per retry.
    expect(occurrences - 1).toBe(1);
    expect(caught?.failure?.message).toContain(`${note} (×10)`);
  });

  it("caps the joined credential-refresh-failure note suffix at 1000 characters even when the underlying notes total far more", async () => {
    let pushCalls = 0;
    let setUrlCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "remote" && gitArgs[1] === "set-url") {
        setUrlCalls++;
        if (setUrlCalls === 1) return spawnResult(0);
        // Each retry's refresh fails with a DISTINCT reason (a per-call marker), so
        // dedupeNotes cannot collapse them — the raw joined text across 10 retries
        // comfortably exceeds 3 000 characters.
        return spawnResult(128, "", `fatal: distinct failure marker ${"x".repeat(280)} #${setUrlCalls}`);
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "fresh-token", expires_at: "2030-01-01T00:00:00Z" }),
    } as Response);

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext({
          orchestratorUrl: "https://orchestrator.example",
          retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries: 10 },
        }),
        { ...BASE_INPUTS, orchestratorUrl: "https://orchestrator.example", machineNonce: "machine-nonce" },
        new NoopStepReporter(),
      );
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(11);
    expect(caught?.failure?.code).toBe("GIT_PUSH_RETRIES_EXHAUSTED");
    const message = caught?.failure?.message ?? "";
    expect(message).toContain("…");
    // Not all ten distinct markers can fit under the 1 000-character cap.
    const markerCount = (message.match(/distinct failure marker/g) ?? []).length;
    expect(markerCount).toBeGreaterThan(0);
    expect(markerCount).toBeLessThan(10);
  });

  it("calls computeBackoffMs with the retry policy and the failing attempt's number before sleeping", async () => {
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return spawnResult(128, "", "fatal: internal server error");
        return spawnResult(0);
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/60", number: 60 }),
      text: async () => "",
    } as Response);

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(pushCalls).toBe(2);
    expect(computeBackoffMs).toHaveBeenCalledWith(1, DEFAULT_RETRY_POLICY);
  });

  it("falls back to the default backoffInitialMs when the value is out of range", async () => {
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return spawnResult(128, "", "fatal: internal server error");
        return spawnResult(0);
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/61", number: 61 }),
      text: async () => "",
    } as Response);

    await pushStep.run(
      makeContext({ retryPolicy: { ...DEFAULT_RETRY_POLICY, backoffInitialMs: 500 } }),
      BASE_INPUTS,
      new NoopStepReporter(),
    );

    expect(pushCalls).toBe(2);
    expect(computeBackoffMs).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ backoffInitialMs: DEFAULT_RETRY_POLICY.backoffInitialMs }),
    );
  });

  it("falls back to the default backoffMaxMs when the value is out of range", async () => {
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return spawnResult(128, "", "fatal: internal server error");
        return spawnResult(0);
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/62", number: 62 }),
      text: async () => "",
    } as Response);

    await pushStep.run(
      makeContext({ retryPolicy: { ...DEFAULT_RETRY_POLICY, backoffMaxMs: 700_000 } }),
      BASE_INPUTS,
      new NoopStepReporter(),
    );

    expect(pushCalls).toBe(2);
    expect(computeBackoffMs).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ backoffMaxMs: DEFAULT_RETRY_POLICY.backoffMaxMs }),
    );
  });

  it("falls back to the default backoffJitter when the value is out of range", async () => {
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return spawnResult(128, "", "fatal: internal server error");
        return spawnResult(0);
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/63", number: 63 }),
      text: async () => "",
    } as Response);

    await pushStep.run(
      makeContext({ retryPolicy: { ...DEFAULT_RETRY_POLICY, backoffJitter: 2 } }),
      BASE_INPUTS,
      new NoopStepReporter(),
    );

    expect(pushCalls).toBe(2);
    expect(computeBackoffMs).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ backoffJitter: DEFAULT_RETRY_POLICY.backoffJitter }),
    );
  });

  it("raises a backoffMaxMs below backoffInitialMs up to backoffInitialMs instead of inverting the backoff", async () => {
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return spawnResult(128, "", "fatal: internal server error");
        return spawnResult(0);
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/64", number: 64 }),
      text: async () => "",
    } as Response);

    // Individually in range ([1_000, 600_000]) but incoherent as a pair: a max
    // below the initial delay would make backoff shrink instead of grow.
    await pushStep.run(
      makeContext({
        retryPolicy: { ...DEFAULT_RETRY_POLICY, backoffInitialMs: 600_000, backoffMaxMs: 1_000 },
      }),
      BASE_INPUTS,
      new NoopStepReporter(),
    );

    expect(pushCalls).toBe(2);
    expect(computeBackoffMs).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ backoffInitialMs: 600_000, backoffMaxMs: 600_000 }),
    );
  });

  it("retries a transient push failure past a null commitSha when the remote is unchanged", async () => {
    let pushCalls = 0;
    let lsRemoteCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      // resolveCommitSha fails: commitSha stays null throughout.
      if (gitArgs[0] === "rev-parse") return spawnResult(128, "", "fatal: not a valid object name HEAD");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") {
        lsRemoteCalls++;
        // The remote never moves off the leased SHA on any lookup.
        return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      }
      if (gitArgs[0] === "push") {
        pushCalls++;
        if (pushCalls === 1) return spawnResult(128, "", "remote: fatal error in commit_refs");
        return spawnResult(0);
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/acme/app/pull/65", number: 65 }),
      text: async () => "",
    } as Response);

    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(pushCalls).toBe(2);
    expect(lsRemoteCalls).toBeGreaterThanOrEqual(2);
    expect(outputs.prNumber).toBe(65);
    expect(outputs.commitSha).toBeNull();
  });

  it("keeps the current token when the mid-retry refresh throws before ever writing it to the environment", async () => {
    let pushCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "remote" && gitArgs[1] === "set-url") return spawnResult(0);
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "remote: fatal error in commit_refs");
      }
      return spawnResult(0);
    });
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "pub-token");
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        // Same token as BASE_INPUTS.githubToken ("gh-token"): the single-use
        // publication credential is only cleared when the vended token differs
        // from the current one, so it stays available for the mid-retry call below.
        json: async () => ({ token: "gh-token", expires_at: "2030-01-01T00:00:00Z" }),
      } as Response)
      .mockResolvedValueOnce({
        // A non-retryable rejection: the fail-closed publication exchange throws
        // immediately, before ever writing process.env.GITHUB_TOKEN.
        ok: false,
        status: 400,
        json: async () => ({}),
      } as Response);

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext({
          retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries: 1 },
          callbackUrl: "https://orchestrator.example",
        }),
        { ...BASE_INPUTS, callbackUrl: "https://orchestrator.example" },
        new NoopStepReporter(),
      );
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(pushCalls).toBe(2);
    expect(caught?.failure?.code).toBe("GIT_PUSH_RETRIES_EXHAUSTED");
    expect(caught?.failure?.message).toContain("credential refresh before retry failed");
    const pushCallArgs = vi.mocked(spawnSync).mock.calls.filter((c) => (c[1] as string[])[0] === "push");
    expect(pushCallArgs).toHaveLength(2);
    // The token that failed to refresh must still be the one used on the retry.
    expect((pushCallArgs[1][1] as string[]).join(" ")).toContain("gh-token");
  });

  it("labels the unpublished-work diff stat with the ref actually used when the primary ref fails and falls back to baseRef", async () => {
    let diffStatCalls = 0;
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `remote-lease-sha\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "diff" && gitArgs.includes("--stat")) {
        diffStatCalls++;
        // 1st attempt: against the lease SHA, never fetched locally — unknown revision.
        if (diffStatCalls === 1) {
          return spawnResult(128, "", "fatal: unknown revision or path not in the working tree: remote-lease-sha");
        }
        // 2nd attempt: falls back to the immutable base ref, which IS present locally.
        return spawnResult(0, " src/app.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      }
      if (gitArgs[0] === "push") {
        return spawnResult(128, "", "fatal: Authentication failed for 'https://github.com/acme/app.git/'");
      }
      return spawnResult(0);
    });

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(makeContext(), { ...BASE_INPUTS, baseRef: "base-ref-sha" }, new NoopStepReporter());
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(diffStatCalls).toBe(2);
    expect(caught?.failure?.category).toBe("auth");
    expect(caught?.message).toContain("git diff --stat base-ref-sha..HEAD:");
    expect(caught?.message).not.toContain("git diff --stat remote-lease-sha..HEAD:");
  });
});
describe("pushStep — mounted workspace never pushes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("AI_IMPLEMENT_WORKSPACE_MODE", "mounted");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a no-op result without touching git or GitHub", async () => {
    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.prUrl).toBeNull();
    expect(outputs.prNumber).toBeNull();
    expect(outputs.branchPushed).toBe(false);
    expect(outputs.commitSha).toBeNull();
    expect(outputs.draft).toBe(false);
    // No git or HTTP calls.
    expect(spawnSync).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does NOT skip when AI_IMPLEMENT_WORKSPACE_MODE is not mounted", async () => {
    vi.stubEnv("AI_IMPLEMENT_WORKSPACE_MODE", "");
    // Outside mounted mode the step falls through to normal push logic,
    // which needs git state. Provide enough for it to throw on "nothing to commit".
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 0,
      output: [],
      signal: null,
      error: undefined,
    });

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(); // normal logic runs, fails on nothing-to-commit
  });
});

// ---- Push guard: adopt own agent push vs refuse foreign work ----

describe("pushStep — push guard: adopt agent push vs refuse foreign work", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function mockGapFillWithRemoteSha(remoteSha: string, mergeBaseExitCode: number) {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") {
        return spawnResult(0, `${remoteSha}\t${gitArgs.at(-1)}\n`);
      }
      if (gitArgs[0] === "merge-base") return spawnResult(mergeBaseExitCode);
      return spawnResult(0);
    });
  }

  const GAP_FILL_INPUTS = {
    ...BASE_INPUTS,
    branchName: "feature/existing-pr",
    baseBranch: "feature/existing-pr",
    baseRef: "ff400c5",
    existingPrNumber: "42",
  };

  it("adopts agent push when remote SHA is reachable from HEAD (merge-base exit 0)", async () => {
    mockGapFillWithRemoteSha("246b3fe", 0);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ token: "fresh-token", expires_at: "2030-01-01T00:00:00Z" }),
    } as Response);
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-publication-token");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const outputs = await pushStep.run(
      makeContext({ callbackUrl: "https://orchestrator.example", prNumber: "42" }),
      { ...GAP_FILL_INPUTS, callbackUrl: "https://orchestrator.example" },
      new NoopStepReporter(),
    );

    expect(outputs.branchPushed).toBe(true);
    expect(outputs.prNumber).toBe(42);
    // Guard logged the adoption
    expect(consoleSpy.mock.calls.some(([msg]) => String(msg).includes("adopting"))).toBe(true);
    consoleSpy.mockRestore();
  });

  it("uses the adopted remote SHA (not baseRef) in the force-with-lease arg when adopting", async () => {
    mockGapFillWithRemoteSha("246b3fe", 0);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ token: "fresh-token", expires_at: "2030-01-01T00:00:00Z" }),
    } as Response);
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-publication-token");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await pushStep.run(
      makeContext({ callbackUrl: "https://orchestrator.example", prNumber: "42" }),
      { ...GAP_FILL_INPUTS, callbackUrl: "https://orchestrator.example" },
      new NoopStepReporter(),
    );

    // Force-with-lease must reference 246b3fe (the adopted remote tip), not ff400c5 (baseRef).
    // Using baseRef as the lease would fail because the remote is already ahead of it.
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "push",
        expect.any(String),
        "HEAD:refs/heads/feature/existing-pr",
        "--force-with-lease=refs/heads/feature/existing-pr:246b3fe",
      ]),
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
    expect(spawnSync).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["--force-with-lease=refs/heads/feature/existing-pr:ff400c5"]),
      expect.anything(),
    );
    consoleSpy.mockRestore();
  });

  it("refuses genuinely foreign push when remote SHA is not reachable from HEAD (merge-base exit 1)", async () => {
    mockGapFillWithRemoteSha("foreignsha", 1);

    await expect(
      pushStep.run(makeContext({ prNumber: "42" }), GAP_FILL_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/refusing to overwrite concurrent work/);

    expect(spawnSync).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["push"]),
      expect.anything(),
    );
  });

  it("does not call merge-base when remote SHA already matches baseRef (fast-path)", async () => {
    // When remoteBranchSha === baseRef the guard is skipped entirely.
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") {
        // remote SHA matches baseRef — no mismatch
        return spawnResult(0, `ff400c5\t${gitArgs.at(-1)}\n`);
      }
      if (gitArgs[0] === "merge-base") {
        throw new Error("merge-base must not be called when SHAs match");
      }
      return spawnResult(0);
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ token: "fresh-token", expires_at: "2030-01-01T00:00:00Z" }),
    } as Response);
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-publication-token");

    const result = await pushStep.run(
      makeContext({ callbackUrl: "https://orchestrator.example", prNumber: "42" }),
      { ...GAP_FILL_INPUTS, callbackUrl: "https://orchestrator.example" },
      new NoopStepReporter(),
    );

    // Reaching here means merge-base was never called (the mock would have thrown).
    expect(result.branchPushed).toBe(true);
    const mergeBaseCalls = vi.mocked(spawnSync).mock.calls.filter(
      ([, args]) => (args as string[])[0] === "merge-base",
    );
    expect(mergeBaseCalls).toHaveLength(0);
  });

  it("calls merge-base with --is-ancestor <remoteSha> HEAD in that exact order", async () => {
    mockGapFillWithRemoteSha("246b3fe", 0);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ token: "fresh-token", expires_at: "2030-01-01T00:00:00Z" }),
    } as Response);
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-publication-token");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await pushStep.run(
      makeContext({ callbackUrl: "https://orchestrator.example", prNumber: "42" }),
      { ...GAP_FILL_INPUTS, callbackUrl: "https://orchestrator.example" },
      new NoopStepReporter(),
    );

    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["merge-base", "--is-ancestor", "246b3fe", "HEAD"],
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
    consoleSpy.mockRestore();
  });
});
