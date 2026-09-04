import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pushStep } from "../pipeline/steps/push.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import { __resetPublicationCredentialForTests } from "../publication-credential.js";

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
