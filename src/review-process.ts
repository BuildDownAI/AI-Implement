/** The review process definitions (ADR 038): who reviews a PR, how their verdict is read, and who fixes it.
 * One table keyed by id; every reader is a plain function with no `ctx`, no store writes, and no I/O.
 * The definition is trusted input that can approve a PR, so every author and `appSlug` is spelled out. */
import type { ReviewFindingsBlockResult, ReviewLedgerFinding } from "./pipeline/review-ledger.js";

export type ReviewProcessId = "ai-implement" | "claude-code-review";
export type ReviewFixer = "ai-implement" | "repository";

export interface ReviewCheckPair {
  /** Check-run names, or the marker for the project's `reviewCheckNames` / DEFAULT_REVIEW_CHECK_NAMES. */
  names: string[] | "project-review-check-names";
  /** `app.slug` of the GitHub App that posts the check run. */
  appSlug: string;
}

export interface ReviewVerdictInput {
  headSha: string;
  checkRuns: Array<{ name: string; appSlug: string; status: string; conclusion: string | null; outputText: string | null }>;
  inlineComments: Array<{ authorLogin: string; authorType: string; body: string; path?: string; line?: number; commitId?: string; url?: string }>;
  /** Findings blocks (ADR 020) already extracted from trusted comments, newest first. */
  blocks: ReviewFindingsBlockResult[];
}

export interface ReviewVerdictResult {
  verdict: "approve" | "changes_requested" | "incomplete" | "no-real-verdict";
  source: "review-contract" | "bughunter-severity" | "check-and-comments" | "none";
  findings: ReviewLedgerFinding[];
}

export interface ReviewProcessDefinition {
  id: ReviewProcessId;
  label: string;
  trustedAuthors: readonly string[];       // lowercase logins
  checkPairs: readonly ReviewCheckPair[];
  readVerdict(input: ReviewVerdictInput): ReviewVerdictResult;
  fixer: ReviewFixer;
}

// Mirrors DEFAULT_REVIEW_CHECK_NAMES in `pipeline/steps/post-push-review.ts` (not exported there). The marker
// resolves to this list because the module is pure and holds no project settings.
const DEFAULT_REVIEW_CHECK_NAMES = ["review", "code-review-plugin", "claude-review", "claude code review", "claude-code-review"];

const BUGHUNTER_RE = /<!--\s*bughunter-severity:\s*(\{[^}]*\})\s*-->\s*$/;

export function parseBughunterSeverity(outputText: string): { normal: number; nit: number; pre_existing: number } | null {
  const match = BUGHUNTER_RE.exec(outputText);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { normal, nit, pre_existing } = parsed as Record<string, unknown>;
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!valid(normal) || !valid(nit) || !valid(pre_existing)) return null;
  return { normal, nit, pre_existing };
}

export function classifyClaudeInlineMarker(body: string): "blocking" | "minor" | null | "untagged" {
  const text = body.trimStart();
  if (text.startsWith("🔴")) return "blocking";
  if (text.startsWith("🟡")) return "minor";
  if (text.startsWith("🟣")) return null;
  return "untagged";
}

function matchesPair(run: { name: string; appSlug: string }, pair: ReviewCheckPair): boolean {
  if (run.appSlug.toLowerCase() !== pair.appSlug.toLowerCase()) return false;
  const names = pair.names === "project-review-check-names" ? DEFAULT_REVIEW_CHECK_NAMES : pair.names;
  const name = run.name.trim().toLowerCase();
  return names.some((n) => n.trim().toLowerCase() === name);
}

export function isTrustedReviewAuthor(login: string, process: ReviewProcessDefinition, extra: readonly string[]): boolean {
  const normalized = login.trim().toLowerCase();
  if (!normalized) return false;
  return process.trustedAuthors.includes(normalized) || extra.some((e) => e.trim().toLowerCase() === normalized);
}

function readBlock(blocks: ReviewFindingsBlockResult[]): ReviewVerdictResult | null {
  const block = blocks[0];
  if (!block) return null;
  // A block that carries no verdict is not a verdict: the reviewer has not finished.
  return { verdict: block.verdict ?? "incomplete", source: "review-contract", findings: block.findings };
}

function noBlock(): ReviewVerdictResult {
  return { verdict: "no-real-verdict", source: "none", findings: [] };
}

const AI_IMPLEMENT_AUTHORS = ["ai-implement", "ai-implement[bot]", "claude", "claude[bot]", "claude-code[bot]", "github-actions[bot]"] as const;
const CLAUDE_CODE_REVIEW_AUTHORS = ["claude[bot]", "claude"] as const;

const GITHUB_ACTIONS_PAIR: ReviewCheckPair = { names: "project-review-check-names", appSlug: "github-actions" };
const CLAUDE_PAIR: ReviewCheckPair = { names: ["Claude Code Review"], appSlug: "claude" };

function inlineFindings(input: ReviewVerdictInput, authors: readonly string[]): ReviewLedgerFinding[] {
  const findings: ReviewLedgerFinding[] = [];
  for (const c of input.inlineComments) {
    if (c.authorType !== "Bot") continue;
    if (!authors.includes(c.authorLogin.trim().toLowerCase())) continue;
    if (c.commitId !== undefined && c.commitId !== input.headSha) continue;
    const marker = classifyClaudeInlineMarker(c.body);
    if (marker === null) continue;
    findings.push({
      source: "github-review",
      // Untagged is recorded as minor: the webhook already stores an inline comment as non-blocking.
      severity: marker === "blocking" ? "blocking" : "minor",
      body: c.body,
      ...(c.path ? { path: c.path } : {}),
      ...(c.line !== undefined ? { line: c.line } : {}),
      ...(c.url ? { url: c.url } : {}),
    });
  }
  return findings;
}

function claudeCodeReviewVerdict(input: ReviewVerdictInput): ReviewVerdictResult {
  const fromBlock = readBlock(input.blocks);
  if (fromBlock) return fromBlock;

  const completed = input.checkRuns.filter((r) => r.status === "completed");

  for (const run of completed) {
    if (!matchesPair(run, CLAUDE_PAIR) || run.outputText === null) continue;
    const severity = parseBughunterSeverity(run.outputText);
    if (!severity) continue;
    return { verdict: severity.normal > 0 ? "changes_requested" : "approve", source: "bughunter-severity", findings: [] };
  }

  const actionsRun = completed.find((r) => matchesPair(r, GITHUB_ACTIONS_PAIR));
  if (actionsRun) {
    if (actionsRun.conclusion !== "success") return { verdict: "no-real-verdict", source: "check-and-comments", findings: [] };
    const findings = inlineFindings(input, CLAUDE_CODE_REVIEW_AUTHORS);
    const blocking = findings.some((f) => f.severity === "blocking");
    return { verdict: blocking ? "changes_requested" : "approve", source: "check-and-comments", findings };
  }

  return { verdict: "incomplete", source: "none", findings: [] };
}

export const REVIEW_PROCESSES: Record<ReviewProcessId, ReviewProcessDefinition> = {
  "ai-implement": {
    id: "ai-implement",
    label: "AI-Implement review",
    trustedAuthors: AI_IMPLEMENT_AUTHORS,
    checkPairs: [GITHUB_ACTIONS_PAIR],
    readVerdict: (input) => readBlock(input.blocks) ?? noBlock(),
    fixer: "ai-implement",
  },
  "claude-code-review": {
    id: "claude-code-review",
    label: "Claude Code Review",
    trustedAuthors: CLAUDE_CODE_REVIEW_AUTHORS,
    checkPairs: [GITHUB_ACTIONS_PAIR, CLAUDE_PAIR],
    readVerdict: claudeCodeReviewVerdict,
    fixer: "ai-implement",
  },
};

export function isReviewProcessId(value: unknown): value is ReviewProcessId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REVIEW_PROCESSES, value);
}

/** Unknown or null falls to the default and logs nothing: a stored value from a newer orchestrator must not
 * stop every review on an older one. */
export function resolveReviewProcess(id: unknown): ReviewProcessDefinition {
  return isReviewProcessId(id) ? REVIEW_PROCESSES[id] : REVIEW_PROCESSES["ai-implement"];
}
