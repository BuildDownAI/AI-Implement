import { describe, expect, it } from "vitest";
import { selectIssuesToDispatch, selectBlockers, parseDeclaredFiles, selectFileOverlapDeferrals } from "../poll-selection.js";
import type { RepoMapping } from "../config.js";
import type { TicketIssue } from "../providers/types.js";

function makeIssue(id: string, identifier: string, teamKey: string, overrides?: Partial<TicketIssue>): TicketIssue {
  return {
    id,
    identifier,
    title: identifier,
    description: null,
    scopeKey: teamKey,
    nativeStatus: "Todo (unstarted)",
    ...overrides,
  };
}

function makeFeatureIssue(
  id: string,
  identifier: string,
  teamKey: string,
  parentIdentifier: string,
  description: string | null = null,
): TicketIssue {
  return {
    id,
    identifier,
    title: identifier,
    description,
    scopeKey: teamKey,
    nativeStatus: "Todo (unstarted)",
    featureBranchChain: [{ identifier: parentIdentifier, mode: "feature" }],
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
    autoApprovePlans: true,
    extraEnv: {},
    provider: "anthropic",
    ticketingProvider: "linear",
    ticketingConfig: { kind: "linear" },
    awsRegion: null,
    paused: false,
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

describe("parseDeclaredFiles", () => {
  it("returns empty set for null description", () => {
    expect(parseDeclaredFiles(null).size).toBe(0);
  });

  it("returns empty set for prose-only description", () => {
    expect(parseDeclaredFiles("Fix the bug in the login flow.\nNo files listed here.").size).toBe(0);
  });

  it("extracts Modify: paths", () => {
    const files = parseDeclaredFiles("- Modify: `src/a.ts`");
    expect([...files]).toEqual(["src/a.ts"]);
  });

  it("extracts Create: paths", () => {
    const files = parseDeclaredFiles("- Create: `src/b.ts`");
    expect([...files]).toEqual(["src/b.ts"]);
  });

  it("extracts Test: paths", () => {
    const files = parseDeclaredFiles("* Test: `src/__tests__/c.test.ts`");
    expect([...files]).toEqual(["src/__tests__/c.test.ts"]);
  });

  it("extracts Delete: paths", () => {
    const files = parseDeclaredFiles("- Delete: `src/old.ts`");
    expect([...files]).toEqual(["src/old.ts"]);
  });

  it("strips :10-20 line-range suffixes", () => {
    const files = parseDeclaredFiles("- Modify: `src/a.ts:10-20`");
    expect([...files]).toEqual(["src/a.ts"]);
  });

  it("extracts multiple paths across verbs", () => {
    const body = `
## Files
- Modify: \`src/a.ts\`
- Create: \`src/b.ts\`
* Test: \`src/__tests__/a.test.ts\`
`;
    const files = parseDeclaredFiles(body);
    expect(files).toEqual(new Set(["src/a.ts", "src/b.ts", "src/__tests__/a.test.ts"]));
  });

  it("is case-insensitive on verb", () => {
    const files = parseDeclaredFiles("- modify: `src/x.ts`");
    expect([...files]).toEqual(["src/x.ts"]);
  });
});

describe("selectFileOverlapDeferrals", () => {
  const PARENT = "FEAT-1";

  it("defers a candidate whose declared files overlap an in-flight sibling on the same grouping branch", () => {
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, "- Modify: `src/a.ts`");
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", PARENT, "- Modify: `src/a.ts`");
    const blockers = selectFileOverlapDeferrals([candidate], [sibling]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].reason).toBe("file-overlap");
    expect(blockers[0].issueId).toBe("c1");
    expect(blockers[0].issueIdentifier).toBe("AII-2");
    expect(blockers[0].detail).toContain("AII-3");
    expect(blockers[0].detail).toContain("src/a.ts");
  });

  it("does not defer when candidate has no declared files (fail-open)", () => {
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, "Fix the bug.");
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", PARENT, "- Modify: `src/a.ts`");
    const blockers = selectFileOverlapDeferrals([candidate], [sibling]);
    expect(blockers).toHaveLength(0);
  });

  it("does not defer when sibling has no declared files (fail-open)", () => {
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, "- Modify: `src/a.ts`");
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", PARENT, "Just some prose.");
    const blockers = selectFileOverlapDeferrals([candidate], [sibling]);
    expect(blockers).toHaveLength(0);
  });

  it("does not defer when there are no in-flight siblings", () => {
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, "- Modify: `src/a.ts`");
    const blockers = selectFileOverlapDeferrals([candidate], []);
    expect(blockers).toHaveLength(0);
  });

  it("does not defer when sibling is on a different grouping branch", () => {
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", "FEAT-1", "- Modify: `src/a.ts`");
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", "FEAT-2", "- Modify: `src/a.ts`");
    const blockers = selectFileOverlapDeferrals([candidate], [sibling]);
    expect(blockers).toHaveLength(0);
  });

  it("does not defer when files do not overlap", () => {
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, "- Modify: `src/a.ts`");
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", PARENT, "- Modify: `src/b.ts`");
    const blockers = selectFileOverlapDeferrals([candidate], [sibling]);
    expect(blockers).toHaveLength(0);
  });

  it("does not defer when candidate has no featureBranchChain", () => {
    const candidate = makeIssue("c1", "AII-2", "AII", { description: "- Modify: `src/a.ts`" });
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", PARENT, "- Modify: `src/a.ts`");
    const blockers = selectFileOverlapDeferrals([candidate], [sibling]);
    expect(blockers).toHaveLength(0);
  });

  it("detail includes sibling identifier and shared files", () => {
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, "- Modify: `src/a.ts`\n- Modify: `src/b.ts`");
    const sibling = makeFeatureIssue("s1", "AII-5", "AII", PARENT, "- Modify: `src/a.ts`");
    const [blocker] = selectFileOverlapDeferrals([candidate], [sibling]);
    expect(blocker.detail).toContain("AII-5");
    expect(blocker.detail).toContain("src/a.ts");
  });
});
