import { describe, expect, it } from "vitest";
import { selectIssuesToDispatch, selectBlockers } from "../poll-selection.js";
import type { RepoMapping } from "../config.js";
import type { LinearIssue } from "../linear.js";

function makeIssue(id: string, identifier: string, teamKey: string): LinearIssue {
  return {
    id,
    identifier,
    title: identifier,
    description: null,
    team: { id: `${teamKey}-id`, key: teamKey },
    state: { id: `${id}-state`, name: "Todo", type: "unstarted" },
  };
}

function makeMapping(maxInProgressAiIssues = 3): RepoMapping {
  return {
    owner: "org",
    repo: "repo",
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: false,
    planningWorkflowFile: "",
  };
}

describe("selectIssuesToDispatch", () => {
  it("returns all issues when team has available slots", () => {
    const selected = selectIssuesToDispatch(
      [makeIssue("1", "APP-1", "APP"), makeIssue("2", "APP-2", "APP")],
      { APP: makeMapping(3) },
      { APP: 1 },
      () => false,
    );
    expect(selected.map((i) => i.identifier)).toEqual(["APP-1", "APP-2"]);
  });

  it("dispatches no issues when team is at its cap", () => {
    const selected = selectIssuesToDispatch(
      [makeIssue("1", "APP-1", "APP")],
      { APP: makeMapping(3) },
      { APP: 3 },
      () => false,
    );
    expect(selected).toEqual([]);
  });

  it("enforces caps independently per team", () => {
    const selected = selectIssuesToDispatch(
      [makeIssue("1", "APP-1", "APP"), makeIssue("2", "APP-2", "APP"), makeIssue("3", "API-1", "API")],
      { APP: makeMapping(3), API: makeMapping(2) },
      { APP: 2, API: 0 },
      () => false,
    );
    expect(selected.map((i) => i.identifier)).toEqual(["APP-1", "API-1"]);
  });

  it("skips already-dispatched issues without consuming a slot", () => {
    const selected = selectIssuesToDispatch(
      [makeIssue("1", "APP-1", "APP"), makeIssue("2", "APP-2", "APP")],
      { APP: makeMapping(3) },
      { APP: 2 },
      (issueId) => issueId === "1",
    );
    expect(selected.map((i) => i.identifier)).toEqual(["APP-2"]);
  });

  it("skips issues with no team mapping", () => {
    const selected = selectIssuesToDispatch(
      [makeIssue("1", "UNK-1", "UNK")],
      { APP: makeMapping(3) },
      {},
      () => false,
    );
    expect(selected).toEqual([]);
  });

  it("returns empty when there are no issues", () => {
    const selected = selectIssuesToDispatch([], { APP: makeMapping(3) }, {}, () => false);
    expect(selected).toEqual([]);
  });

  it("tracks slot consumption across multiple dispatches in one cycle", () => {
    const selected = selectIssuesToDispatch(
      [makeIssue("1", "APP-1", "APP"), makeIssue("2", "APP-2", "APP"), makeIssue("3", "APP-3", "APP")],
      { APP: makeMapping(2) },
      { APP: 0 },
      () => false,
    );
    expect(selected).toHaveLength(2);
    expect(selected.map((i) => i.identifier)).toEqual(["APP-1", "APP-2"]);
  });
});

describe("selectBlockers", () => {
  it("returns no-mapping when teamRepoMap lacks the issue's team", () => {
    const blockers = selectBlockers(
      [makeIssue("1", "UNK-1", "UNK")],
      { APP: makeMapping(3) },
      {},
      () => false,
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0].reason).toBe("no-mapping");
    expect(blockers[0].issueId).toBe("1");
    expect(blockers[0].teamKey).toBe("UNK");
  });

  it("returns dedup when isAlreadyDispatched is true, NOT concurrency even if at cap", () => {
    const blockers = selectBlockers(
      [makeIssue("1", "APP-1", "APP")],
      { APP: makeMapping(1) },
      { APP: 1 }, // at cap
      (id) => id === "1",
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0].reason).toBe("dedup");
  });

  it("returns concurrency when team is at cap and not deduped", () => {
    const blockers = selectBlockers(
      [makeIssue("1", "APP-1", "APP")],
      { APP: makeMapping(2) },
      { APP: 2 },
      () => false,
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0].reason).toBe("concurrency");
    expect(blockers[0].teamKey).toBe("APP");
  });

  it("returns nothing for a dispatchable issue", () => {
    const blockers = selectBlockers(
      [makeIssue("1", "APP-1", "APP")],
      { APP: makeMapping(3) },
      { APP: 1 },
      () => false,
    );
    expect(blockers).toHaveLength(0);
  });

  it("returns multiple blockers from mixed input, sorted by reason+teamKey+identifier", () => {
    const blockers = selectBlockers(
      [
        makeIssue("1", "APP-2", "APP"), // concurrency (APP at cap)
        makeIssue("2", "APP-1", "APP"), // dedup
        makeIssue("3", "API-1", "API"), // no-mapping
        makeIssue("4", "APP-3", "APP"), // concurrency (APP at cap)
      ],
      { APP: makeMapping(1) },
      { APP: 1 }, // APP at cap
      (id) => id === "2",
    );
    // issue "2" (APP-1) → dedup; issue "3" (API-1) → no-mapping; issues "1","4" → concurrency
    // sorted: concurrency/APP/APP-2, concurrency/APP/APP-3, dedup/APP/APP-1, no-mapping/API/API-1
    expect(blockers).toHaveLength(4);
    expect(blockers[0]).toMatchObject({ reason: "concurrency", issueIdentifier: "APP-2" });
    expect(blockers[1]).toMatchObject({ reason: "concurrency", issueIdentifier: "APP-3" });
    expect(blockers[2]).toMatchObject({ reason: "dedup", issueIdentifier: "APP-1" });
    expect(blockers[3]).toMatchObject({ reason: "no-mapping", issueIdentifier: "API-1" });
  });
});
