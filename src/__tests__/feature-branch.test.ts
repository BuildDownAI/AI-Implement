import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveBaseBranch, nonTerminalDesignatedChildren, type FeatureChildState } from "../feature-branch.js";
import type { RepoMapping } from "../config.js";
import type { FeatureBranchChainEntry, TicketIssue } from "../providers/types.js";

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

function makeIssue(featureBranchChain?: FeatureBranchChainEntry[]): TicketIssue {
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

// AII-609: "terminal" means the tracker's own workflow state — completed or cancelled —
// independent of whether an orchestrator job row exists for the child. A child mid
// implementation (planning done, run dispatched, tracker state still non-terminal) must
// still be reported as blocking.
describe("nonTerminalDesignatedChildren", () => {
  const child = (identifier: string, designated: boolean, terminal: boolean): FeatureChildState => ({
    identifier,
    designated,
    terminal,
  });

  it("blocks on the exact AII-604/607/608 shape: one child Done, one In Progress with a running job", () => {
    // The job row is irrelevant to this predicate — it isn't part of FeatureChildState at
    // all, so a caller cannot accidentally let a running job masquerade as terminal.
    const children = [child("AII-607", true, true), child("AII-608", true, false)];
    expect(nonTerminalDesignatedChildren(children).map((c) => c.identifier)).toEqual(["AII-608"]);
  });

  it("is ready once every designated child reaches a terminal state (mix of completed and cancelled)", () => {
    const children = [child("A-1", true, true), child("A-2", true, true)];
    expect(nonTerminalDesignatedChildren(children)).toEqual([]);
  });

  it("never blocks on a non-designated child, terminal or not", () => {
    const children = [child("A-1", true, true), child("A-2", false, false)];
    expect(nonTerminalDesignatedChildren(children)).toEqual([]);
  });

  it("is ready for an empty child list", () => {
    expect(nonTerminalDesignatedChildren([])).toEqual([]);
  });
});

describe("resolveBaseBranch", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns the feature branch and ensures it from defaultBranch for a single-entry chain", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)                               // feature branch missing
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ object: { sha: "base-sha" } }) } as Response) // base head
      .mockResolvedValueOnce({ ok: true, status: 201 } as Response);                                // create ref

    const base = await resolveBaseBranch({ ghToken: "t", issue: makeIssue([{ identifier: "OOL-78", mode: "feature" }]), mapping: makeMapping() });

    expect(base).toBe("ai-implement/feature/ool-78");
    const createBody = JSON.parse((vi.mocked(fetch).mock.calls[2][1] as RequestInit).body as string);
    expect(createBody).toEqual({ ref: "refs/heads/ai-implement/feature/ool-78", sha: "base-sha" });
  });

  it("cascades a multi-entry chain: each branch cut from the previous one", async () => {
    vi.mocked(fetch)
      // ensure OOL-78 (missing → cut from testing)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ object: { sha: "testing-sha" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201 } as Response)
      // ensure OOL-96 (missing → cut from OOL-78 branch)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ object: { sha: "f78-sha" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201 } as Response);

    const base = await resolveBaseBranch({
      ghToken: "t",
      issue: makeIssue([{ identifier: "OOL-78", mode: "feature" }, { identifier: "OOL-96", mode: "feature" }]),
      mapping: makeMapping(),
    });

    expect(base).toBe("ai-implement/feature/ool-96");
    // The OOL-78 branch is read from refs/heads/testing; the OOL-96 branch is cut from the OOL-78 branch head.
    const f78Sha = JSON.parse((vi.mocked(fetch).mock.calls[2][1] as RequestInit).body as string).sha;
    expect(f78Sha).toBe("testing-sha");
    const f96Sha = JSON.parse((vi.mocked(fetch).mock.calls[5][1] as RequestInit).body as string).sha;
    expect(f96Sha).toBe("f78-sha");
    expect(vi.mocked(fetch).mock.calls[4][0]).toContain("ai-implement/feature/ool-78");
  });

  it("returns defaultBranch and creates nothing when there is no chain", async () => {
    const base = await resolveBaseBranch({ ghToken: "t", issue: makeIssue(undefined), mapping: makeMapping() });
    expect(base).toBe("testing");
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  });

  it("fails closed when a grouped branch cannot be resolved", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" } as Response);

    await expect(resolveBaseBranch({
      ghToken: "t",
      issue: makeIssue([{ identifier: "OOL-78", mode: "feature" }]),
      mapping: makeMapping(),
    })).rejects.toThrow(/refusing to dispatch against "testing"/);
  });
});

describe("findOpenRollUpPr (parent no-work churn guard)", () => {
  const mapping = { owner: "o", repo: "r", defaultBranch: "testing" } as never;
  const parent = (id: string) => ({
    id, identifier: id, title: "t", description: null, scopeKey: "T", nativeStatus: "todo",
    featureBranchChain: [{ identifier: id, mode: "feature" as const }],
  }) as never;

  it("returns the PR when an open roll-up exists for the parent's feature branch", async () => {
    const finder = vi.fn(async () => ({ number: 42, url: "u", state: "open" as const, merged: false }));
    const { findOpenRollUpPr } = await import("../feature-branch.js");
    const pr = await findOpenRollUpPr({ ghToken: "tok", issue: parent("P-1"), mapping, finder });
    expect(pr).toEqual({ number: 42, url: "u" });
    expect(finder).toHaveBeenCalledWith("tok", "o", "r", "ai-implement/feature/p-1", "testing");
  });

  it("returns null for merged/closed roll-ups and for non-parent (leaf) chains", async () => {
    const { findOpenRollUpPr } = await import("../feature-branch.js");
    const merged = vi.fn(async () => ({ number: 1, url: "u", state: "closed" as const, merged: true }));
    expect(await findOpenRollUpPr({ ghToken: "t", issue: parent("P-2"), mapping, finder: merged })).toBeNull();
    // leaf: chain ends at an ancestor, not itself -> guard does not apply, finder never called
    const leafFinder = vi.fn();
    const leaf = { ...(parent("C-1") as object), featureBranchChain: [{ identifier: "P-9", mode: "feature" }] } as never;
    expect(await findOpenRollUpPr({ ghToken: "t", issue: leaf, mapping, finder: leafFinder })).toBeNull();
    expect(leafFinder).not.toHaveBeenCalled();
    // empty chain
    const bare = { ...(parent("X-1") as object), featureBranchChain: [] } as never;
    expect(await findOpenRollUpPr({ ghToken: "t", issue: bare, mapping, finder: leafFinder })).toBeNull();
  });
});
