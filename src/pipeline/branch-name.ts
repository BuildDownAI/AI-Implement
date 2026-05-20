const MAX_BRANCH_SUMMARY_LENGTH = 48;

function slugify(value: string | undefined, fallback: string): string {
  const slug = (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BRANCH_SUMMARY_LENGTH)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function buildIssueBranchName(issueIdentifier: string | undefined, issueTitle: string | undefined): string {
  const key = slugify(issueIdentifier, "issue");
  const summary = slugify(issueTitle, "implementation");
  return `ai-implement/${key}-${summary}`;
}

export function branchMatchesIssueIdentifier(branchRef: string | undefined, issueIdentifier: string | undefined): boolean {
  if (!branchRef || !issueIdentifier) return false;

  const ref = branchRef.toLowerCase();
  const rawIdentifier = issueIdentifier.toLowerCase();
  const slugIdentifier = slugify(issueIdentifier, "");
  const candidates = [...new Set([rawIdentifier, slugIdentifier].filter(Boolean))];

  return candidates.some((identifier) => (
    ref === identifier ||
    ref.startsWith(`${identifier}/`) ||
    ref === `ai-implement/${identifier}` ||
    ref.startsWith(`ai-implement/${identifier}-`) ||
    ref.startsWith(`ai-implement/${identifier}/`)
  ));
}
