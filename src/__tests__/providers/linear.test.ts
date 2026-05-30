import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LinearProvider } from "../../providers/linear.js";
import { MissingProviderConfigError, type TicketingProvider } from "../../providers/types.js";

describe("LinearProvider", () => {
  it("constructor throws when linearApiKey is missing", () => {
    expect(() => new LinearProvider({})).toThrow(MissingProviderConfigError);
  });

  it("constructor accepts a linearApiKey", () => {
    const p = new LinearProvider({ linearApiKey: "k" });
    expect(p.id).toBe("linear");
  });

  it("satisfies TicketingProvider at the type level", () => {
    const p = new LinearProvider({ linearApiKey: "k" });
    const provider: TicketingProvider = p;
    expect(provider.id).toBe("linear");
  });
});

describe("LinearProvider.postComment", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("sends the GraphQL commentCreate mutation with issueId and body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { commentCreate: { success: true } } }),
    } as Response);

    const p = new LinearProvider({ linearApiKey: "test-key" });
    await p.postComment("issue-uuid-1", "Hello body");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "test-key" }),
      }),
    );
    const callArgs = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(callArgs[1]?.body as string);
    expect(body.variables).toEqual({ issueId: "issue-uuid-1", body: "Hello body" });
  });

  it("throws on Linear HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "boom",
    } as Response);

    const p = new LinearProvider({ linearApiKey: "test-key" });
    await expect(p.postComment("i", "b")).rejects.toThrow(/Linear API error/);
  });

  it("throws on Linear GraphQL error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errors: [{ message: "Permission denied" }] }),
    } as Response);

    const p = new LinearProvider({ linearApiKey: "test-key" });
    await expect(p.postComment("i", "b")).rejects.toThrow(/Permission denied/);
  });
});

describe("LinearProvider.fetchLifecycleStates", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("maps Linear state.type to IssueLifecycleState", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [
              { id: "a", state: { type: "completed" } },
              { id: "b", state: { type: "canceled" } },
              { id: "c", state: { type: "started" } },
              { id: "d", state: { type: "unstarted" } },
            ],
          },
        },
      }),
    } as Response);

    const p = new LinearProvider({ linearApiKey: "k" });
    const states = await p.fetchLifecycleStates(["a", "b", "c", "d", "missing"]);

    expect(states.get("a")).toBe("completed");
    expect(states.get("b")).toBe("cancelled");
    expect(states.get("c")).toBe("active");
    expect(states.get("d")).toBe("active");
    expect(states.has("missing")).toBe(false);
  });

  it("returns empty map when called with empty array, makes no fetch", async () => {
    const p = new LinearProvider({ linearApiKey: "k" });
    const states = await p.fetchLifecycleStates([]);
    expect(states.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("LinearProvider.fetchAIImplementSnapshot", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  function makeIssue(overrides: {
    id?: string;
    identifier?: string;
    title?: string;
    description?: string | null;
    teamKey?: string;
    stateName?: string;
    stateType?: string;
    labels?: string[];
    inverseRelations?: Array<{ type: string; issue: { state: { type: string } } }>;
    parent?: { id: string; identifier: string; title: string; childCount: number } | null;
  } = {}) {
    return {
      id: overrides.id ?? "uuid-1",
      identifier: overrides.identifier ?? "ENG-1",
      title: overrides.title ?? "Title",
      description: overrides.description ?? null,
      team: { id: "team-id", key: overrides.teamKey ?? "ENG" },
      state: {
        id: "state-id",
        name: overrides.stateName ?? "Todo",
        type: overrides.stateType ?? "unstarted",
      },
      labels: { nodes: (overrides.labels ?? []).map((name, i) => ({ id: `l${i}`, name })) },
      inverseRelations: { nodes: overrides.inverseRelations ?? [] },
      parent: overrides.parent
        ? {
            id: overrides.parent.id,
            identifier: overrides.parent.identifier,
            title: overrides.parent.title,
            children: { nodes: Array.from({ length: overrides.parent.childCount }, (_, i) => ({ id: `c${i}` })) },
          }
        : null,
    };
  }

  function mockSinglePage(nodes: ReturnType<typeof makeIssue>[]) {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    } as Response);
  }

  it("buckets issues by Plan-Complete label", async () => {
    mockSinglePage([
      makeIssue({ id: "a", identifier: "ENG-1", labels: ["AI-Implement", "Plan-Complete"] }),
      makeIssue({ id: "b", identifier: "ENG-2", labels: ["AI-Implement"] }),
    ]);

    const p = new LinearProvider({ linearApiKey: "k" });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.readyForImplementation.map((i) => i.id)).toEqual(["a"]);
    expect(snap.needsPlanning.map((i) => i.id)).toEqual(["b"]);
    expect(snap.inProgressCountsByScope).toEqual({});
    expect(snap.readyForImplementation[0].scopeKey).toBe("ENG");
    expect(snap.readyForImplementation[0].nativeStatus).toBe("Todo (unstarted)");
  });

  it("maps parentRef with childCount when the issue has a parent; omits it otherwise", async () => {
    mockSinglePage([
      makeIssue({
        id: "child",
        identifier: "ENG-2",
        labels: ["AI-Implement", "Plan-Complete"],
        parent: { id: "parent-uuid", identifier: "ENG-1", title: "Parent epic", childCount: 3 },
      }),
      makeIssue({ id: "orphan", identifier: "ENG-9", labels: ["AI-Implement", "Plan-Complete"] }),
    ]);

    const p = new LinearProvider({ linearApiKey: "k" });
    const snap = await p.fetchAIImplementSnapshot();

    const child = snap.readyForImplementation.find((i) => i.id === "child")!;
    expect(child.parentRef).toEqual({
      id: "parent-uuid",
      identifier: "ENG-1",
      title: "Parent epic",
      childCount: 3,
    });
    const orphan = snap.readyForImplementation.find((i) => i.id === "orphan")!;
    expect(orphan.parentRef).toBeUndefined();
  });

  it("counts AI-Working / AI-Planning issues by scope and excludes them from buckets", async () => {
    mockSinglePage([
      makeIssue({ id: "a", teamKey: "T1", labels: ["AI-Implement", "AI-Working"] }),
      makeIssue({ id: "b", teamKey: "T2", labels: ["AI-Implement", "AI-Planning"] }),
    ]);

    const p = new LinearProvider({ linearApiKey: "k" });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.inProgressCountsByScope).toEqual({ T1: 1, T2: 1 });
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
  });

  it("skips issues with Ready for Review label", async () => {
    mockSinglePage([
      makeIssue({ id: "a", identifier: "ENG-1", labels: ["AI-Implement", "Ready for Review"] }),
      makeIssue({ id: "b", identifier: "ENG-2", labels: ["AI-Implement"] }),
    ]);

    const p = new LinearProvider({ linearApiKey: "k" });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.id)).toEqual(["b"]);
    expect(snap.readyForImplementation).toEqual([]);
    expect(snap.inProgressCountsByScope).toEqual({});
  });

  it("skips issues blocked by an open issue, includes ones whose blocker is completed", async () => {
    mockSinglePage([
      makeIssue({
        id: "a",
        identifier: "ENG-1",
        labels: ["AI-Implement"],
        inverseRelations: [{ type: "blocks", issue: { state: { type: "started" } } }],
      }),
      makeIssue({
        id: "b",
        identifier: "ENG-2",
        labels: ["AI-Implement"],
        inverseRelations: [{ type: "blocks", issue: { state: { type: "completed" } } }],
      }),
    ]);

    const p = new LinearProvider({ linearApiKey: "k" });
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.id)).toEqual(["b"]);
    expect(snap.readyForImplementation).toEqual([]);
  });
});

// ----- Lifecycle verb tests -----

function mockJsonOnce(data: unknown) {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data }),
  } as Response);
}

describe("LinearProvider.markPlanningStarted", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("ensures AI-Planning label, adds it to the issue, and transitions to In Progress when movable", async () => {
    // 1. getTeamIdByKey
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    // 2. ensureTeamLabel — find existing AI-Planning label
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-planning" }] } });
    // 3. addLabelToIssue — fetch current labels
    mockJsonOnce({ issue: { labels: { nodes: [] } } });
    // 4. addLabelToIssue — issueUpdate
    mockJsonOnce({ issueUpdate: { success: true } });
    // 5. transitionToInProgressIfMovable — fetch state.type (movable)
    mockJsonOnce({ issue: { state: { type: "unstarted" } } });
    // 6. getInProgressStateId — workflowStates query (team id is cached)
    mockJsonOnce({
      workflowStates: { nodes: [{ id: "state-inprog", name: "In Progress", type: "started" }] },
    });
    // 7. updateIssueState
    mockJsonOnce({ issueUpdate: { success: true } });

    const p = new LinearProvider({ linearApiKey: "k" });
    await p.markPlanningStarted("issue-1", "ENG");

    expect(fetch).toHaveBeenCalledTimes(7);
    const lastBody = JSON.parse(vi.mocked(fetch).mock.calls[6][1]?.body as string);
    expect(lastBody.variables).toEqual({ issueId: "issue-1", stateId: "state-inprog" });
  });

  it("does not transition state when issue is in a non-movable state", async () => {
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-planning" }] } });
    mockJsonOnce({ issue: { labels: { nodes: [] } } });
    mockJsonOnce({ issueUpdate: { success: true } });
    // state.type fetch returns "started" — not movable
    mockJsonOnce({ issue: { state: { type: "started" } } });

    const p = new LinearProvider({ linearApiKey: "k" });
    await p.markPlanningStarted("issue-1", "ENG");

    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("creates AI-Planning label with #8B5CF6 color when not found", async () => {
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    // ensureTeamLabel: search returns empty → create
    mockJsonOnce({ issueLabels: { nodes: [] } });
    mockJsonOnce({ issueLabelCreate: { issueLabel: { id: "new-label" } } });
    mockJsonOnce({ issue: { labels: { nodes: [] } } });
    mockJsonOnce({ issueUpdate: { success: true } });
    // state.type fetch (movable)
    mockJsonOnce({ issue: { state: { type: "backlog" } } });
    mockJsonOnce({
      workflowStates: { nodes: [{ id: "state-inprog", name: "In Progress", type: "started" }] },
    });
    mockJsonOnce({ issueUpdate: { success: true } });

    const p = new LinearProvider({ linearApiKey: "k" });
    await p.markPlanningStarted("issue-1", "ENG");

    const createBody = JSON.parse(vi.mocked(fetch).mock.calls[2][1]?.body as string);
    expect(createBody.variables).toEqual({ teamId: "team-uuid", name: "AI-Planning", color: "#8B5CF6" });
  });
});

describe("LinearProvider.markPlanComplete", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("removes AI-Planning label, then adds Plan-Complete label resolved via issue's team key", async () => {
    // 1. removeLabelByName: fetch labels
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lp", name: "AI-Planning" }, { id: "lo", name: "Other" }] } } });
    // 2. removeLabelByName: issueUpdate to drop AI-Planning
    mockJsonOnce({ issueUpdate: { success: true } });
    // 3. getTeamKeyForIssue
    mockJsonOnce({ issue: { team: { key: "ENG" } } });
    // 4. getTeamIdByKey
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    // 5. ensureTeamLabel: find existing Plan-Complete
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-pc" }] } });
    // 6. addLabelToIssue: fetch current labels
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lo" }] } } });
    // 7. addLabelToIssue: issueUpdate
    mockJsonOnce({ issueUpdate: { success: true } });

    const p = new LinearProvider({ linearApiKey: "k" });
    await p.markPlanComplete("issue-1");

    expect(fetch).toHaveBeenCalledTimes(7);
    const removeBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
    expect(removeBody.variables).toEqual({ issueId: "issue-1", labelIds: ["lo"] });
    const addBody = JSON.parse(vi.mocked(fetch).mock.calls[6][1]?.body as string);
    expect(addBody.variables.labelIds).toEqual(["lo", "label-pc"]);
  });
});

describe("LinearProvider.markImplementing", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("ensures AI-Working label and adds it to the issue (no state transition when not movable)", async () => {
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-aw" }] } });
    mockJsonOnce({ issue: { labels: { nodes: [] } } });
    mockJsonOnce({ issueUpdate: { success: true } });
    // state.type fetch returns "started" — not movable, no transition
    mockJsonOnce({ issue: { state: { type: "started" } } });

    const p = new LinearProvider({ linearApiKey: "k" });
    await p.markImplementing("issue-1", "ENG");

    expect(fetch).toHaveBeenCalledTimes(5);
    const addBody = JSON.parse(vi.mocked(fetch).mock.calls[3][1]?.body as string);
    expect(addBody.variables).toEqual({ issueId: "issue-1", labelIds: ["label-aw"] });
  });

  it("does not transition state when issue is in a non-movable state", async () => {
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-aw" }] } });
    mockJsonOnce({ issue: { labels: { nodes: [] } } });
    mockJsonOnce({ issueUpdate: { success: true } });
    // state.type "completed" — not movable
    mockJsonOnce({ issue: { state: { type: "completed" } } });

    const p = new LinearProvider({ linearApiKey: "k" });
    await p.markImplementing("issue-1", "ENG");

    // 4 setup/label fetches + 1 state.type query, but no getInProgressStateId/updateIssueState
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("transitions state to In Progress when issue is in a movable state", async () => {
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-aw" }] } });
    mockJsonOnce({ issue: { labels: { nodes: [] } } });
    mockJsonOnce({ issueUpdate: { success: true } });
    // state.type "backlog" — movable
    mockJsonOnce({ issue: { state: { type: "backlog" } } });
    // getInProgressStateId
    mockJsonOnce({
      workflowStates: { nodes: [{ id: "state-inprog", name: "In Progress", type: "started" }] },
    });
    // updateIssueState
    mockJsonOnce({ issueUpdate: { success: true } });

    const p = new LinearProvider({ linearApiKey: "k" });
    await p.markImplementing("issue-1", "ENG");

    expect(fetch).toHaveBeenCalledTimes(7);
    const lastBody = JSON.parse(vi.mocked(fetch).mock.calls[6][1]?.body as string);
    expect(lastBody.variables).toEqual({ issueId: "issue-1", stateId: "state-inprog" });
  });

  it("creates AI-Working label with #F59E0B color when not found", async () => {
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ issueLabels: { nodes: [] } });
    mockJsonOnce({ issueLabelCreate: { issueLabel: { id: "new-label" } } });
    mockJsonOnce({ issue: { labels: { nodes: [] } } });
    mockJsonOnce({ issueUpdate: { success: true } });
    // state.type fetch — not movable to keep mock count minimal
    mockJsonOnce({ issue: { state: { type: "started" } } });

    const p = new LinearProvider({ linearApiKey: "k" });
    await p.markImplementing("issue-1", "ENG");

    const createBody = JSON.parse(vi.mocked(fetch).mock.calls[2][1]?.body as string);
    expect(createBody.variables).toEqual({ teamId: "team-uuid", name: "AI-Working", color: "#F59E0B" });
  });
});

describe("LinearProvider.markPrReady", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("swaps AI-Working for Ready for Review atomically and posts a PR comment", async () => {
    // 1. ensureWorkspaceReadyForReviewLabel: search workspace
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-rfr" }] } });
    // 2. fetch issue labels for swap
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lw", name: "AI-Working" }, { id: "lo", name: "Other" }] } } });
    // 3. issueUpdate label swap
    mockJsonOnce({ issueUpdate: { success: true } });
    // 4. postComment
    mockJsonOnce({ commentCreate: { success: true } });

    const p = new LinearProvider({ linearApiKey: "k" });
    await p.markPrReady("issue-1", "https://github.com/o/r/pull/7");

    expect(fetch).toHaveBeenCalledTimes(4);
    const swapBody = JSON.parse(vi.mocked(fetch).mock.calls[2][1]?.body as string);
    expect(swapBody.variables).toEqual({ issueId: "issue-1", labelIds: ["lo", "label-rfr"] });
    const commentBody = JSON.parse(vi.mocked(fetch).mock.calls[3][1]?.body as string);
    expect(commentBody.variables).toEqual({
      issueId: "issue-1",
      body: "AI implementation PR: https://github.com/o/r/pull/7",
    });
  });
});

describe("LinearProvider.clearWorkingState", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("removes the AI-Working label from the issue", async () => {
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lw", name: "AI-Working" }, { id: "lo", name: "Other" }] } } });
    mockJsonOnce({ issueUpdate: { success: true } });

    const p = new LinearProvider({ linearApiKey: "k" });
    await p.clearWorkingState("issue-1");

    expect(fetch).toHaveBeenCalledTimes(2);
    const updateBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
    expect(updateBody.variables).toEqual({ issueId: "issue-1", labelIds: ["lo"] });
  });

  it("no-ops (no mutation) when AI-Working label is absent", async () => {
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lo", name: "Other" }] } } });

    const p = new LinearProvider({ linearApiKey: "k" });
    await p.clearWorkingState("issue-1");

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the issue has no labels at all", async () => {
    mockJsonOnce({ issue: { labels: { nodes: [] } } });

    const p = new LinearProvider({ linearApiKey: "k" });
    await p.clearWorkingState("issue-1");

    // Only the labels-fetch query runs; no update mutation when there's nothing to remove
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("LinearProvider.markPlanningFailed", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("removes AI-Planning label and posts a failure comment", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { issue: { labels: { nodes: [{ id: "lblP", name: "AI-Planning" }] } } } }),
    } as Response);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { issueUpdate: { success: true } } }),
    } as Response);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { commentCreate: { success: true } } }),
    } as Response);

    const p = new LinearProvider({ linearApiKey: "k" });
    await p.markPlanningFailed("issue-1", "GraphQL exploded");

    const lastCall = vi.mocked(fetch).mock.calls.at(-1)!;
    const body = JSON.parse(lastCall[1]?.body as string);
    expect(body.variables.body).toContain("Planning failed: GraphQL exploded");
  });
});

describe("LinearProvider.markImplementationFailed", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("removes AI-Working label and posts a failure comment", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { issue: { labels: { nodes: [{ id: "lblW", name: "AI-Working" }] } } } }),
    } as Response);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { issueUpdate: { success: true } } }),
    } as Response);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { commentCreate: { success: true } } }),
    } as Response);

    const p = new LinearProvider({ linearApiKey: "k" });
    await p.markImplementationFailed("issue-1", "tests timed out");

    const lastCall = vi.mocked(fetch).mock.calls.at(-1)!;
    const body = JSON.parse(lastCall[1]?.body as string);
    expect(body.variables.body).toContain("Implementation failed: tests timed out");
  });
});

describe("LinearProvider.issueUrl", () => {
  it("uses linearWorkspaceUrl when provided", () => {
    const p = new LinearProvider({ linearApiKey: "k", linearWorkspaceUrl: "https://linear.app/acme" });
    expect(p.issueUrl({
      id: "u", identifier: "ENG-1", title: "t", description: null, scopeKey: "ENG", nativeStatus: "",
    })).toBe("https://linear.app/acme/issue/ENG-1");
  });

  it("falls back to https://linear.app when workspace URL is unset", () => {
    const p = new LinearProvider({ linearApiKey: "k" });
    expect(p.issueUrl({
      id: "u", identifier: "ENG-1", title: "t", description: null, scopeKey: "ENG", nativeStatus: "",
    })).toBe("https://linear.app/issue/ENG-1");
  });
});

describe("LinearProvider.findByKey", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns null for malformed identifiers", async () => {
    const p = new LinearProvider({ linearApiKey: "k" });
    expect(await p.findByKey("not a key")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null when the GraphQL query yields no nodes", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { issues: { nodes: [] } } }),
    } as Response);
    const p = new LinearProvider({ linearApiKey: "k" });
    expect(await p.findByKey("ENG-999")).toBeNull();
  });

  it("bubbles non-404 errors from the Linear API", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "boom",
    } as Response);
    const p = new LinearProvider({ linearApiKey: "k" });
    await expect(p.findByKey("ENG-1")).rejects.toThrow(/Linear API error/);
  });

  it("returns a TicketIssue when found", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issues: {
            nodes: [{
              id: "issue-uuid", identifier: "ENG-1", title: "Hello", description: "World",
              team: { key: "ENG" }, state: { name: "Todo", type: "unstarted" },
            }],
          },
        },
      }),
    } as Response);
    const p = new LinearProvider({ linearApiKey: "k" });
    const issue = await p.findByKey("ENG-1");
    expect(issue).toEqual({
      id: "issue-uuid", identifier: "ENG-1", title: "Hello", description: "World",
      scopeKey: "ENG", nativeStatus: "Todo (unstarted)",
    });
  });
});
