import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DedupModule from "../dedup.js";
import type * as RunnerModeModule from "../runner-mode.js";
import type * as OrchestratorSettingsModule from "../orchestrator-settings.js";
import type * as LinearAppAuthModule from "../linear-app-auth.js";
import type { LinearProvider as LinearProviderClass } from "../providers/linear.js";

// AII-694: the Linear provider reads its pickup label from the settings table
// (default "AI-Implement") instead of a hardcoded module constant. This suite
// exercises the provider/settings integration end-to-end with a mocked fetch,
// the same pattern src/__tests__/providers/linear.test.ts uses.

let dbPath: string;
let dedup: typeof DedupModule;
let runnerMode: typeof RunnerModeModule;
let settings: typeof OrchestratorSettingsModule;
let linearAuth: typeof LinearAppAuthModule;
let LinearProvider: typeof LinearProviderClass;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn());
  dbPath = path.join(
    os.tmpdir(),
    `linear-pickup-label-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  runnerMode = await import("../runner-mode.js");
  settings = await import("../orchestrator-settings.js");
  linearAuth = await import("../linear-app-auth.js");
  ({ LinearProvider } = await import("../providers/linear.js"));
  runnerMode.initSettingsTable();
  linearAuth.configureLinearAuth("client-id", "client-secret");
  linearAuth.__setLinearTokenForTest("test-token");
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

function mockJsonOnce(data: unknown) {
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data }),
  } as Response);
}

function lastCallBody(): { query: string; variables: Record<string, unknown> } {
  const call = vi.mocked(fetch).mock.calls.at(-1)!;
  return JSON.parse(call[1]?.body as string);
}

describe("LinearProvider.fetchAIImplementSnapshot — pickup label", () => {
  it("sends the default label as a variable when no row exists, and never inlines it in the query", async () => {
    mockJsonOnce({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });

    const p = new LinearProvider({});
    await p.fetchAIImplementSnapshot();

    const body = lastCallBody();
    expect(body.variables.label).toBe("AI-Implement");
    expect(body.query).toContain("$label: String!");
    expect(body.query).not.toContain('"AI-Implement"');
  });

  it("sends the stored label as the variable once set", async () => {
    settings.setOrchestratorSetting("linearPickupLabel", "AI Implement - New");
    mockJsonOnce({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });

    const p = new LinearProvider({});
    await p.fetchAIImplementSnapshot();

    expect(lastCallBody().variables.label).toBe("AI Implement - New");
  });

  it("a leaf carrying the configured label under a parent carrying it is designated into the feature chain", async () => {
    settings.setOrchestratorSetting("linearPickupLabel", "AI Implement - New");
    mockJsonOnce({
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
    mockJsonOnce({
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

    mockJsonOnce({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    await p.fetchAIImplementSnapshot();
    expect(lastCallBody().variables.label).toBe("AI-Implement");

    settings.setOrchestratorSetting("linearPickupLabel", "AI Implement - New");

    mockJsonOnce({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    await p.fetchAIImplementSnapshot();
    expect(lastCallBody().variables.label).toBe("AI Implement - New");
  });

  it("logs one line naming the active label when the snapshot returns zero open issues", async () => {
    settings.setOrchestratorSetting("linearPickupLabel", "AI Implement - New");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockJsonOnce({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });

    const p = new LinearProvider({});
    await p.fetchAIImplementSnapshot();

    expect(logSpy).toHaveBeenCalledWith('[linear] No open issues carry the pickup label "AI Implement - New"');
  });

  it("does not log the empty-poll line when at least one issue is returned", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockJsonOnce({
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
    mockJsonOnce({ issues: { nodes: [] } });

    const p = new LinearProvider({});
    await p.fetchFeatureNodeRollUps();

    const body = lastCallBody();
    expect(body.variables.label).toBe("AI-Implement");
    expect(body.query).toContain("$label: String!");
    expect(body.query).not.toContain('"AI-Implement"');
  });

  it("sends the stored label and uses it to classify the parent as a feature node", async () => {
    settings.setOrchestratorSetting("linearPickupLabel", "AI Implement - New");
    mockJsonOnce({
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
    mockJsonOnce({
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
