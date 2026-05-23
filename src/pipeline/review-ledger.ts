export type ReviewLedgerSource =
  | "claude-review-summary"
  | "github-review"
  | "github-review-thread"
  | "ai-implement-internal";

export type ReviewLedgerSeverity = "blocking" | "medium" | "minor";

export interface ReviewLedgerFinding {
  source: ReviewLedgerSource;
  severity: ReviewLedgerSeverity;
  body: string;
  path?: string;
  line?: number;
  url?: string;
}

export interface GhResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
}

export type GhSpawn = (args: string[]) => GhResult;

export function collectExternalReviewFindingsFromGh(ghSpawn: GhSpawn, prNumber: string): ReviewLedgerFinding[] {
  const findings: ReviewLedgerFinding[] = [];

  collectChangesRequestedReviews(ghSpawn, prNumber, findings);
  collectUnresolvedReviewThreads(ghSpawn, prNumber, findings);

  return findings;
}

export function extractClaudeSummaryFindings(body: string, url?: string): ReviewLedgerFinding[] {
  const items: string[] = [];
  let inBlockingSection = false;
  let currentItem: string | undefined;

  const flushCurrentItem = () => {
    if (!currentItem) return;

    const normalizedBody = normalizeText(currentItem);
    if (normalizedBody) {
      items.push(normalizedBody);
    }

    currentItem = undefined;
  };

  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushCurrentItem();
      inBlockingSection = /^blocking\b/i.test(normalizeText(heading[1]));
      continue;
    }

    if (!inBlockingSection) continue;

    const bullet = line.match(/^\s*(?:[-*+]|\d+[\.)])\s+(.+)$/);
    if (bullet) {
      flushCurrentItem();
      currentItem = bullet[1];
      continue;
    }

    const continuation = line.match(/^\s{2,}(\S.*)$/);
    if (continuation && currentItem) {
      currentItem = `${currentItem} ${continuation[1]}`;
    }
  }

  flushCurrentItem();

  return items.map((item) => ({
    source: "claude-review-summary",
    severity: "blocking",
    body: item,
    ...(url ? { url } : {}),
  }));
}

export function formatReviewLedgerForPrompt(findings: ReviewLedgerFinding[]): string {
  if (findings.length === 0) {
    return "No unresolved external review findings.";
  }

  return findings
    .map((finding, index) => {
      const location = formatLocation(finding);
      const header = [`[external-${index + 1}]`, finding.source, finding.severity, location]
        .filter(Boolean)
        .join(" ");
      return [header, finding.body, finding.url ? `URL: ${finding.url}` : undefined].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function formatLocation(finding: ReviewLedgerFinding): string | undefined {
  if (!finding.path) return undefined;
  return typeof finding.line === "number" ? `${finding.path}:${finding.line}` : finding.path;
}

function collectChangesRequestedReviews(ghSpawn: GhSpawn, prNumber: string, findings: ReviewLedgerFinding[]): void {
  const result = safeGhSpawn(ghSpawn, [
    "api",
    "--paginate",
    "--slurp",
    `repos/:owner/:repo/pulls/${prNumber}/reviews?per_page=100`,
  ]);
  if (!result || result.exitCode !== 0) return;

  const reviews = parseReviewPages(result.stdout);

  const latestActionableReviewsByReviewer = new Map<string, Record<string, unknown>>();

  reviews.forEach((review, index) => {
    if (!isRecord(review) || !isActionableReviewState(review.state)) return;

    latestActionableReviewsByReviewer.set(getReviewReviewerKey(review, index), review);
  });

  for (const review of latestActionableReviewsByReviewer.values()) {
    if (review.state !== "CHANGES_REQUESTED" || typeof review.body !== "string") continue;
    const body = review.body.trim();
    if (!body) continue;

    findings.push({
      source: "github-review",
      severity: "blocking",
      body,
      ...(typeof review.html_url === "string" ? { url: review.html_url } : {}),
    });
  }
}

function collectUnresolvedReviewThreads(ghSpawn: GhSpawn, prNumber: string, findings: ReviewLedgerFinding[]): void {
  let after: string | undefined;

  for (;;) {
    const result = safeGhSpawn(ghSpawn, buildReviewThreadsArgs(prNumber, after));
    if (!result || result.exitCode !== 0) return;

    const payload = parseJson(result.stdout);
    const reviewThreads = getReviewThreadsConnection(payload);
    if (!reviewThreads) return;

    collectReviewThreadFindings(reviewThreads.nodes, findings);

    if (reviewThreads.pageInfo?.hasNextPage !== true) return;
    if (typeof reviewThreads.pageInfo.endCursor !== "string" || !reviewThreads.pageInfo.endCursor) return;

    after = reviewThreads.pageInfo.endCursor;
  }
}

function buildReviewThreadsArgs(prNumber: string, after?: string): string[] {
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
    `query=${reviewThreadsQuery}`,
  ];

  if (after) {
    args.push("-F", `after=${after}`);
  }

  return args;
}

function collectReviewThreadFindings(nodes: unknown[], findings: ReviewLedgerFinding[]): void {
  for (const thread of nodes) {
    if (!isRecord(thread) || thread.isResolved !== false || thread.isOutdated === true) continue;

    const comments = getCommentNodes(thread);
    const latestComment = comments?.at(-1);
    if (!isRecord(latestComment) || typeof latestComment.body !== "string") continue;

    const body = latestComment.body.trim();
    if (!body) continue;

    findings.push({
      source: "github-review-thread",
      severity: "blocking",
      body,
      ...(typeof thread.path === "string" ? { path: thread.path } : {}),
      ...(typeof thread.line === "number" ? { line: thread.line } : {}),
      ...(typeof latestComment.url === "string" ? { url: latestComment.url } : {}),
    });
  }
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

function parseReviewPages(stdout: string): unknown[] {
  const payload = parseJson(stdout);
  if (!Array.isArray(payload)) return [];
  if (payload.every(Array.isArray)) return payload.flat();
  return payload;
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

function getCommentNodes(thread: Record<string, unknown>): unknown[] | undefined {
  const comments = thread.comments;
  if (!isRecord(comments)) return undefined;
  return Array.isArray(comments.nodes) ? comments.nodes : undefined;
}

function isActionableReviewState(value: unknown): value is "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" {
  return value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "DISMISSED";
}

function getReviewReviewerKey(review: Record<string, unknown>, fallbackIndex: number): string {
  const user = review.user;
  if (!isRecord(user)) return `review:${fallbackIndex}`;
  if (typeof user.id === "number" || typeof user.id === "string") return `user-id:${user.id}`;
  if (typeof user.login === "string") return `user-login:${user.login}`;
  return `review:${fallbackIndex}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const reviewThreadsQuery = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            nodes {
              body
              url
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
