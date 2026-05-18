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
