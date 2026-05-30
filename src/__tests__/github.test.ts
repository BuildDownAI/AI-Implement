import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dispatchWorkflow, providerDispatchFields, getBranchSha, ensureBranchExists } from "../github.js";
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
