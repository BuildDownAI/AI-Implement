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

  it("returns the branch name directly from a single-entry chain and ensures it from defaultBranch", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)                               // branch missing
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ object: { sha: "base-sha" } }) } as Response) // base head
      .mockResolvedValueOnce({ ok: true, status: 201 } as Response);                                // create ref

    const base = await resolveBaseBranch({
      ghToken: "t",
      issue: makeIssue(["ai-implement/multi-issue/ool-96-ool-97"]),
      mapping: makeMapping(),
    });

    expect(base).toBe("ai-implement/multi-issue/ool-96-ool-97");
    const createBody = JSON.parse((vi.mocked(fetch).mock.calls[2][1] as RequestInit).body as string);
    expect(createBody).toEqual({ ref: "refs/heads/ai-implement/multi-issue/ool-96-ool-97", sha: "base-sha" });
  });

  it("cascades a multi-entry chain: each branch cut from the previous one", async () => {
    vi.mocked(fetch)
      // ensure first branch (missing → cut from testing)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ object: { sha: "testing-sha" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201 } as Response)
      // ensure second branch (missing → cut from first)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ object: { sha: "first-sha" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201 } as Response);

    const base = await resolveBaseBranch({
      ghToken: "t",
      issue: makeIssue([
        "ai-implement/multi-issue/ool-96-ool-97",
        "ai-implement/multi-issue/ool-100-ool-99",
      ]),
      mapping: makeMapping(),
    });

    expect(base).toBe("ai-implement/multi-issue/ool-100-ool-99");
    // First branch cut from testing
    const first = JSON.parse((vi.mocked(fetch).mock.calls[2][1] as RequestInit).body as string);
    expect(first.sha).toBe("testing-sha");
    expect(first.ref).toBe("refs/heads/ai-implement/multi-issue/ool-96-ool-97");
    // Second branch cut from first
    const second = JSON.parse((vi.mocked(fetch).mock.calls[5][1] as RequestInit).body as string);
    expect(second.sha).toBe("first-sha");
    expect(second.ref).toBe("refs/heads/ai-implement/multi-issue/ool-100-ool-99");
    // The head read for the second cut was the first branch URL
    expect(vi.mocked(fetch).mock.calls[4][0]).toContain("ai-implement/multi-issue/ool-96-ool-97");
  });

  it("returns defaultBranch and creates nothing when there is no chain", async () => {
    const base = await resolveBaseBranch({ ghToken: "t", issue: makeIssue(undefined), mapping: makeMapping() });
    expect(base).toBe("testing");
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  });

  it("fails open to defaultBranch when branch creation errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" } as Response);

    const base = await resolveBaseBranch({
      ghToken: "t",
      issue: makeIssue(["ai-implement/multi-issue/ool-96-ool-97"]),
      mapping: makeMapping(),
    });

    expect(base).toBe("testing");
    expect(warn).toHaveBeenCalled();
  });
});
