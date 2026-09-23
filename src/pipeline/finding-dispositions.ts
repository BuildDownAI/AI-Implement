import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GhResult, GhSpawn, ReviewLedgerFinding } from "./review-ledger.js";

export function stableReviewFindingKey(finding: ReviewLedgerFinding): string {
  const material = [
    finding.source,
    finding.path ?? "",
    typeof finding.line === "number" ? String(finding.line) : "",
    normalizeBody(finding.body),
  ].join("\n");
  return crypto.createHash("sha256").update(material).digest("hex");
}

function normalizeBody(body: string): string {
  return body.replace(/\s+/g, " ").trim().toLowerCase();
}

export type Disposition = "fixed" | "follow-up" | "invalid";

export interface FindingDisposition {
  findingKey: string;
  disposition: Disposition;
  reason: string;
}

const FINDING_KEY_RE = /^[0-9a-f]{64}$/;
const MAX_REASON_LENGTH = 500;
const MAX_VALID_ENTRIES = 200;

export function sanitizeFindingDispositions(value: unknown): { valid: FindingDisposition[]; dropped: number } {
  if (!Array.isArray(value)) return { valid: [], dropped: 0 };

  const byKey = new Map<string, FindingDisposition>();
  let dropped = 0;

  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.findingKey !== "string" || !FINDING_KEY_RE.test(entry.findingKey)) {
      dropped++;
      continue;
    }
    if (entry.disposition !== "fixed" && entry.disposition !== "follow-up" && entry.disposition !== "invalid") {
      dropped++;
      continue;
    }
    const reason = typeof entry.reason === "string" ? entry.reason.slice(0, MAX_REASON_LENGTH) : "";
    byKey.set(entry.findingKey, { findingKey: entry.findingKey, disposition: entry.disposition, reason });
  }

  const deduped = [...byKey.values()];
  dropped += Math.max(0, deduped.length - MAX_VALID_ENTRIES);
  const valid = deduped.slice(0, MAX_VALID_ENTRIES);

  return { valid, dropped };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export const DISPOSITIONS_FILE = "ai-output/finding-dispositions.json";
const DISPOSITION_MARKER = "<!-- ai-implement finding-disposition -->";

export function buildDispositionInstructions(): string {
  return `## Finding dispositions

Give every listed finding exactly one disposition, keyed by its \`findingKey\`, and write a JSON array to \`${DISPOSITIONS_FILE}\`. Each entry has \`findingKey\`, \`disposition\`, and \`reason\`.

- \`fixed\`: you changed the code to address it.
- \`invalid\`: the finding is wrong about the code. Say why in one sentence.
- \`follow-up\`: the finding asks for behavior the issue does not require. Do not implement it. Say what it asks for in one sentence.

A finding that reports a defect in lines this PR changed is always in scope. It can only be \`fixed\` or \`invalid\`, never \`follow-up\`.

Compare every finding with the issue's acceptance criteria before you choose a disposition.`;
}

export function readFindingDispositions(workspaceDir: string): { valid: FindingDisposition[]; dropped: number } {
  const filePath = path.join(workspaceDir, DISPOSITIONS_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    console.log(`[finding-dispositions] no dispositions file at ${DISPOSITIONS_FILE}`);
    return { valid: [], dropped: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log(`[finding-dispositions] invalid JSON in ${DISPOSITIONS_FILE}`);
    return { valid: [], dropped: 0 };
  }

  return sanitizeFindingDispositions(parsed);
}

interface ReviewThread {
  id: string;
  isResolved: boolean;
  path?: string;
  line?: number;
  body: string;
}

export function replyToDispositionThreads(ghSpawn: GhSpawn, prNumber: string, dispositions: FindingDisposition[]): number {
  const byKey = new Map(dispositions.map((d) => [d.findingKey, d]));
  const threads = listUnresolvedThreads(ghSpawn, prNumber);

  let replied = 0;
  for (const thread of threads) {
    const key = stableReviewFindingKey({ source: "github-review-thread", severity: "medium", body: thread.body, ...(thread.path ? { path: thread.path } : {}), ...(typeof thread.line === "number" ? { line: thread.line } : {}) });
    const disposition = byKey.get(key);
    if (!disposition) continue;

    if (disposition.disposition === "follow-up") {
      if (replyToThread(ghSpawn, thread.id, `${DISPOSITION_MARKER}\nDeferred as a follow-up: ${disposition.reason}`)) {
        replied++;
        resolveThread(ghSpawn, thread.id);
      }
    } else if (disposition.disposition === "invalid") {
      if (replyToThread(ghSpawn, thread.id, `${DISPOSITION_MARKER}\nNot changed: ${disposition.reason}`)) {
        replied++;
      }
    }
  }

  return replied;
}

function listUnresolvedThreads(ghSpawn: GhSpawn, prNumber: string): ReviewThread[] {
  const threads: ReviewThread[] = [];
  let after: string | undefined;

  for (;;) {
    const result = safeGhSpawn(ghSpawn, buildThreadsArgs(prNumber, after));
    if (!result) break;

    const connection = getReviewThreadsConnection(parseJson(result.stdout));
    if (!connection) break;

    for (const node of connection.nodes) {
      if (!isRecord(node) || node.isResolved !== false || typeof node.id !== "string") continue;
      const comments = isRecord(node.comments) && Array.isArray(node.comments.nodes) ? node.comments.nodes : [];
      const firstComment = comments[0];
      if (!isRecord(firstComment) || typeof firstComment.body !== "string") continue;
      threads.push({
        id: node.id,
        isResolved: false,
        ...(typeof node.path === "string" ? { path: node.path } : {}),
        ...(typeof node.line === "number" ? { line: node.line } : {}),
        body: firstComment.body.trim(),
      });
    }

    const pageInfo = connection.pageInfo;
    if (!isRecord(pageInfo) || pageInfo.hasNextPage !== true || typeof pageInfo.endCursor !== "string") break;
    after = pageInfo.endCursor;
  }

  return threads;
}

function replyToThread(ghSpawn: GhSpawn, threadId: string, body: string): boolean {
  const result = safeGhSpawn(ghSpawn, [
    "api",
    "graphql",
    "-f",
    `query=${addReplyMutation}`,
    "-f",
    `threadId=${threadId}`,
    "-f",
    `body=${body}`,
  ]);
  if (!result || result.exitCode !== 0) {
    console.log(`[finding-dispositions] failed to reply to thread ${threadId}: ${result?.stderr ?? "unknown error"}`);
    return false;
  }
  return true;
}

function resolveThread(ghSpawn: GhSpawn, threadId: string): void {
  const result = safeGhSpawn(ghSpawn, [
    "api",
    "graphql",
    "-f",
    `query=${resolveThreadMutation}`,
    "-f",
    `threadId=${threadId}`,
  ]);
  if (!result || result.exitCode !== 0) {
    console.log(`[finding-dispositions] failed to resolve thread ${threadId}: ${result?.stderr ?? "unknown error"}`);
  }
}

function buildThreadsArgs(prNumber: string, after?: string): string[] {
  const args = [
    "api",
    "graphql",
    "-F",
    "owner={owner}",
    "-F",
    "repo={repo}",
    "-F",
    `number=${prNumber}`,
    "-f",
    `query=${dispositionThreadsQuery}`,
  ];

  if (after) {
    args.push("-F", `after=${after}`);
  }

  return args;
}

function safeGhSpawn(ghSpawn: GhSpawn, args: string[]): GhResult | undefined {
  try {
    return ghSpawn(args);
  } catch {
    return undefined;
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function getReviewThreadsConnection(payload: unknown): { nodes: unknown[]; pageInfo?: Record<string, unknown> } | undefined {
  if (!isRecord(payload)) return undefined;
  const data = payload.data;
  if (!isRecord(data)) return undefined;
  const repository = data.repository;
  if (!isRecord(repository)) return undefined;
  const pullRequest = repository.pullRequest;
  if (!isRecord(pullRequest)) return undefined;
  const reviewThreads = pullRequest.reviewThreads;
  if (!isRecord(reviewThreads)) return undefined;
  if (!Array.isArray(reviewThreads.nodes)) return undefined;
  return {
    nodes: reviewThreads.nodes,
    ...(isRecord(reviewThreads.pageInfo) ? { pageInfo: reviewThreads.pageInfo } : {}),
  };
}

const dispositionThreadsQuery = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes {
          id
          isResolved
          path
          line
          comments(first: 1) {
            nodes {
              body
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
`;

const addReplyMutation = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment {
      id
    }
  }
}
`;

const resolveThreadMutation = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
    }
  }
}
`;
