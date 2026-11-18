import { describe, it, expect, beforeEach } from "vitest";
import { LinearProvider } from "../../providers/linear.js";
import { configureLinearAuth, __setLinearTokenForTest } from "../../linear-app-auth.js";
import { fakeFetch, type FakeFetch, type ReplyInit } from "../helpers/fake-fetch.js";
import { linearData as data } from "../helpers/replies/linear.js";

// AII-889: every Linear label write sends only the labels that change (addedLabelIds /
// removedLabelIds). A full `labelIds` set written from a stale read restores a label that
// another writer removed: SAN-40 kept AI-Planning after its plan completed and sat unpicked.

beforeEach(() => {
  configureLinearAuth("client-id", "client-secret");
  __setLinearTokenForTest("test-token");
});

type Label = { id: string; name: string };
type Input = { labelIds?: string[]; addedLabelIds?: string[]; removedLabelIds?: string[]; stateId?: string };

/**
 * A small in-memory Linear. Label reads are served from `readLabels` (which a test can leave
 * stale), while issueUpdate writes apply to the live set, the way the real API does.
 */
function linearIssue(initial: Label[], opts: { stateType?: string } = {}) {
  const known: Label[] = [
    ...initial,
    { id: "label-pc", name: "Plan-Complete" },
    { id: "label-rfr", name: "Ready for Review" },
    { id: "label-planning", name: "AI-Planning" },
    { id: "label-aw", name: "AI-Working" },
    { id: "label-nh", name: "Other" },
  ];
  const state = { live: [...initial], readLabels: [...initial] as Label[] | null };
  const writes: Input[] = [];
  const fake: FakeFetch = fakeFetch({ "POST /graphql": (call) => {
    const { query, variables } = JSON.parse(call.body) as { query: string; variables: Record<string, unknown> };
    if (query.includes("issueUpdate")) {
      const input = { ...((variables.input ?? {}) as Input) };
      if (variables.labelIds) input.labelIds = variables.labelIds as string[];
      writes.push(input);
      if (input.labelIds) state.live = known.filter((l) => input.labelIds!.includes(l.id));
      state.live = state.live.filter((l) => !input.removedLabelIds?.includes(l.id));
      for (const id of input.addedLabelIds ?? []) {
        const l = known.find((k) => k.id === id);
        if (l && !state.live.some((x) => x.id === id)) state.live.push(l);
      }
      return data({ issueUpdate: { success: true } }) as ReplyInit;
    }
    if (query.includes("commentCreate")) return data({ commentCreate: { success: true } }) as ReplyInit;
    if (query.includes("issueLabels(")) {
      const name = (variables as { name: string }).name;
      return data({ issueLabels: { nodes: known.filter((l) => l.name === name).map((l) => ({ id: l.id, team: null })) } }) as ReplyInit;
    }
    if (query.includes("teams(")) return data({ teams: { nodes: [{ id: "team-1", key: "SAN" }] } }) as ReplyInit;
    if (query.includes("workflowStates")) return data({ workflowStates: { nodes: [{ id: "s-done", name: "Done", type: "completed" }] } }) as ReplyInit;
    if (query.includes("state { type }") && query.includes("labels")) {
      return data({ issue: { state: { type: opts.stateType ?? "started" }, team: { key: "SAN" }, labels: { nodes: state.readLabels ?? state.live } } }) as ReplyInit;
    }
    if (query.includes("state { type }")) return data({ issue: { state: { type: opts.stateType ?? "started" }, team: { key: "SAN" } } }) as ReplyInit;
    if (query.includes("labels { nodes")) return data({ issue: { labels: { nodes: state.readLabels ?? state.live } } }) as ReplyInit;
    if (query.includes("team { key }")) return data({ issue: { team: { key: "SAN" } } }) as ReplyInit;
    throw new Error(`unexpected query: ${query}`);
  } }).install();
  return { fake, state, writes, names: () => state.live.map((l) => l.name).sort() };
}

describe("Linear label writes never replace the full label set", () => {
  it("a stale label read during markPlanComplete does not restore a removed AI-Planning", async () => {
    const linear = linearIssue([{ id: "lp", name: "AI-Planning" }, { id: "lo", name: "Other" }]);
    // Another writer removes AI-Planning after our read snapshot was taken.
    linear.state.live = linear.state.live.filter((l) => l.name !== "AI-Planning");

    await new LinearProvider({}).markPlanComplete("issue-1", "SAN", { awaitApproval: false });

    expect(linear.names()).toEqual(["Other", "Plan-Complete"]);
  });

  it("a stale read in markPrReady does not restore an Other label removed meanwhile", async () => {
    const linear = linearIssue([{ id: "label-aw", name: "AI-Working" }, { id: "lo", name: "Other" }]);
    linear.state.live = linear.state.live.filter((l) => l.name !== "Other");

    await new LinearProvider({}).markPrReady("issue-1", "SAN", "https://github.com/o/r/pull/1");

    expect(linear.names()).toEqual(["Ready for Review"]);
  });

  it("a stale read in markMerged does not restore a label removed meanwhile", async () => {
    const linear = linearIssue([{ id: "label-rfr", name: "Ready for Review" }, { id: "lx", name: "Other" }]);
    linear.state.live = linear.state.live.filter((l) => l.name !== "Other");

    await new LinearProvider({}).markMerged("issue-1", "SAN");

    expect(linear.names()).toEqual([]);
  });

  it.each<[string, Label[], (p: LinearProvider) => Promise<unknown>]>([
    ["markPlanningStarted", [], (p) => p.markPlanningStarted("issue-1", "SAN")],
    ["markPlanComplete", [{ id: "label-planning", name: "AI-Planning" }], (p) => p.markPlanComplete("issue-1", "SAN", { awaitApproval: false })],
    ["markPlanningFailed", [{ id: "label-planning", name: "AI-Planning" }], (p) => p.markPlanningFailed("issue-1", "SAN", "x")],
    ["markImplementing", [], (p) => p.markImplementing("issue-1", "SAN")],
    ["markPrReady", [{ id: "label-aw", name: "AI-Working" }], (p) => p.markPrReady("issue-1", "SAN", "u")],
    ["markMerged", [{ id: "label-rfr", name: "Ready for Review" }], (p) => p.markMerged("issue-1", "SAN")],
    ["markPrClosedUnmerged", [{ id: "label-rfr", name: "Ready for Review" }], (p) => p.markPrClosedUnmerged("issue-1", "SAN", "u")],
    ["markImplementationFailed", [{ id: "label-aw", name: "AI-Working" }], (p) => p.markImplementationFailed("issue-1", "SAN", "x")],
    ["clearWorkingState", [{ id: "label-aw", name: "AI-Working" }, { id: "label-planning", name: "AI-Planning" }], (p) => p.clearWorkingState("issue-1", "SAN", "implementation")],
    ["parkForHuman", [{ id: "label-aw", name: "AI-Working" }], (p) => p.parkForHuman("issue-1", "SAN", "implementation")],
  ])("%s writes labels without a full labelIds set", async (_name, labels, run) => {
    const linear = linearIssue(labels);
    const provider = new LinearProvider({});
    // markPrClosedUnmerged needs a canceled state; answer its lookup from the same fake.
    if (_name === "markPrClosedUnmerged") {
      (provider as unknown as { getCanceledStateId: () => Promise<string> }).getCanceledStateId = async () => "s-cancel";
    }
    await run(provider);

    expect(linear.writes.length).toBeGreaterThan(0);
    for (const write of linear.writes) expect(write).not.toHaveProperty("labelIds");
    for (const call of linear.fake.calls) expect(JSON.parse(call.body).query).not.toContain("$labelIds");
  });

  it("sends no label write when there is nothing to remove", async () => {
    const linear = linearIssue([{ id: "lo", name: "Other" }]);
    await new LinearProvider({}).clearWorkingState("issue-1", "SAN", "planning");
    expect(linear.writes).toEqual([]);
  });
});
