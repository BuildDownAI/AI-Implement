import { describe, expect, it, vi } from "vitest";
import {
  REVIEW_PROCESSES,
  classifyClaudeInlineMarker,
  isReviewProcessId,
  isTrustedReviewAuthor,
  parseBughunterSeverity,
  resolveReviewProcess,
  type ReviewVerdictInput,
} from "../review-process.js";

const HEAD = "abc123";
const claude = REVIEW_PROCESSES["claude-code-review"];
const aiImplement = REVIEW_PROCESSES["ai-implement"];

const check = (over: Partial<ReviewVerdictInput["checkRuns"][number]> = {}): ReviewVerdictInput["checkRuns"][number] => ({
  name: "review", appSlug: "github-actions", status: "completed", conclusion: "success", outputText: null, ...over,
});
const comment = (over: Partial<ReviewVerdictInput["inlineComments"][number]> = {}): ReviewVerdictInput["inlineComments"][number] => ({
  authorLogin: "claude[bot]", authorType: "Bot", body: "Rename this.", path: "a.ts", line: 3, commitId: HEAD, ...over,
});
const input = (over: Partial<ReviewVerdictInput> = {}): ReviewVerdictInput => ({
  headSha: HEAD, checkRuns: [check()], inlineComments: [comment(), comment({ line: 9 })], blocks: [], ...over,
});
const hosted = (normal: number) =>
  `Details\n<!-- bughunter-severity: {"normal":${normal},"nit":1,"pre_existing":0} -->`;

describe("definitions", () => {
  it("lists every entry exactly", () => {
    expect(aiImplement.trustedAuthors).toEqual(["ai-implement", "ai-implement[bot]", "claude", "claude[bot]", "claude-code[bot]", "github-actions[bot]"]);
    expect(aiImplement.checkPairs).toEqual([{ names: "project-review-check-names", appSlug: "github-actions" }]);
    expect(aiImplement.fixer).toBe("ai-implement");
    expect(claude.trustedAuthors).toEqual(["claude[bot]", "claude"]);
    expect(claude.checkPairs).toEqual([
      { names: "project-review-check-names", appSlug: "github-actions" },
      { names: ["Claude Code Review"], appSlug: "claude" },
    ]);
    expect(claude.fixer).toBe("ai-implement");
  });

  it("keeps trusted authors lowercase", () => {
    for (const p of Object.values(REVIEW_PROCESSES)) {
      for (const a of p.trustedAuthors) expect(a).toBe(a.toLowerCase());
    }
  });
});

describe("resolveReviewProcess", () => {
  it("resolves known ids and defaults the rest without logging", () => {
    const spies = (["log", "warn", "error", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    expect(resolveReviewProcess("claude-code-review").id).toBe("claude-code-review");
    for (const v of [null, undefined, "x", 3, "toString"]) expect(resolveReviewProcess(v)).toBe(aiImplement);
    for (const s of spies) { expect(s).not.toHaveBeenCalled(); s.mockRestore(); }
  });

  it("isReviewProcessId", () => {
    expect(isReviewProcessId("ai-implement")).toBe(true);
    expect(isReviewProcessId("constructor")).toBe(false);
    expect(isReviewProcessId(null)).toBe(false);
  });
});

describe("isTrustedReviewAuthor", () => {
  it("is case-insensitive and honors extras", () => {
    expect(isTrustedReviewAuthor("Claude[bot]", claude, [])).toBe(true);
    expect(isTrustedReviewAuthor("topia-ai-implement-bot[bot]", claude, ["topia-ai-implement-bot[bot]"])).toBe(true);
    expect(isTrustedReviewAuthor("topia-ai-implement-bot[bot]", claude, [])).toBe(false);
    expect(isTrustedReviewAuthor("github-actions[bot]", claude, [])).toBe(false);
    expect(isTrustedReviewAuthor("github-actions[bot]", aiImplement, [])).toBe(true);
  });
});

describe("claude-code-review readVerdict", () => {
  it("reads the Topia shape as approve with minor findings", () => {
    const r = claude.readVerdict(input());
    expect(r.verdict).toBe("approve");
    expect(r.source).toBe("check-and-comments");
    expect(r.findings.map((f) => f.severity)).toEqual(["minor", "minor"]);
  });

  it("a red comment blocks; purple, untrusted, stale-commit, and non-bot comments add nothing", () => {
    const r = claude.readVerdict(input({ inlineComments: [
      comment({ body: "🔴 **Important** broken" }),
      comment({ body: "🟣 old" }),
      comment({ authorLogin: "someone[bot]" }),
      comment({ commitId: "other" }),
      comment({ authorType: "User" }),
    ] }));
    expect(r.verdict).toBe("changes_requested");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.severity).toBe("blocking");
  });

  it("counts a comment with no commitId", () => {
    const { commitId: _c, ...bare } = comment();
    expect(claude.readVerdict(input({ inlineComments: [bare] })).findings).toHaveLength(1);
  });

  it("reads the hosted severity line", () => {
    const run = check({ name: "Claude Code Review", appSlug: "claude", conclusion: "neutral", outputText: hosted(2) });
    expect(claude.readVerdict(input({ checkRuns: [run], inlineComments: [] }))).toMatchObject({ verdict: "changes_requested", source: "bughunter-severity" });
    const zero = { ...run, outputText: hosted(0) };
    expect(claude.readVerdict(input({ checkRuns: [zero], inlineComments: [] }))).toMatchObject({ verdict: "approve", source: "bughunter-severity" });
  });

  it("does not match the claude pair for a github-actions check with the severity line", () => {
    const run = check({ name: "Claude Code Review", conclusion: "neutral", outputText: hosted(2) });
    const r = claude.readVerdict(input({ checkRuns: [run], inlineComments: [] }));
    expect(r.source).not.toBe("bughunter-severity");
    expect(r.verdict).toBe("no-real-verdict");
  });

  it("handles failure and missing or unfinished checks", () => {
    expect(claude.readVerdict(input({ checkRuns: [check({ conclusion: "failure" })] })).verdict).toBe("no-real-verdict");
    expect(claude.readVerdict(input({ checkRuns: [] })).verdict).toBe("incomplete");
    expect(claude.readVerdict(input({ checkRuns: [check({ status: "in_progress", conclusion: null })] })).verdict).toBe("incomplete");
    expect(claude.readVerdict(input({ checkRuns: [check({ name: "lint" })] })).verdict).toBe("incomplete");
  });

  it("a block wins over check runs; a block without a verdict is incomplete", () => {
    const finding = { source: "review-contract" as const, severity: "blocking" as const, body: "x" };
    const r = claude.readVerdict(input({ blocks: [{ findings: [finding], verdict: "changes_requested", findingsUnavailable: false }] }));
    expect(r).toEqual({ verdict: "changes_requested", source: "review-contract", findings: [finding] });
    expect(claude.readVerdict(input({ blocks: [{ findings: [], findingsUnavailable: true }] })).verdict).toBe("incomplete");
  });
});

describe("ai-implement readVerdict", () => {
  it("the newest block wins; none is no-real-verdict", () => {
    const newest = { findings: [], verdict: "approve" as const, findingsUnavailable: false };
    const older = { findings: [], verdict: "changes_requested" as const, findingsUnavailable: false };
    expect(aiImplement.readVerdict(input({ blocks: [newest, older] }))).toEqual({ verdict: "approve", source: "review-contract", findings: [] });
    expect(aiImplement.readVerdict(input())).toEqual({ verdict: "no-real-verdict", source: "none", findings: [] });
  });
});

describe("helpers", () => {
  it("classifyClaudeInlineMarker", () => {
    expect(classifyClaudeInlineMarker("🔴 x")).toBe("blocking");
    expect(classifyClaudeInlineMarker("🟡 x")).toBe("minor");
    expect(classifyClaudeInlineMarker("🟣 x")).toBeNull();
    expect(classifyClaudeInlineMarker("plain")).toBe("untagged");
  });

  it("parseBughunterSeverity", () => {
    expect(parseBughunterSeverity(hosted(2))).toEqual({ normal: 2, nit: 1, pre_existing: 0 });
    expect(parseBughunterSeverity("no line")).toBeNull();
    expect(parseBughunterSeverity("<!-- bughunter-severity: {oops} -->")).toBeNull();
    expect(parseBughunterSeverity('<!-- bughunter-severity: {"normal":1} -->')).toBeNull();
  });
});
