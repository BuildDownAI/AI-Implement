import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pushStep } from "../pipeline/steps/push.js";
import type { PipelineContextData } from "../pipeline/types.js";
import { NoopStepReporter } from "../pipeline/reporter.js";
import { __resetPublicationCredentialForTests } from "../publication-credential.js";
import { DEFAULT_RETRY_POLICY } from "../pipeline/retry-backoff.js";
import type { FailureRecord } from "../pipeline/failure-classification.js";
import { makeContext as makeBaseContext, makeFeedbackLoopOutputs } from "./helpers/builders.js";
import { fakeFetch, type FakeFetch, type ReplyInit, type Routes } from "./helpers/fake-fetch.js";
import { githubError } from "./helpers/github-replies.js";
import { makeSnapshot } from "./configured-run-fixture.js";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("../pipeline/retry-backoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pipeline/retry-backoff.js")>();
  // Wraps the real implementation (so backoff math and every other test's timing-
  // insensitive behavior is unchanged) purely so a test can assert what it was called
  // with, rather than inferring timing from NODE_ENV=test's sleepSync no-op.
  return { ...actual, computeBackoffMs: vi.fn(actual.computeBackoffMs), sleepAsync: vi.fn(actual.sleepAsync) };
});

import { spawnSync } from "node:child_process";
import { computeBackoffMs, sleepAsync } from "../pipeline/retry-backoff.js";

// The issue the implementation branch below is named for; the PR title, body and commit assertions name it.
// No orchestrator URL or nonce: a GitHub Actions run, like BASE_INPUTS. The pipeline copies these into the
// step's inputs, so a test that vends a token passes the same values to both. The checked-out branch is the
// inputs' base branch: the clone reports it back and the pipeline passes it on as `baseBranch`.
function makeContext(overrides: Partial<PipelineContextData> = {}) {
  return makeBaseContext({ issueIdentifier: "ENG-42", orchestratorUrl: "", nonce: "", branch: "main", ...overrides });
}

// A gap-fill run checks out the PR's own branch, which the inputs name as both base and branch.
const GAP_FILL_CONTEXT = { prNumber: "42", branch: "feature/existing-pr" };

const CREATE_PR = "POST /repos/acme/app/pulls";
const LIST_PRS = "GET /repos/acme/app/pulls";
const VEND_TOKEN = "POST /api/token";
const PUBLICATION_TOKEN = "POST /api/runner/publication-token";

/** GitHub's answer to a created pull request, trimmed to the fields the step reads. */
const created = (number: number): ReplyInit => ({
  status: 201,
  json: { html_url: `https://github.com/acme/app/pull/${number}`, number },
});
/** The orchestrator's answer to a token vend; `/api/token` and `/api/runner/publication-token` share it. */
const minted = (token: string): ReplyInit => ({ json: { token, expires_at: "2030-01-01T00:00:00Z" } });
const unprocessable = githubError(422, "Validation Failed");

interface PullRequestCreate { title: string; head: string; base: string; body: string; draft?: boolean }

/** The body of the n-th pull request the step asked GitHub to create. */
function prRequest(fake: FakeFetch, n = 0): PullRequestCreate {
  const creates = fake.calls.filter((call) => `${call.method} ${call.path}` === CREATE_PR);
  return JSON.parse(creates[n].body) as PullRequestCreate;
}

const BASE_INPUTS = {
  workspaceDir: "/tmp/workspace",
  repoOwner: "acme",
  repoRepo: "app",
  githubToken: "gh-token",
  branchName: "ai-implement/eng-42-test",
  baseBranch: "main",
  // The commit the clone checked out, which the clone step reports as clonedRef; never a branch name.
  baseRef: "c0ffee00",
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

const TEST_VERDICT_SENTENCE =
  "The CI checks on this PR are the source of truth for the test verdict. The line above is the runner's own pre-push report.";

// No routes: a request in a test that installs none fails it. A test's own fake replaces this one.
let unrouted: FakeFetch;
beforeEach(() => {
  unrouted = fakeFetch({}).install();
});

describe("pushStep", () => {
  beforeEach(() => {
    __resetPublicationCredentialForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    __resetPublicationCredentialForTests();
    vi.unstubAllEnvs();
  });

  it("creates PR and returns prUrl, prNumber, commitSha on success", async () => {
    mockGitSuccess("abc123");
    fakeFetch({ [CREATE_PR]: created(7) }).install();

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
    const fake = fakeFetch({ [VEND_TOKEN]: minted("fresh-token"), [CREATE_PR]: created(7) }).install();

    try {
      await pushStep.run(
        makeContext({ orchestratorUrl: "https://orchestrator.example", nonce: "machine-nonce" }),
        {
          ...BASE_INPUTS,
          orchestratorUrl: "https://orchestrator.example",
          machineNonce: "machine-nonce",
        },
        new NoopStepReporter(),
      );

      expect(fake.calls.map((call) => `${call.method} ${call.url.href}`)).toEqual([
        "POST https://orchestrator.example/api/token",
        "POST https://api.github.com/repos/acme/app/pulls",
      ]);

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

      expect(fake.calls[1].headers.get("authorization")).toBe("Bearer fresh-token");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("exchanges the process-only publication credential immediately before GHA remote writes", async () => {
    mockGitSuccess("abc123");
    vi.stubEnv("GITHUB_TOKEN", "workflow-token");
    vi.stubEnv("GH_TOKEN", "workflow-token");
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-publication-token");
    const fake = fakeFetch({ [PUBLICATION_TOKEN]: minted("fresh-token"), [CREATE_PR]: created(7) }).install();

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

      expect(fake.calls.map((call) => `${call.method} ${call.url.href}`)).toEqual([
        "POST https://orchestrator.example/api/runner/publication-token",
        "POST https://api.github.com/repos/acme/app/pulls",
      ]);
      expect(Object.fromEntries(fake.calls[0].headers)).toEqual({
        authorization: "Bearer one-use-publication-token",
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
      expect(fake.calls[1].headers.get("authorization")).toBe("Bearer fresh-token");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("updates an existing PR branch with a freshly vended token without creating another PR", async () => {
    mockGitSuccess("abc123");
    vi.stubEnv("GITHUB_TOKEN", "workflow-token");
    vi.stubEnv("GH_TOKEN", "workflow-token");
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-publication-token");
    const fake = fakeFetch({ [PUBLICATION_TOKEN]: minted("fresh-token") }).install();

    const outputs = await pushStep.run(
      makeContext({ callbackUrl: "https://orchestrator.example", ...GAP_FILL_CONTEXT }),
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
    expect(fake.calls).toHaveLength(1);
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
    const fake = fakeFetch({ [PUBLICATION_TOKEN]: minted("fresh-token") }).install();

    const outputs = await pushStep.run(
      makeContext({ callbackUrl: "https://orchestrator.example", ...GAP_FILL_CONTEXT }),
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
    expect(fake.calls).toHaveLength(1);
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
      makeContext(GAP_FILL_CONTEXT),
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
      makeContext(GAP_FILL_CONTEXT),
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
    expect(unrouted.calls).toEqual([]);
  });

  it("completes the push with the boot token when credential vending returns 403", async () => {
    mockGitSuccess("abc123");
    const fake = fakeFetch({
      [VEND_TOKEN]: { status: 403, json: { error: "Invalid or expired nonce" } },
      [CREATE_PR]: created(7),
    }).install();

    const outputs = await pushStep.run(
      makeContext({ orchestratorUrl: "https://orchestrator.example", nonce: "machine-nonce" }),
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
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([VEND_TOKEN, CREATE_PR]);
    expect(fake.calls[1].headers.get("authorization")).toBe("Bearer gh-token");
  });

  it("uses the context branch as the PR base when baseBranch input is omitted", async () => {
    mockGitSuccess("abc123");
    const fake = fakeFetch({ [CREATE_PR]: created(7) }).install();

    await pushStep.run(
      makeContext({ branch: "development" }),
      { ...BASE_INPUTS, baseBranch: undefined },
      new NoopStepReporter(),
    );

    expect(prRequest(fake).base).toBe("development");
  });

  it("returns existing PR info on 422 (PR already open)", async () => {
    mockGitSuccess("sha999");
    const fake = fakeFetch({
      [CREATE_PR]: unprocessable,
      [LIST_PRS]: { json: [{ html_url: "https://github.com/acme/app/pull/3", number: 3 }] },
    }).install();

    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.prUrl).toBe("https://github.com/acme/app/pull/3");
    expect(outputs.prNumber).toBe(3);
    expect(outputs.branchPushed).toBe(true);
    expect(fake.calls[1].url.search).toBe("?head=acme:ai-implement/eng-42-test&state=open");
  });

  it("throws on git push failure and redacts token", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "sha\n");
      if (gitArgs[0] === "ls-remote") {
        return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-test\n");
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
        return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-test\n");
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
    fakeFetch({ [CREATE_PR]: { status: 500, text: "Internal Server Error" } }).install();

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/PR creation failed with HTTP 500/);
  });

  it("throws when listing open PRs fails after 422", async () => {
    mockGitSuccess("sha404");
    fakeFetch({ [CREATE_PR]: unprocessable, [LIST_PRS]: { status: 503, text: "Service Unavailable" } }).install();

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/listing open PRs failed with HTTP 503/);
  });

  it("throws when 422 returned but no open PR found for branch", async () => {
    mockGitSuccess("sha405");
    fakeFetch({ [CREATE_PR]: unprocessable, [LIST_PRS]: { json: [] } }).install();

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/no open PR found for branch/);
  });

  it("uses issueIdentifier in default PR title", async () => {
    mockGitSuccess();
    const fake = fakeFetch({ [CREATE_PR]: created(1) }).install();

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(prRequest(fake).title).toContain("ENG-42");
  });

  it("creates a concise PR body with summary, approach, and test plan sections", async () => {
    mockGitSuccess();
    const ctx = makeContext();
    ctx.setOutputs("feedback-loop", makeFeedbackLoopOutputs());
    ctx.setOutputs("preflight", { summary: "typecheck: passed, tests: passed (12 assertions)" });
    const fake = fakeFetch({ [CREATE_PR]: created(1) }).install();

    await pushStep.run(ctx, BASE_INPUTS, new NoopStepReporter());

    const body = prRequest(fake);
    expect(body.body).toContain("## Summary");
    expect(body.body).toContain("Implemented the requested work for ENG-42: Test.");
    expect(body.body).toContain("## Approach");
    expect(body.body).toContain("Implements ENG-42: Test.");
    expect(body.body).toContain("Fixes ENG-42");
    expect(body.body).toContain("- Modified: `src/app.ts`");
    expect(body.body).toContain("- Added: `src/app.test.ts`");
    expect(body.body).toContain("## Test plan");
    expect(body.body).toContain("- [x] typecheck: passed");
    expect(body.body).toContain(`${"- [x] typecheck: passed, tests: passed (12 assertions)"}\n\n${TEST_VERDICT_SENTENCE}\n`);
    expect(body.body).toContain("typecheck: passed");
    expect(body.body).toContain("- [ ] Manual: review the changed behavior against the ticket acceptance criteria.");
    expect(body.body).toContain("Generated with AI-Implement");
    expect(body.body).not.toContain("## What was implemented");
    expect(body.body).not.toContain("## AI review");
  });

  it("footer includes harness, model, and provider with explicit values", async () => {
    mockGitSuccess();
    const fake = fakeFetch({ [CREATE_PR]: created(1) }).install();

    await pushStep.run(makeContext({ model: "claude-opus-4-5", provider: "bedrock" }), BASE_INPUTS, new NoopStepReporter());

    expect(prRequest(fake).body).toContain("Generated with AI-Implement · harness: Claude Code · model: claude-opus-4-5 · provider: bedrock");
  });

  it("footer degrades to model: unknown when model is absent", async () => {
    mockGitSuccess();
    const fake = fakeFetch({ [CREATE_PR]: created(1) }).install();

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    const body = prRequest(fake);
    expect(body.body).toContain("Generated with AI-Implement");
    expect(body.body).toContain("model: unknown");
  });

  it("footer defaults to provider: anthropic when provider is absent", async () => {
    mockGitSuccess();
    const fake = fakeFetch({ [CREATE_PR]: created(1) }).install();

    await pushStep.run(makeContext({ model: "claude-sonnet-4-6" }), BASE_INPUTS, new NoopStepReporter());

    expect(prRequest(fake).body).toContain("provider: anthropic");
  });

  it("footer names the implementation stage harness and provider for a configured Codex run", async () => {
    mockGitSuccess();
    const fake = fakeFetch({ [CREATE_PR]: created(1) }).install();

    // The fixture's implementation stage is Codex on OpenAI.
    const agentConfig = makeSnapshot();
    await pushStep.run(makeContext({ model: "gpt-6-luna", provider: "anthropic", agentConfig }), BASE_INPUTS, new NoopStepReporter());

    const body = prRequest(fake);
    expect(body.body).toContain("Generated with AI-Implement · harness: Codex · model: gpt-6-luna · provider: openai");
    expect(body.body).not.toContain("harness: Claude Code");
    expect(body.body).not.toContain("provider: anthropic");
  });

  it("footer keeps Claude Code and shows the stage provider for a configured Bedrock run", async () => {
    mockGitSuccess();
    const fake = fakeFetch({ [CREATE_PR]: created(1) }).install();

    const snapshot = makeSnapshot();
    const agentConfig = { ...snapshot, stages: { ...snapshot.stages, implementation: { ...snapshot.stages.implementation, agent: "claude", provider: "bedrock" } } } as const;
    await pushStep.run(makeContext({ model: "m", provider: "bedrock", agentConfig }), BASE_INPUTS, new NoopStepReporter());

    const body = prRequest(fake);
    expect(body.body).toContain("harness: Claude Code · model: m · provider: bedrock");
  });

  it("footer includes Bedrock ARN-style model ID verbatim", async () => {
    mockGitSuccess();
    const fake = fakeFetch({ [CREATE_PR]: created(1) }).install();

    const bedrockModel = "anthropic.claude-opus-4-5-20260101-v1:0";
    await pushStep.run(makeContext({ model: bedrockModel, provider: "bedrock" }), BASE_INPUTS, new NoopStepReporter());

    const body = prRequest(fake);
    expect(body.body).toContain(`model: ${bedrockModel}`);
    expect(body.body).toContain("provider: bedrock");
  });

  it("checks out implementation branch and commits working tree changes before pushing", async () => {
    mockGitSuccess("abc123");
    fakeFetch({ [CREATE_PR]: created(1) }).install();

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["checkout", "-B", "ai-implement/eng-42-test"],
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
        "HEAD:refs/heads/ai-implement/eng-42-test",
        "--force-with-lease=refs/heads/ai-implement/eng-42-test:beadfeed",
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
    fakeFetch({ [CREATE_PR]: created(1) }).install();

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "push",
        expect.any(String),
        "HEAD:refs/heads/ai-implement/eng-42-test",
        "--force-with-lease=refs/heads/ai-implement/eng-42-test:",
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
        return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-test\n");
      }
      return spawnResult(0);
    });
    fakeFetch({ [CREATE_PR]: created(1) }).install();

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(lsRemoteAttempts).toBe(3);
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "push",
        expect.any(String),
        "HEAD:refs/heads/ai-implement/eng-42-test",
        "--force-with-lease=refs/heads/ai-implement/eng-42-test:beadfeed",
      ]),
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
  });

  it("looks up the exact implementation branch ref for the remote lease", async () => {
    mockGitSuccess();
    fakeFetch({ [CREATE_PR]: created(1) }).install();

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["ls-remote", expect.any(String), "refs/heads/ai-implement/eng-42-test"],
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
  });

  it("throws when Claude leaves no working tree changes", async () => {
    mockGitSuccess("abc123", false);

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/Nothing to commit/);
    expect(unrouted.calls).toEqual([]);
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
    expect(unrouted.calls).toEqual([]);
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
    expect(unrouted.calls).toEqual([]);
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
        return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-test\n");
      }
      return spawnResult(0);
    });
    fakeFetch({ [CREATE_PR]: created(9) }).install();

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
    expect(unrouted.calls).toEqual([]);
  });

  it("(c1) allow-list suppresses a default sensitive-file hit", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M .env\n");
      if (gitArgs[0] === "diff") return spawnResult(0, ".env\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\t.env\n");
      if (gitArgs[0] === "ls-remote") {
        return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-test\n");
      }
      return spawnResult(0);
    });
    fakeFetch({ [CREATE_PR]: created(9) }).install();

    const outputs = await pushStep.run(
      makeContext({ sensitiveFiles: { allow: [".env"] } }),
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
        makeContext({ sensitiveFiles: { allow: [".env"] } }),
        { ...BASE_INPUTS, sensitiveFiles: { allow: [".env"] } },
        new NoopStepReporter(),
      ),
    ).rejects.toThrow(/Push blocked/);
    expect(unrouted.calls).toEqual([]);
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
    expect(unrouted.calls).toEqual([]);
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
        makeContext({ sensitiveFiles: { add: ["*.secret"] } }),
        { ...BASE_INPUTS, sensitiveFiles: { add: ["*.secret"] } },
        new NoopStepReporter(),
      ),
    ).rejects.toThrow(/client-configured pattern \(\*\.secret\)/);
    expect(unrouted.calls).toEqual([]);
  });

  it("allow-list glob suppresses a matching variant (.env.local)", async () => {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M .env.local\n");
      if (gitArgs[0] === "diff") return spawnResult(0, ".env.local\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\t.env.local\n");
      if (gitArgs[0] === "ls-remote") {
        return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-test\n");
      }
      return spawnResult(0);
    });
    fakeFetch({ [CREATE_PR]: created(9) }).install();

    const outputs = await pushStep.run(
      makeContext({ sensitiveFiles: { allow: [".env.*"] } }),
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
          return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-test\n");
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
      fakeFetch({ [CREATE_PR]: created(7) }).install();

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

/** The review summary the pipeline hands push for an unapproved feedback-loop run (pipeline-loader.ts). */
function reviewSummary(run: ReturnType<typeof makeFeedbackLoopOutputs>) {
  const { terminationReason, iterations, finalFeedback, passes, postMortem } = run;
  return { terminationReason, iterations, finalFeedback, passes, ...(postMortem ? { postMortem } : {}) };
}

const REVIEW_SUMMARY = reviewSummary(makeFeedbackLoopOutputs({ approved: false, iterations: 3, finalFeedback: "Missing tests for the retry path." }));
// Only a run that hit the turn cap carries a post-mortem.
const MAX_TURNS_SUMMARY = reviewSummary(makeFeedbackLoopOutputs({ terminationReason: "max_turns", postMortem: "## Post-mortem\nScope too broad." }));
const OUTAGE_SUMMARY = reviewSummary(makeFeedbackLoopOutputs({ terminationReason: "provider_unavailable" }));

describe("pushStep draft PRs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a draft PR with an unapproved section in the body", async () => {
    mockGitSuccess("abc123");
    const fake = fakeFetch({ [CREATE_PR]: created(9) }).install();

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, draft: true, reviewSummary: MAX_TURNS_SUMMARY },
      new NoopStepReporter(),
    );

    expect(outputs.draft).toBe(true);
    const body = prRequest(fake);
    expect(body.draft).toBe(true);
    expect(body.body).toContain("Automated review did not approve");
    expect(body.body).toContain("Implementation hit the 50-turn cap");
    expect(body.body).toContain("max_turns");
    expect(body.body).toContain("Post-mortem");
    // The test-plan line must not contradict the unapproved section above it: no
    // testsSummary/preflight summary was supplied, so the fallback must say
    // verification was skipped (unchecked box), not that it ran (checked box).
    expect(body.body).toContain("- [ ] Automated verification was skipped — the review loop did not approve this change.");
    expect(body.body).toContain(`${"- [ ] Automated verification was skipped — the review loop did not approve this change."}\n\n${TEST_VERDICT_SENTENCE}\n`);
    expect(body.body).not.toContain("Automated verification was run by the AI-Implement pipeline before opening this PR.");
  });

  it("heads a provider_unavailable draft PR as a provider outage, not a review rejection", async () => {
    mockGitSuccess("abc123");
    const fake = fakeFetch({ [CREATE_PR]: created(9) }).install();

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, draft: true, reviewSummary: OUTAGE_SUMMARY },
      new NoopStepReporter(),
    );

    expect(outputs.draft).toBe(true);
    const body = prRequest(fake);
    expect(body.draft).toBe(true);
    expect(body.body).toContain("The model provider was unavailable during this run");
    expect(body.body).not.toContain("Automated review did not approve");
    expect(body.body).not.toContain("Reviewer's final feedback");
    expect(body.body).not.toContain("unapproved run");
    expect(body.body).toContain("Run notes");
    expect(body.body).toContain("partial changes were preserved");
    // The column is specifically the implement call's spawn attempts (not review's).
    expect(body.body).toContain("| Pass | Implement outcome | Turns / limit | Implement attempts | Cost | Tokens | Review |");
    // The test-plan line must not read as a review rejection on a provider outage — the
    // reviewer may never have run at all (BAC-27201).
    expect(body.body).toContain("- [ ] Automated verification was skipped — the model provider was unavailable and the run was interrupted.");
    expect(body.body).toContain(`${"- [ ] Automated verification was skipped — the model provider was unavailable and the run was interrupted."}\n\n${TEST_VERDICT_SENTENCE}\n`);
    expect(body.body).not.toContain("the review loop did not approve this change");
    expect(body.body).not.toContain("Automated verification was run by the AI-Implement pipeline before opening this PR.");
  });

  it("shows an implement invocation failure code next to the review verdict in the pass table", async () => {
    mockGitSuccess("abc123");
    const fake = fakeFetch({ [CREATE_PR]: created(9) }).install();

    await pushStep.run(
      makeContext(),
      {
        ...BASE_INPUTS, draft: true,
        reviewSummary: {
          ...REVIEW_SUMMARY,
          passes: [
            { iteration: 1, implementTurns: 3, implementOutcome: "success", costUsd: 1, reviewApproved: false },
            { iteration: 2, implementTurns: 4, implementOutcome: "error", implementFailureCode: "LLM_TERMINAL_ERROR", costUsd: 1, reviewApproved: true },
          ],
        },
      },
      new NoopStepReporter(),
    );

    const body = prRequest(fake);
    expect(body.body).toContain("| 1 | success | 3 |");
    expect(body.body).toContain("| 2 | error (LLM_TERMINAL_ERROR) | 4 |");
    expect(body.body).toMatch(/\| 2 \| error \(LLM_TERMINAL_ERROR\).*\| approved \|/);
  });

  it("renders Codex turns as unavailable and missing cost as unavailable in the unapproved table (AII-113)", async () => {
    mockGitSuccess("abc123");
    const fake = fakeFetch({ [CREATE_PR]: created(9) }).install();

    await pushStep.run(
      makeContext(),
      {
        ...BASE_INPUTS, draft: true,
        reviewSummary: {
          ...REVIEW_SUMMARY,
          passes: [
            {
              iteration: 1, implementTurns: 7, implementOutcome: "success", costUsd: null, reviewCostUsd: null, reviewApproved: false,
              tokensIn: 10, tokensOut: 20,
              attribution: {
                version: 1, invocationId: "inv-1", stage: "implementation", snapshotId: "snap-1", agent: "codex", provider: "openai",
                model: "m", profileId: null, authMode: "codex-subscription",
                limit: { kind: "timeout_ms", value: 600000 }, outcome: "success", usage: null,
              },
            },
          ],
        },
      },
      new NoopStepReporter(),
    );

    const body = prRequest(fake);
    expect(body.body).toContain("| 1 | success | n/a (native turn count unavailable); limit 600s timeout | 1 | unavailable | in 10 / out 20 | rejected |");
    expect(body.body).not.toContain("$0.00");
  });

  it("titles a provider_unavailable 422 non-draft fallback as an interruption, not an unapproved rejection", async () => {
    mockGitSuccess("abc123");
    const fake = fakeFetch({
      // The draft create is refused, no PR is open, then the retry without the draft flag succeeds.
      [CREATE_PR]: [unprocessable, created(10)],
      [LIST_PRS]: { json: [] },
    }).install();

    const outputs = await pushStep.run(
      makeContext(),
      {
        ...BASE_INPUTS,
        prTitle: "ENG-42: Test",
        draft: true,
        reviewSummary: OUTAGE_SUMMARY,
      },
      new NoopStepReporter(),
    );

    expect(outputs.draft).toBe(false);
    expect(outputs.prNumber).toBe(10);
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([CREATE_PR, LIST_PRS, CREATE_PR]);
    const retryBody = prRequest(fake, 1);
    expect(retryBody.draft).toBeUndefined();
    expect(retryBody.title).toBe("[INTERRUPTED — provider outage] ENG-42: Test");
  });

  it("falls back to a titled normal PR when the draft flag is rejected (422, no existing PR)", async () => {
    mockGitSuccess("abc123");
    const fake = fakeFetch({
      // The draft create is refused, no PR is open, then the retry without the draft flag succeeds.
      [CREATE_PR]: [unprocessable, created(10)],
      [LIST_PRS]: { json: [] },
    }).install();

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, prTitle: "ENG-42: Test", draft: true, reviewSummary: REVIEW_SUMMARY },
      new NoopStepReporter(),
    );

    expect(outputs.draft).toBe(false);
    expect(outputs.prNumber).toBe(10);
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([CREATE_PR, LIST_PRS, CREATE_PR]);
    const retryBody = prRequest(fake, 1);
    expect(retryBody.draft).toBeUndefined();
    expect(retryBody.title).toBe("[NEEDS REVIEW — unapproved] ENG-42: Test");
  });

  it("still resolves an already-open PR on 422 when drafting", async () => {
    mockGitSuccess("abc123");
    fakeFetch({
      [CREATE_PR]: unprocessable,
      [LIST_PRS]: { json: [{ html_url: "https://github.com/acme/app/pull/8", number: 8, draft: true }] },
    }).install();

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
    fakeFetch({
      [CREATE_PR]: unprocessable,
      [LIST_PRS]: { json: [{ html_url: "https://github.com/acme/app/pull/8", number: 8, draft: false }] },
    }).install();

    const outputs = await pushStep.run(
      makeContext(),
      { ...BASE_INPUTS, draft: true, reviewSummary: REVIEW_SUMMARY },
      new NoopStepReporter(),
    );

    expect(outputs.draft).toBe(false);
  });

  it("non-draft pushes send no draft flag and no unapproved section", async () => {
    mockGitSuccess("abc123");
    const fake = fakeFetch({ [CREATE_PR]: created(7) }).install();

    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(outputs.draft).toBe(false);
    const body = prRequest(fake);
    expect(body.draft).toBeUndefined();
    expect(body.body).not.toContain("Automated review did not approve");
  });
});

describe("pushStep — dependency install status in the PR body", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("leads the body with a warning and names installMethod/installError when both attempts failed", async () => {
    mockGitSuccess("abc123");
    const ctx = makeContext();
    ctx.setOutputs("install", { installFailed: true, installMethod: "npm ci" });
    ctx.setOutputs("install-retry", { installFailed: true, installMethod: "npm ci", installError: "ERESOLVE unable to resolve dependency tree" });
    const fake = fakeFetch({ [CREATE_PR]: created(11) }).install();

    // The pipeline opens a run whose dependencies never installed as a draft, approved or not.
    await pushStep.run(ctx, { ...BASE_INPUTS, draft: true }, new NoopStepReporter());

    const body = prRequest(fake);
    expect(body.draft).toBe(true);
    expect(body.body.startsWith("## ⚠️ Dependencies did not install")).toBe(true);
    expect(body.body).toContain("`npm ci`");
    expect(body.body).toContain("ERESOLVE unable to resolve dependency tree");
    expect(body.body).toContain("- [ ] Automated verification was skipped — dependency install failed.");
    expect(body.body).toContain(`${"- [ ] Automated verification was skipped — dependency install failed."}\n\n${TEST_VERDICT_SENTENCE}\n`);
  });

  it("neutralizes an embedded fence in installError so the PR body's code block is not broken", async () => {
    mockGitSuccess("abc123");
    const ctx = makeContext();
    ctx.setOutputs("install", { installFailed: true, installMethod: "npm ci" });
    ctx.setOutputs("install-retry", {
      installFailed: true,
      installMethod: "npm ci",
      installError: "some output\n```\nmalicious markdown injected here\n```\nmore output",
    });
    const fake = fakeFetch({ [CREATE_PR]: created(11) }).install();

    await pushStep.run(ctx, { ...BASE_INPUTS, draft: true }, new NoopStepReporter());

    const body = prRequest(fake);
    const fenceCount = (body.body.match(/^```$/gm) ?? []).length;
    expect(fenceCount).toBe(2);
    expect(body.body).toContain("'''\nmalicious markdown injected here\n'''");
  });

  it("orders the dependency warning before the unapproved section when both are present", async () => {
    mockGitSuccess("abc123");
    const ctx = makeContext();
    ctx.setOutputs("install", { installFailed: true, installMethod: "npm ci" });
    ctx.setOutputs("install-retry", { installFailed: true, installMethod: "npm ci", installError: "boom" });
    const fake = fakeFetch({ [CREATE_PR]: created(11) }).install();

    await pushStep.run(ctx, { ...BASE_INPUTS, draft: true, reviewSummary: REVIEW_SUMMARY }, new NoopStepReporter());

    const body = prRequest(fake);
    const warningIdx = body.body.indexOf("## ⚠️ Dependencies did not install");
    const unapprovedIdx = body.body.indexOf("Automated review did not approve");
    expect(warningIdx).toBeGreaterThanOrEqual(0);
    expect(unapprovedIdx).toBeGreaterThan(warningIdx);
  });

  it("reports the retry succeeding after an initial failure with no warning section", async () => {
    mockGitSuccess("abc123");
    const ctx = makeContext();
    ctx.setOutputs("install", { installFailed: true, installMethod: "npm ci" });
    ctx.setOutputs("install-retry", { installFailed: false, installMethod: "npm ci" });
    const fake = fakeFetch({ [CREATE_PR]: created(12) }).install();

    await pushStep.run(ctx, BASE_INPUTS, new NoopStepReporter());

    const body = prRequest(fake);
    expect(body.body).not.toContain("## ⚠️ Dependencies did not install");
    expect(body.body).toContain("Initial dependency install failed; it succeeded after this change.");
    expect(body.body.indexOf(TEST_VERDICT_SENTENCE)).toBeGreaterThan(-1);
    expect(body.body.indexOf(TEST_VERDICT_SENTENCE)).toBeLessThan(body.body.indexOf("- [x] Initial dependency install failed"));
  });

  it.each([
    ["ok", { installFailed: false, installMethod: "npm ci" }],
    ["skipped", { installFailed: false, installMethod: "skipped: no package.json" }],
  ])("adds nothing new when the first install is %s and the retry never ran", async (_label, installOutputs) => {
    mockGitSuccess("abc123");
    const ctx = makeContext();
    ctx.setOutputs("install", installOutputs);
    const fake = fakeFetch({ [CREATE_PR]: created(13) }).install();

    await pushStep.run(ctx, BASE_INPUTS, new NoopStepReporter());

    const body = prRequest(fake);
    expect(body.body).not.toContain("## ⚠️ Dependencies did not install");
    expect(body.body).not.toContain("Initial dependency install failed; it succeeded after this change.");
    expect(body.body).not.toContain("dependency install failed");
  });

  it("never renders install status for a gap-fill push (no PR body is built)", async () => {
    mockGitSuccess("abc123");
    const ctx = makeContext(GAP_FILL_CONTEXT);
    ctx.setOutputs("install", { installFailed: true, installMethod: "npm ci" });
    ctx.setOutputs("install-retry", { installFailed: true, installMethod: "npm ci", installError: "boom" });

    const outputs = await pushStep.run(
      ctx,
      {
        ...BASE_INPUTS,
        branchName: "feature/existing-pr",
        baseBranch: "feature/existing-pr",
        baseRef: "beadfeed",
        existingPrNumber: "42",
      },
      new NoopStepReporter(),
    );

    expect(outputs.prNumber).toBe(42);
    expect(unrouted.calls).toEqual([]);
  });
});

// ---- Case A: agent committed its own changes ----

describe("pushStep — Case A (agent-committed changes)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        return spawnResult(0, "beadfeed\trefs/heads/ai-implement/eng-42-test\n");
      }
      return spawnResult(0);
    });
  }

  it("pushes agent-committed work without throwing 'Nothing to commit'", async () => {
    mockAgentCommitted("commitA");
    fakeFetch({ [CREATE_PR]: created(11) }).install();

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
    const fake = fakeFetch({ [CREATE_PR]: created(21) }).install();

    await pushStep.run(
      makeContext({ branch: "ai-implement/feature/eng-40" }),
      {
        ...BASE_INPUTS,
        branchName: "ai-implement/eng-42-test",
        baseBranch: "ai-implement/feature/eng-40",
        baseRef: "clone-sha",
      },
      new NoopStepReporter(),
    );

    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["rev-list", "--count", "clone-sha..HEAD"],
      expect.objectContaining({ cwd: "/tmp/workspace" }),
    );
    expect(prRequest(fake)).toEqual(expect.objectContaining({
      head: "ai-implement/eng-42-test",
      base: "ai-implement/feature/eng-40",
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
    expect(unrouted.calls).toEqual([]);
  });

  it("uses the range diff for the PR body summary in Case A", async () => {
    mockAgentCommitted();
    fakeFetch({ [CREATE_PR]: created(12) }).install();

    await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    // Should use git diff --name-status c0ffee00..HEAD (not git show HEAD)
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["diff", "--name-status", "c0ffee00..HEAD"],
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
      makeContext({ groupingParent: true }),
      { ...BASE_INPUTS, groupingParent: true },
      new NoopStepReporter(),
    );

    expect(outputs.prUrl).toBeNull();
    expect(outputs.prNumber).toBeNull();
    expect(outputs.branchPushed).toBe(false);
    expect(outputs.commitSha).toBeNull();
    expect(unrouted.calls).toEqual([]);
  });

  it("does NOT create a PR (never calls fetch) on a grouping-parent no-op", async () => {
    mockNoChanges();

    await pushStep.run(
      makeContext({ groupingParent: true }),
      { ...BASE_INPUTS, groupingParent: true },
      new NoopStepReporter(),
    );

    expect(unrouted.calls).toEqual([]);
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
    expect(unrouted.calls).toEqual([]);
  });

  it("still throws 'Nothing to commit' for a leaf run with groupingParent=false", async () => {
    mockNoChanges();

    await expect(
      pushStep.run(
        makeContext({ groupingParent: false }),
        { ...BASE_INPUTS, groupingParent: false },
        new NoopStepReporter(),
      ),
    ).rejects.toThrow(/Nothing to commit/);
    expect(unrouted.calls).toEqual([]);
  });

  it("pushes normally when a grouping parent DOES have working-tree changes", async () => {
    // groupingParent=true but the agent left uncommitted changes → standard path
    mockGitSuccess("sha-gp");
    fakeFetch({ [CREATE_PR]: created(13) }).install();

    const outputs = await pushStep.run(
      makeContext({ groupingParent: true }),
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
  });

  it("fails CLOSED when git rev-list errors on a grouping-parent run (never silently no-ops)", async () => {
    // Regression: hasCommitsAheadOfBase used to return false on git error, which would make a
    // grouping-parent run take the Case-B no-op → markMerged → silently discard committed work.
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, ""); // clean working tree
      if (gitArgs[0] === "rev-list") return spawnResult(128, "", "fatal: bad revision 'c0ffee00..HEAD'");
      return spawnResult(0);
    });

    await expect(
      pushStep.run(makeContext({ groupingParent: true }), { ...BASE_INPUTS, groupingParent: true }, new NoopStepReporter()),
    ).rejects.toThrow(/git rev-list .*failed/);
    expect(unrouted.calls).toEqual([]);
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
      if (gitArgs[0] === "diff" && gitArgs.includes("c0ffee00..HEAD")) {
        return spawnResult(0, "src/app.ts\n.env\n"); // full committed diff — secret committed earlier
      }
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "sha\n");
      return spawnResult(0);
    });

    await expect(
      pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter()),
    ).rejects.toThrow(/Push blocked/);
    expect(unrouted.calls).toEqual([]);
  });
});

describe("pushStep — push failure classification and retry (BAC-27116)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    fakeFetch({ [CREATE_PR]: created(50) }).install();

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
    const fake = fakeFetch({ [CREATE_PR]: created(51) }).install();

    const outputs = await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());

    expect(pushCalls).toBe(2);
    // One lease lookup before the first attempt, one remote inspection after the failure.
    expect(lsRemoteCalls).toBe(2);
    expect(outputs.prNumber).toBe(51);
    expect(outputs.pushAttempts).toBe(2);
    expect(fake.calls).toHaveLength(1);
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
    expect(unrouted.calls).toEqual([]);
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

  it("retries a 403 on a freshly minted token, but not on the boot token (AII-922)", async () => {
    const run = async (vend: boolean) => {
      let pushCalls = 0;
      // The machine-nonce path vends again before the retried push; the boot token never vends.
      fakeFetch(vend
        ? { [VEND_TOKEN]: [minted("fresh-tok"), minted("fresher-tok")], [CREATE_PR]: created(7) }
        : {}).install();
      vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
        const gitArgs = args as string[];
        if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
        if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
        if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
        if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
        if (gitArgs[0] === "push") {
          pushCalls++;
          return pushCalls === 1
            ? spawnResult(128, "", "remote: Permission to acme/app.git denied to bot[bot].\nfatal: unable to access: The requested URL returned error: 403")
            : spawnResult(0);
        }
        return spawnResult(0);
      });
      const result = pushStep.run(
        makeContext({
          retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries: 2 },
          ...(vend ? { orchestratorUrl: "https://orchestrator.example", nonce: "n" } : {}),
        }),
        vend ? { ...BASE_INPUTS, orchestratorUrl: "https://orchestrator.example", machineNonce: "n" } : BASE_INPUTS,
        new NoopStepReporter(),
      );
      return { result, pushCalls: () => pushCalls };
    };

    const fresh = await run(true);
    await expect(fresh.result).resolves.toMatchObject({ prNumber: 7 });
    expect(fresh.pushCalls()).toBe(2);

    const boot = await run(false);
    await expect(boot.result).rejects.toThrow(/git push failed/);
    expect(boot.pushCalls()).toBe(1);
  });

  it("keeps the auth classification when a fresh-token 403 survives the final attempt (AII-922)", async () => {
    let pushCalls = 0;
    // One vend before the first push, and one before each of the two retries.
    fakeFetch({ [VEND_TOKEN]: [minted("fresh-tok"), minted("fresher-tok"), minted("freshest-tok")] }).install();
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
      if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
      if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
      if (gitArgs[0] === "ls-remote") return spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
      if (gitArgs[0] === "push") {
        pushCalls++;
        return spawnResult(128, "", "remote: Permission to acme/app.git denied to bot[bot].\nfatal: unable to access: The requested URL returned error: 403");
      }
      return spawnResult(0);
    });
    let caught: (Error & { failure?: { category: string; code: string } }) | undefined;
    try {
      await pushStep.run(
        makeContext({
          retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries: 2 },
          orchestratorUrl: "https://orchestrator.example",
          nonce: "n",
        }),
        { ...BASE_INPUTS, orchestratorUrl: "https://orchestrator.example", machineNonce: "n" },
        new NoopStepReporter(),
      );
    } catch (e) {
      caught = e as typeof caught;
    }
    expect(pushCalls).toBe(3);
    expect(caught?.failure).toMatchObject({ category: "auth", code: "GIT_AUTH" });
  });

  describe("ls-remote retry after a token refresh (AII-936)", () => {
    const NOT_FOUND = "remote: Repository not found.\nfatal: repository 'https://x-access-token:fresh-tok@github.com/acme/app.git/' not found";
    const FRESH_INPUTS = { ...BASE_INPUTS, orchestratorUrl: "https://orchestrator.example", machineNonce: "n" };
    const freshContext = () => makeContext({ orchestratorUrl: "https://orchestrator.example", nonce: "n" });

    const mockLsRemote = (failures: number, stderr = NOT_FOUND) => {
      let calls = 0;
      vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
        const gitArgs = args as string[];
        if (gitArgs[0] === "status") return spawnResult(0, " M src/app.ts\n");
        if (gitArgs[0] === "rev-parse") return spawnResult(0, "abc123\n");
        if (gitArgs[0] === "show") return spawnResult(0, "M\tsrc/app.ts\n");
        if (gitArgs[0] === "ls-remote") {
          calls++;
          return calls <= failures ? spawnResult(128, "", stderr) : spawnResult(0, `beadfeed\t${gitArgs.at(-1)}\n`);
        }
        return spawnResult(0);
      });
      return () => calls;
    };
    const vend = () => fakeFetch({ [VEND_TOKEN]: minted("fresh-tok"), [CREATE_PR]: created(7) }).install();
    const sleeps = () => vi.mocked(sleepAsync).mock.calls.map((c) => c[0]);

    it("continues when ls-remote fails twice then succeeds, logging each failed attempt", async () => {
      vend();
      const calls = mockLsRemote(2);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(pushStep.run(freshContext(), FRESH_INPUTS, new NoopStepReporter())).resolves.toMatchObject({ prNumber: 7 });
        const lines = errSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[push] ls-remote attempt"));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain("attempt 1/5 failed: remote: Repository not found");
        expect(lines.join("\n")).not.toContain("fresh-tok");
        expect(lines.join("\n")).toContain("***");
      } finally {
        errSpy.mockRestore();
      }
      expect(calls()).toBe(3);
      expect(sleeps()).toEqual([1000, 2000]);
    });

    it("throws GIT_AUTH_FRESH_TOKEN after five failed attempts on the 1/2/4/8 s schedule", async () => {
      vend();
      const calls = mockLsRemote(99);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let caught: (Error & { failure?: FailureRecord }) | undefined;
      try {
        await pushStep.run(freshContext(), FRESH_INPUTS, new NoopStepReporter());
      } catch (e) {
        caught = e as typeof caught;
      } finally {
        errSpy.mockRestore();
      }
      expect(calls()).toBe(5);
      expect(sleeps()).toEqual([1000, 2000, 4000, 8000]);
      expect(caught?.message).toMatch(/git ls-remote failed after 5 attempts/);
      expect(caught?.message).not.toContain("fresh-tok");
      expect(caught?.failure).toMatchObject({
        category: "transient",
        code: "GIT_AUTH_FRESH_TOKEN",
        stage: "push",
        retryable: false,
      });
    });

    it("keeps the classifier's record for a non-auth failure after a refresh", async () => {
      vend();
      mockLsRemote(99, "fatal: unable to access: Could not resolve host: github.com");
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let caught: (Error & { failure?: FailureRecord }) | undefined;
      try {
        await pushStep.run(freshContext(), FRESH_INPUTS, new NoopStepReporter());
      } catch (e) {
        caught = e as typeof caught;
      } finally {
        errSpy.mockRestore();
      }
      expect(caught?.failure?.code).toBe("GIT_REMOTE_TRANSIENT");
    });

    it("keeps the short schedule and the unclassified error on the boot token", async () => {
      const calls = mockLsRemote(99);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let caught: (Error & { failure?: FailureRecord }) | undefined;
      try {
        await pushStep.run(makeContext(), BASE_INPUTS, new NoopStepReporter());
      } catch (e) {
        caught = e as typeof caught;
      } finally {
        errSpy.mockRestore();
      }
      expect(calls()).toBe(3);
      expect(sleeps()).toEqual([250, 1000]);
      expect(caught?.message).toMatch(/git ls-remote failed after 3 attempts/);
      expect(caught?.failure).toBeUndefined();
    });
  });

  it("logs the credential source of the push and never the token (AII-922)", async () => {
    type Credentials = { orchestratorUrl?: string; machineNonce?: string; callbackUrl?: string };
    const run = async (label: string, inputs: Credentials, vend: Routes, env?: string) => {
      if (env) vi.stubEnv("RUN_PUBLICATION_TOKEN", env);
      fakeFetch({ ...vend, [CREATE_PR]: created(7) }).install();
      mockGitSuccess();
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      // The context carries what the pipeline copies into these inputs.
      const ctx = makeContext({ orchestratorUrl: inputs.orchestratorUrl ?? "", nonce: inputs.machineNonce ?? "", callbackUrl: inputs.callbackUrl });
      try {
        await pushStep.run(ctx, { ...BASE_INPUTS, ...inputs }, new NoopStepReporter());
        return log.mock.calls.map((c) => c.join(" ")).join("\n");
      } finally {
        log.mockRestore();
        vi.unstubAllEnvs();
        void label;
      }
    };
    const nonce = await run("nonce", { orchestratorUrl: "https://orchestrator.example", machineNonce: "n" }, { [VEND_TOKEN]: minted("nonce-minted-secret") });
    expect(nonce).toContain("[push] credential source: machine-nonce");
    expect(nonce).not.toContain("nonce-minted-secret");

    const pub = await run("pub", { callbackUrl: "https://orchestrator.example" }, { [PUBLICATION_TOKEN]: minted("pub-minted-secret") }, "one-use-publication-token");
    expect(pub).toContain("[push] credential source: publication-token");
    expect(pub).not.toContain("pub-minted-secret");
    expect(pub).not.toContain("one-use-publication-token");

    const refused = () => {
      throw new Error("connection refused");
    };
    const boot = await run("boot", { orchestratorUrl: "https://orchestrator.example", machineNonce: "n" }, { [VEND_TOKEN]: refused });
    expect(boot).toContain("[push] credential source: boot-token");
    expect(boot).not.toContain("gh-token");
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
    const fake = fakeFetch({ [PUBLICATION_TOKEN]: minted("fresh-token") }).install();

    const outputs = await pushStep.run(
      makeContext({ callbackUrl: "https://orchestrator.example", ...GAP_FILL_CONTEXT }),
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
    expect(fake.calls).toHaveLength(1);
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
          "! [rejected] ai-implement/eng-42-test -> ai-implement/eng-42-test (stale info)",
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
          "! [rejected] ai-implement/eng-42-test -> ai-implement/eng-42-test (stale info)",
        );
      }
      return spawnResult(0);
    });
    fakeFetch({ [CREATE_PR]: created(70) }).install();

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
    fakeFetch({ [CREATE_PR]: created(71) }).install();

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
          "! [rejected] ai-implement/eng-42-test -> ai-implement/eng-42-test (stale info)",
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
    expect(unrouted.calls).toEqual([]);
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
    expect(caught?.failure?.message).toContain("Remote ai-implement/eng-42-test advanced past the lease SHA during this attempt.");
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
          "! [rejected] ai-implement/eng-42-test -> ai-implement/eng-42-test (stale info)",
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
    fakeFetch({ [VEND_TOKEN]: [minted("fresh-token"), minted("fresher-token")], [CREATE_PR]: created(71) }).install();

    const outputs = await pushStep.run(
      makeContext({ orchestratorUrl: "https://orchestrator.example", nonce: "machine-nonce" }),
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
    fakeFetch({ [VEND_TOKEN]: minted("fresh-token") }).install();

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext({ orchestratorUrl: "https://orchestrator.example", nonce: "machine-nonce" }),
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
    fakeFetch({ [VEND_TOKEN]: [minted("fresh-token"), minted("fresher-token")] }).install();

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext({
          orchestratorUrl: "https://orchestrator.example",
          nonce: "machine-nonce",
          retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries:1 },
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
    fakeFetch({ [VEND_TOKEN]: [minted("fresh-token"), minted("fresher-token"), minted("freshest-token")] }).install();

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext({
          orchestratorUrl: "https://orchestrator.example",
          nonce: "machine-nonce",
          retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries:2 },
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
    // One vend before the first push and one before each of the ten retries, each minting a new token.
    fakeFetch({ [VEND_TOKEN]: Array.from({ length: 11 }, (_, i) => minted(`fresh-token-${i + 1}`)) }).install();

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext({
          orchestratorUrl: "https://orchestrator.example",
          nonce: "machine-nonce",
          retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries:10 },
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
    // One vend before the first push and one before each of the ten retries, each minting a new token.
    fakeFetch({ [VEND_TOKEN]: Array.from({ length: 11 }, (_, i) => minted(`fresh-token-${i + 1}`)) }).install();

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(
        makeContext({
          orchestratorUrl: "https://orchestrator.example",
          nonce: "machine-nonce",
          retryPolicy: { ...DEFAULT_RETRY_POLICY, pushRetries:10 },
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
    fakeFetch({ [CREATE_PR]: created(60) }).install();

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
    fakeFetch({ [CREATE_PR]: created(61) }).install();

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
    fakeFetch({ [CREATE_PR]: created(62) }).install();

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
    fakeFetch({ [CREATE_PR]: created(63) }).install();

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
    fakeFetch({ [CREATE_PR]: created(64) }).install();

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
    fakeFetch({ [CREATE_PR]: created(65) }).install();

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
    fakeFetch({
      [PUBLICATION_TOKEN]: [
        // Same token as BASE_INPUTS.githubToken ("gh-token"): the single-use
        // publication credential is only cleared when the vended token differs
        // from the current one, so it stays available for the mid-retry call below.
        minted("gh-token"),
        // A non-retryable rejection, as the orchestrator answers a credential it already consumed:
        // the fail-closed publication exchange throws immediately, before ever writing process.env.GITHUB_TOKEN.
        { status: 403, json: { error: "Unauthorized" } },
      ],
    }).install();

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
    expect(unrouted.calls).toEqual([]);
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
    fakeFetch({ [PUBLICATION_TOKEN]: minted("fresh-token") }).install();
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-publication-token");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const outputs = await pushStep.run(
      makeContext({ callbackUrl: "https://orchestrator.example", ...GAP_FILL_CONTEXT }),
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
    fakeFetch({ [PUBLICATION_TOKEN]: minted("fresh-token") }).install();
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-publication-token");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await pushStep.run(
      makeContext({ callbackUrl: "https://orchestrator.example", ...GAP_FILL_CONTEXT }),
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

    let caught: (Error & { failure?: FailureRecord }) | undefined;
    try {
      await pushStep.run(makeContext(GAP_FILL_CONTEXT), GAP_FILL_INPUTS, new NoopStepReporter());
    } catch (err) {
      caught = err as typeof caught;
    }

    expect(caught?.message).toMatch(/refusing to overwrite concurrent work/);
    // AII-749: classified so the failure callback can decide whether to
    // re-enqueue (bot moved the branch) or notify a human, instead of the
    // refusal just being an unclassified plain Error.
    expect(caught?.failure?.category).toBe("conflict");
    expect(caught?.failure?.code).toBe("GIT_LEASE_REJECTED");
    expect(caught?.failure?.retryable).toBe(false);
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
    fakeFetch({ [PUBLICATION_TOKEN]: minted("fresh-token") }).install();
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-publication-token");

    const result = await pushStep.run(
      makeContext({ callbackUrl: "https://orchestrator.example", ...GAP_FILL_CONTEXT }),
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
    fakeFetch({ [PUBLICATION_TOKEN]: minted("fresh-token") }).install();
    vi.stubEnv("RUN_PUBLICATION_TOKEN", "one-use-publication-token");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await pushStep.run(
      makeContext({ callbackUrl: "https://orchestrator.example", ...GAP_FILL_CONTEXT }),
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
