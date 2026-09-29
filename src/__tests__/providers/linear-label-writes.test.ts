import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LinearProvider } from "../../providers/linear.js";
import { configureLinearAuth, __setLinearTokenForTest } from "../../linear-app-auth.js";

beforeEach(() => {
  configureLinearAuth("client-id", "client-secret");
  __setLinearTokenForTest("test-token");
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { vi.restoreAllMocks(); });

type Label = { id: string; name: string };

function mockJsonOnce(data: unknown) {
  vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ data }) } as Response);
}

function sentBody(call: number): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(vi.mocked(fetch).mock.calls[call][1]?.body as string);
}

function mutations() {
  return vi.mocked(fetch).mock.calls
    .map((c) => JSON.parse(c[1]?.body as string) as { query: string; variables: Record<string, unknown> })
    .filter((b) => b.query.includes("issueUpdate"));
}

describe("Linear label writes never replace the full label set", () => {
  it("a stale label read during the add does not restore a removed AI-Planning", async () => {
    // A tiny in-memory Linear: the label query is served from a STALE snapshot that still
    // carries AI-Planning, while issueUpdate mutations are applied to the live label set.
    let live: Label[] = [
      { id: "lp", name: "AI-Planning" },
      { id: "lo", name: "Other" },
    ];
    const stale: Label[] = [...live];
    const known: Label[] = [...live, { id: "label-pc", name: "Plan-Complete" }];

    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const { query, variables } = JSON.parse((init as RequestInit).body as string);
      let data: unknown;
      if (query.includes("issueUpdate")) {
        const input = (variables.input ?? {}) as {
          labelIds?: string[]; addedLabelIds?: string[]; removedLabelIds?: string[];
        };
        if (variables.labelIds) input.labelIds = variables.labelIds as string[];
        if (input.labelIds) {
          live = known.filter((l) => input.labelIds!.includes(l.id));
        } else {
          live = live.filter((l) => !input.removedLabelIds?.includes(l.id));
          for (const id of input.addedLabelIds ?? []) {
            const l = known.find((k) => k.id === id);
            if (l && !live.some((x) => x.id === id)) live.push(l);
          }
        }
        data = { issueUpdate: { success: true } };
      } else if (query.includes("labels { nodes")) {
        data = { issue: { labels: { nodes: stale } } };
      } else if (query.includes("team { key }")) {
        data = { issue: { team: { key: "SAN" } } };
      } else if (query.includes("teams(")) {
        data = { teams: { nodes: [{ id: "team-1", key: "SAN" }] } };
      } else if (query.includes("issueLabels")) {
        data = { issueLabels: { nodes: [{ id: "label-pc" }] } };
      } else {
        throw new Error(`unexpected query: ${query}`);
      }
      return { ok: true, json: async () => ({ data }) } as Response;
    });

    await new LinearProvider({}).markPlanComplete("issue-1", "SAN");

    expect(live.map((l) => l.name).sort()).toEqual(["Other", "Plan-Complete"]);
  });

  it("markPlanningStarted sends addedLabelIds only, with no label read", async () => {
    mockJsonOnce({ issue: { team: { key: "ENG" } } });
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-planning" }] } });
    mockJsonOnce({ issueUpdate: { success: true } });
    mockJsonOnce({ issue: { state: { type: "started" } } });

    await new LinearProvider({}).markPlanningStarted("issue-1", "ENG");

    const m = mutations();
    expect(m).toHaveLength(1);
    expect(m[0].variables).toEqual({ issueId: "issue-1", input: { addedLabelIds: ["label-planning"] } });
    expect(vi.mocked(fetch).mock.calls.some((c) => (c[1]?.body as string).includes("labels { nodes { id"))).toBe(false);
  });

  it("markPlanComplete sends one issueUpdate removing AI-Planning and adding Plan-Complete", async () => {
    mockJsonOnce({ issue: { team: { key: "ENG" } } });
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-pc" }] } });
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lp", name: "AI-Planning" }] } } });
    mockJsonOnce({ issueUpdate: { success: true } });

    await new LinearProvider({}).markPlanComplete("issue-1", "ENG");

    const m = mutations();
    expect(m).toHaveLength(1);
    expect(m[0].variables).toEqual({
      issueId: "issue-1",
      input: { removedLabelIds: ["lp"], addedLabelIds: ["label-pc"] },
    });
    expect(m[0].query).not.toMatch(/(?<![a-zA-Z])labelIds/);
  });

  it("markPlanComplete sends only addedLabelIds when the issue lacks AI-Planning", async () => {
    mockJsonOnce({ issue: { team: { key: "ENG" } } });
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-pc" }] } });
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lo", name: "Other" }] } } });
    mockJsonOnce({ issueUpdate: { success: true } });

    await new LinearProvider({}).markPlanComplete("issue-1", "ENG");

    expect(mutations()[0].variables).toEqual({ issueId: "issue-1", input: { addedLabelIds: ["label-pc"] } });
  });

  it("markPlanningFailed sends removedLabelIds only", async () => {
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lp", name: "AI-Planning" }, { id: "lo", name: "Other" }] } } });
    mockJsonOnce({ issueUpdate: { success: true } });
    mockJsonOnce({ commentCreate: { success: true } });

    await new LinearProvider({}).markPlanningFailed("issue-1", "ENG", "boom");

    expect(sentBody(1).variables).toEqual({ issueId: "issue-1", input: { removedLabelIds: ["lp"] } });
  });

  it("markImplementing sends addedLabelIds only, with no label read", async () => {
    mockJsonOnce({ issue: { team: { key: "ENG" } } });
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-aw" }] } });
    mockJsonOnce({ issueUpdate: { success: true } });
    mockJsonOnce({ issue: { state: { type: "started" } } });

    await new LinearProvider({}).markImplementing("issue-1", "ENG");

    const m = mutations();
    expect(m).toHaveLength(1);
    expect(m[0].variables).toEqual({ issueId: "issue-1", input: { addedLabelIds: ["label-aw"] } });
    expect(vi.mocked(fetch).mock.calls.some((c) => (c[1]?.body as string).includes("labels { nodes { id"))).toBe(false);
  });

  it("markPrReady sends one issueUpdate removing AI-Working and adding Ready for Review", async () => {
    mockJsonOnce({ issueLabels: { nodes: [{ id: "label-rfr" }] } });
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lw", name: "AI-Working" }, { id: "lo", name: "Other" }] } } });
    mockJsonOnce({ issueUpdate: { success: true } });
    mockJsonOnce({ commentCreate: { success: true } });

    await new LinearProvider({}).markPrReady("issue-1", "ENG", "https://github.com/o/r/pull/7");

    const m = mutations();
    expect(m).toHaveLength(1);
    expect(m[0].variables).toEqual({
      issueId: "issue-1",
      input: { removedLabelIds: ["lw"], addedLabelIds: ["label-rfr"] },
    });
  });

  it("markMerged sends stateId with removedLabelIds and no labelIds", async () => {
    mockJsonOnce({ issue: { state: { type: "started" }, team: { key: "ENG" }, labels: { nodes: [{ id: "L1", name: "Ready for Review" }, { id: "L2", name: "bug" }] } } });
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ workflowStates: { nodes: [{ id: "s-done", name: "Done", type: "completed" }] } });
    mockJsonOnce({ issueUpdate: { success: true } });

    await new LinearProvider({}).markMerged("issue-1", "ENG");

    const m = mutations();
    expect(m).toHaveLength(1);
    expect(m[0].variables).toEqual({ issueId: "issue-1", input: { stateId: "s-done", removedLabelIds: ["L1"] } });
    expect(JSON.stringify(m[0])).not.toMatch(/"labelIds"|\$labelIds/);
  });

  it("markMerged sends stateId only when Ready for Review is absent", async () => {
    mockJsonOnce({ issue: { state: { type: "started" }, team: { key: "ENG" }, labels: { nodes: [{ id: "L2", name: "bug" }] } } });
    mockJsonOnce({ teams: { nodes: [{ id: "team-uuid", key: "ENG" }] } });
    mockJsonOnce({ workflowStates: { nodes: [{ id: "s-done", name: "Done", type: "completed" }] } });
    mockJsonOnce({ issueUpdate: { success: true } });

    await new LinearProvider({}).markMerged("issue-1", "ENG");

    expect(mutations()[0].variables).toEqual({ issueId: "issue-1", input: { stateId: "s-done" } });
  });

  it("markMerged sends no mutation for a completed issue", async () => {
    mockJsonOnce({ issue: { state: { type: "completed" }, team: { key: "ENG" }, labels: { nodes: [{ id: "L1", name: "Ready for Review" }] } } });

    await new LinearProvider({}).markMerged("issue-1", "ENG");

    expect(mutations()).toHaveLength(0);
  });

  it("markImplementationFailed sends removedLabelIds only", async () => {
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lw", name: "AI-Working" }, { id: "lo", name: "Other" }] } } });
    mockJsonOnce({ issueUpdate: { success: true } });
    mockJsonOnce({ commentCreate: { success: true } });

    await new LinearProvider({}).markImplementationFailed("issue-1", "ENG", "boom");

    expect(sentBody(1).variables).toEqual({ issueId: "issue-1", input: { removedLabelIds: ["lw"] } });
  });

  it("markImplementationFailed sends no label write when the issue lacks AI-Working", async () => {
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lo", name: "Other" }] } } });
    mockJsonOnce({ commentCreate: { success: true } });

    await new LinearProvider({}).markImplementationFailed("issue-1", "ENG", "boom");

    expect(mutations()).toHaveLength(0);
  });

  it("clearWorkingState sends one write listing each carried label id", async () => {
    mockJsonOnce({ issue: { labels: { nodes: [{ id: "lw", name: "AI-Working" }, { id: "lp", name: "AI-Planning" }, { id: "lo", name: "Other" }] } } });
    mockJsonOnce({ issueUpdate: { success: true } });

    await new LinearProvider({}).clearWorkingState("issue-1", "ENG");

    const m = mutations();
    expect(m).toHaveLength(1);
    expect(m[0].variables).toEqual({ issueId: "issue-1", input: { removedLabelIds: ["lw", "lp"] } });
  });
});
