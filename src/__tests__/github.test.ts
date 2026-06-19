import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dispatchWorkflow, providerDispatchFields, getBranchSha, ensureBranchExists, capDispatchFields, capRunnerEnv, branchPrefixDispatchFields, branchPrefixRunnerEnv, cancelWorkflowRun, getPullRequestState } from "../github.js";
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
