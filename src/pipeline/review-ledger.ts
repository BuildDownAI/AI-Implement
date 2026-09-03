export type ReviewLedgerSource =
  | "claude-review-summary"
  | "github-review"
  | "github-review-thread"
  | "ai-implement-internal";

export type ReviewLedgerSeverity = "blocking" | "medium" | "minor";

export const AI_IMPLEMENT_NATIVE_REVIEW_MARKER = "<!-- ai-implement native-review -->";

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

const TRUSTED_REVIEW_COMMENT_AUTHORS = new Set([
  "ai-implement",
  "ai-implement[bot]",
  "claude",
  "claude[bot]",
  "claude-code[bot]",
]);

const GITHUB_ACTIONS_REVIEW_AUTHOR = "github-actions";

export function collectExternalReviewFindingsFromGh(ghSpawn: GhSpawn, prNumber: string): { findings: ReviewLedgerFinding[]; findingsUnavailable: boolean } {
  const findings: ReviewLedgerFinding[] = [];
  const out = { findingsUnavailable: false };

  // A reviewer's latest formal verdict is authoritative: only reviewers currently in
  // CHANGES_REQUESTED state contribute blocking inline threads. Leftover nit threads from
  // a reviewer who has since approved (or only commented) are surfaced as non-blocking context.
  const blockingReviewerLogins = collectChangesRequestedReviews(ghSpawn, prNumber, findings);
  collectClaudeIssueComments(ghSpawn, prNumber, findings, out);
  collectUnresolvedReviewThreads(ghSpawn, prNumber, findings, blockingReviewerLogins);

  return { findings: dedupeReviewFindings(findings), findingsUnavailable: out.findingsUnavailable };
}

/** Normalizes a GitHub login so REST (`claude[bot]`) and GraphQL (`claude`) forms compare equal. */
function normalizeReviewerLogin(login: string): string {
  return login.trim().toLowerCase().replace(/\[bot\]$/, "");
}

function parseVerdictItem(item: unknown): { body: string; path?: string; line?: number } | null {
  if (typeof item === "string") {
    const body = item.trim();
    return body ? { body } : null;
  }
  if (!isRecord(item)) return null;
  const body = typeof item.body === "string" ? item.body.trim() : "";
  if (!body) return null;
  const path = typeof item.path === "string" && item.path ? item.path : undefined;
  const line = typeof item.line === "number" ? item.line : undefined;
  return { body, ...(path ? { path } : {}), ...(line !== undefined ? { line } : {}) };
}

/**
 * Extracts findings from a `<!-- claude-review-verdict {...} -->` marker embedded in a
 * comment body. Returns null when the marker is absent or the JSON is malformed (caller
 * should fall back to heading-based extraction). Returns an empty array when the marker
 * is present and valid but both blocking[] and minor[] are empty.
 */
export function extractVerdictMarkerFindings(body: string, url?: string): ReviewLedgerFinding[] | null {
  const markerPrefix = "<!-- claude-review-verdict ";
  const markerSuffix = " -->";
  const startIdx = body.indexOf(markerPrefix);
  if (startIdx === -1) return null;
  const jsonStart = startIdx + markerPrefix.length;
  let parsed: unknown;
  let endIdx = body.indexOf(markerSuffix, jsonStart);
  while (endIdx !== -1) {
    const candidate = body.slice(jsonStart, endIdx).trim();
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      endIdx = body.indexOf(markerSuffix, endIdx + markerSuffix.length);
    }
  }
  if (endIdx === -1) {
    console.warn("[review-ledger] Malformed JSON in claude-review-verdict marker; treating comment as no verdict");
    return null;
  }
  if (!isRecord(parsed)) return null;
  const findings: ReviewLedgerFinding[] = [];
  if (Array.isArray(parsed.blocking)) {
    for (const item of parsed.blocking) {
      const v = parseVerdictItem(item);
      if (!v) continue;
      findings.push({
        source: "claude-review-summary",
        severity: "blocking",
        body: v.body,
        ...(v.path ? { path: v.path } : {}),
        ...(typeof v.line === "number" ? { line: v.line } : {}),
        ...(url ? { url } : {}),
      });
    }
  }
  if (Array.isArray(parsed.minor)) {
    for (const item of parsed.minor) {
      const v = parseVerdictItem(item);
      if (!v) continue;
      findings.push({
        source: "claude-review-summary",
        severity: "minor",
        body: v.body,
        ...(v.path ? { path: v.path } : {}),
        ...(typeof v.line === "number" ? { line: v.line } : {}),
        ...(url ? { url } : {}),
      });
    }
  }
  return findings;
}

export function extractClaudeSummaryFindings(body: string, url?: string): ReviewLedgerFinding[] {
  const items: string[] = [];
  let inBlockingSection = false;
  let currentItem: string | undefined;
  let currentItemAllowsUnindentedContinuation = false;

  const flushCurrentItem = () => {
    if (!currentItem) return;

    const normalizedBody = normalizeText(currentItem);
    if (normalizedBody) {
      items.push(normalizedBody);
    }

    currentItem = undefined;
    currentItemAllowsUnindentedContinuation = false;
  };

  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) {
      if (currentItemAllowsUnindentedContinuation) flushCurrentItem();
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushCurrentItem();
      inBlockingSection = isClaudeBlockingHeading(heading[1]);
      continue;
    }

    if (!inBlockingSection) continue;

    const bullet = line.match(/^\s*(?:[-*+]|\d+[\.)])\s+(.+)$/);
    if (bullet) {
      flushCurrentItem();
      currentItem = bullet[1];
      currentItemAllowsUnindentedContinuation = false;
      continue;
    }

    const boldNumbered = line.match(/^\s*\*\*\s*\d+[\.)]\s+(.+?)\s*\*\*\s*$/);
    if (boldNumbered) {
      flushCurrentItem();
      currentItem = boldNumbered[1];
      currentItemAllowsUnindentedContinuation = true;
      continue;
    }

    const continuation = line.match(/^\s{2,}(\S.*)$/) ??
      (currentItemAllowsUnindentedContinuation ? line.match(/^\s{0,3}(\S.*)$/) : null);
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

function classifyClaudeFindingHeading(value: string): ReviewLedgerSeverity | null {
  const normalized = normalizeText(value).replace(/:$/, "");
  if (/\b(?:blocking|changes requested|must fix|required fixes?)\b/i.test(normalized)) return "blocking";
  if (/\b(?:minor|non-blocking|notes?)\b/i.test(normalized)) return "minor";
  if (/\b(?:findings?|issues?|concerns?|problems?)\b/i.test(normalized)) return "medium";
  return null;
}

function stripClaudeActionNoise(lines: string[]): string {
  return lines
    .filter((line) => !/^\s*[-*]\s+\[[ xX]\]\s+/.test(line))
    .filter((line) => !/^\s*[·•]\s+Branch\s*:/i.test(line))
    .join("\n")
    .trim();
}

function hasExplicitCleanVerdict(body: string): boolean {
  return /\bno\s+(?:correctness(?:,\s*security,?\s*or\s*style)?)?\s*(?:issues?|findings?|concerns?|changes)\s+(?:were\s+)?(?:found|required)\b/i.test(body);
}

function hasFindingSignal(body: string): boolean {
  return /\b(?:one|two|three|\d+)\s+(?:minor\s+)?(?:issues?|findings?|concerns?|notes?)\b/i.test(body)
    || /\b(?:issue|finding|concern)\s+(?:undercuts|remains|requires|needs|must)\b/i.test(body)
    || /\bminor\s+(?:issue|finding|concern|note)\b/i.test(body)
    || /\bminor\s*\(\s*non-blocking\s*\)/i.test(body);
}

function isExplicitlyEmptyFindingSection(body: string): boolean {
  const normalized = normalizeText(body).replace(/^[*_`\s-]+|[*_`.\s-]+$/g, "");
  return /^(?:none|nothing|n\/a|no\s+(?:(?:blocking|minor|non-blocking|material|actionable)\s+)?(?:issues?|findings?|concerns?|changes)(?:\s+(?:were\s+)?(?:found|required))?)$/i.test(normalized);
}

// GHA review format is freeform (no machine-readable severity tags or path:line markers),
// so a start-anchored denylist of absence-of-concern and resolution phrases is used instead
// of an allowlist. Anchoring prevents false positives: "No null check is performed" does not
// match because "check" is not in the concern-noun set.
function isNonFindingBullet(text: string): boolean {
  const lc = normalizeText(text).toLowerCase();
  if (/^no\s+(?:\w+\s+)*(?:concerns?|issues?|findings?|problems?|blocking)(?:\s|$|[,;—–-])/i.test(lc)) return true;
  if (/^nothing\s+blocking\b/i.test(lc)) return true;
  if (/^cleanly\s+resolved\b/i.test(lc)) return true;
  if (/^(?:both|all)\s+(?:blocking\s+)?(?:issues?|findings?|concerns?).{0,60}\b(?:are|were|have\s+been)\s+resolved\b/i.test(lc)) return true;
  if (/^matches?\s+the\s+spec\b/i.test(lc)) return true;
  return false;
}

function parseSectionBullets(lines: string[]): string[] {
  const bullets: string[] = [];
  let current: string | undefined;

  const flushCurrent = () => {
    if (current !== undefined) {
      const trimmed = current.trim();
      if (trimmed) bullets.push(trimmed);
      current = undefined;
    }
  };

  for (const line of lines) {
    if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line) || /^\s*[·•]\s+Branch\s*:/i.test(line)) continue;
    if (!line.trim()) {
      flushCurrent();
      continue;
    }
    // Handles standard bullets (-, *, +, 1., 1)) and the compound "1. -" format used in GHA reviews
    const match = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:[-*]\s+)?(.+)$/);
    if (match) {
      flushCurrent();
      current = match[1];
      continue;
    }
    if (current !== undefined && /^\s{2,}/.test(line)) {
      current = `${current} ${line.trim()}`;
      continue;
    }
    flushCurrent();
  }

  flushCurrent();
  return bullets;
}

/**
 * Parses the live comment shape emitted by anthropics/claude-code-action when it runs
 * under GitHub Actions. The action has repeatedly omitted the requested verdict marker,
 * so a completed external review must not be treated as clean merely because the marker
 * is absent. Recognized finding sections are preserved; when the comment cannot be parsed
 * into structured findings, the caller is signalled via findingsUnavailable rather than
 * fabricating a synthetic block.
 */
export function extractGithubActionsClaudeReviewFindings(body: string, url?: string): { findings: ReviewLedgerFinding[]; findingsUnavailable: boolean } {
  const findings: ReviewLedgerFinding[] = [];
  const lines = body.split(/\r?\n/);
  let severity: ReviewLedgerSeverity | null = null;
  let sectionLines: string[] = [];
  let recognizedSections = 0;
  let explicitlyEmptySections = 0;

  const flush = () => {
    if (!severity) {
      sectionLines = [];
      return;
    }
    const bullets = parseSectionBullets(sectionLines);
    if (bullets.length > 0) {
      const genuineFindings = bullets.filter((b) => !isNonFindingBullet(b));
      if (genuineFindings.length === 0) {
        explicitlyEmptySections += 1;
      } else {
        for (const bulletBody of genuineFindings) {
          findings.push({
            source: "claude-review-summary",
            severity,
            body: normalizeText(bulletBody),
            ...(url ? { url } : {}),
          });
        }
      }
    } else {
      const findingBody = normalizeText(stripClaudeActionNoise(sectionLines));
      if (findingBody) {
        if (isExplicitlyEmptyFindingSection(findingBody)) {
          explicitlyEmptySections += 1;
        } else {
          findings.push({
            source: "claude-review-summary",
            severity,
            body: findingBody,
            ...(url ? { url } : {}),
          });
        }
      }
    }
    sectionLines = [];
  };

  for (const line of lines) {
    const markdownHeading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    const boldHeading = line.match(/^\s*\*\*(.+?)\*\*\s*(.*)$/);
    if (markdownHeading) {
      flush();
      severity = classifyClaudeFindingHeading(markdownHeading[1]);
      if (severity) recognizedSections += 1;
      continue;
    }
    if (boldHeading) {
      const boldSeverity = classifyClaudeFindingHeading(boldHeading[1]);
      if (boldSeverity) {
        flush();
        severity = boldSeverity;
        recognizedSections += 1;
        const trailingText = boldHeading[2].trim();
        if (trailingText) sectionLines.push(trailingText);
        continue;
      }
    }
    if (severity) sectionLines.push(line);
  }
  flush();

  if (findings.length > 0) return { findings, findingsUnavailable: false };
  if (recognizedSections > 0 && explicitlyEmptySections === recognizedSections) return { findings: [], findingsUnavailable: false };
  if (hasExplicitCleanVerdict(body) && !hasFindingSignal(body)) return { findings: [], findingsUnavailable: false };

  console.warn("[review-ledger] External review comment could not be parsed — treating findings as unavailable");
  return { findings: [], findingsUnavailable: true };
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

function collectChangesRequestedReviews(ghSpawn: GhSpawn, prNumber: string, findings: ReviewLedgerFinding[]): Set<string> {
  const blockingReviewerLogins = new Set<string>();
  const result = safeGhSpawn(ghSpawn, [
    "api",
    "--paginate",
    "--slurp",
    `repos/:owner/:repo/pulls/${prNumber}/reviews?per_page=100`,
  ]);
  if (!result || result.exitCode !== 0) return blockingReviewerLogins;

  const reviews = parseReviewPages(result.stdout);

  const latestActionableReviewsByReviewer = new Map<string, Record<string, unknown>>();

  reviews.forEach((review, index) => {
    if (!isRecord(review) || !isActionableReviewState(review.state)) return;

    latestActionableReviewsByReviewer.set(getReviewReviewerKey(review, index), review);
  });

  for (const review of latestActionableReviewsByReviewer.values()) {
    if (review.state !== "CHANGES_REQUESTED") continue;

    // Record the reviewer regardless of body so their unresolved inline threads stay blocking.
    const user = review.user;
    if (isRecord(user) && typeof user.login === "string") {
      blockingReviewerLogins.add(normalizeReviewerLogin(user.login));
    }

    if (typeof review.body !== "string") continue;
    const body = review.body.trim();
    if (!body) continue;

    findings.push({
      source: "github-review",
      severity: "blocking",
      body,
      ...(typeof review.html_url === "string" ? { url: review.html_url } : {}),
    });
  }

  return blockingReviewerLogins;
}

function collectClaudeIssueComments(ghSpawn: GhSpawn, prNumber: string, findings: ReviewLedgerFinding[], out: { findingsUnavailable: boolean }): void {
  const result = safeGhSpawn(ghSpawn, [
    "api",
    "--paginate",
    "--slurp",
    `repos/:owner/:repo/issues/${prNumber}/comments?per_page=100`,
  ]);
  if (!result || result.exitCode !== 0) return;

  const comments = parseReviewPages(result.stdout)
    .map((comment, index) => ({ comment, index, timestamp: reviewCommentTimestamp(comment) }))
    .sort((a, b) => b.timestamp - a.timestamp || b.index - a.index)
    .map(({ comment }) => comment);

  // Top-level Claude review comments are revision verdicts, not an append-only ledger.
  // The live action currently posts a new comment for each head instead of updating a
  // sticky comment, so the newest recognized verdict supersedes older review summaries.
  // Formal CHANGES_REQUESTED reviews and unresolved threads remain independently collected.
  for (const comment of comments) {
    if (!isRecord(comment) || typeof comment.body !== "string" || isAiImplementComment(comment.body)) continue;

    const url = typeof comment.html_url === "string" ? comment.html_url : undefined;

    // Verdict marker path: accept only from the GitHub Actions bot or an
    // already-trusted Claude author. Other integrations must not be able to
    // supersede the latest Claude review by emitting a lookalike marker.
    if (isVerdictEligibleAuthor(comment)) {
      const verdictFindings = extractVerdictMarkerFindings(comment.body, url);
      if (verdictFindings !== null) {
        findings.push(...verdictFindings);
        return;
      }
    }

    // Heading-based extraction (backward compat with target repos using trusted-author
    // Claude App identity that posts without a verdict marker).
    if (isLikelyClaudeReviewComment(comment)) {
      findings.push(...extractClaudeSummaryFindings(comment.body, url));
      return;
    }

    if (isGithubActionsClaudeReviewComment(comment)) {
      const ghResult = extractGithubActionsClaudeReviewFindings(comment.body, url);
      findings.push(...ghResult.findings);
      if (ghResult.findingsUnavailable) out.findingsUnavailable = true;
      return;
    }
  }
}

function reviewCommentTimestamp(comment: unknown): number {
  if (!isRecord(comment)) return 0;
  const value = typeof comment.updated_at === "string"
    ? comment.updated_at
    : typeof comment.created_at === "string"
      ? comment.created_at
      : "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function collectUnresolvedReviewThreads(
  ghSpawn: GhSpawn,
  prNumber: string,
  findings: ReviewLedgerFinding[],
  blockingReviewerLogins: Set<string>,
): void {
  let after: string | undefined;

  for (;;) {
    const result = safeGhSpawn(ghSpawn, buildReviewThreadsArgs(prNumber, after));
    if (!result || result.exitCode !== 0) return;

    const payload = parseJson(result.stdout);
    const reviewThreads = getReviewThreadsConnection(payload);
    if (!reviewThreads) return;

    collectReviewThreadFindings(reviewThreads.nodes, findings, blockingReviewerLogins);

    if (reviewThreads.pageInfo?.hasNextPage !== true) return;
    if (typeof reviewThreads.pageInfo.endCursor !== "string" || !reviewThreads.pageInfo.endCursor) return;

    after = reviewThreads.pageInfo.endCursor;
  }
}

function dedupeReviewFindings(findings: ReviewLedgerFinding[]): ReviewLedgerFinding[] {
  const deduped: ReviewLedgerFinding[] = [];
  const indexByNormalizedBody = new Map<string, number>();

  for (const finding of findings) {
    const key = normalizeText(finding.body).toLowerCase();
    if (!key) continue;

    const existingIndex = indexByNormalizedBody.get(key);
    if (existingIndex === undefined) {
      indexByNormalizedBody.set(key, deduped.length);
      deduped.push(finding);
      continue;
    }

    const existing = deduped[existingIndex];
    if (!hasLineLocation(existing) && hasLineLocation(finding)) {
      deduped[existingIndex] = finding;
    }
  }

  return deduped;
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

function collectReviewThreadFindings(
  nodes: unknown[],
  findings: ReviewLedgerFinding[],
  blockingReviewerLogins: Set<string>,
): void {
  for (const thread of nodes) {
    if (!isRecord(thread) || thread.isResolved !== false || thread.isOutdated === true) continue;

    const comments = getCommentNodes(thread);
    const latestComment = comments?.at(-1);
    if (!isRecord(latestComment) || typeof latestComment.body !== "string") continue;

    const body = latestComment.body.trim();
    if (!body) continue;

    // An unresolved inline thread only blocks when its author's current verdict is
    // CHANGES_REQUESTED. Otherwise (approved, commented, or no formal review) it is a
    // non-blocking nit that should not override the reviewer's approval.
    const author = latestComment.author;
    const authorLogin = isRecord(author) && typeof author.login === "string" ? author.login : "";
    const severity: ReviewLedgerSeverity = authorLogin && blockingReviewerLogins.has(normalizeReviewerLogin(authorLogin))
      ? "blocking"
      : "medium";

    findings.push({
      source: "github-review-thread",
      severity,
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

function isLikelyClaudeReviewComment(comment: Record<string, unknown>): comment is Record<string, unknown> & { body: string } {
  if (typeof comment.body !== "string" || isAiImplementComment(comment.body)) return false;
  return isClaudeAuthor(comment) && hasClaudeReviewHeading(comment.body);
}

function isGithubActionsClaudeReviewComment(comment: Record<string, unknown>): comment is Record<string, unknown> & { body: string } {
  if (typeof comment.body !== "string" || isAiImplementComment(comment.body)) return false;
  return isGithubActionsBotAuthor(comment)
    && /\*\*Claude finished\b/i.test(comment.body)
    && hasClaudeReviewHeading(comment.body);
}

function isAiImplementComment(body: string): boolean {
  return body.includes("<!-- ai-implement");
}

function isClaudeAuthor(comment: Record<string, unknown>): boolean {
  const user = comment.user;
  if (!isRecord(user) || typeof user.login !== "string") return false;
  return TRUSTED_REVIEW_COMMENT_AUTHORS.has(user.login.toLowerCase());
}

function isGithubActionsBotAuthor(comment: Record<string, unknown>): boolean {
  const user = comment.user;
  if (!isRecord(user) || typeof user.login !== "string") return false;
  return user.type === "Bot"
    && normalizeReviewerLogin(user.login) === GITHUB_ACTIONS_REVIEW_AUTHOR;
}

function isVerdictEligibleAuthor(comment: Record<string, unknown>): boolean {
  return isGithubActionsBotAuthor(comment) || isClaudeAuthor(comment);
}

function hasClaudeReviewHeading(body: string): boolean {
  return /(?:^|\n)\s{0,3}#{1,6}\s+(?:PR Review|Code Review|Claude Review|Follow-up Review|Code Review Complete|Review(?=\s*:|\s+complete\b|\s*$)|Changes Requested)\b/im.test(body);
}

function isClaudeBlockingHeading(value: string): boolean {
  const normalized = normalizeText(value);
  if (/approved|complete/i.test(normalized) && !/changes requested/i.test(normalized)) return false;
  return /^blocking\b/i.test(normalized) || /changes requested/i.test(normalized);
}

function hasLineLocation(finding: ReviewLedgerFinding): boolean {
  return typeof finding.path === "string" && typeof finding.line === "number";
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
          comments(last: 1) {
            nodes {
              body
              url
              author {
                login
              }
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
