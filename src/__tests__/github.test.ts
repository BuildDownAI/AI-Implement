import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dispatchWorkflow, providerDispatchFields } from "../github.js";
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
    awsRegion: null,
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
