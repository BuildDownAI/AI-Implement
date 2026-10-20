import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LinearProvider } from "../../providers/linear.js";
import { MissingProviderConfigError, TrackerUnavailableError, type TicketingProvider } from "../../providers/types.js";
import {
  configureLinearAuth,
  __setLinearTokenForTest,
  __resetLinearAuthForTest,
} from "../../linear-app-auth.js";
import { makeIssue, makeMapping } from "../helpers/builders.js";
import type { FakeFetch, Reply } from "../helpers/fake-fetch.js";
import { linearData as data, linearGraphql } from "../helpers/replies/linear.js";

// Linear auth lives in the linear-app-auth singleton now (not on ProviderConfig). Configure it
// and seed a token before every test so the provider's requests carry `Bearer test-token`, and
// no mint round-trip is injected into the request counts these assertions rely on.
beforeEach(() => {
  configureLinearAuth("client-id", "client-secret");
  __setLinearTokenForTest("test-token");
});

const linear = (...replies: Reply[]): FakeFetch => linearGraphql(...replies).install();

const variables = (fake: FakeFetch, n: number) => JSON.parse(fake.calls[n].body).variables;

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
  it("sends the GraphQL commentCreate mutation with issueId and body", async () => {
    const fake = linear(data({ commentCreate: { success: true } }));

    const p = new LinearProvider({});
    await p.postComment("issue-uuid-1", "Hello body");

    expect(fake.calls[0].url.href).toBe("https://api.linear.app/graphql");
    expect(fake.calls[0].headers.get("Authorization")).toBe("Bearer test-token");
    expect(variables(fake, 0)).toEqual({ issueId: "issue-uuid-1", body: "Hello body" });
  });

  it("throws on Linear HTTP error", async () => {
    linear({ status: 500, text: "boom" });

    const p = new LinearProvider({});
    await expect(p.postComment("i", "b")).rejects.toThrow(/Linear API error/);
  });

  it("throws on Linear GraphQL error", async () => {
    linear({ json: { data: null, errors: [{ message: "Permission denied", path: ["commentCreate"] }] } });

    const p = new LinearProvider({});
    await expect(p.postComment("i", "b")).rejects.toThrow(/Permission denied/);
  });
});

describe("LinearProvider.fetchPlanningContext", () => {
  it("returns the issue's planning comments, authenticated as the app", async () => {
    const fake = linear(data({
      issue: {
        comments: {
          nodes: [
            { body: "## 🏗️ AI Planning: Architecture Analysis\nUse the widget pattern.", createdAt: "2026-01-01T00:00:00Z" },
            { body: "just a regular human comment", createdAt: "2026-01-02T00:00:00Z" },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }));

    const p = new LinearProvider({});
    const ctx = await p.fetchPlanningContext("issue-uuid-1");

    expect(ctx).toContain("Use the widget pattern.");
    expect(ctx).not.toContain("just a regular human comment");
    expect(fake.calls[0].url.href).toBe("https://api.linear.app/graphql");
    expect(fake.calls[0].headers.get("Authorization")).toBe("Bearer test-token");
  });

  it("returns empty string (never throws) when Linear is unreachable", async () => {
    linear({ status: 500 });

    const p = new LinearProvider({});
    await expect(p.fetchPlanningContext("issue-uuid-1")).resolves.toBe("");
  });
});

describe("LinearProvider.fetchLifecycleStates", () => {
  it("maps Linear state.type to IssueLifecycleState", async () => {
    linear(data({
      issues: {
        nodes: [
          { id: "a", state: { type: "completed" } },
          { id: "b", state: { type: "canceled" } },
          { id: "c", state: { type: "started" } },
          { id: "d", state: { type: "unstarted" } },
        ],
      },
    }));

    const p = new LinearProvider({});
    const states = await p.fetchLifecycleStates(["a", "b", "c", "d", "missing"]);

    expect(states.get("a")).toBe("completed");
    expect(states.get("b")).toBe("cancelled");
    expect(states.get("c")).toBe("active");
    expect(states.get("d")).toBe("active");
    expect(states.has("missing")).toBe(false);
  });

  it("returns empty map when called with empty array, makes no fetch", async () => {
    const fake = linear();
    const p = new LinearProvider({});
    const states = await p.fetchLifecycleStates([]);
    expect(states.size).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("LinearProvider.fetchAIImplementSnapshot", () => {
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

  // One issue as the snapshot query returns it. Linear derives an identifier from its team's key,
  // so the team key is the identifier's prefix and each child is numbered after its parent.
  function issueNode(overrides: {
    id?: string;
    identifier?: string;
    title?: string;
    description?: string | null;
    stateName?: string;
    stateType?: string;
    labels?: string[];
    inverseRelations?: Array<{ type: string; issue: { state: { type: string } } }>;
    parent?: Ancestor | null;
    children?: Child[];
  } = {}) {
    const identifier = overrides.identifier ?? "ENG-1";
    const [teamKey, number] = identifier.split("-");
    return {
      id: overrides.id ?? "uuid-1",
      identifier,
      title: overrides.title ?? "Title",
      description: overrides.description ?? null,
      team: { id: `team-${teamKey}`, key: teamKey },
      state: {
        id: "state-id",
        name: overrides.stateName ?? "Todo",
        type: overrides.stateType ?? "unstarted",
      },
      labels: { nodes: (overrides.labels ?? []).map((name) => ({ id: `label-${name}`, name })) },
      inverseRelations: { nodes: overrides.inverseRelations ?? [] },
      children: {
        nodes: (overrides.children ?? []).map((c, i) => ({
          identifier: `${teamKey}-${Number(number) + 1 + i}`,
          state: { type: c.stateType ?? "unstarted" },
          labels: labelNodes(c.labels),
        })),
      },
      parent: ancestorNode(overrides.parent),
    };
  }

  function singlePage(nodes: ReturnType<typeof issueNode>[]) {
    return linear(data({ issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } }));
  }

  it("buckets issues by Plan-Complete label", async () => {
    singlePage([
      issueNode({ id: "a", identifier: "ENG-1", labels: ["AI-Implement", "Plan-Complete"] }),
      issueNode({ id: "b", identifier: "ENG-2", labels: ["AI-Implement"] }),
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
    singlePage([
      issueNode({
        id: "child",
        identifier: "ENG-2",
        labels: ["AI-Implement", "Plan-Complete"],
        parent: { identifier: "ENG-1", labels: ["AI-Implement"] },
      }),
      issueNode({ id: "orphan", identifier: "ENG-9", labels: ["AI-Implement", "Plan-Complete"] }),
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
      singlePage([
        issueNode({
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
      singlePage([
        issueNode({
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
      singlePage([
        issueNode({
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
      singlePage([
        issueNode({
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
      singlePage([
        issueNode({
          id: "parent",
          identifier: "OOL-78",
          labels: ["AI-Implement"],
          description: "Closing work spec.",
          children: [
            { labels: ["AI-Implement"], stateType: "completed" },
            { labels: ["AI-Implement"], stateType: "canceled" },
            { labels: ["Improvement"], stateType: "completed" }, // non-AI child, but terminal
          ],
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      const parent = snap.needsPlanning.find((i) => i.id === "parent")!;
      expect(parent.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }]);
    });

    it("AII-349 race guard: skips parent when some AI children are Done but unlabeled active children remain", async () => {
      // Operator labeled parent first, then 325/326/327 are Done (by hand) but 328/329
      // are not yet labeled with AI-Implement. The parent must wait — not finalize.
      singlePage([
        issueNode({
          id: "parent",
          identifier: "AII-324",
          labels: ["AI-Implement"],
          description: "Closing work spec.",
          children: [
            { labels: ["AI-Implement"], stateType: "completed" }, // 325 — Done by hand
            { labels: ["AI-Implement"], stateType: "completed" }, // 326 — Done by hand
            { labels: ["AI-Implement"], stateType: "completed" }, // 327 — Done by hand
            { labels: [], stateType: "unstarted" },               // 328 — not yet labeled
            { labels: [], stateType: "unstarted" },               // 329 — not yet labeled
          ],
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      expect(snap.needsPlanning).toEqual([]);
      expect(snap.readyForImplementation).toEqual([]);
      expect(snap.parentsToFinalize).toEqual([]);
    });

    it("AII-349 race guard: does not finalize blank-spec parent when unlabeled active children remain", async () => {
      singlePage([
        issueNode({
          id: "parent",
          identifier: "AII-324",
          labels: ["AI-Implement"],
          description: null, // blank spec → would finalize if guard didn't apply
          children: [
            { labels: ["AI-Implement"], stateType: "completed" },
            { labels: [], stateType: "unstarted" }, // not yet labeled
          ],
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      expect(snap.parentsToFinalize).toEqual([]);
    });

    it("AII-349 race guard: non-AI child in terminal state does NOT gate dispatch", async () => {
      // A non-AI child that is Done (e.g. completed by human outside the pipeline) should
      // not block the parent — only active undesignated children trigger the guard.
      singlePage([
        issueNode({
          id: "parent",
          identifier: "OOL-78",
          labels: ["AI-Implement"],
          description: "Closing work spec.",
          children: [
            { labels: ["AI-Implement"], stateType: "completed" },
            { labels: ["Improvement"], stateType: "completed" }, // non-AI, terminal — OK
            { labels: ["Improvement"], stateType: "canceled" },  // non-AI, terminal — OK
          ],
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      const parent = snap.needsPlanning.find((i) => i.id === "parent")!;
      expect(parent).toBeDefined();
      expect(parent.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }]);
    });

    it("skips a labeled parent whose children are not yet AI-Implement (race guard)", async () => {
      singlePage([
        issueNode({
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
      singlePage([
        issueNode({
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
      singlePage([
        issueNode({
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
      singlePage([
        issueNode({
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
      singlePage([
        issueNode({
          id: "parent",
          identifier: "OOL-78",
          labels: ["AI-Implement"],
          description: `Closing work spec.\n\n${MULTI_YML}`,
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
      singlePage([
        issueNode({
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

    it("finalizes an empty-spec grouping parent (null description) instead of dispatching", async () => {
      singlePage([
        issueNode({
          id: "parent",
          identifier: "OOL-78",
          labels: ["AI-Implement"],
          description: null,
          children: [
            { labels: ["AI-Implement"], stateType: "completed" },
            { labels: ["AI-Implement"], stateType: "canceled" },
          ],
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      expect(snap.needsPlanning).toEqual([]);
      expect(snap.readyForImplementation).toEqual([]);
      expect(snap.parentsToFinalize).toEqual([
        { issueId: "parent", identifier: "OOL-78", scopeKey: "OOL" },
      ]);
    });

    it("finalizes an empty-spec grouping parent (ai-implement.yml-only description) instead of dispatching", async () => {
      singlePage([
        issueNode({
          id: "parent",
          identifier: "OOL-78",
          labels: ["AI-Implement"],
          description: MULTI_YML,
          children: [
            { labels: ["AI-Implement"], stateType: "completed" },
          ],
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      expect(snap.needsPlanning).toEqual([]);
      expect(snap.readyForImplementation).toEqual([]);
      expect(snap.parentsToFinalize).toEqual([
        { issueId: "parent", identifier: "OOL-78", scopeKey: "OOL" },
      ]);
    });

    it("dispatches a non-empty-spec grouping parent normally (no regression)", async () => {
      singlePage([
        issueNode({
          id: "parent",
          identifier: "OOL-78",
          labels: ["AI-Implement"],
          description: "## Do the work\n\nActual spec here.",
          children: [
            { labels: ["AI-Implement"], stateType: "completed" },
            { labels: ["AI-Implement"], stateType: "canceled" },
          ],
        }),
      ]);
      const snap = await new LinearProvider({}).fetchAIImplementSnapshot();
      const parent = snap.needsPlanning.find((i) => i.id === "parent")!;
      expect(parent.featureBranchChain).toEqual([{ identifier: "OOL-78", mode: "feature" }]);
      expect(snap.parentsToFinalize).toEqual([]);
    });
  });

  it("counts AI-Working / AI-Planning issues by scope and excludes them from buckets", async () => {
    singlePage([
      issueNode({ id: "a", identifier: "T1-1", labels: ["AI-Implement", "AI-Working"] }),
      issueNode({ id: "b", identifier: "T2-1", labels: ["AI-Implement", "AI-Planning"] }),
    ]);

    const p = new LinearProvider({});
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.inProgressCountsByScope).toEqual({ T1: 1, T2: 1 });
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
  });

  it("skips issues with Ready for Review label", async () => {
    singlePage([
      issueNode({ id: "a", identifier: "ENG-1", labels: ["AI-Implement", "Ready for Review"] }),
      issueNode({ id: "b", identifier: "ENG-2", labels: ["AI-Implement"] }),
    ]);

    const p = new LinearProvider({});
    const snap = await p.fetchAIImplementSnapshot();

    expect(snap.needsPlanning.map((i) => i.id)).toEqual(["b"]);
    expect(snap.readyForImplementation).toEqual([]);
    expect(snap.inProgressCountsByScope).toEqual({});
  });

  it("skips issues blocked by an open issue, includes ones whose blocker is completed", async () => {
    singlePage([
      issueNode({
        id: "a",
        identifier: "ENG-1",
        labels: ["AI-Implement"],
        inverseRelations: [{ type: "blocks", issue: { state: { type: "started" } } }],
      }),
      issueNode({
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
  afterEach(() => { vi.restoreAllMocks(); });

  function page(nodes: unknown[], pageInfo = { hasNextPage: false, endCursor: null as string | null }): Reply {
    return data({ issues: { nodes, pageInfo } });
  }
  const labels = (...names: string[]) => ({ nodes: names.map((name) => ({ name })) });
  const MULTI_YML = ["```yaml", "# ai-implement.yml", "feature_branch:", '  mode: "multi-issue"', "```"].join("\n");

  it("returns feature nodes with parent target; non-feature parent → null (base)", async () => {
    linear(page([
      { id: "ool-107-id", identifier: "OOL-107", description: null, team: { key: "OOL" },
        children: { nodes: [{ identifier: "OOL-108", state: { type: "completed" }, labels: labels("AI-Implement") }] },
        parent: { identifier: "OOL-106", description: null, labels: labels("AI-Implement") } },
      // OOL-107 is completed and labeled (it is in this page), so Linear lists it among its parent's children.
      { id: "ool-106-id", identifier: "OOL-106", description: null, team: { key: "OOL" },
        children: { nodes: [
          { identifier: "OOL-107", state: { type: "completed" }, labels: labels("AI-Implement") },
          { identifier: "OOL-109", state: { type: "canceled" }, labels: labels("AI-Implement") },
        ] },
        parent: null },
    ]));
    const rollUps = await new LinearProvider({}).fetchFeatureNodeRollUps();
    expect(rollUps).toEqual([
      { issueId: "ool-107-id", identifier: "OOL-107", scopeKey: "OOL", mode: "feature", parent: { identifier: "OOL-106", mode: "feature" }, childIdentifiers: ["OOL-108"] },
      { issueId: "ool-106-id", identifier: "OOL-106", scopeKey: "OOL", mode: "feature", parent: null, childIdentifiers: ["OOL-107", "OOL-109"] },
    ]);
  });

  it("excludes completed issues that are not feature nodes (no AI-Implement child)", async () => {
    linear(page([
      { id: "ool-50-id", identifier: "OOL-50", description: null, team: { key: "OOL" },
        children: { nodes: [{ identifier: "OOL-52", state: { type: "completed" }, labels: labels("Improvement") }] }, parent: null },
      { id: "ool-51-id", identifier: "OOL-51", description: null, team: { key: "OOL" },
        children: { nodes: [] }, parent: null },
    ]));
    const rollUps = await new LinearProvider({}).fetchFeatureNodeRollUps();
    expect(rollUps).toEqual([]);
  });

  it("carries each node's and its parent's mode onto the roll-up", async () => {
    linear(page([
      {
        id: "ool-78-id",
        identifier: "OOL-78",
        description: MULTI_YML,
        team: { key: "OOL" },
        children: { nodes: [{ identifier: "OOL-87", state: { type: "completed" }, labels: labels("AI-Implement") }] },
        parent: { identifier: "OOL-70", description: null, labels: labels("AI-Implement") },
      },
    ]));
    const [rollUp] = await new LinearProvider({}).fetchFeatureNodeRollUps();
    expect(rollUp.mode).toBe("multi-issue");
    expect(rollUp.parent).toEqual({ identifier: "OOL-70", mode: "feature" });
    expect(rollUp.childIdentifiers).toEqual(["OOL-87"]);
  });

  // AII-609: a node's own tracker state reaching "completed" must not be trusted as a
  // proxy for "all its children are terminal too" — the roll-up gate re-checks live.
  it("defers the roll-up while a designated child is not yet terminal (AII-609)", async () => {
    linear(page([
      { id: "aii-604-id", identifier: "AII-604", description: null, team: { key: "AII" },
        children: { nodes: [
          { identifier: "AII-607", state: { type: "completed" }, labels: labels("AI-Implement") },
          { identifier: "AII-608", state: { type: "started" }, labels: labels("AI-Implement") }, // still in flight
        ] },
        parent: null },
    ]));
    const rollUps = await new LinearProvider({}).fetchFeatureNodeRollUps();
    expect(rollUps).toEqual([]);
  });

  it("pages through every match so a feature node on a later page is found", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({
      id: `aii-${1000 + i}-id`, identifier: `AII-${1000 + i}`, description: null, team: { key: "AII" }, children: { nodes: [] }, parent: null,
    }));
    const fake = linear(
      page(filler, { hasNextPage: true, endCursor: "c1" }),
      page(
        [{ id: "aii-682-id", identifier: "AII-682", description: null, team: { key: "AII" },
          children: { nodes: [{ identifier: "AII-683", state: { type: "completed" }, labels: labels("AI-Implement") }] },
          parent: null }],
      ),
    );
    const rollUps = await new LinearProvider({}).fetchFeatureNodeRollUps();
    expect(rollUps.map((r) => r.identifier)).toEqual(["AII-682"]);
    expect(fake.calls).toHaveLength(2);
    expect(variables(fake, 0).after).toBeNull();
    expect(variables(fake, 0).first).toBe(100);
    expect(variables(fake, 1).after).toBe("c1");
  });

  it("stops after 20 pages and warns once when every page has a next page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Each page carries one completed issue that is not a feature node, as a real page past the cursor does.
    const fake = linear(...Array.from({ length: 20 }, (_, i) => page(
      [{ id: `aii-${2000 + i}-id`, identifier: `AII-${2000 + i}`, description: null, team: { key: "AII" }, children: { nodes: [] }, parent: null }],
      { hasNextPage: true, endCursor: `c${i}` },
    )));
    await new LinearProvider({}).fetchFeatureNodeRollUps();
    expect(fake.calls).toHaveLength(20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("fetchFeatureNodeRollUps");
  });
});

// ----- Lifecycle verb tests -----

describe("LinearProvider.markPlanningStarted", () => {
  it("uses the issue's Linear team when the provided scope key points elsewhere", async () => {
    const fake = linear(
      // 1. getTeamKeyForIssue
      data({ issue: { team: { key: "THR2" } } }),
      // 2. getTeamIdByKey for the issue team, not the caller-provided scope key
      data({ teams: { nodes: [{ id: "team-thr2", key: "THR2" }] } }),
      // 3. ensureTeamLabel: same label exists on another team only, so create one for THR2
      data({ issueLabels: { nodes: [{ id: "label-other-team", team: { id: "team-other" } }] } }),
      // 4. ensureTeamLabel: create team-scoped label
      data({ issueLabelCreate: { issueLabel: { id: "label-thr2-planning" } } }),
      // 5. addLabelToIssue: fetch current labels
      data({ issue: { labels: { nodes: [] } } }),
      // 6. addLabelToIssue: issueUpdate
      data({ issueUpdate: { success: true } }),
      // 7. transitionToInProgressIfMovable — non-movable, so no state update
      data({ issue: { state: { type: "started" } } }),
    );

    const p = new LinearProvider({});
    await p.markPlanningStarted("issue-1", "AII");

    expect(variables(fake, 1)).toEqual({ key: "THR2" });
    expect(variables(fake, 3)).toEqual({ teamId: "team-thr2", name: "AI-Planning", color: "#8B5CF6" });
    expect(variables(fake, 5)).toEqual({ issueId: "issue-1", labelIds: ["label-thr2-planning"] });
  });

  it("ensures AI-Planning label, adds it to the issue, and transitions to In Progress when movable", async () => {
    const fake = linear(
      // 1. getTeamKeyForIssue
      data({ issue: { team: { key: "ENG" } } }),
      // 2. getTeamIdByKey
      data({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } }),
      // 3. ensureTeamLabel — find existing AI-Planning label (workspace-level)
      data({ issueLabels: { nodes: [{ id: "label-planning", team: null }] } }),
      // 4. addLabelToIssue — fetch current labels
      data({ issue: { labels: { nodes: [] } } }),
      // 5. addLabelToIssue — issueUpdate
      data({ issueUpdate: { success: true } }),
      // 6. transitionToInProgressIfMovable — fetch state.type (movable)
      data({ issue: { state: { type: "unstarted" } } }),
      // 7. getInProgressStateId — workflowStates query (team id is cached)
      data({ workflowStates: { nodes: [{ id: "state-inprog", name: "In Progress", type: "started" }] } }),
      // 8. updateIssueState
      data({ issueUpdate: { success: true } }),
    );

    const p = new LinearProvider({});
    await p.markPlanningStarted("issue-1", "ENG");

    expect(fake.calls).toHaveLength(8);
    expect(variables(fake, 7)).toEqual({ issueId: "issue-1", stateId: "state-inprog" });
  });

  it("does not transition state when issue is in a non-movable state", async () => {
    const fake = linear(
      data({ issue: { team: { key: "ENG" } } }),
      data({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } }),
      data({ issueLabels: { nodes: [{ id: "label-planning", team: null }] } }),
      data({ issue: { labels: { nodes: [] } } }),
      data({ issueUpdate: { success: true } }),
      // state.type fetch returns "started" — not movable
      data({ issue: { state: { type: "started" } } }),
    );

    const p = new LinearProvider({});
    await p.markPlanningStarted("issue-1", "ENG");

    expect(fake.calls).toHaveLength(6);
  });

  it("creates AI-Planning label with #8B5CF6 color when not found", async () => {
    const fake = linear(
      data({ issue: { team: { key: "ENG" } } }),
      data({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } }),
      // ensureTeamLabel: search returns empty → create
      data({ issueLabels: { nodes: [] } }),
      data({ issueLabelCreate: { issueLabel: { id: "new-label" } } }),
      data({ issue: { labels: { nodes: [] } } }),
      data({ issueUpdate: { success: true } }),
      // state.type fetch (movable)
      data({ issue: { state: { type: "backlog" } } }),
      data({ workflowStates: { nodes: [{ id: "state-inprog", name: "In Progress", type: "started" }] } }),
      data({ issueUpdate: { success: true } }),
    );

    const p = new LinearProvider({});
    await p.markPlanningStarted("issue-1", "ENG");

    expect(variables(fake, 3)).toEqual({ teamId: "team-uuid", name: "AI-Planning", color: "#8B5CF6" });
  });
});

describe("LinearProvider.markPlanComplete", () => {
  it("removes AI-Planning label, then adds Plan-Complete label resolved via issue's team key", async () => {
    const fake = linear(
      // 1. removeLabelByName: fetch labels
      data({ issue: { labels: { nodes: [{ id: "lp", name: "AI-Planning" }, { id: "lo", name: "Other" }] } } }),
      // 2. removeLabelByName: issueUpdate to drop AI-Planning
      data({ issueUpdate: { success: true } }),
      // 3. getTeamKeyForIssue
      data({ issue: { team: { key: "ENG" } } }),
      // 4. getTeamIdByKey
      data({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } }),
      // 5. ensureTeamLabel: find existing Plan-Complete (workspace-level)
      data({ issueLabels: { nodes: [{ id: "label-pc", team: null }] } }),
      // 6. addLabelToIssue: fetch current labels
      data({ issue: { labels: { nodes: [{ id: "lo" }] } } }),
      // 7. addLabelToIssue: issueUpdate
      data({ issueUpdate: { success: true } }),
    );

    const p = new LinearProvider({});
    await p.markPlanComplete("issue-1", "ENG");

    expect(fake.calls).toHaveLength(7);
    expect(variables(fake, 1)).toEqual({ issueId: "issue-1", labelIds: ["lo"] });
    expect(variables(fake, 6).labelIds).toEqual(["lo", "label-pc"]);
  });
});

describe("LinearProvider.markImplementing", () => {
  it("ensures AI-Working label and adds it to the issue (no state transition when not movable)", async () => {
    const fake = linear(
      data({ issue: { team: { key: "ENG" } } }),
      data({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } }),
      data({ issueLabels: { nodes: [{ id: "label-aw", team: null }] } }),
      data({ issue: { labels: { nodes: [] } } }),
      data({ issueUpdate: { success: true } }),
      // state.type fetch returns "started" — not movable, no transition
      data({ issue: { state: { type: "started" } } }),
    );

    const p = new LinearProvider({});
    await p.markImplementing("issue-1", "ENG");

    expect(fake.calls).toHaveLength(6);
    expect(variables(fake, 4)).toEqual({ issueId: "issue-1", labelIds: ["label-aw"] });
  });

  it("does not transition state when issue is in a non-movable state", async () => {
    const fake = linear(
      data({ issue: { team: { key: "ENG" } } }),
      data({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } }),
      data({ issueLabels: { nodes: [{ id: "label-aw", team: null }] } }),
      data({ issue: { labels: { nodes: [] } } }),
      data({ issueUpdate: { success: true } }),
      // state.type "completed" — not movable
      data({ issue: { state: { type: "completed" } } }),
    );

    const p = new LinearProvider({});
    await p.markImplementing("issue-1", "ENG");

    // 4 setup/label requests + 1 state.type query, but no getInProgressStateId/updateIssueState
    expect(fake.calls).toHaveLength(6);
  });

  it("transitions state to In Progress when issue is in a movable state", async () => {
    const fake = linear(
      data({ issue: { team: { key: "ENG" } } }),
      data({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } }),
      data({ issueLabels: { nodes: [{ id: "label-aw", team: null }] } }),
      data({ issue: { labels: { nodes: [] } } }),
      data({ issueUpdate: { success: true } }),
      // state.type "backlog" — movable
      data({ issue: { state: { type: "backlog" } } }),
      // getInProgressStateId
      data({ workflowStates: { nodes: [{ id: "state-inprog", name: "In Progress", type: "started" }] } }),
      // updateIssueState
      data({ issueUpdate: { success: true } }),
    );

    const p = new LinearProvider({});
    await p.markImplementing("issue-1", "ENG");

    expect(fake.calls).toHaveLength(8);
    expect(variables(fake, 7)).toEqual({ issueId: "issue-1", stateId: "state-inprog" });
  });

  it("creates AI-Working label with #F59E0B color when not found", async () => {
    const fake = linear(
      data({ issue: { team: { key: "ENG" } } }),
      data({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } }),
      data({ issueLabels: { nodes: [] } }),
      data({ issueLabelCreate: { issueLabel: { id: "new-label" } } }),
      data({ issue: { labels: { nodes: [] } } }),
      data({ issueUpdate: { success: true } }),
      // state.type fetch — not movable to keep the request count minimal
      data({ issue: { state: { type: "started" } } }),
    );

    const p = new LinearProvider({});
    await p.markImplementing("issue-1", "ENG");

    expect(variables(fake, 3)).toEqual({ teamId: "team-uuid", name: "AI-Working", color: "#F59E0B" });
  });
});

describe("LinearProvider.markPrReady", () => {
  it("swaps AI-Working for Ready for Review atomically and posts a PR comment", async () => {
    const fake = linear(
      // 1. ensureWorkspaceReadyForReviewLabel: search workspace
      data({ issueLabels: { nodes: [{ id: "label-rfr" }] } }),
      // 2. fetch issue labels for swap
      data({ issue: { labels: { nodes: [{ id: "lw", name: "AI-Working" }, { id: "lo", name: "Other" }] } } }),
      // 3. issueUpdate label swap
      data({ issueUpdate: { success: true } }),
      // 4. postComment
      data({ commentCreate: { success: true } }),
    );

    const p = new LinearProvider({});
    await p.markPrReady("issue-1", "ENG", "https://github.com/o/r/pull/7");

    expect(fake.calls).toHaveLength(4);
    expect(variables(fake, 2)).toEqual({ issueId: "issue-1", labelIds: ["lo", "label-rfr"] });
    expect(variables(fake, 3)).toEqual({
      issueId: "issue-1",
      body: "AI implementation PR: https://github.com/o/r/pull/7",
    });
  });
});

describe("LinearProvider.clearWorkingState", () => {
  it("removes the AI-Working label from the issue", async () => {
    const fake = linear(
      data({ issue: { labels: { nodes: [{ id: "lw", name: "AI-Working" }, { id: "lo", name: "Other" }] } } }),
      data({ issueUpdate: { success: true } }),
      // second removeLabelByName call for AI-Planning — not present, no mutation
      data({ issue: { labels: { nodes: [{ id: "lo", name: "Other" }] } } }),
    );

    const p = new LinearProvider({});
    await p.clearWorkingState("issue-1", "ENG");

    expect(fake.calls).toHaveLength(3);
    expect(variables(fake, 1)).toEqual({ issueId: "issue-1", labelIds: ["lo"] });
  });

  it("removes the AI-Planning label from the issue", async () => {
    const fake = linear(
      data({ issue: { labels: { nodes: [{ id: "lp", name: "AI-Planning" }, { id: "lo", name: "Other" }] } } }),
      // AI-Working absent — no mutation
      // second removeLabelByName call for AI-Planning
      data({ issue: { labels: { nodes: [{ id: "lp", name: "AI-Planning" }, { id: "lo", name: "Other" }] } } }),
      data({ issueUpdate: { success: true } }),
    );

    const p = new LinearProvider({});
    await p.clearWorkingState("issue-1", "ENG");

    expect(fake.calls).toHaveLength(3);
    expect(variables(fake, 2)).toEqual({ issueId: "issue-1", labelIds: ["lo"] });
  });

  it("no-ops (no mutation) when AI-Working label is absent", async () => {
    const fake = linear(
      data({ issue: { labels: { nodes: [{ id: "lo", name: "Other" }] } } }),
      // second removeLabelByName call for AI-Planning — also absent
      data({ issue: { labels: { nodes: [{ id: "lo", name: "Other" }] } } }),
    );

    const p = new LinearProvider({});
    await p.clearWorkingState("issue-1", "ENG");

    expect(fake.calls).toHaveLength(2);
  });

  it("no-ops when the issue has no labels at all", async () => {
    const fake = linear(
      data({ issue: { labels: { nodes: [] } } }),
      // second removeLabelByName call for AI-Planning — also empty
      data({ issue: { labels: { nodes: [] } } }),
    );

    const p = new LinearProvider({});
    await p.clearWorkingState("issue-1", "ENG");

    // Two labels-fetch queries run; no update mutation when there's nothing to remove
    expect(fake.calls).toHaveLength(2);
  });
});

describe("LinearProvider.markPlanningFailed", () => {
  it("removes AI-Planning label and posts a failure comment", async () => {
    const fake = linear(
      data({ issue: { labels: { nodes: [{ id: "lblP", name: "AI-Planning" }] } } }),
      data({ issueUpdate: { success: true } }),
      data({ commentCreate: { success: true } }),
    );

    const p = new LinearProvider({});
    const commented = await p.markPlanningFailed("issue-1", "ENG", "GraphQL exploded");

    expect(variables(fake, fake.calls.length - 1).body).toContain("Planning failed: GraphQL exploded");
    expect(commented).toBe(true);
  });
});

describe("LinearProvider.markImplementationFailed", () => {
  it("removes AI-Working label and posts a failure comment", async () => {
    const fake = linear(
      data({ issue: { labels: { nodes: [{ id: "lblW", name: "AI-Working" }] } } }),
      data({ issueUpdate: { success: true } }),
      data({ commentCreate: { success: true } }),
    );

    const p = new LinearProvider({});
    const commented = await p.markImplementationFailed("issue-1", "ENG", "tests timed out");

    expect(variables(fake, fake.calls.length - 1).body).toContain("Implementation failed: tests timed out");
    expect(commented).toBe(true);
  });
});

describe("LinearProvider.markMerged", () => {
  it("moves a started issue to Done and drops the Ready for Review label", async () => {
    const fake = linear(
      // 1. fetch issue state, team key, and labels
      data({ issue: { state: { type: "started" }, team: { key: "ENG" }, labels: { nodes: [{ id: "L1", name: "Ready for Review" }, { id: "L2", name: "bug" }] } } }),
      // 2. getTeamIdByKey
      data({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } }),
      // 3. getCompletedStateId: workflowStates query
      data({ workflowStates: { nodes: [{ id: "s-rel", name: "Released", type: "completed" }, { id: "s-done", name: "Done", type: "completed" }] } }),
      // 4. issueUpdate: move state + drop label
      data({ issueUpdate: { success: true } }),
    );

    const p = new LinearProvider({});
    await p.markMerged("issue-1", "ENG");

    expect(fake.calls).toHaveLength(4);
    expect(variables(fake, 3)).toMatchObject({ issueId: "issue-1", stateId: "s-done", labelIds: ["L2"] });
  });

  it("no-ops when the issue is already completed", async () => {
    const fake = linear(data({ issue: { state: { type: "completed" }, team: { key: "ENG" }, labels: { nodes: [] } } }));

    const p = new LinearProvider({});
    await p.markMerged("issue-1", "ENG");

    expect(fake.calls).toHaveLength(1);
  });

  it("no-ops when the issue is already canceled", async () => {
    const fake = linear(data({ issue: { state: { type: "canceled" }, team: { key: "ENG" }, labels: { nodes: [] } } }));

    const p = new LinearProvider({});
    await p.markMerged("issue-1", "ENG");

    expect(fake.calls).toHaveLength(1);
  });

  it("falls back to the first completed state when none is named Done", async () => {
    const fake = linear(
      // 1. fetch issue state, team key, labels
      data({ issue: { state: { type: "unstarted" }, team: { key: "ENG" }, labels: { nodes: [] } } }),
      // 2. getTeamIdByKey
      data({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } }),
      // 3. workflowStates — only "Shipped", no "Done"
      data({ workflowStates: { nodes: [{ id: "s-shipped", name: "Shipped", type: "completed" }] } }),
      // 4. issueUpdate
      data({ issueUpdate: { success: true } }),
    );

    const p = new LinearProvider({});
    await p.markMerged("issue-1", "ENG");

    expect(variables(fake, 3).stateId).toBe("s-shipped");
  });

  it("keeps all labels except Ready for Review", async () => {
    const fake = linear(
      data({ issue: { state: { type: "started" }, team: { key: "ENG" }, labels: { nodes: [{ id: "L1", name: "Ready for Review" }, { id: "L2", name: "bug" }, { id: "L3", name: "AI-Implement" }] } } }),
      data({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } }),
      data({ workflowStates: { nodes: [{ id: "s-done", name: "Done", type: "completed" }] } }),
      data({ issueUpdate: { success: true } }),
    );

    const p = new LinearProvider({});
    await p.markMerged("issue-1", "ENG");

    expect(variables(fake, 3).labelIds).toEqual(["L2", "L3"]);
  });
});

describe("LinearProvider.issueUrl", () => {
  it("uses linearWorkspaceUrl when provided", () => {
    const p = new LinearProvider({ linearWorkspaceUrl: "https://linear.app/acme" });
    expect(p.issueUrl(makeIssue({ identifier: "ENG-1" }))).toBe("https://linear.app/acme/issue/ENG-1");
  });

  it("falls back to https://linear.app when workspace URL is unset", () => {
    const p = new LinearProvider({});
    expect(p.issueUrl(makeIssue({ identifier: "ENG-1" }))).toBe("https://linear.app/issue/ENG-1");
  });
});

describe("LinearProvider.findByKey", () => {
  it("returns null for malformed identifiers", async () => {
    const fake = linear();
    const p = new LinearProvider({});
    expect(await p.findByKey("not a key")).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it("returns null when the GraphQL query yields no nodes", async () => {
    linear(data({ issues: { nodes: [] } }));
    const p = new LinearProvider({});
    expect(await p.findByKey("ENG-999")).toBeNull();
  });

  it("bubbles non-404 errors from the Linear API", async () => {
    linear({ status: 500, text: "boom" });
    const p = new LinearProvider({});
    await expect(p.findByKey("ENG-1")).rejects.toThrow(/Linear API error/);
  });

  it("returns a TicketIssue when found", async () => {
    linear(data({
      issues: {
        nodes: [{
          id: "issue-uuid", identifier: "ENG-1", title: "Hello", description: "World",
          team: { key: "ENG" }, state: { name: "Todo", type: "unstarted" },
        }],
      },
    }));
    const p = new LinearProvider({});
    const issue = await p.findByKey("ENG-1");
    expect(issue).toEqual({
      id: "issue-uuid", identifier: "ENG-1", title: "Hello", description: "World",
      scopeKey: "ENG", nativeStatus: "Todo (unstarted)",
    });
  });
});

describe("LinearProvider.listIssuesPage", () => {
  // The tracker export passes the stored mapping with the requested team as its teamKey.
  const mapping = makeMapping({ teamKey: "ENG" });
  const page = {
    issues: {
      nodes: [{
        id: "u1", identifier: "ENG-1", title: "T", description: "D", branchName: "eng-1",
        state: { name: "Todo", type: "unstarted" }, labels: { nodes: [{ name: "AI-Implement" }] },
        project: { name: "P" }, parent: { identifier: "ENG-0" },
        comments: { nodes: [{ body: "hi", user: { name: "A" }, createdAt: "2026-01-01T00:00:00Z" }] },
        relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "ENG-2" } }] },
      }],
      pageInfo: { hasNextPage: true, endCursor: "cur" },
    },
  };

  it("does not stamp sourceSystem or team on the records", async () => {
    linear(data(page));
    const result = await new LinearProvider({}).listIssuesPage(mapping, null);
    expect(result.issues[0]).not.toHaveProperty("sourceSystem");
    expect(result.issues[0]).not.toHaveProperty("team");
  });

  it("sends first 50 and the cursor", async () => {
    const fake = linear(data(page), data(page));
    const p = new LinearProvider({});
    await p.listIssuesPage(mapping, null);
    await p.listIssuesPage(mapping, "cur");
    expect([variables(fake, 0), variables(fake, 1)]).toEqual([
      { teamKey: "ENG", first: 50, after: null },
      { teamKey: "ENG", first: 50, after: "cur" },
    ]);
  });

  it("throws on a non-OK response", async () => {
    linear({ status: 500, text: "Internal Server Error" });
    await expect(new LinearProvider({}).listIssuesPage(mapping, null)).rejects.toThrow(/Linear API error/);
  });

  it("throws on GraphQL errors instead of returning an empty page", async () => {
    linear({ json: { data: null, errors: [{ message: "bad", path: ["issues"] }] } });
    await expect(new LinearProvider({}).listIssuesPage(mapping, null)).rejects.toThrow(/GraphQL error/);
  });

  it("throws TrackerUnavailableError without calling fetch when auth is unconfigured", async () => {
    const fake = linear();
    const p = new LinearProvider({});
    __resetLinearAuthForTest();
    await expect(p.listIssuesPage(mapping, null)).rejects.toBeInstanceOf(TrackerUnavailableError);
    expect(fake.calls).toHaveLength(0);
  });
});
