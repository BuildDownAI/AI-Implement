export interface ReviewIssue {
  title: string;
  location?: string;
  problem: string;
  requiredFix: string;
}

export interface ReviewVerdict {
  approved: boolean;
  blockingIssues: ReviewIssue[];
  score: number;
  progressDelta: number;
  feedback: string;
}

export const REVIEW_VERDICT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "blocking_issues", "score", "progress_delta", "feedback"],
  properties: {
    approved: { type: "boolean" },
    blocking_issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "problem", "required_fix"],
        properties: {
          title: { type: "string", minLength: 1 },
          location: { type: "string" },
          problem: { type: "string", minLength: 1 },
          required_fix: { type: "string", minLength: 1 },
        },
      },
    },
    score: { type: "integer", minimum: 0, maximum: 100 },
    progress_delta: { type: "integer", minimum: 0, maximum: 100 },
    feedback: { type: "string" },
  },
};

interface RawReviewIssue {
  title?: unknown;
  location?: unknown;
  problem?: unknown;
  required_fix?: unknown;
}

interface RawReviewVerdict {
  approved?: unknown;
  blocking_issues?: unknown;
  score?: unknown;
  progress_delta?: unknown;
  feedback?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function boundedInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`expected ${field} to be an integer from 0 to 100`);
  }
  return value;
}

function rejectUnexpectedKeys(record: Record<string, unknown>, allowed: Set<string>, context: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`unexpected field ${context}.${key}`);
  }
}

const REVIEW_VERDICT_KEYS = new Set(["approved", "blocking_issues", "score", "progress_delta", "feedback"]);
const REVIEW_ISSUE_KEYS = new Set(["title", "location", "problem", "required_fix"]);

function parseIssue(value: unknown, index: number): ReviewIssue {
  if (!isRecord(value)) throw new Error(`expected blocking_issues[${index}] to be an object`);
  rejectUnexpectedKeys(value, REVIEW_ISSUE_KEYS, `blocking_issues[${index}]`);
  const issue = value as RawReviewIssue;
  const title = nonEmptyString(issue.title);
  if (!title) throw new Error(`expected blocking_issues[${index}].title to be a non-empty string`);
  const problem = nonEmptyString(issue.problem);
  if (!problem) throw new Error(`expected blocking_issues[${index}].problem to be a non-empty string`);
  const requiredFix = nonEmptyString(issue.required_fix);
  if (!requiredFix) throw new Error(`expected blocking_issues[${index}].required_fix to be a non-empty string`);
  if (issue.location !== undefined && typeof issue.location !== "string") {
    throw new Error(`expected blocking_issues[${index}].location to be a string when present`);
  }
  const location = nonEmptyString(issue.location) ?? undefined;
  return { title, ...(location ? { location } : {}), problem, requiredFix };
}

export function parseReviewVerdict(value: unknown): ReviewVerdict {
  if (!isRecord(value)) throw new Error("expected structured review output to be an object");
  rejectUnexpectedKeys(value, REVIEW_VERDICT_KEYS, "review");
  const raw = value as RawReviewVerdict;
  if (typeof raw.approved !== "boolean") throw new Error("expected approved to be a boolean");
  if (!Array.isArray(raw.blocking_issues)) throw new Error("expected blocking_issues to be an array");
  if (typeof raw.feedback !== "string") throw new Error("expected feedback to be a string");

  const blockingIssues = raw.blocking_issues.map(parseIssue);

  return {
    approved: raw.approved && blockingIssues.length === 0,
    blockingIssues,
    score: boundedInteger(raw.score, "score"),
    progressDelta: boundedInteger(raw.progress_delta, "progress_delta"),
    feedback: raw.feedback.trim(),
  };
}

export function plainIssueText(issue: ReviewIssue): string {
  return [
    issue.title,
    issue.location ? `Location: ${issue.location}` : "",
    issue.problem ? `Problem: ${issue.problem}` : "",
    issue.requiredFix ? `Required fix: ${issue.requiredFix}` : "",
  ].filter(Boolean).join("\n");
}
