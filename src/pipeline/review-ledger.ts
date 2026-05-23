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

export function extractClaudeSummaryFindings(body: string, url?: string): ReviewLedgerFinding[] {
  const findings: ReviewLedgerFinding[] = [];
  let inBlockingSection = false;

  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      inBlockingSection = /^blocking\b/i.test(normalizeText(heading[1]));
      continue;
    }

    if (!inBlockingSection) continue;

    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (!bullet) continue;

    const normalizedBody = normalizeText(bullet[1]);
    if (!normalizedBody) continue;

    findings.push({
      source: "claude-review-summary",
      severity: "blocking",
      body: normalizedBody,
      ...(url ? { url } : {}),
    });
  }

  return findings;
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

function normalizeText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
