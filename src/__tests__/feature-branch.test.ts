import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveBaseBranch } from "../feature-branch.js";
import type { RepoMapping } from "../config.js";
import type { TicketIssue } from "../providers/types.js";

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    owner: "acme",
    repo: "widget",
    workflowFile: "claude-implement.yml",
    defaultBranch: "testing",
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

function makeIssue(featureBranchChain?: string[]): TicketIssue {
  return {
    id: "child-uuid",
    identifier: "OOL-87",
    title: "Child work",
    description: null,
    scopeKey: "OOL",
    nativeStatus: "Todo (unstarted)",
    ...(featureBranchChain ? { featureBranchChain } : {}),
  };
}

describe("resolveBaseBranch", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns the feature branch and ensures it from defaultBranch for a single-entry chain", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)                               // feature branch missing
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ object: { sha: "base-sha" } }) } as Response) // base head
      .mockResolvedValueOnce({ ok: true, status: 201 } as Response);                                // create ref

    const base = await resolveBaseBranch({ ghToken: "t", issue: makeIssue(["ai-implement/feature/ool-78"]), mapping: makeMapping() });

    expect(base).toBe("ai-implement/feature/ool-78");
    const createBody = JSON.parse((vi.mocked(fetch).mock.calls[2][1] as RequestInit).body as string);
    expect(createBody).toEqual({ ref: "refs/heads/ai-implement/feature/ool-78", sha: "base-sha" });
  });

  it("cascades a multi-entry chain: each branch cut from the previous one", async () => {
    vi.mocked(fetch)
      // ensure ai-implement/feature/ool-78 (missing → cut from testing)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ object: { sha: "testing-sha" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201 } as Response)
      // ensure ai-implement/feature/ool-96 (missing → cut from ool-78 branch)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ object: { sha: "f78-sha" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201 } as Response);

    const base = await resolveBaseBranch({
      ghToken: "t",
      issue: makeIssue(["ai-implement/feature/ool-78", "ai-implement/feature/ool-96"]),
      mapping: makeMapping(),
    });

    expect(base).toBe("ai-implement/feature/ool-96");
    const f78Sha = JSON.parse((vi.mocked(fetch).mock.calls[2][1] as RequestInit).body as string).sha;
    expect(f78Sha).toBe("testing-sha");
    const f96Sha = JSON.parse((vi.mocked(fetch).mock.calls[5][1] as RequestInit).body as string).sha;
    expect(f96Sha).toBe("f78-sha");
    expect(vi.mocked(fetch).mock.calls[4][0]).toContain("ai-implement/feature/ool-78");
  });

  it("handles a multi-issue branch name in the chain", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ object: { sha: "base-sha" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201 } as Response);

    const base = await resolveBaseBranch({
      ghToken: "t",
      issue: makeIssue(["ai-implement/multi-issue/aii-10-aii-5"]),
      mapping: makeMapping(),
    });

    expect(base).toBe("ai-implement/multi-issue/aii-10-aii-5");
    const createBody = JSON.parse((vi.mocked(fetch).mock.calls[2][1] as RequestInit).body as string);
    expect(createBody.ref).toBe("refs/heads/ai-implement/multi-issue/aii-10-aii-5");
  });

  it("returns defaultBranch and creates nothing when there is no chain", async () => {
    const base = await resolveBaseBranch({ ghToken: "t", issue: makeIssue(undefined), mapping: makeMapping() });
    expect(base).toBe("testing");
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  });

  it("fails open to defaultBranch when branch creation errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" } as Response);

    const base = await resolveBaseBranch({ ghToken: "t", issue: makeIssue(["ai-implement/feature/ool-78"]), mapping: makeMapping() });

    expect(base).toBe("testing");
    expect(warn).toHaveBeenCalled();
  });
});
