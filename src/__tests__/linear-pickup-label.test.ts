import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as OrchestratorSettingsModule from "../orchestrator-settings.js";
import type { LinearProvider as LinearProviderClass } from "../providers/linear.js";
import type { FakeFetch } from "./helpers/fake-fetch.js";
import { linearData, linearGraphql } from "./helpers/replies/linear.js";
import { testDb } from "./helpers/test-db.js";

// AII-694: the Linear provider reads its pickup label from the settings table
// (default "AI-Implement") instead of a hardcoded module constant. This suite
// exercises the provider/settings integration end-to-end with a faked Linear API,
// the same pattern src/__tests__/providers/linear.test.ts uses.

let settings: typeof OrchestratorSettingsModule;
let LinearProvider: typeof LinearProviderClass;
let fake: FakeFetch;

// Each GraphQL response in order, one per request; a request past the last fails the test.
function linearAnswers(...data: unknown[]): void {
  fake = linearGraphql(...data.map(linearData)).install();
}

beforeEach(async () => {
  const { modules } = await testDb({
    modules: {
      settings: () => import("../orchestrator-settings.js"),
      linearAuth: () => import("../linear-app-auth.js"),
      linear: () => import("../providers/linear.js"),
    },
  });
  settings = modules.settings;
  ({ LinearProvider } = modules.linear);
  modules.linearAuth.configureLinearAuth("client-id", "client-secret");
  modules.linearAuth.__setLinearTokenForTest("test-token");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function lastCallBody(): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(fake.calls.at(-1)!.body);
}

describe("LinearProvider.fetchAIImplementSnapshot — pickup label", () => {
  it("sends the default label as a variable when no row exists, and never inlines it in the query", async () => {
    linearAnswers({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });

    const p = new LinearProvider({});
    await p.fetchAIImplementSnapshot();

    const body = lastCallBody();
    expect(body.variables.label).toBe("AI-Implement");
    expect(body.query).toContain("$label: String!");
    expect(body.query).not.toContain('"AI-Implement"');
  });

  it("sends the stored label as the variable once set", async () => {
    settings.setOrchestratorSetting("linearPickupLabel", "AI Implement - New");
    linearAnswers({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });

    const p = new LinearProvider({});
    await p.fetchAIImplementSnapshot();

    expect(lastCallBody().variables.label).toBe("AI Implement - New");
  });

  it("a leaf carrying the configured label under a parent carrying it is designated into the feature chain", async () => {
    settings.setOrchestratorSetting("linearPickupLabel", "AI Implement - New");
    linearAnswers({
      issues: {
        nodes: [
          {
            id: "leaf",
            identifier: "ENG-2",
            title: "t",
            description: null,
            team: { id: "team-id", key: "ENG" },
            state: { id: "s", name: "Todo", type: "unstarted" },
            labels: { nodes: [{ id: "l0", name: "AI Implement - New" }] },
            inverseRelations: { nodes: [] },
            children: { nodes: [] },
            parent: {
              identifier: "ENG-1",
              description: null,
              labels: { nodes: [{ name: "AI Implement - New" }] },
              parent: null,
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    const p = new LinearProvider({});
    const snap = await p.fetchAIImplementSnapshot();

    const leaf = snap.needsPlanning.find((i) => i.id === "leaf")!;
    expect(leaf.featureBranchChain).toEqual([{ identifier: "ENG-1", mode: "feature" }]);
  });

  it("a parent whose child carries only the old default label is treated as undesignated, not the configured label", async () => {
    settings.setOrchestratorSetting("linearPickupLabel", "AI Implement - New");
    linearAnswers({
      issues: {
        nodes: [
          {
            id: "parent",
            identifier: "ENG-1",
            title: "t",
            description: "Closing work spec.",
            team: { id: "team-id", key: "ENG" },
            state: { id: "s", name: "Todo", type: "unstarted" },
            labels: { nodes: [{ id: "l0", name: "AI Implement - New" }] },
            inverseRelations: { nodes: [] },
            children: {
              nodes: [
                {
                  identifier: "ENG-1-c0",
                  state: { type: "unstarted" },
                  labels: { nodes: [{ name: "AI-Implement" }] }, // old default, not the configured label
                },
              ],
            },
            parent: null,
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    const p = new LinearProvider({});
    const snap = await p.fetchAIImplementSnapshot();

    // No child carries the configured label, so the parent is a waiting parent — skipped.
    expect(snap.needsPlanning).toEqual([]);
    expect(snap.readyForImplementation).toEqual([]);
    expect(snap.parentsToFinalize).toEqual([]);
  });

  it("re-reads the setting on every call — a later save takes effect without re-constructing the provider", async () => {
    const p = new LinearProvider({});
    const empty = { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    linearAnswers(empty, empty);

    await p.fetchAIImplementSnapshot();
    expect(lastCallBody().variables.label).toBe("AI-Implement");

    settings.setOrchestratorSetting("linearPickupLabel", "AI Implement - New");

    await p.fetchAIImplementSnapshot();
    expect(lastCallBody().variables.label).toBe("AI Implement - New");
  });

  it("logs one line naming the active label when the snapshot returns zero open issues", async () => {
    settings.setOrchestratorSetting("linearPickupLabel", "AI Implement - New");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    linearAnswers({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });

    const p = new LinearProvider({});
    await p.fetchAIImplementSnapshot();

    expect(logSpy).toHaveBeenCalledWith('[linear] No open issues carry the pickup label "AI Implement - New"');
  });

  it("does not log the empty-poll line when at least one issue is returned", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    linearAnswers({
      issues: {
        nodes: [
          {
            id: "a",
            identifier: "ENG-1",
            title: "t",
            description: null,
            team: { id: "team-id", key: "ENG" },
            state: { id: "s", name: "Todo", type: "unstarted" },
            labels: { nodes: [{ id: "l0", name: "AI-Implement" }] },
            inverseRelations: { nodes: [] },
            children: { nodes: [] },
            parent: null,
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    const p = new LinearProvider({});
    await p.fetchAIImplementSnapshot();

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("No open issues carry the pickup label"));
  });
});

describe("LinearProvider.fetchFeatureNodeRollUps — pickup label", () => {
  it("sends the label as a GraphQL variable, never inlined in the query", async () => {
    linearAnswers({ issues: { nodes: [] } });

    const p = new LinearProvider({});
    await p.fetchFeatureNodeRollUps();

    const body = lastCallBody();
    expect(body.variables.label).toBe("AI-Implement");
    expect(body.query).toContain("$label: String!");
    expect(body.query).not.toContain('"AI-Implement"');
  });

  it("sends the stored label and uses it to classify the parent as a feature node", async () => {
    settings.setOrchestratorSetting("linearPickupLabel", "AI Implement - New");
    linearAnswers({
      issues: {
        nodes: [
          {
            id: "node-id",
            identifier: "ENG-1",
            description: null,
            team: { key: "ENG" },
            children: {
              nodes: [
                { identifier: "ENG-1-c0", state: { type: "completed" }, labels: { nodes: [{ name: "AI Implement - New" }] } },
              ],
            },
            parent: { identifier: "ENG-0", description: null, labels: { nodes: [{ name: "AI Implement - New" }] } },
          },
        ],
      },
    });

    const p = new LinearProvider({});
    const rollUps = await p.fetchFeatureNodeRollUps();

    expect(lastCallBody().variables.label).toBe("AI Implement - New");
    expect(rollUps).toEqual([
      {
        issueId: "node-id",
        identifier: "ENG-1",
        scopeKey: "ENG",
        mode: "feature",
        parent: { identifier: "ENG-0", mode: "feature" },
        childIdentifiers: ["ENG-1-c0"],
      },
    ]);
  });

  it("a parent whose old-default-labeled ancestor no longer matches the configured label rolls up to base", async () => {
    settings.setOrchestratorSetting("linearPickupLabel", "AI Implement - New");
    linearAnswers({
      issues: {
        nodes: [
          {
            id: "node-id",
            identifier: "ENG-1",
            description: null,
            team: { key: "ENG" },
            children: {
              nodes: [
                { identifier: "ENG-1-c0", state: { type: "completed" }, labels: { nodes: [{ name: "AI Implement - New" }] } },
              ],
            },
            parent: { identifier: "ENG-0", description: null, labels: { nodes: [{ name: "AI-Implement" }] } },
          },
        ],
      },
    });

    const p = new LinearProvider({});
    const [rollUp] = await p.fetchFeatureNodeRollUps();

    expect(rollUp.parent).toBeNull();
  });
});
