import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LinearProvider } from "../../providers/linear.js";
import { MissingProviderConfigError, type TicketingProvider } from "../../providers/types.js";
import {
  configureLinearAuth,
  __setLinearTokenForTest,
  __resetLinearAuthForTest,
} from "../../linear-app-auth.js";

// Linear auth lives in the linear-app-auth singleton now (not on ProviderConfig). Configure it
// and seed a token before every test so the provider's requests carry `Bearer test-token`, and
// no mint round-trip is injected into the fetch-call counts these assertions rely on.
beforeEach(() => {
  configureLinearAuth("client-id", "client-secret");
  __setLinearTokenForTest("test-token");
});

describe("LinearProvider", () => {
  it("constructor throws when Linear auth is not configured", () => {
    __resetLinearAuthForTest(); // override the beforeEach configuration for this case
    expect(() => new LinearProvider({})).toThrow(MissingProviderConfigError);
  });

  it("constructor succeeds when Linear auth is configured", () => {
    const p = new LinearProvider({});
    expect(p.id).toBe("linear");
  });

  it("satisfies TicketingProvider at the type level", () => {
    const p = new LinearProvider({});
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

    const p = new LinearProvider({});
    await p.postComment("issue-uuid-1", "Hello body");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
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

    const p = new LinearProvider({});
    await expect(p.postComment("i", "b")).rejects.toThrow(/Linear API error/);
  });

  it("throws on Linear GraphQL error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errors: [{ message: "Permission denied" }] }),
    } as Response);

    const p = new LinearProvider({});
    await expect(p.postComment("i", "b")).rejects.toThrow(/Permission denied/);
  });
});

describe("LinearProvider.fetchPlanningContext", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns the issue's planning comments, authenticated as the app", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            comments: {
              nodes: [
                { body: "## 🏗️ AI Planning: Architecture Analysis\nUse the widget pattern.", createdAt: "2026-01-01T00:00:00Z" },
                { body: "just a regular human comment", createdAt: "2026-01-02T00:00:00Z" },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    } as Response);

    const p = new LinearProvider({});
    const ctx = await p.fetchPlanningContext("issue-uuid-1");

    expect(ctx).toContain("Use the widget pattern.");
    expect(ctx).not.toContain("just a regular human comment");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }),
    );
  });

  it("returns empty string (never throws) when Linear is unreachable", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    const p = new LinearProvider({});
    await expect(p.fetchPlanningContext("issue-uuid-1")).resolves.toBe("");
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

    const p = new LinearProvider({});
    const states = await p.fetchLifecycleStates(["a", "b", "c", "d", "missing"]);

    expect(states.get("a")).toBe("completed");
    expect(states.get("b")).toBe("cancelled");
    expect(states.get("c")).toBe("active");
    expect(states.get("d")).toBe("active");
    expect(states.has("missing")).toBe(false);
  });

  it("returns empty map when called with empty array, makes no fetch", async () => {
    const p = new LinearProvider({});
    const states = await p.fetchLifecycleStates([]);
    expect(states.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("LinearProvider.fetchAIImplementSnapshot", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  type Ancestor = { identifier: string; description?: string | null; labels?: string[]; parent?: Ancestor | null };
  type Child = { labels?: string[]; stateType?: string };

  const MULTI_YML = ["```yaml", "# ai-implement.yml", "feature_branch:", '  mode: "multi-issue"', "```"].join("\n");

  function labelNodes(names: string[] | undefined) {
    return { nodes: (names ?? []).map((name) => ({ name })) };
  }
  function ancestorNode(a: Ancestor | null | undefined): unknown {
    if (!a) return null;
    return { identifier: a.identifier, description: a.description ?? null, labels: labelNodes(a.labels), parent: ancestorNode(a.parent) };
  }

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
    parent?: Ancestor | null;
    children?: Child[];
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
      children: {
        nodes: (overrides.children ?? []).map((c, i) => ({
          identifier: `${overrides.identifier ?? "ENG-1"}-c${i}`,
          state: { type: c.stateType ?? "unstarted" },
          labels: labelNodes(c.labels),
        })),
      },
      parent: ancestorNode(overrides.parent),
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

    const p = new LinearProvider({});
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.readyForImplementation.map((i) => i.id)).toEqual(["a"]);
    expect(snap.needsPlanning.map((i) => i.id)).toEqual(["b"]);
    expect(snap.inProgressCountsByScope).toEqual({});
    expect(snap.readyForImplementation[0].scopeKey).toBe("ENG");
    expect(snap.readyForImplementation[0].nativeStatus).toBe("Todo (unstarted)");
  });

  it("maps parentRef when the issue has a parent; omits it otherwise", async () => {
    mockSinglePage([
      makeIssue({
        id: "child",
        identifier: "ENG-2",
        labels: ["AI-Implement", "Plan-Complete"],
        parent: { identifier: "ENG-1", labels: ["AI-Implement"] },
      }),
      makeIssue({ id: "orphan", identifier: "ENG-9", labels: ["AI-Implement", "Plan-Complete"] }),
    ]);

    const p = new LinearProvider({});
    const snap = await p.fetchAIImplementSnapshot();

    const child = snap.readyForImplementation.find((i) => i.id === "child")!;
    expect(child.parentRef).toEqual({ identifier: "ENG-1" });
    const orphan = snap.readyForImplementation.find((i) => i.id === "orphan")!;
    expect(orphan.parentRef).toBeUndefined();
  });

  describe("feature-branch grouping", () => {
    it("a leaf under a labeled parent targets the parent's feature-branch chain", async () => {
      mockSinglePage([
        makeIssue({
          id: "leaf",
          identifier: "OOL-96",
          labels: ["AI-Implement", "Plan-Complete"],
          parent: { identifier: "OOL-78", labels: ["AI-Implement"] },
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      const leaf = snap.readyForImplementation.find((i) => i.id === "leaf")!;
      expect(leaf.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }]);
    });

    it("a leaf under an UNlabeled parent gets no chain (PRs to base)", async () => {
      mockSinglePage([
        makeIssue({
          id: "leaf",
          identifier: "OOL-50",
          labels: ["AI-Implement"],
          parent: { identifier: "OOL-40", labels: ["Improvement"] },
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      const leaf = snap.needsPlanning.find((i) => i.id === "leaf")!;
      expect(leaf.featureBranchChain).toBeUndefined();
    });

    it("cascades the chain through labeled grandparents", async () => {
      mockSinglePage([
        makeIssue({
          id: "leaf",
          identifier: "OOL-99",
          labels: ["AI-Implement"],
          parent: {
            identifier: "OOL-96",
            labels: ["AI-Implement"],
            parent: { identifier: "OOL-78", labels: ["AI-Implement"] },
          },
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      const leaf = snap.needsPlanning.find((i) => i.id === "leaf")!;
      // base-most first
      expect(leaf.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }, { identifier: "OOL-96", mode: "feature" }]);
    });

    it("skips a feature-node parent while any AI-Implement child is in flight", async () => {
      mockSinglePage([
        makeIssue({
          id: "parent",
          identifier: "OOL-78",
          labels: ["AI-Implement"],
          children: [
            { labels: ["AI-Implement"], stateType: "completed" },
            { labels: ["AI-Implement"], stateType: "started" }, // still in flight
          ],
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      expect(snap.needsPlanning).toEqual([]);
      expect(snap.readyForImplementation).toEqual([]);
    });

    it("dispatches a feature-node parent once all AI-Implement children are terminal, onto its own branch", async () => {
      mockSinglePage([
        makeIssue({
          id: "parent",
          identifier: "OOL-78",
          labels: ["AI-Implement"],
          children: [
            { labels: ["AI-Implement"], stateType: "completed" },
            { labels: ["AI-Implement"], stateType: "canceled" },
            { labels: ["Improvement"], stateType: "started" }, // non-AI child does not gate
          ],
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      const parent = snap.needsPlanning.find((i) => i.id === "parent")!;
      expect(parent.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }]);
    });

    it("skips a labeled parent whose children are not yet AI-Implement (race guard)", async () => {
      mockSinglePage([
        makeIssue({
          id: "parent",
          identifier: "OOL-78",
          labels: ["AI-Implement"],
          children: [{ labels: ["Improvement"], stateType: "unstarted" }],
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      expect(snap.needsPlanning).toEqual([]);
      expect(snap.readyForImplementation).toEqual([]);
    });

    it("targets a multi-issue parent's branch when the parent's ai-implement.yml selects it", async () => {
      mockSinglePage([
        makeIssue({
          id: "leaf",
          identifier: "OOL-87",
          labels: ["AI-Implement"],
          parent: { identifier: "OOL-78", description: MULTI_YML, labels: ["AI-Implement"] },
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      expect(snap.needsPlanning[0].featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "multi-issue" }]);
    });

    it("leaves feature-node behaviour unchanged when there is no ai-implement.yml", async () => {
      mockSinglePage([
        makeIssue({
          id: "leaf",
          identifier: "OOL-87",
          labels: ["AI-Implement"],
          parent: { identifier: "OOL-78", description: null, labels: ["AI-Implement"] },
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      expect(snap.needsPlanning[0].featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }]);
    });

    it("resolves each ancestor's mode independently when modes are mixed", async () => {
      mockSinglePage([
        makeIssue({
          id: "leaf",
          identifier: "OOL-87",
          labels: ["AI-Implement"],
          parent: {
            identifier: "OOL-78",
            description: MULTI_YML,
            labels: ["AI-Implement"],
            parent: { identifier: "OOL-70", description: null, labels: ["AI-Implement"] },
          },
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      expect(snap.needsPlanning[0].featureBranchChain).toEqual([
        { identifier: "OOL-70", mode: "feature" },
        { identifier: "OOL-78", mode: "multi-issue" },
      ]);
    });

    it("puts a multi-issue parent's own closing work on its multi-issue branch", async () => {
      mockSinglePage([
        makeIssue({
          id: "parent",
          identifier: "OOL-78",
          labels: ["AI-Implement"],
          description: MULTI_YML,
          children: [
            { labels: ["AI-Implement"], stateType: "completed" },
            { labels: ["AI-Implement"], stateType: "canceled" },
          ],
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      const parent = snap.needsPlanning.find((i) => i.id === "parent")!;
      expect(parent.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "multi-issue" }]);
    });

    it("strips the config block from the description handed to the runner", async () => {
      const descWithConfig = `Group of unrelated work.\n\n${MULTI_YML}`;
      mockSinglePage([
        makeIssue({
          id: "parent",
          identifier: "OOL-78",
          labels: ["AI-Implement"],
          description: descWithConfig,
          children: [
            { labels: ["AI-Implement"], stateType: "completed" },
          ],
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      const parent = snap.needsPlanning.find((i) => i.id === "parent")!;
      expect(parent.description).toBe("Group of unrelated work.");
      expect(parent.description).not.toContain("feature_branch");
    });
  });

  it("counts AI-Working / AI-Planning issues by scope and excludes them from buckets", async () => {
    mockSinglePage([
      makeIssue({ id: "a", teamKey: "T1", labels: ["AI-Implement", "AI-Working"] }),
      makeIssue({ id: "b", teamKey: "T2", labels: ["AI-Implement", "AI-Planning"] }),
    ]);

    const p = new LinearProvider({});
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

    const p = new LinearProvider({});
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

    const p = new LinearProvider({});
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.id)).toEqual(["b"]);
    expect(snap.readyForImplementation).toEqual([]);
  });
});

describe("LinearProvider.fetchFeatureNodeRollUps", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  function mockResponse(nodes: unknown[]) {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { issues: { nodes } } }),
    } as Response);
  }
  const labels = (...names: string[]) => ({ nodes: names.map((name) => ({ name })) });
  const MULTI_YML = ["```yaml", "# ai-implement.yml", "feature_branch:", '  mode: "multi-issue"', "```"].join("\n");

  it("returns feature nodes with parent target; non-feature parent → null (base)", async () => {
    mockResponse([
      { identifier: "OOL-107", team: { key: "OOL" },
        children: { nodes: [{ identifier: "OOL-child1", labels: labels("AI-Implement") }] },
        parent: { identifier: "OOL-106", labels: labels("AI-Implement") } },
      { identifier: "OOL-106", team: { key: "OOL" },
        children: { nodes: [{ identifier: "OOL-child2", labels: labels("AI-Implement") }] },
        parent: null },
    ]);
    const rollUps = await new LinearProvider({}).fetchFeatureNodeRollUps();
    expect(rollUps).toEqual([
      { identifier: "OOL-107", scopeKey: "OOL", mode: "feature", parent: { identifier: "OOL-106", mode: "feature" }, childIdentifiers: ["OOL-child1"] },
      { identifier: "OOL-106", scopeKey: "OOL", mode: "feature", parent: null, childIdentifiers: ["OOL-child2"] },
    ]);
  });

  it("excludes completed issues that are not feature nodes (no AI-Implement child)", async () => {
    mockResponse([
      { identifier: "OOL-50", team: { key: "OOL" },
        children: { nodes: [{ labels: labels("Improvement") }] }, parent: null },
      { identifier: "OOL-51", team: { key: "OOL" },
        children: { nodes: [] }, parent: null },
    ]);
    const rollUps = await new LinearProvider({}).fetchFeatureNodeRollUps();
    expect(rollUps).toEqual([]);
  });

  it("carries each node's and its parent's mode onto the roll-up", async () => {
    mockResponse([
      {
        id: "ool-78-id",
        identifier: "OOL-78",
        description: MULTI_YML,
        team: { key: "OOL" },
        children: { nodes: [{ identifier: "OOL-87", labels: labels("AI-Implement") }] },
        parent: { identifier: "OOL-70", description: null, labels: labels("AI-Implement") },
      },
    ]);
    const [rollUp] = await new LinearProvider({}).fetchFeatureNodeRollUps();
    expect(rollUp.mode).toBe("multi-issue");
    expect(rollUp.parent).toEqual({ identifier: "OOL-70", mode: "feature" });
    expect(rollUp.childIdentifiers).toEqual(["OOL-87"]);
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

  it("uses the issue's Linear team when the provided scope key points elsewhere", async () => {
    // 1. getTeamKeyForIssue
    mockJsonOnce({ issue: { team: { key: "THR2" } } });
    // 2. getTeamIdByKey for the issue team, not the caller-provided scope key
    mockJsonOnce({ teams: { nodes: [{ id: "team-thr2", key: "THR2" }] } });
    // 3. ensureTeamLabel: same label exists on another team only, so create one for THR2
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-other-team", team: { id: "team-other" } }] } });
    // 4. ensureTeamLabel: create team-scoped label
    mockJsonOnce({ issueLabelCreate: { issueLabel: { id: "label-thr2-planning" } } });
    // 5. addLabelToIssue: fetch current labels
    mockJsonOnce({ issue: { labels: { nodes: [] } } });
    // 6. addLabelToIssue: issueUpdate
    mockJsonOnce({ issueUpdate: { success: true } });
    // 7. transitionToInProgressIfMovable — non-movable, so no state update
    mockJsonOnce({ issue: { state: { type: "started" } } });

    const p = new LinearProvider({});
    await p.markPlanningStarted("issue-1", "AII");

    const teamLookupBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
    expect(teamLookupBody.variables).toEqual({ key: "THR2" });

    const createBody = JSON.parse(vi.mocked(fetch).mock.calls[3][1]?.body as string);
    expect(createBody.variables).toEqual({ teamId: "team-thr2", name: "AI-Planning", color: "#8B5CF6" });

    const addBody = JSON.parse(vi.mocked(fetch).mock.calls[5][1]?.body as string);
    expect(addBody.variables).toEqual({ issueId: "issue-1", labelIds: ["label-thr2-planning"] });
  });

  it("ensures AI-Planning label, adds it to the issue, and transitions to In Progress when movable", async () => {
    // 1. getTeamKeyForIssue
    mockJsonOnce({ issue: { team: { key: "ENG" } } });
    // 2. getTeamIdByKey
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    // 3. ensureTeamLabel — find existing AI-Planning label
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-planning" }] } });
    // 4. addLabelToIssue — fetch current labels
    mockJsonOnce({ issue: { labels: { nodes: [] } } });
    // 5. addLabelToIssue — issueUpdate
    mockJsonOnce({ issueUpdate: { success: true } });
    // 6. transitionToInProgressIfMovable — fetch state.type (movable)
    mockJsonOnce({ issue: { state: { type: "unstarted" } } });
    // 7. getInProgressStateId — workflowStates query (team id is cached)
    mockJsonOnce({
      workflowStates: { nodes: [{ id: "state-inprog", name: "In Progress", type: "started" }] },
    });
    // 8. updateIssueState
    mockJsonOnce({ issueUpdate: { success: true } });

    const p = new LinearProvider({});
    await p.markPlanningStarted("issue-1", "ENG");

    expect(fetch).toHaveBeenCalledTimes(8);
    const lastBody = JSON.parse(vi.mocked(fetch).mock.calls[7][1]?.body as string);
    expect(lastBody.variables).toEqual({ issueId: "issue-1", stateId: "state-inprog" });
  });

  it("does not transition state when issue is in a non-movable state", async () => {
    mockJsonOnce({ issue: { team: { key: "ENG" } } });
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-planning" }] } });
    mockJsonOnce({ issue: { labels: { nodes: [] } } });
    mockJsonOnce({ issueUpdate: { success: true } });
    // state.type fetch returns "started" — not movable
    mockJsonOnce({ issue: { state: { type: "started" } } });

    const p = new LinearProvider({});
    await p.markPlanningStarted("issue-1", "ENG");

    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("creates AI-Planning label with #8B5CF6 color when not found", async () => {
    mockJsonOnce({ issue: { team: { key: "ENG" } } });
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

    const p = new LinearProvider({});
    await p.markPlanningStarted("issue-1", "ENG");

    const createBody = JSON.parse(vi.mocked(fetch).mock.calls[3][1]?.body as string);
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

    const p = new LinearProvider({});
    await p.markPlanComplete("issue-1", "team-a");

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
    mockJsonOnce({ issue: { team: { key: "ENG" } } });
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-aw" }] } });
    mockJsonOnce({ issue: { labels: { nodes: [] } } });
    mockJsonOnce({ issueUpdate: { success: true } });
    // state.type fetch returns "started" — not movable, no transition
    mockJsonOnce({ issue: { state: { type: "started" } } });

    const p = new LinearProvider({});
    await p.markImplementing("issue-1", "ENG");

    expect(fetch).toHaveBeenCalledTimes(6);
    const addBody = JSON.parse(vi.mocked(fetch).mock.calls[4][1]?.body as string);
    expect(addBody.variables).toEqual({ issueId: "issue-1", labelIds: ["label-aw"] });
  });

  it("does not transition state when issue is in a non-movable state", async () => {
    mockJsonOnce({ issue: { team: { key: "ENG" } } });
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-aw" }] } });
    mockJsonOnce({ issue: { labels: { nodes: [] } } });
    mockJsonOnce({ issueUpdate: { success: true } });
    // state.type "completed" — not movable
    mockJsonOnce({ issue: { state: { type: "completed" } } });

    const p = new LinearProvider({});
    await p.markImplementing("issue-1", "ENG");

    // 4 setup/label fetches + 1 state.type query, but no getInProgressStateId/updateIssueState
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("transitions state to In Progress when issue is in a movable state", async () => {
    mockJsonOnce({ issue: { team: { key: "ENG" } } });
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

    const p = new LinearProvider({});
    await p.markImplementing("issue-1", "ENG");

    expect(fetch).toHaveBeenCalledTimes(8);
    const lastBody = JSON.parse(vi.mocked(fetch).mock.calls[7][1]?.body as string);
    expect(lastBody.variables).toEqual({ issueId: "issue-1", stateId: "state-inprog" });
  });

  it("creates AI-Working label with #F59E0B color when not found", async () => {
    mockJsonOnce({ issue: { team: { key: "ENG" } } });
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ issueLabels: { nodes: [] } });
    mockJsonOnce({ issueLabelCreate: { issueLabel: { id: "new-label" } } });
    mockJsonOnce({ issue: { labels: { nodes: [] } } });
    mockJsonOnce({ issueUpdate: { success: true } });
    // state.type fetch — not movable to keep mock count minimal
    mockJsonOnce({ issue: { state: { type: "started" } } });

    const p = new LinearProvider({});
    await p.markImplementing("issue-1", "ENG");

    const createBody = JSON.parse(vi.mocked(fetch).mock.calls[3][1]?.body as string);
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

    const p = new LinearProvider({});
    await p.markPrReady("issue-1", "team-a", "https://github.com/o/r/pull/7");

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
    // second removeLabelByName call for AI-Planning — not present, no mutation
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lo", name: "Other" }] } } });

    const p = new LinearProvider({});
    await p.clearWorkingState("issue-1", "team-a");

    expect(fetch).toHaveBeenCalledTimes(3);
    const updateBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
    expect(updateBody.variables).toEqual({ issueId: "issue-1", labelIds: ["lo"] });
  });

  it("removes the AI-Planning label from the issue", async () => {
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lp", name: "AI-Planning" }, { id: "lo", name: "Other" }] } } });
    // AI-Working absent — no mutation
    // second removeLabelByName call for AI-Planning
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lp", name: "AI-Planning" }, { id: "lo", name: "Other" }] } } });
    mockJsonOnce({ issueUpdate: { success: true } });

    const p = new LinearProvider({});
    await p.clearWorkingState("issue-1", "team-a");

    expect(fetch).toHaveBeenCalledTimes(3);
    const updateBody = JSON.parse(vi.mocked(fetch).mock.calls[2][1]?.body as string);
    expect(updateBody.variables).toEqual({ issueId: "issue-1", labelIds: ["lo"] });
  });

  it("no-ops (no mutation) when AI-Working label is absent", async () => {
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lo", name: "Other" }] } } });
    // second removeLabelByName call for AI-Planning — also absent
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lo", name: "Other" }] } } });

    const p = new LinearProvider({});
    await p.clearWorkingState("issue-1", "team-a");

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("no-ops when the issue has no labels at all", async () => {
    mockJsonOnce({ issue: { labels: { nodes: [] } } });
    // second removeLabelByName call for AI-Planning — also empty
    mockJsonOnce({ issue: { labels: { nodes: [] } } });

    const p = new LinearProvider({});
    await p.clearWorkingState("issue-1", "team-a");

    // Two labels-fetch queries run; no update mutation when there's nothing to remove
    expect(fetch).toHaveBeenCalledTimes(2);
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

    const p = new LinearProvider({});
    await p.markPlanningFailed("issue-1", "team-a", "GraphQL exploded");

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

    const p = new LinearProvider({});
    await p.markImplementationFailed("issue-1", "team-a", "tests timed out");

    const lastCall = vi.mocked(fetch).mock.calls.at(-1)!;
    const body = JSON.parse(lastCall[1]?.body as string);
    expect(body.variables.body).toContain("Implementation failed: tests timed out");
  });
});

describe("LinearProvider.markMerged", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("moves a started issue to Done and drops the Ready for Review label", async () => {
    // 1. fetch issue state, team key, and labels
    mockJsonOnce({ issue: { state: { type: "started" }, team: { key: "ENG" }, labels: { nodes: [{ id: "L1", name: "Ready for Review" }, { id: "L2", name: "bug" }] } } });
    // 2. getTeamIdByKey
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    // 3. getCompletedStateId: workflowStates query
    mockJsonOnce({ workflowStates: { nodes: [{ id: "s-rel", name: "Released", type: "completed" }, { id: "s-done", name: "Done", type: "completed" }] } });
    // 4. issueUpdate: move state + drop label
    mockJsonOnce({ issueUpdate: { success: true } });

    const p = new LinearProvider({ linearWorkspaceUrl: "https://linear.app/acme" });
    await p.markMerged("issue-1", "team-a");

    expect(fetch).toHaveBeenCalledTimes(4);
    const updateBody = JSON.parse(vi.mocked(fetch).mock.calls[3][1]?.body as string);
    expect(updateBody.variables).toMatchObject({ issueId: "issue-1", stateId: "s-done", labelIds: ["L2"] });
  });

  it("no-ops when the issue is already completed", async () => {
    mockJsonOnce({ issue: { state: { type: "completed" }, team: { key: "ENG" }, labels: { nodes: [] } } });

    const p = new LinearProvider({});
    await p.markMerged("issue-1", "team-a");

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the issue is already canceled", async () => {
    mockJsonOnce({ issue: { state: { type: "canceled" }, team: { key: "ENG" }, labels: { nodes: [] } } });

    const p = new LinearProvider({});
    await p.markMerged("issue-1", "team-a");

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the first completed state when none is named Done", async () => {
    // 1. fetch issue state, team key, labels
    mockJsonOnce({ issue: { state: { type: "unstarted" }, team: { key: "ENG" }, labels: { nodes: [] } } });
    // 2. getTeamIdByKey
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    // 3. workflowStates — only "Shipped", no "Done"
    mockJsonOnce({ workflowStates: { nodes: [{ id: "s-shipped", name: "Shipped", type: "completed" }] } });
    // 4. issueUpdate
    mockJsonOnce({ issueUpdate: { success: true } });

    const p = new LinearProvider({});
    await p.markMerged("issue-1", "team-a");

    const updateBody = JSON.parse(vi.mocked(fetch).mock.calls[3][1]?.body as string);
    expect(updateBody.variables.stateId).toBe("s-shipped");
  });

  it("keeps all labels except Ready for Review", async () => {
    mockJsonOnce({ issue: { state: { type: "started" }, team: { key: "ENG" }, labels: { nodes: [{ id: "L1", name: "Ready for Review" }, { id: "L2", name: "bug" }, { id: "L3", name: "AI-Implement" }] } } });
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ workflowStates: { nodes: [{ id: "s-done", name: "Done", type: "completed" }] } });
    mockJsonOnce({ issueUpdate: { success: true } });

    const p = new LinearProvider({});
    await p.markMerged("issue-1", "team-a");

    const updateBody = JSON.parse(vi.mocked(fetch).mock.calls[3][1]?.body as string);
    expect(updateBody.variables.labelIds).toEqual(["L2", "L3"]);
  });
});

describe("LinearProvider.issueUrl", () => {
  it("uses linearWorkspaceUrl when provided", () => {
    const p = new LinearProvider({ linearWorkspaceUrl: "https://linear.app/acme" });
    expect(p.issueUrl({
      id: "u", identifier: "ENG-1", title: "t", description: null, scopeKey: "ENG", nativeStatus: "",
    })).toBe("https://linear.app/acme/issue/ENG-1");
  });

  it("falls back to https://linear.app when workspace URL is unset", () => {
    const p = new LinearProvider({});
    expect(p.issueUrl({
      id: "u", identifier: "ENG-1", title: "t", description: null, scopeKey: "ENG", nativeStatus: "",
    })).toBe("https://linear.app/issue/ENG-1");
  });
});

describe("LinearProvider.findByKey", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns null for malformed identifiers", async () => {
    const p = new LinearProvider({});
    expect(await p.findByKey("not a key")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null when the GraphQL query yields no nodes", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { issues: { nodes: [] } } }),
    } as Response);
    const p = new LinearProvider({});
    expect(await p.findByKey("ENG-999")).toBeNull();
  });

  it("bubbles non-404 errors from the Linear API", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "boom",
    } as Response);
    const p = new LinearProvider({});
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
    const p = new LinearProvider({});
    const issue = await p.findByKey("ENG-1");
    expect(issue).toEqual({
      id: "issue-uuid", identifier: "ENG-1", title: "Hello", description: "World",
      scopeKey: "ENG", nativeStatus: "Todo (unstarted)",
    });
  });
});
