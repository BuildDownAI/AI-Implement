import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dispatchWorkflow, providerDispatchFields, getBranchSha, fetchRepoTarball, ensureBranchExists, capDispatchFields, capRunnerEnv, branchPrefixDispatchFields, branchPrefixRunnerEnv, skillsRepoDispatchFields, skillsRepoRunnerEnv, profilesDispatchFields, profilesRunnerEnv, buildEnvelopeDispatchInputs, cancelWorkflowRun, getPullRequestState, deleteBranch, findPullRequestByBranches, mergePullRequest, getCombinedChecksState, parseLinkNext, listRepoBranchesAndTags } from "../github.js";
import { decodeRunConfig } from "../run-config.js";
import type { RepoMapping } from "../config.js";

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    owner: "test-org",
    repo: "test-repo",
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: false,
    planningWorkflowFile: "",
    autoApprovePlans: true,
    extraEnv: {},
    provider: "anthropic",
    ticketingProvider: "linear",
    ticketingConfig: { kind: "linear" },
    awsRegion: null,
    paused: false,
    maxTurns: null,
    maxIterations: null,
    maxJobMinutes: null,
    branchPrefix: null,
    skillsRepo: null,
    autoMerge: false,
    ...overrides,
  };
}

const mockMapping: RepoMapping = makeMapping();

const mockInputs = {
  issue_id: "id-123",
  issue_identifier: "TEST-1",
  issue_title: "Test issue",
  issue_description: "A test issue",
};

describe("dispatchWorkflow", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns success on 204 response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 204, ok: true } as Response);

    const result = await dispatchWorkflow("gh-token", mockMapping, mockInputs);
    expect(result).toEqual({ success: true, status: 204 });

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/test-org/test-repo/actions/workflows/claude-implement.yml/dispatches");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.ref).toBe("main");
    expect(body.inputs.issue_identifier).toBe("TEST-1");
    expect(body.inputs.issue_id).toBe("id-123");
  });

  it("returns success on 200 response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 200, ok: true } as Response);
    const result = await dispatchWorkflow("gh-token", mockMapping, mockInputs);
    expect(result).toEqual({ success: true, status: 200 });
  });

  it("returns failure with error body on non-success status", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 422,
      ok: false,
      text: async () => "Unprocessable Entity",
    } as Response);

    const result = await dispatchWorkflow("gh-token", mockMapping, mockInputs);
    expect(result.success).toBe(false);
    expect(result.status).toBe(422);
    expect(result.error).toBe("Unprocessable Entity");
  });

  it("sends correct auth header", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 204, ok: true } as Response);
    await dispatchWorkflow("my-token", mockMapping, mockInputs);
    const opts = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-token");
  });

  it("does not include provider or aws_region in inputs for anthropic mappings", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 204, ok: true } as Response);
    await dispatchWorkflow("gh-token", mockMapping, {
      ...mockInputs,
      ...providerDispatchFields(mockMapping),
    });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.inputs.provider).toBeUndefined();
    expect(body.inputs.aws_region).toBeUndefined();
  });

  it("forwards runner_image when present in inputs", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 204, ok: true } as Response);
    await dispatchWorkflow("gh-token", mockMapping, {
      ...mockInputs,
      runner_image: "ghcr.io/builddownai/ai-implement-runner:next",
    });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.inputs.runner_image).toBe("ghcr.io/builddownai/ai-implement-runner:next");
  });

  it("omits runner_image when not provided", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 204, ok: true } as Response);
    await dispatchWorkflow("gh-token", mockMapping, mockInputs);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.inputs.runner_image).toBeUndefined();
  });

  it("forwards provider and aws_region in inputs for bedrock mappings", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 204, ok: true } as Response);
    const bedrockMapping = makeMapping({ provider: "bedrock", awsRegion: "us-west-2" });
    await dispatchWorkflow("gh-token", bedrockMapping, {
      ...mockInputs,
      ...providerDispatchFields(bedrockMapping),
    });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.inputs.provider).toBe("bedrock");
    expect(body.inputs.aws_region).toBe("us-west-2");
  });

  it("forwards base_branch in inputs while ref stays the workflow default branch", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 204, ok: true } as Response);
    await dispatchWorkflow("gh-token", mockMapping, {
      ...mockInputs,
      base_branch: "ai-implement/feature/eng-1",
    });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.ref).toBe("main");
    expect(body.inputs.base_branch).toBe("ai-implement/feature/eng-1");
  });

  it("omits base_branch from inputs when it is not provided (non-grouped path)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 204, ok: true } as Response);
    await dispatchWorkflow("gh-token", mockMapping, mockInputs);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect("base_branch" in body.inputs).toBe(false);
  });
});

describe("ensureBranchExists", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  function refResponse(sha: string) {
    return { ok: true, status: 200, json: async () => ({ object: { sha } }) } as Response;
  }
  const notFound = { ok: false, status: 404 } as Response;

  it("returns the SHA when a branch exists and null on 404 (getBranchSha)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(refResponse("abc123"));
    expect(await getBranchSha("t", "o", "r", "feat")).toBe("abc123");

    vi.mocked(fetch).mockResolvedValueOnce(notFound);
    expect(await getBranchSha("t", "o", "r", "missing")).toBeNull();
  });

  it("preserves slash separators in the ref path for multi-segment branch names", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(refResponse("abc123"));
    await getBranchSha("t", "o", "r", "ai-implement/feature/ool-78");
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toBe("https://api.github.com/repos/o/r/git/ref/heads/ai-implement/feature/ool-78");
    expect(url).not.toContain("%2F");
  });

  it("throws on a 422 that is not an 'already exists' race", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce(refResponse("base-sha"))
      .mockResolvedValueOnce({ ok: false, status: 422, text: async () => "Validation Failed: sha is not a commit" } as Response);

    await expect(ensureBranchExists("t", "o", "r", "feat", "testing")).rejects.toThrow(/HTTP 422/);
  });

  it("creates the branch from the base head when it does not exist", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(notFound)              // target branch missing
      .mockResolvedValueOnce(refResponse("base-sha")) // base branch head
      .mockResolvedValueOnce({ ok: true, status: 201 } as Response); // create ref

    await ensureBranchExists("t", "o", "r", "ai-implement/feature/eng-1", "testing");

    const createCall = vi.mocked(fetch).mock.calls[2];
    expect(createCall[0]).toBe("https://api.github.com/repos/o/r/git/refs");
    const body = JSON.parse((createCall[1] as RequestInit).body as string);
    expect(body).toEqual({ ref: "refs/heads/ai-implement/feature/eng-1", sha: "base-sha" });
  });

  it("is a no-op when the branch already exists", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(refResponse("already-here"));
    await ensureBranchExists("t", "o", "r", "feat", "testing");
    expect(vi.mocked(fetch).mock.calls.length).toBe(1); // only the existence check
  });

  it("tolerates a 422 create race as success", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(notFound)
      .mockResolvedValueOnce(refResponse("base-sha"))
      .mockResolvedValueOnce({ ok: false, status: 422, text: async () => "Reference already exists" } as Response);

    await expect(ensureBranchExists("t", "o", "r", "feat", "testing")).resolves.toBeUndefined();
  });
});

describe("providerDispatchFields", () => {
  it("returns empty object for anthropic mappings", () => {
    expect(providerDispatchFields(makeMapping({ provider: "anthropic" }))).toEqual({});
  });

  it("returns provider and aws_region for bedrock mappings", () => {
    expect(
      providerDispatchFields(makeMapping({ provider: "bedrock", awsRegion: "eu-central-1" })),
    ).toEqual({ provider: "bedrock", aws_region: "eu-central-1" });
  });

  it("omits aws_region when bedrock mapping has no region set (orchestrator guard handles that case)", () => {
    expect(
      providerDispatchFields(makeMapping({ provider: "bedrock", awsRegion: null })),
    ).toEqual({ provider: "bedrock" });
  });
});

describe("capDispatchFields", () => {
  it("returns empty object when no caps are set", () => {
    expect(capDispatchFields(makeMapping({}))).toEqual({});
  });

  it("includes only the caps that are set, as strings", () => {
    expect(
      capDispatchFields(makeMapping({ maxTurns: 40, maxIterations: 2, maxJobMinutes: 30 })),
    ).toEqual({ max_turns: "40", max_iterations: "2", job_timeout_minutes: "30" });
  });

  it("omits caps left null", () => {
    expect(capDispatchFields(makeMapping({ maxTurns: 40 }))).toEqual({ max_turns: "40" });
  });
});

describe("capRunnerEnv", () => {
  it("returns empty object when no caps are set", () => {
    expect(capRunnerEnv(makeMapping({}))).toEqual({});
  });

  it("includes turn/iteration caps as env vars (strings) when set", () => {
    expect(capRunnerEnv(makeMapping({ maxTurns: 40, maxIterations: 2 }))).toEqual({
      AI_IMPLEMENT_MAX_TURNS: "40",
      AI_IMPLEMENT_MAX_ITERATIONS: "2",
    });
  });

  it("omits job timeout (GHA-only, not a runner env var)", () => {
    expect(capRunnerEnv(makeMapping({ maxTurns: 40, maxJobMinutes: 30 }))).toEqual({
      AI_IMPLEMENT_MAX_TURNS: "40",
    });
  });

  it("omits caps left null", () => {
    expect(capRunnerEnv(makeMapping({ maxIterations: 3 }))).toEqual({
      AI_IMPLEMENT_MAX_ITERATIONS: "3",
    });
  });
});

describe("cancelWorkflowRun", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns true on 202 Accepted", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 202, ok: true } as Response);
    const result = await cancelWorkflowRun("token", "owner", "repo", 42);
    expect(result).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/actions/runs/42/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns true on 409 (run not in a cancellable state)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 409, ok: false } as Response);
    const result = await cancelWorkflowRun("token", "owner", "repo", 99);
    expect(result).toBe(true);
  });

  it("returns false on other non-OK statuses", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 500, ok: false } as Response);
    const result = await cancelWorkflowRun("token", "owner", "repo", 7);
    expect(result).toBe(false);
  });

  it("returns false on 404 without throwing", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 404, ok: false } as Response);
    await expect(cancelWorkflowRun("token", "owner", "repo", 1)).resolves.toBe(false);
  });
});

describe("getPullRequestState", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("returns merged=true for a merged PR", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ merged: true, state: "closed" }) })));
    expect(await getPullRequestState("t", "o", "r", 7)).toEqual({ merged: true, state: "closed" });
  });
  it("returns merged=false for a closed-unmerged PR", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ merged: false, state: "closed" }) })));
    expect(await getPullRequestState("t", "o", "r", 7)).toEqual({ merged: false, state: "closed" });
  });
  it("returns null on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    expect(await getPullRequestState("t", "o", "r", 7)).toBeNull();
  });
});

describe("branchPrefixDispatchFields", () => {
  it("returns empty object when no prefix is set", () => {
    expect(branchPrefixDispatchFields(makeMapping({}))).toEqual({});
    expect(branchPrefixDispatchFields(makeMapping({ branchPrefix: null }))).toEqual({});
  });

  it("includes branch_prefix when set", () => {
    expect(branchPrefixDispatchFields(makeMapping({ branchPrefix: "pr" }))).toEqual({
      branch_prefix: "pr",
    });
  });
});

describe("branchPrefixRunnerEnv", () => {
  it("returns empty object when no prefix is set", () => {
    expect(branchPrefixRunnerEnv(makeMapping({}))).toEqual({});
  });

  it("includes AI_IMPLEMENT_BRANCH_PREFIX when set", () => {
    expect(branchPrefixRunnerEnv(makeMapping({ branchPrefix: "pr" }))).toEqual({
      AI_IMPLEMENT_BRANCH_PREFIX: "pr",
    });
  });
});

describe("skillsRepoDispatchFields", () => {
  it("returns empty object when no skills repo is set", () => {
    expect(skillsRepoDispatchFields(makeMapping({}))).toEqual({});
    expect(skillsRepoDispatchFields(makeMapping({ skillsRepo: null }))).toEqual({});
  });

  it("includes skills_repo when set", () => {
    expect(skillsRepoDispatchFields(makeMapping({ skillsRepo: "org/skills" }))).toEqual({
      skills_repo: "org/skills",
    });
  });
});

describe("skillsRepoRunnerEnv", () => {
  it("returns empty object when no skills repo is set", () => {
    expect(skillsRepoRunnerEnv(makeMapping({}))).toEqual({});
  });

  it("includes AI_IMPLEMENT_SKILLS_REPO when set", () => {
    expect(skillsRepoRunnerEnv(makeMapping({ skillsRepo: "org/skills" }))).toEqual({
      AI_IMPLEMENT_SKILLS_REPO: "org/skills",
    });
  });
});

describe("profilesDispatchFields", () => {
  it("returns empty object when the issue has no profiles", () => {
    expect(profilesDispatchFields({})).toEqual({});
    expect(profilesDispatchFields({ profiles: undefined })).toEqual({});
    expect(profilesDispatchFields({ profiles: [] })).toEqual({});
  });

  it("comma-joins profiles when present", () => {
    expect(profilesDispatchFields({ profiles: ["backend"] })).toEqual({ profiles: "backend" });
    expect(profilesDispatchFields({ profiles: ["backend", "webapp"] })).toEqual({
      profiles: "backend,webapp",
    });
  });
});

describe("profilesRunnerEnv", () => {
  it("returns empty object when the issue has no profiles", () => {
    expect(profilesRunnerEnv({})).toEqual({});
    expect(profilesRunnerEnv({ profiles: [] })).toEqual({});
  });

  it("includes AI_IMPLEMENT_PROFILES when profiles are present", () => {
    expect(profilesRunnerEnv({ profiles: ["backend", "webapp"] })).toEqual({
      AI_IMPLEMENT_PROFILES: "backend,webapp",
    });
  });
});

describe("buildEnvelopeDispatchInputs", () => {
  const baseIssue = { id: "uuid-1", identifier: "AII-1", title: "T", description: "D" };

  it("carries profiles in run_config when non-empty", () => {
    const inputs = buildEnvelopeDispatchInputs(mockMapping, { ...baseIssue, profiles: ["backend", "webapp"] }, { runnerPhase: "implementation" });
    const cfg = decodeRunConfig(inputs.run_config as string);
    expect(cfg.profiles).toEqual(["backend", "webapp"]);
  });

  it("omits profiles from run_config when absent or empty", () => {
    const noProfiles = buildEnvelopeDispatchInputs(mockMapping, baseIssue, { runnerPhase: "implementation" });
    expect(decodeRunConfig(noProfiles.run_config as string).profiles).toBeUndefined();

    const emptyProfiles = buildEnvelopeDispatchInputs(mockMapping, { ...baseIssue, profiles: [] }, { runnerPhase: "implementation" });
    expect(decodeRunConfig(emptyProfiles.run_config as string).profiles).toBeUndefined();
  });

  it("carries planningContext in run_config when provided", () => {
    const ctx = { parent: "- AII-0: parent", siblings: "None", dependencies: "None" };
    const inputs = buildEnvelopeDispatchInputs(mockMapping, baseIssue, {
      runnerPhase: "planning",
      planningContext: ctx,
    });
    const cfg = decodeRunConfig(inputs.run_config as string);
    expect(cfg.planningContext).toEqual(ctx);
  });

  it("omits planningContext from run_config when not provided", () => {
    const inputs = buildEnvelopeDispatchInputs(mockMapping, baseIssue, { runnerPhase: "planning" });
    expect(decodeRunConfig(inputs.run_config as string).planningContext).toBeUndefined();
  });

  it("implementation dispatch carries profiles but no planningContext", () => {
    const inputs = buildEnvelopeDispatchInputs(mockMapping, { ...baseIssue, profiles: ["backend"] }, { runnerPhase: "implementation" });
    const cfg = decodeRunConfig(inputs.run_config as string);
    expect(cfg.profiles).toEqual(["backend"]);
    expect(cfg.planningContext).toBeUndefined();
  });

  it("planning dispatch with context but no profiles", () => {
    const ctx = { parent: "- AII-0: parent", siblings: "None", dependencies: "None" };
    const inputs = buildEnvelopeDispatchInputs(mockMapping, baseIssue, { runnerPhase: "planning", planningContext: ctx });
    const cfg = decodeRunConfig(inputs.run_config as string);
    expect(cfg.profiles).toBeUndefined();
    expect(cfg.planningContext).toEqual(ctx);
  });
});

describe("deleteBranch", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns true on 204 No Content", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 204, ok: true } as Response);
    expect(await deleteBranch("tok", "owner", "repo", "ai-implement/feature/foo-1")).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/git/refs/heads/ai-implement/feature/foo-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("returns true on 404 (idempotent — branch already deleted)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ status: 404, ok: false } as Response);
    expect(await deleteBranch("tok", "owner", "repo", "ai-implement/feature/foo-1")).toBe(true);
  });

  it('returns true on 422 "Reference does not exist" (the git-refs API reports a missing ref as 422, not 404)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 422,
      ok: false,
      text: async () =>
        '{"message":"Reference does not exist","documentation_url":"https://docs.github.com/rest/git/refs#delete-a-reference","status":"422"}',
    } as unknown as Response);
    expect(await deleteBranch("tok", "owner", "repo", "ai-implement/feature/foo-1")).toBe(true);
  });

  it("throws on a 422 that is not a missing ref (e.g. protected branch)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 422,
      ok: false,
      text: async () => '{"message":"Refusing to delete the default branch"}',
    } as unknown as Response);
    await expect(deleteBranch("tok", "owner", "repo", "ai-implement/feature/foo-1")).rejects.toThrow();
  });

  it("throws on other non-success statuses", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 403,
      ok: false,
      text: async () => "Forbidden",
    } as unknown as Response);
    await expect(deleteBranch("tok", "owner", "repo", "ai-implement/feature/foo-1")).rejects.toThrow();
  });
});

describe("findPullRequestByBranches", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns merged PR when merged_at is set", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => [{ number: 5, html_url: "https://gh/pr/5", state: "closed", merged_at: "2026-06-30T12:00:00Z" }],
    })));
    expect(await findPullRequestByBranches("tok", "owner", "repo", "head-branch", "base-branch")).toEqual({
      number: 5, url: "https://gh/pr/5", state: "closed", merged: true,
    });
  });

  it("returns open PR with merged=false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => [{ number: 3, html_url: "https://gh/pr/3", state: "open", merged_at: null }],
    })));
    expect(await findPullRequestByBranches("tok", "owner", "repo", "h", "b")).toEqual({
      number: 3, url: "https://gh/pr/3", state: "open", merged: false,
    });
  });

  it("returns closed-unmerged PR with merged=false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => [{ number: 2, html_url: "https://gh/pr/2", state: "closed", merged_at: null }],
    })));
    expect(await findPullRequestByBranches("tok", "owner", "repo", "h", "b")).toEqual({
      number: 2, url: "https://gh/pr/2", state: "closed", merged: false,
    });
  });

  it("returns null when the PR list is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] })));
    expect(await findPullRequestByBranches("tok", "owner", "repo", "h", "b")).toBeNull();
  });

  it("prefers a merged PR when multiple results are returned", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => [
        { number: 9, html_url: "https://gh/pr/9", state: "closed", merged_at: null },
        { number: 8, html_url: "https://gh/pr/8", state: "closed", merged_at: "2026-06-30T12:00:00Z" },
      ],
    })));
    const result = await findPullRequestByBranches("tok", "owner", "repo", "h", "b");
    expect(result).toMatchObject({ number: 8, merged: true });
  });

  it("prefers an open PR over a newer closed-unmerged one (reopened PRs keep their created date)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => [
        { number: 12, html_url: "https://gh/pr/12", state: "closed", merged_at: null, updated_at: "2026-07-02T09:00:00Z" },
        { number: 7, html_url: "https://gh/pr/7", state: "open", merged_at: null, updated_at: "2026-07-01T08:00:00Z" },
      ],
    })));
    expect(await findPullRequestByBranches("tok", "owner", "repo", "h", "b")).toEqual({
      number: 7, url: "https://gh/pr/7", state: "open", merged: false,
    });
  });

  it("prefers a merged PR over an open one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => [
        { number: 12, html_url: "https://gh/pr/12", state: "open", merged_at: null, updated_at: "2026-07-02T09:00:00Z" },
        { number: 7, html_url: "https://gh/pr/7", state: "closed", merged_at: "2026-06-30T12:00:00Z", updated_at: "2026-06-30T12:00:00Z" },
      ],
    })));
    expect(await findPullRequestByBranches("tok", "owner", "repo", "h", "b")).toEqual({
      number: 7, url: "https://gh/pr/7", state: "closed", merged: true,
    });
  });

  it("picks the most recently updated PR when all are closed-unmerged, regardless of list order", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => [
        { number: 4, html_url: "https://gh/pr/4", state: "closed", merged_at: null, updated_at: "2026-06-20T10:00:00Z" },
        { number: 2, html_url: "https://gh/pr/2", state: "closed", merged_at: null, updated_at: "2026-07-05T10:00:00Z" },
        { number: 3, html_url: "https://gh/pr/3", state: "closed", merged_at: null, updated_at: "2026-06-28T10:00:00Z" },
      ],
    })));
    expect(await findPullRequestByBranches("tok", "owner", "repo", "h", "b")).toEqual({
      number: 2, url: "https://gh/pr/2", state: "closed", merged: false,
    });
  });

  it("requests the list sorted by updated desc so the per_page window holds recently active PRs", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [] }));
    vi.stubGlobal("fetch", fetchMock);
    await findPullRequestByBranches("tok", "owner", "repo", "h", "b");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("state=all&sort=updated&direction=desc&per_page=10"),
      expect.anything(),
    );
  });

  it("returns null on non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    expect(await findPullRequestByBranches("tok", "owner", "repo", "h", "b")).toBeNull();
  });
});

describe("mergePullRequest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns "merged" on HTTP 200', async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ok: true })));
    expect(await mergePullRequest("tok", "owner", "repo", 5, "sha5", "merge")).toBe("merged");
  });

  it('returns "blocked" on HTTP 405', async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 405, ok: false })));
    expect(await mergePullRequest("tok", "owner", "repo", 5, "sha5", "merge")).toBe("blocked");
  });

  it('returns "conflict" on HTTP 409', async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 409, ok: false })));
    expect(await mergePullRequest("tok", "owner", "repo", 5, "sha5", "merge")).toBe("conflict");
  });
});

describe("getCombinedChecksState", () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns "success" when there are zero check-runs and zero commit statuses', async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ check_runs: [], state: "success", total_count: 0 }),
    })));
    expect(await getCombinedChecksState("tok", "owner", "repo", "abc")).toBe("success");
  });

  it('returns "pending" when a check-run is in_progress', async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ check_runs: [{ status: "in_progress", conclusion: null }] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ state: "success", total_count: 0 }) }),
    );
    expect(await getCombinedChecksState("tok", "owner", "repo", "abc")).toBe("pending");
  });

  it('returns "failure" when a completed check-run has conclusion "failure"', async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ check_runs: [{ status: "completed", conclusion: "failure" }] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ state: "success", total_count: 0 }) }),
    );
    expect(await getCombinedChecksState("tok", "owner", "repo", "abc")).toBe("failure");
  });
});

describe("fetchRepoTarball", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  const tarball = (bytes: number[]) =>
    ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer }) as Response;

  it("requests the tarball endpoint at the exact ref", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(tarball([1, 2, 3]));
    await fetchRepoTarball("tok", "Owner", "Repo", "abc123");

    // A wrong path here surfaces only as a 404 at deploy time, when the orchestrator
    // is mid-deploy and least able to explain itself.
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "https://api.github.com/repos/Owner/Repo/tarball/abc123",
    );
  });

  it("sends the bearer token — the source repository may be private", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(tarball([1]));
    await fetchRepoTarball("tok", "Owner", "Repo", "abc123");

    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("returns the bytes as a Buffer", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(tarball([31, 139, 8]));
    const out = await fetchRepoTarball("tok", "Owner", "Repo", "abc123");
    expect(Buffer.isBuffer(out)).toBe(true);
    expect([...out]).toEqual([31, 139, 8]);
  });

  it("throws on a non-ok response rather than returning an empty context", async () => {
    // Returning empty bytes would extract to an empty build context and fail much later.
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    await expect(fetchRepoTarball("tok", "Owner", "Repo", "nope")).rejects.toThrow(/HTTP 404/);
  });
});

describe("parseLinkNext", () => {
  it("returns null for a null header", () => {
    expect(parseLinkNext(null)).toBeNull();
  });

  it("returns null when only rel='prev' is present", () => {
    expect(parseLinkNext('<https://api.github.com/repos/o/r/branches?page=1>; rel="prev"')).toBeNull();
  });

  it("returns the URL for a header containing rel='next'", () => {
    const header = '<https://api.github.com/repos/o/r/branches?page=2>; rel="next"';
    expect(parseLinkNext(header)).toBe("https://api.github.com/repos/o/r/branches?page=2");
  });

  it("extracts rel='next' when the header contains multiple relations", () => {
    const header =
      '<https://api.github.com/repos/o/r/branches?page=1>; rel="prev", ' +
      '<https://api.github.com/repos/o/r/branches?page=3>; rel="next"';
    expect(parseLinkNext(header)).toBe("https://api.github.com/repos/o/r/branches?page=3");
  });
});

describe("listRepoBranchesAndTags pagination", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function makePage(names: string[], nextUrl: string | null): Response {
    const link = nextUrl ? `<${nextUrl}>; rel="next"` : null;
    return {
      ok: true,
      json: async () => names.map((name) => ({ name })),
      headers: { get: (h: string) => (h === "link" ? link : null) },
    } as unknown as Response;
  }

  it("follows Link rel=next and accumulates all branches across pages", async () => {
    const page1Names = Array.from({ length: 100 }, (_, i) => `branch-${String(i).padStart(3, "0")}`);
    const page2Names = Array.from({ length: 22 }, (_, i) => `branch-${String(i + 100).padStart(3, "0")}`);

    // branches and tags start in parallel, so call order is: branches-page1, tags-page1, branches-page2
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(
          makePage(page1Names, "https://api.github.com/repos/o/r/branches?page=2"),
        )
        // tags: single page, no next (starts concurrently with branches)
        .mockResolvedValueOnce(makePage([], null))
        // branches page 2
        .mockResolvedValueOnce(makePage(page2Names, null)),
    );

    const result = await listRepoBranchesAndTags("tok", "o", "r");
    expect(result.branches).toHaveLength(122);
    expect(result.branches[0]).toBe("branch-000");
    expect(result.branches[99]).toBe("branch-099");
    expect(result.branches[121]).toBe("branch-121");
  });

  it("returns a single page of results when there is no Link header", async () => {
    const names = ["main", "dev"];
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(makePage(names, null))
        .mockResolvedValueOnce(makePage(["v1.0"], null)),
    );

    const result = await listRepoBranchesAndTags("tok", "o", "r");
    expect(result.branches).toEqual(["main", "dev"]);
    expect(result.tags).toEqual(["v1.0"]);
  });
});
