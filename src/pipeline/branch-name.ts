const MAX_BRANCH_SUMMARY_LENGTH = 48;
const MAX_BRANCH_PREFIX_LENGTH = 64;
const BRANCH_PREFIX_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function slugify(value: string | undefined, fallback: string): string {
  const slug = (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BRANCH_SUMMARY_LENGTH)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/**
 * Validates and normalizes a per-project branch prefix.
 * - Blank/whitespace/undefined -> null (no prefix).
 * - Strips surrounding slashes.
 * - Must be a safe git ref path segment: only [A-Za-z0-9._/-], starting with an
 *   alphanumeric, no "..", no "//", <= 64 chars.
 * Throws on an invalid (non-blank) value so callers can surface a clear error.
 */
export function normalizeBranchPrefix(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let value = raw.trim().replace(/^\/+|\/+$/g, "");
  if (value === "") return null;
  if (value.length > MAX_BRANCH_PREFIX_LENGTH) {
    throw new Error(`branchPrefix must be ${MAX_BRANCH_PREFIX_LENGTH} characters or fewer`);
  }
  if (value.includes("..") || value.includes("//")) {
    throw new Error("branchPrefix must not contain '..' or '//'");
  }
  for (const segment of value.split("/")) {
    if (!BRANCH_PREFIX_SEGMENT_PATTERN.test(segment)) {
      throw new Error(
        "branchPrefix segments may contain only letters, digits, '.', '_', '-' and must each start with a letter or digit",
      );
    }
  }
  return value;
}

export function buildIssueBranchName(
  issueIdentifier: string | undefined,
  issueTitle: string | undefined,
  prefix?: string | null,
): string {
  const key = slugify(issueIdentifier, "issue");
  const summary = slugify(issueTitle, "implementation");
  const base = `ai-implement/${key}-${summary}`;
  // The prefix is already validated upstream (admin API + runner ingest); here we
  // only trim and strip surrounding slashes so the join stays well-formed.
  const cleaned = (prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  return cleaned ? `${cleaned}/${base}` : base;
}

export function branchMatchesIssueIdentifier(branchRef: string | undefined, issueIdentifier: string | undefined): boolean {
  if (!branchRef || !issueIdentifier) return false;

  const ref = branchRef.toLowerCase();
  const rawIdentifier = issueIdentifier.toLowerCase();
  const slugIdentifier = slugify(issueIdentifier, "");
  const candidates = [...new Set([rawIdentifier, slugIdentifier].filter(Boolean))];

  return candidates.some((identifier) => {
    // Legacy bare-identifier branches: "gen-65" or "gen-65/...".
    if (ref === identifier || ref.startsWith(`${identifier}/`)) return true;

    // ai-implement/<identifier> at a path-segment boundary, optionally preceded
    // by a prefix path (e.g. "pr/ai-implement/gen-65-..."), followed by end, '-'
    // or '/' so "gen-65" never matches "gen-650". A regex (rather than
    // indexOf/lastIndexOf) so a prefix that itself embeds an
    // "ai-implement/<key>" substring can't shadow the real trailing marker.
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|/)ai-implement/${escaped}(-|/|$)`).test(ref);
  });
}
