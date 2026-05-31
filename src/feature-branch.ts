import type { RepoMapping } from "./config.js";
import type { TicketIssue } from "./providers/types.js";
import { ensureBranchExists } from "./github.js";
import { buildFeatureBranchName } from "./pipeline/branch-name.js";

/**
 * Feature-branch grouping for parent/child issues.
 *
 * Lives in its own module (not inlined into index.ts) because index.ts invokes
 * main() at import time and therefore cannot be imported by a unit test. Keeping
 * the resolution logic here keeps it importable and testable in isolation.
 */

/**
 * Minimum number of children a parent must have for its children to be grouped
 * onto a shared feature branch. A solo child PRs straight to the base branch, as
 * today. Set to 1 to group every parented child.
 */
export const MIN_CHILDREN_FOR_FEATURE_BRANCH = 2;

export function qualifiesForFeatureBranch(issue: TicketIssue): boolean {
  return !!issue.parentRef && issue.parentRef.childCount >= MIN_CHILDREN_FOR_FEATURE_BRANCH;
}

/**
 * Resolves the base branch a child's PR should target. For a child of a parent with
 * >= MIN_CHILDREN_FOR_FEATURE_BRANCH children, this is a shared feature branch cut
 * from mapping.defaultBranch (created on the remote if missing). Otherwise it is
 * mapping.defaultBranch unchanged.
 *
 * Fails open: any error (branch creation, GitHub API) logs a warning and returns
 * mapping.defaultBranch so the child still dispatches. Grouping is an enhancement,
 * not a gate.
 */
export async function resolveBaseBranch(opts: {
  ghToken: string;
  issue: TicketIssue;
  mapping: RepoMapping;
}): Promise<string> {
  const { ghToken, issue, mapping } = opts;
  if (!qualifiesForFeatureBranch(issue)) return mapping.defaultBranch;

  try {
    const featureBranch = buildFeatureBranchName(issue.parentRef!.identifier);
    await ensureBranchExists(ghToken, mapping.owner, mapping.repo, featureBranch, mapping.defaultBranch);
    return featureBranch;
  } catch (err) {
    console.warn(
      `[poll] Feature-branch resolution failed for ${issue.identifier} (parent ${issue.parentRef?.identifier}); ` +
        `falling back to base branch "${mapping.defaultBranch}":`,
      err,
    );
    return mapping.defaultBranch;
  }
}
