import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { qualifiesForFeatureBranch, resolveBaseBranch, MIN_CHILDREN_FOR_FEATURE_BRANCH } from "../feature-branch.js";
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

function makeIssue(parentRef?: TicketIssue["parentRef"]): TicketIssue {
  return {
    id: "child-uuid",
    identifier: "OOL-87",
    title: "Child work",
    description: null,
    scopeKey: "OOL",
    nativeStatus: "Todo (unstarted)",
    ...(parentRef ? { parentRef } : {}),
  };
}

const parent = { identifier: "OOL-78", childCount: 3 };

describe("qualifiesForFeatureBranch", () => {
  it("is true only for a parent with >= MIN children", () => {
    expect(MIN_CHILDREN_FOR_FEATURE_BRANCH).toBe(2);
    expect(qualifiesForFeatureBranch(makeIssue({ ...parent, childCount: 2 }))).toBe(true);
    expect(qualifiesForFeatureBranch(makeIssue({ ...parent, childCount: 1 }))).toBe(false);
    expect(qualifiesForFeatureBranch(makeIssue(undefined))).toBe(false);
  });
});

describe("resolveBaseBranch", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns the feature branch and ensures it from defaultBranch when qualifying", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)                               // feature branch missing
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ object: { sha: "base-sha" } }) } as Response) // base head
      .mockResolvedValueOnce({ ok: true, status: 201 } as Response);                                // create ref

    const base = await resolveBaseBranch({ ghToken: "t", issue: makeIssue(parent), mapping: makeMapping() });

    expect(base).toBe("ai-implement/feature/ool-78");
    const createBody = JSON.parse((vi.mocked(fetch).mock.calls[2][1] as RequestInit).body as string);
    expect(createBody).toEqual({ ref: "refs/heads/ai-implement/feature/ool-78", sha: "base-sha" });
  });

  it("returns defaultBranch and creates nothing when not qualifying", async () => {
    const base = await resolveBaseBranch({ ghToken: "t", issue: makeIssue(undefined), mapping: makeMapping() });
    expect(base).toBe("testing");
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  });

  it("fails open to defaultBranch when branch creation errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" } as Response);

    const base = await resolveBaseBranch({ ghToken: "t", issue: makeIssue(parent), mapping: makeMapping() });

    expect(base).toBe("testing");
    expect(warn).toHaveBeenCalled();
  });
});
