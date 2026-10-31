import { readFileSync } from "node:fs";
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

const HEAD = "502838ec1958f0b6795ae777106587865f9f6f8e";
const claude = REVIEW_PROCESSES["claude-code-review"];
const aiImplement = REVIEW_PROCESSES["ai-implement"];

const check = (over: Partial<ReviewVerdictInput["checkRuns"][number]> = {}): ReviewVerdictInput["checkRuns"][number] => ({
  name: "review", appSlug: "github-actions", status: "completed", conclusion: "success", outputText: null, ...over,
});
const comment = (over: Partial<ReviewVerdictInput["inlineComments"][number]> = {}): ReviewVerdictInput["inlineComments"][number] => ({
  authorLogin: "claude[bot]", authorType: "Bot", body: "Rename this.", path: "a.ts", line: 3, commitId: HEAD, ...over,
});
const input = (over: Partial<ReviewVerdictInput> = {}): ReviewVerdictInput => ({
  headSha: HEAD, checkRuns: [check()], inlineComments: [comment(), comment({ line: 9 })], blocks: [], issueComments: [], ...over,
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

  it("claude-code-review-repository-fix reads like claude-code-review but the repository fixes", () => {
    const repoFix = resolveReviewProcess("claude-code-review-repository-fix");
    expect(repoFix.id).toBe("claude-code-review-repository-fix");
    expect(repoFix.label).toBe("Claude Code Review, repository auto-fix");
    expect(repoFix.fixer).toBe("repository");
    expect(repoFix.trustedAuthors).toEqual(claude.trustedAuthors);
    expect(repoFix.checkPairs).toEqual(claude.checkPairs);
    expect(repoFix.readVerdict).toBe(claude.readVerdict);
    expect(repoFix.classifyInline).toBe(classifyClaudeInlineMarker);
    expect(repoFix.summaryBlockingGates).toBe(true);
    expect(claude.fixer).toBe("ai-implement");
    expect(aiImplement.summaryBlockingGates).toBe(false);
    expect(aiImplement.classifyInline).toBeUndefined();
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
    expect(isReviewProcessId("claude-code-review-repository-fix")).toBe(true);
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

describe("DEFAULT_REVIEW_CHECK_NAMES drift guard", () => {
  const literal = (file: string): string[] => {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    const m = /const DEFAULT_REVIEW_CHECK_NAMES = \[([^\]]*)\]/.exec(src);
    expect(m).not.toBeNull();
    return [...m![1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  };

  it("keeps the module's copy equal to post-push-review's list", () => {
    const original = literal("../pipeline/steps/post-push-review.ts");
    expect(original.length).toBeGreaterThan(0);
    expect(literal("../review-process.ts")).toEqual(original);
  });
});

const codex = REVIEW_PROCESSES["codex-code-review"];
const codexBadge = (p: number) => `**<sub><sub>![P${p} Badge](https://img.shields.io/badge/P${p}-yellow?style=flat)</sub></sub>  Handle multi-team history without inventing a winning team**`;
const stateComment = (status = "completed", unresolved: boolean = false, commit = HEAD) => ({
  authorLogin: "chatgpt-codex-connector[bot]", authorType: "Bot",
  body: `<!-- codex-pull-request-review-summary -->
<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${commit}","has_any_findings":true,"has_unresolved_findings":${unresolved},"status":"${status}"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->`,
});
describe("Codex Code Review", () => {
  it("defines only the Codex authors, with no check pairs and the AI fixer", () => {
    expect(codex.trustedAuthors).toEqual(["chatgpt-codex-connector[bot]", "chatgpt-codex-connector"]);
    expect(codex.checkPairs).toEqual([]);
    expect(codex.fixer).toBe("ai-implement");
  });
  it.each([[0, "blocking"], [1, "blocking"], [2, "minor"]])("classifies P%s", (p, severity) => {
    expect(codex.classifyInline!(codexBadge(Number(p)))).toBe(severity);
    expect(codex.classifyInline!("no badge")).toBe("untagged");
  });
  it.each([
    ["completed", false, "approve"], ["completed", true, "changes_requested"],
    ["running", false, "incomplete"], ["failed", false, "no-real-verdict"],
  ] as const)("reads %s unresolved=%s", (status, unresolved, verdict) => {
    expect(codex.readVerdict(input({ issueComments: [stateComment(status, unresolved)] })).verdict).toBe(verdict);
  });
  it.each([[0], [1], [1, 2], [2], [2, 2]])("gates unresolved badges %j", (...priorities) => {
    const inlineComments = priorities.map((p) => comment({ authorLogin: "chatgpt-codex-connector[bot]", body: codexBadge(p) }));
    const result = codex.readVerdict(input({ issueComments: [stateComment("completed", true)], inlineComments }));
    expect(result.verdict).toBe(priorities.every((p) => p === 2) ? "approve" : "changes_requested");
    expect(result.findings.map((f) => f.severity)).toEqual(priorities.map((p) => p === 2 ? "minor" : "blocking"));
  });
  it("ignores old P1 alongside head P2 and fails closed without readable head badges", () => {
    const minor = comment({ authorLogin: "chatgpt-codex-connector[bot]", body: codexBadge(2) });
    const old = { ...minor, body: codexBadge(1), commitId: "old" };
    const read = (inlineComments: ReviewVerdictInput["inlineComments"]) => codex.readVerdict(input({ issueComments: [stateComment("completed", true)], inlineComments }));
    expect(read([old, minor]).verdict).toBe("approve");
    for (const comments of [[], [old], [{ ...minor, body: "no badge" }], [{ ...minor, authorType: "User" }],
      [{ ...minor, authorLogin: "evil[bot]" }], [{ ...minor, commitId: undefined }]]) {
      expect(read(comments).verdict).toBe("changes_requested");
    }
  });
  it("includes only trusted badge findings on the exact head", () => {
    const comments = [0, 1, 2].map((p) => comment({ authorLogin: "chatgpt-codex-connector[bot]", body: codexBadge(p) }));
    const result = codex.readVerdict(input({ issueComments: [stateComment("completed", true)], inlineComments: [
      ...comments, { ...comments[0]!, commitId: "old" }, { ...comments[0]!, authorLogin: "evil[bot]" },
      { ...comments[0]!, body: "no badge" }, { ...comments[0]!, commitId: undefined },
    ] }));
    expect(result.findings.map((f) => f.severity)).toEqual(["blocking", "blocking", "minor"]);
  });
  it("ignores stale, untrusted, human and malformed state; silence waits", () => {
    for (const issueComments of [[], [stateComment("completed", false, "old")],
      [{ ...stateComment(), authorLogin: "evil[bot]" }], [{ ...stateComment(), authorType: "User" }],
      [{ ...stateComment(), body: "<!-- codex-review-state:v1 {oops} -->" }]]) {
      expect(codex.readVerdict(input({ issueComments })).verdict).toBe("incomplete");
    }
  });
  it("uses the newest matching state, including edits and the GraphQL login", () => {
    expect(codex.readVerdict(input({ issueComments: [stateComment(), stateComment("running")] })).verdict).toBe("incomplete");
    expect(codex.readVerdict(input({ issueComments: [
      { ...stateComment(), authorLogin: "chatgpt-codex-connector", updatedAt: "2026-10-30T12:00:00Z" },
      { ...stateComment("running"), updatedAt: "2026-10-30T11:00:00Z" },
    ] })).verdict).toBe("approve");
  });
});
