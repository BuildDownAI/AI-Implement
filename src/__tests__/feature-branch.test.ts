import { describe, it, expect, vi, afterEach } from "vitest";
import {
  findOpenRollUpPr,
  nonTerminalDesignatedChildren,
  resolveBaseBranch,
  resolvePlanningBranch,
  type FeatureChildState,
} from "../feature-branch.js";
import { makeIssue, makeMapping } from "./helpers/builders.js";
import { fakeFetch } from "./helpers/fake-fetch.js";

const mapping = makeMapping({ defaultBranch: "testing" });
const REFS = "/repos/test-org/test-repo/git/ref/heads";
const ool78 = { identifier: "OOL-78", mode: "feature" as const };
const ool96 = { identifier: "OOL-96", mode: "feature" as const };
const sha = (value: string) => ({ json: { object: { sha: value } } });

// AII-609: "terminal" means the tracker's own workflow state — completed or cancelled —
// independent of whether an orchestrator job row exists for the child. A child mid
// implementation (planning done, run dispatched, tracker state still non-terminal) must
// still be reported as blocking.
describe("nonTerminalDesignatedChildren", () => {
  const child = (identifier: string, designated: boolean, terminal: boolean): FeatureChildState => ({
    identifier,
    designated,
    terminal,
  });

  it("blocks on the exact AII-604/607/608 shape: one child Done, one In Progress with a running job", () => {
    // The job row is irrelevant to this predicate — it isn't part of FeatureChildState at
    // all, so a caller cannot accidentally let a running job masquerade as terminal.
    const children = [child("AII-607", true, true), child("AII-608", true, false)];
    expect(nonTerminalDesignatedChildren(children).map((c) => c.identifier)).toEqual(["AII-608"]);
  });

  it("is ready once every designated child reaches a terminal state (mix of completed and cancelled)", () => {
    const children = [child("A-1", true, true), child("A-2", true, true)];
    expect(nonTerminalDesignatedChildren(children)).toEqual([]);
  });

  it("never blocks on a non-designated child, terminal or not", () => {
    const children = [child("A-1", true, true), child("A-2", false, false)];
    expect(nonTerminalDesignatedChildren(children)).toEqual([]);
  });

  it("is ready for an empty child list", () => {
    expect(nonTerminalDesignatedChildren([])).toEqual([]);
  });
});

describe("resolveBaseBranch", () => {
  it("returns the feature branch and ensures it from defaultBranch for a single-entry chain", async () => {
    const github = fakeFetch({
      [`GET ${REFS}/ai-implement/feature/ool-78`]: { status: 404 },
      [`GET ${REFS}/testing`]: sha("base-sha"),
      "POST /repos/test-org/test-repo/git/refs": { status: 201 },
    });
    github.install();

    const base = await resolveBaseBranch({ ghToken: "t", issue: makeIssue({ featureBranchChain: [ool78] }), mapping });

    expect(base).toBe("ai-implement/feature/ool-78");
    expect(JSON.parse(github.calls[2].body)).toEqual({ ref: "refs/heads/ai-implement/feature/ool-78", sha: "base-sha" });
  });

  it("cascades a multi-entry chain: each branch cut from the previous one", async () => {
    const github = fakeFetch({
      // OOL-78 is missing until it is created; OOL-96 is then cut from its head.
      [`GET ${REFS}/ai-implement/feature/ool-78`]: [{ status: 404 }, sha("f78-sha")],
      [`GET ${REFS}/testing`]: sha("testing-sha"),
      [`GET ${REFS}/ai-implement/feature/ool-96`]: { status: 404 },
      "POST /repos/test-org/test-repo/git/refs": [{ status: 201 }, { status: 201 }],
    });
    github.install();

    const base = await resolveBaseBranch({ ghToken: "t", issue: makeIssue({ featureBranchChain: [ool78, ool96] }), mapping });

    expect(base).toBe("ai-implement/feature/ool-96");
    expect(github.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${REFS}/ai-implement/feature/ool-78`,
      `GET ${REFS}/testing`,
      "POST /repos/test-org/test-repo/git/refs",
      `GET ${REFS}/ai-implement/feature/ool-96`,
      `GET ${REFS}/ai-implement/feature/ool-78`,
      "POST /repos/test-org/test-repo/git/refs",
    ]);
    expect(JSON.parse(github.calls[2].body).sha).toBe("testing-sha");
    expect(JSON.parse(github.calls[5].body)).toEqual({ ref: "refs/heads/ai-implement/feature/ool-96", sha: "f78-sha" });
  });

  it("returns defaultBranch and creates nothing when there is no chain", async () => {
    const github = fakeFetch({});
    github.install();

    const base = await resolveBaseBranch({ ghToken: "t", issue: makeIssue(), mapping });

    expect(base).toBe("testing");
    expect(github.calls).toHaveLength(0);
  });

  it("fails closed when a grouped branch cannot be resolved", async () => {
    fakeFetch({ [`GET ${REFS}/ai-implement/feature/ool-78`]: { status: 500, text: "boom" } }).install();

    await expect(resolveBaseBranch({ ghToken: "t", issue: makeIssue({ featureBranchChain: [ool78] }), mapping }))
      .rejects.toThrow(/refusing to dispatch against "testing"/);
  });
});

// AII-898: read-only counterpart used by planning dispatch — must never create a branch.
describe("resolvePlanningBranch", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("returns the chain's target branch when it already exists", async () => {
    const github = fakeFetch({ [`GET ${REFS}/ai-implement/feature/ool-78`]: sha("tip-sha") });
    github.install();

    const branch = await resolvePlanningBranch({ ghToken: "t", issue: makeIssue({ featureBranchChain: [ool78] }), mapping });

    expect(branch).toBe("ai-implement/feature/ool-78");
    expect(github.calls).toHaveLength(1); // one existence check, no branch creation
  });

  it("only checks the chain's last entry for a multi-entry chain", async () => {
    const github = fakeFetch({ [`GET ${REFS}/ai-implement/feature/ool-96`]: sha("tip-sha") });
    github.install();

    const branch = await resolvePlanningBranch({ ghToken: "t", issue: makeIssue({ featureBranchChain: [ool78, ool96] }), mapping });

    expect(branch).toBe("ai-implement/feature/ool-96");
    expect(github.calls).toHaveLength(1);
  });

  it("returns null and logs once when the chain's branch does not exist yet", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fakeFetch({ [`GET ${REFS}/ai-implement/feature/ool-78`]: { status: 404 } }).install();

    const branch = await resolvePlanningBranch({
      ghToken: "t",
      issue: makeIssue({ identifier: "OOL-87", scopeKey: "OOL", featureBranchChain: [ool78] }),
      mapping,
    });

    expect(branch).toBeNull();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain("OOL-87");
    expect(logSpy.mock.calls[0][0]).toContain("ai-implement/feature/ool-78");
    expect(logSpy.mock.calls[0][0]).toContain("testing"); // the fallback (mapping.defaultBranch)
  });

  it("returns null and makes no request when there is no chain", async () => {
    const github = fakeFetch({});
    github.install();

    const branch = await resolvePlanningBranch({ ghToken: "t", issue: makeIssue(), mapping });

    expect(branch).toBeNull();
    expect(github.calls).toHaveLength(0);
  });
});

describe("findOpenRollUpPr (parent no-work churn guard)", () => {
  const parent = (identifier: string) =>
    makeIssue({ identifier, scopeKey: "P", featureBranchChain: [{ identifier, mode: "feature" }] });

  it("returns the PR when an open roll-up exists for the parent's feature branch", async () => {
    const finder = vi.fn(async () => ({ number: 42, url: "u", state: "open" as const, merged: false }));
    const pr = await findOpenRollUpPr({ ghToken: "tok", issue: parent("P-1"), mapping, finder });
    expect(pr).toEqual({ number: 42, url: "u" });
    expect(finder).toHaveBeenCalledWith("tok", "test-org", "test-repo", "ai-implement/feature/p-1", "testing");
  });

  it("returns null for merged/closed roll-ups and for non-parent (leaf) chains", async () => {
    const merged = vi.fn(async () => ({ number: 1, url: "u", state: "closed" as const, merged: true }));
    expect(await findOpenRollUpPr({ ghToken: "t", issue: parent("P-2"), mapping, finder: merged })).toBeNull();
    // leaf: chain ends at an ancestor, not itself -> guard does not apply, finder never called
    const leafFinder = vi.fn();
    const leaf = makeIssue({ featureBranchChain: [{ identifier: "P-9", mode: "feature" }] });
    expect(await findOpenRollUpPr({ ghToken: "t", issue: leaf, mapping, finder: leafFinder })).toBeNull();
    expect(leafFinder).not.toHaveBeenCalled();
    // empty chain
    const bare = makeIssue({ featureBranchChain: [] });
    expect(await findOpenRollUpPr({ ghToken: "t", issue: bare, mapping, finder: leafFinder })).toBeNull();
  });
});
