import { describe, expect, it } from "vitest";
import { selectIssuesToDispatch, selectBlockers, parseDeclaredFiles, selectFileOverlapDeferrals, rememberCandidates, resolveInFlightSiblings, resetSeenCandidates, getCachedPlanningContext, setCachedPlanningContext, resetPlanningContextCache, needsPlanningContextFetch, getPlanningContextCacheSize, PLANNING_CONTEXT_CACHE_MAX } from "../poll-selection.js";
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

describe("same-batch overlap + in-flight sourcing (AII-278)", () => {
  const chain = [{ identifier: "P-1", mode: "feature" as const }];
  const mk = (id: string, desc: string | null) =>
    makeIssue(id, id, "T", { description: desc, featureBranchChain: chain });

  it("defers the second of two SAME-BATCH candidates declaring the same file", () => {
    const a = mk("C-1", "- Modify: `src/shared.ts`");
    const b = mk("C-2", "- Modify: `src/shared.ts`\n- Create: `src/other.ts`");
    const d = selectFileOverlapDeferrals([b, a], []); // order-independent: identifier sort accepts C-1 first
    expect(d).toHaveLength(1);
    expect(d[0].issueIdentifier).toBe("C-2");
    expect(d[0].reason).toBe("file-overlap");
    expect(d[0].detail).toContain("C-1");
  });

  it("three-way batch: first accepted, both later overlappers deferred", () => {
    const a = mk("C-1", "- Modify: `src/shared.ts`");
    const b = mk("C-2", "- Modify: `src/shared.ts`");
    const c = mk("C-3", "- Modify: `src/shared.ts`");
    const d = selectFileOverlapDeferrals([c, b, a], []);
    expect(d.map((x) => x.issueIdentifier).sort()).toEqual(["C-2", "C-3"]);
  });

  it("same-batch candidates on DIFFERENT grouping branches never defer each other", () => {
    const other = [{ identifier: "P-2", mode: "feature" as const }];
    const a = mk("C-1", "- Modify: `src/shared.ts`");
    const b = { ...mk("C-2", "- Modify: `src/shared.ts`"), featureBranchChain: other };
    expect(selectFileOverlapDeferrals([a, b], [])).toHaveLength(0);
  });

  it("batch candidate defers against an in-flight (non-candidate) sibling's declared files", () => {
    const inFlight = mk("C-9", "- Modify: `src/shared.ts`");
    const cand = mk("C-2", "- Modify: `src/shared.ts`");
    const d = selectFileOverlapDeferrals([cand], [inFlight]);
    expect(d).toHaveLength(1);
    expect(d[0].detail).toContain("C-9");
  });

  it("fail-open within the batch: undeclared candidates never defer or cause deferrals", () => {
    const a = mk("C-1", "no files section here");
    const b = mk("C-2", "- Modify: `src/shared.ts`");
    expect(selectFileOverlapDeferrals([a, b], [])).toHaveLength(0);
  });
});

// PR #202 review finding #2: the planning template's inline `Files:` convention must parse —
// otherwise every orchestrator-planned issue silently fail-opens on the dispatch guard.
describe("parseDeclaredFiles — inline Files: convention (planning template shape)", () => {
  it("parses the PLANNING.md work-unit form (backticked, parenthetical annotation, trailing period)", () => {
    const body = "- **WU-3: Short name** — brief description. Files: `src/file.ts` (update), `tests/integration/foo.test.ts`. Depends on: WU-1.";
    expect(parseDeclaredFiles(body)).toEqual(new Set(["src/file.ts", "tests/integration/foo.test.ts"]));
  });

  it("parses the implement.ts emitted form (bare comma-joined, no backticks)", () => {
    expect(parseDeclaredFiles("Files: src/a.ts, src/b.ts")).toEqual(new Set(["src/a.ts", "src/b.ts"]));
  });

  it("both conventions in one body union together", () => {
    const body = "## Files\n- Modify: `src/x.ts`\n\nFiles: `src/y.ts`.";
    expect(parseDeclaredFiles(body)).toEqual(new Set(["src/x.ts", "src/y.ts"]));
  });

  it("ignores prose after an inline list and non-path tokens (still fail-open on junk)", () => {
    expect(parseDeclaredFiles("Files: none yet")).toEqual(new Set());
  });
});

// AII-375: planning block fallback in the file-overlap guard.
describe("selectFileOverlapDeferrals — planning block fallback", () => {
  const PARENT = "FEAT-1";
  const planningBlock = (files: string[]) =>
    `<!-- ai-implement-planning\nv: 1\nfiles: ${JSON.stringify(files)}\nrisk: low\n-->`;

  it("defers a prose-only candidate when its planning block overlaps an in-flight sibling", () => {
    const candidate = makeFeatureIssue(
      "c1", "AII-2", "AII", PARENT,
      `Fix the widget.\n\n${planningBlock(["src/a.ts"])}`,
    );
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", PARENT, "- Modify: `src/a.ts`");
    const blockers = selectFileOverlapDeferrals([candidate], [sibling]);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].reason).toBe("file-overlap");
    expect(blockers[0].issueId).toBe("c1");
  });

  it("fails open when the candidate has no declared files and no planning block", () => {
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, "Prose only.");
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", PARENT, "- Modify: `src/a.ts`");
    expect(selectFileOverlapDeferrals([candidate], [sibling])).toHaveLength(0);
  });

  it("defers when the sibling uses only a planning block and files overlap", () => {
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, "- Modify: `src/a.ts`");
    const sibling = makeFeatureIssue(
      "s1", "AII-3", "AII", PARENT,
      `Fix stuff.\n\n${planningBlock(["src/a.ts"])}`,
    );
    const blockers = selectFileOverlapDeferrals([candidate], [sibling]);
    expect(blockers).toHaveLength(1);
  });
});

// AII-388: the planning block lives in the planning *comment*, not the description.
// The guard must read it from the assembled planning context (as returned by
// fetchPlanningContext), NOT from a hand-built description string.
describe("selectFileOverlapDeferrals — planning context sourcing (AII-388)", () => {
  const PARENT = "FEAT-1";
  // Simulates the text returned by fetchPlanningContext / assemblePlanningContext —
  // the full comment body including headers and the machine block appended last.
  const planningContextWithBlock = (files: string[]) =>
    `## 🗺 AI Planning: Implementation Map\n\n(analysis)\n\n<!-- ai-implement-planning\nv: 1\nfiles: ${JSON.stringify(files)}\nrisk: low\n-->`;

  it("defers a prose-only candidate whose planning context (not description) contains a block overlapping a sibling", () => {
    // The candidate description has NO planning block and NO file bullets — exactly
    // as it arrives from the tracker in production after a planning run.
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, "Prose only. No files.");
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", PARENT, "- Modify: `src/a.ts`");
    const planningContexts = new Map([["c1", planningContextWithBlock(["src/a.ts"])]]);
    const blockers = selectFileOverlapDeferrals([candidate], [sibling], planningContexts);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].reason).toBe("file-overlap");
    expect(blockers[0].issueId).toBe("c1");
    expect(blockers[0].detail).toContain("AII-3");
    expect(blockers[0].detail).toContain("src/a.ts");
  });

  it("defers when an in-flight sibling's planning context declares the overlapping file", () => {
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, "- Modify: `src/a.ts`");
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", PARENT, "Prose only.");
    const planningContexts = new Map([["s1", planningContextWithBlock(["src/a.ts"])]]);
    const blockers = selectFileOverlapDeferrals([candidate], [sibling], planningContexts);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].issueId).toBe("c1");
    expect(blockers[0].detail).toContain("AII-3");
  });

  it("fails open when the planning context has no block (no deferral, no throw)", () => {
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, "Prose only.");
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", PARENT, "- Modify: `src/a.ts`");
    const planningContexts = new Map([["c1", "## 🗺 AI Planning: Implementation Map\n\n(no machine block)"]]);
    expect(selectFileOverlapDeferrals([candidate], [sibling], planningContexts)).toHaveLength(0);
  });

  it("description verb bullets take precedence over planning context block", () => {
    // Candidate has description bullets for src/b.ts only; planning block says src/a.ts.
    // Sibling touches src/a.ts. Candidate should NOT defer — the description bullets win.
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, "- Modify: `src/b.ts`");
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", PARENT, "- Modify: `src/a.ts`");
    const planningContexts = new Map([["c1", planningContextWithBlock(["src/a.ts"])]]);
    expect(selectFileOverlapDeferrals([candidate], [sibling], planningContexts)).toHaveLength(0);
  });

  it("defers a null-description candidate when its planning context block overlaps a sibling (Gap 1 fix)", () => {
    // Pre-fix: || !description short-circuited before the planning-context loop, returning
    // empty — the very case this feature exists for.
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, null);
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", PARENT, "- Modify: `src/a.ts`");
    const planningContexts = new Map([["c1", planningContextWithBlock(["src/a.ts"])]]);
    const blockers = selectFileOverlapDeferrals([candidate], [sibling], planningContexts);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].issueId).toBe("c1");
  });

  it("defers an empty-description candidate when its planning context block overlaps a sibling (Gap 1 fix)", () => {
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, "");
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", PARENT, "- Modify: `src/a.ts`");
    const planningContexts = new Map([["c1", planningContextWithBlock(["src/a.ts"])]]);
    const blockers = selectFileOverlapDeferrals([candidate], [sibling], planningContexts);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].issueId).toBe("c1");
  });

  it("null-description issue is included by the fetch filter and defers end-to-end (Gap 2 fix)", () => {
    // Both prior rounds of this fix were defeated by a layer the tests did not cover.
    // Round 1: resolveIssueFiles short-circuit was fixed, but index.ts/admin.ts never
    //          fetched planning context for null-description issues (i.description !== null guard).
    // Round 2: that guard is removed; this test drives the full path — filter → context map →
    //          selectFileOverlapDeferrals — to catch any future regression at any layer.
    const candidate = makeFeatureIssue("c1", "AII-2", "AII", PARENT, null);
    const sibling = makeFeatureIssue("s1", "AII-3", "AII", PARENT, "- Modify: `src/a.ts`");

    // The shared predicate from poll-selection.ts — drift at either call site fails this test.
    const issuesNeedingContext = [candidate, sibling].filter(needsPlanningContextFetch);
    // A null-description issue must be included — this is what was broken before.
    expect(issuesNeedingContext.some((i) => i.id === "c1")).toBe(true);

    // Simulate fetching and storing context only for issues that passed the filter.
    const planningContexts = new Map(
      issuesNeedingContext
        .filter((i) => i.id === "c1")
        .map((i) => [i.id, planningContextWithBlock(["src/a.ts"])]),
    );
    const blockers = selectFileOverlapDeferrals([candidate], [sibling], planningContexts);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].issueId).toBe("c1");
  });
});

// PR #202 review finding #1 (admin-side remnant): the shared cache resolves in-flight
// siblings identically for the poll loop and the admin blockers preview.
describe("shared seen-candidates cache (rememberCandidates / resolveInFlightSiblings)", () => {
  it("resolves an in-flight id remembered in a prior cycle; unknown ids fail open", () => {
    resetSeenCandidates();
    const chain = [{ identifier: "P-1", mode: "feature" as const }];
    const sib = makeIssue("in-flight-1", "C-9", "T", { description: "- Modify: `src/shared.ts`", featureBranchChain: chain });
    rememberCandidates([sib]);
    expect(resolveInFlightSiblings(["in-flight-1", "never-seen"])).toEqual([sib]);
    // and the guard actually defers against the resolved sibling
    const cand = makeIssue("cand-1", "C-10", "T", { description: "- Modify: `src/shared.ts`", featureBranchChain: chain });
    const d = selectFileOverlapDeferrals([cand], resolveInFlightSiblings(["in-flight-1"]));
    expect(d).toHaveLength(1);
    resetSeenCandidates();
  });
});

// AII-390: planning-context fetch is gated on featureBranchChain being non-empty.
// Issues outside a feature tree can never produce a deferral, so fetching their
// planning context is wasted work. The filter in index.ts / admin.ts must match the
// predicate that selectFileOverlapDeferrals itself uses for groupingBranchOf.
describe("planning-context fetch filter — grouping-branch guard (AII-390)", () => {
  it("excludes non-feature-tree issues from the fetch filter", () => {
    const nonFeature = makeIssue("i1", "AII-1", "AII", { description: "Prose only." });
    const featureIssue = makeFeatureIssue("i2", "AII-2", "AII", "FEAT-1", "Prose only.");

    const needingContext = [nonFeature, featureIssue].filter(needsPlanningContextFetch);

    expect(needingContext.some((i) => i.id === "i1")).toBe(false);
    expect(needingContext.some((i) => i.id === "i2")).toBe(true);
  });

  it("excludes feature-tree issues whose description already has file bullets", () => {
    const withBullets = makeFeatureIssue("i1", "AII-1", "AII", "FEAT-1", "- Modify: `src/a.ts`");
    const withoutBullets = makeFeatureIssue("i2", "AII-2", "AII", "FEAT-1", "Prose only.");

    const needingContext = [withBullets, withoutBullets].filter(needsPlanningContextFetch);

    expect(needingContext.some((i) => i.id === "i1")).toBe(false);
    expect(needingContext.some((i) => i.id === "i2")).toBe(true);
  });
});

// AII-390: planning context is memoised per issue id so the same issue is not
// re-fetched on every 60-second poll cycle for the life of a run.
describe("planning context cache (AII-390)", () => {
  it("getCachedPlanningContext returns undefined before any value is set", () => {
    resetPlanningContextCache();
    expect(getCachedPlanningContext("never-set")).toBeUndefined();
    resetPlanningContextCache();
  });

  it("getCachedPlanningContext returns the value set by setCachedPlanningContext", () => {
    resetPlanningContextCache();
    setCachedPlanningContext("issue-1", "## Planning context");
    expect(getCachedPlanningContext("issue-1")).toBe("## Planning context");
    resetPlanningContextCache();
  });

  it("second poll cycle hits the cache — at most one fetch per issue per process", () => {
    resetPlanningContextCache();
    let fetchCount = 0;

    // Poll cycle 1: cache miss → fetch
    if (getCachedPlanningContext("issue-1") === undefined) {
      fetchCount++;
      setCachedPlanningContext("issue-1", "## planning context");
    }

    // Poll cycle 2: cache hit → no fetch
    if (getCachedPlanningContext("issue-1") === undefined) {
      fetchCount++;
    }

    expect(fetchCount).toBe(1);
    resetPlanningContextCache();
  });

  it("resetPlanningContextCache clears all entries", () => {
    setCachedPlanningContext("issue-1", "some context");
    resetPlanningContextCache();
    expect(getCachedPlanningContext("issue-1")).toBeUndefined();
  });

  it("cache does not grow past PLANNING_CONTEXT_CACHE_MAX — oldest entry is evicted", () => {
    resetPlanningContextCache();
    for (let i = 0; i < PLANNING_CONTEXT_CACHE_MAX + 1; i++) {
      setCachedPlanningContext(`issue-${i}`, `ctx-${i}`);
    }
    expect(getPlanningContextCacheSize()).toBe(PLANNING_CONTEXT_CACHE_MAX);
    // The first entry (issue-0) should have been evicted as the oldest.
    expect(getCachedPlanningContext("issue-0")).toBeUndefined();
    // The last entry (issue-PLANNING_CONTEXT_CACHE_MAX) should still be present.
    expect(getCachedPlanningContext(`issue-${PLANNING_CONTEXT_CACHE_MAX}`)).toBe(`ctx-${PLANNING_CONTEXT_CACHE_MAX}`);
    resetPlanningContextCache();
  });
});
