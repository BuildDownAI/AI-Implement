import type { RepoMapping } from "./config.js";
import type { TicketIssue } from "./providers/types.js";
import { ensureBranchExists } from "./github.js";
import { buildGroupingBranchName } from "./pipeline/branch-name.js";

/**
 * Feature-branch grouping for parent/child issues.
 *
 * Lives in its own module (not inlined into index.ts) because index.ts invokes
 * main() at import time and therefore cannot be imported by a unit test. Keeping
 * the resolution logic here keeps it importable and testable in isolation.
 *
 * The grouping decision (which issues are leaves vs. feature-node parents, and the
 * ordered branch chain) is made by the provider and carried on
 * `TicketIssue.featureBranchChain`. This module only turns that chain into real remote
 * branches and reports the branch the PR should target.
 */

/**
 * Resolves the branch a dispatched issue's PR should target, creating any feature
 * branches in `issue.featureBranchChain` that don't yet exist.
 *
 * The chain is base-most first: each entry's branch `ai-implement/<mode>/<identifier>` is
 * cut from the previous entry's branch (or mapping.defaultBranch for the first), and the
 * PR targets the LAST entry's branch. An empty/absent chain returns mapping.defaultBranch.
 *
 * `ensureBranchExists` is idempotent (422-tolerant), so an existing ancestor branch is
 * reused and only the missing tip of the chain is cut.
 *
 * Fails open: any error (branch creation, GitHub API) logs a warning and returns
 * mapping.defaultBranch so the issue still dispatches. Grouping is an enhancement,
 * not a gate.
 */
export async function resolveBaseBranch(opts: {
  ghToken: string;
  issue: TicketIssue;
  mapping: RepoMapping;
}): Promise<string> {
  const { ghToken, issue, mapping } = opts;
  const chain = issue.featureBranchChain ?? [];
  if (chain.length === 0) return mapping.defaultBranch;

  try {
    let cutFrom = mapping.defaultBranch;
    let target = mapping.defaultBranch;
    for (const entry of chain) {
      const branch = buildGroupingBranchName(entry.identifier, entry.mode);
      await ensureBranchExists(ghToken, mapping.owner, mapping.repo, branch, cutFrom);
      cutFrom = branch;
      target = branch;
    }
    return target;
  } catch (err) {
    console.warn(
      `[poll] Feature-branch resolution failed for ${issue.identifier} ` +
        `(chain ${chain.map((e) => `${e.mode}:${e.identifier}`).join(" -> ")}); falling back to base branch "${mapping.defaultBranch}":`,
      err,
    );
    return mapping.defaultBranch;
  }
}
