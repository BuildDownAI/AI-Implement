import type { RepoMapping } from "./config.js";
import type { FeatureNodeRollUp } from "./providers/types.js";
import { getInstallationToken } from "./github-app-auth.js";
import { buildFeatureBranchName } from "./pipeline/branch-name.js";
import { compareBranches, createPullRequest, findOpenPullRequest, mergeBranch } from "./github.js";

/**
 * Feature-branch roll-up (the merge-up half of feature-branch grouping).
 *
 * When a feature-node issue completes, its feature branch should be merged into its
 * parent's branch:
 *
 *   - parent is a feature node → **direct git merge** `feature/<child>` into
 *     `feature/<parent>` (no PR). A PR's base-branch name and title encode the parent's
 *     identifier, so Linear's GitHub integration would auto-link the roll-up to the
 *     parent issue and falsely mark it Done on merge — before its own closing work runs.
 *     A plain merge commit with no identifiers avoids that.
 *   - no feature-node parent (top of the tree) → open a `feature/<top>` → base PR and
 *     leave it for a human to review and merge (never auto-merged).
 *
 * Idempotent: a branch already merged into its target (0 commits ahead) is skipped, so
 * re-running each poll cycle is cheap and safe. Fails soft per roll-up — one failure
 * never aborts the others or the poll loop.
 */

export interface MergeUpDeps {
  githubAppId: string;
  githubAppPrivateKey: string;
  /** Resolve the repo mapping for a scope/team key, or null when unmapped/paused. */
  resolveMapping: (scopeKey: string) => RepoMapping | null;
}

export async function runMergeUps(rollUps: FeatureNodeRollUp[], deps: MergeUpDeps): Promise<void> {
  for (const rollUp of rollUps) {
    try {
      await rollUpOne(rollUp, deps);
    } catch (err) {
      console.error(`[merge-up] Failed for ${rollUp.identifier}:`, err);
    }
  }
}

async function rollUpOne(rollUp: FeatureNodeRollUp, deps: MergeUpDeps): Promise<void> {
  const mapping = deps.resolveMapping(rollUp.scopeKey);
  if (!mapping) return; // unmapped or paused — skip silently

  const { owner, repo } = mapping;
  const ghToken = await getInstallationToken(deps.githubAppId, deps.githubAppPrivateKey, owner);

  const branch = buildFeatureBranchName(rollUp.identifier);
  const target = rollUp.parentIdentifier
    ? buildFeatureBranchName(rollUp.parentIdentifier)
    : mapping.defaultBranch;

  const ahead = await compareBranches(ghToken, owner, repo, target, branch);
  if (ahead === null || ahead === 0) return; // branch missing, or already fully merged

  if (rollUp.parentIdentifier !== null) {
    // Internal roll-up → direct merge, no PR (avoids Linear linking the roll-up to the
    // parent issue). Commit message is intentionally free of issue identifiers / magic words.
    const result = await mergeBranch(
      ghToken,
      owner,
      repo,
      target,
      branch,
      "[ai-implement] Automated feature-branch roll-up",
    );
    if (result === "conflict") {
      console.warn(
        `[merge-up] Conflict rolling up ${branch} → ${target} (${rollUp.identifier}) — needs a manual merge`,
      );
    } else if (result === "merged") {
      console.log(`[merge-up] Rolled up ${branch} → ${target} (${rollUp.identifier})`);
    }
    return;
  }

  // Top of the tree → feature → base PR for human review. Opened once, never auto-merged.
  const existing = await findOpenPullRequest(ghToken, owner, repo, branch, target);
  if (existing) return;
  const pr = await createPullRequest(ghToken, owner, repo, {
    head: branch,
    base: target,
    title: "[ai-implement] Feature branch ready for review",
    body:
      "Automated feature-branch grouping: this feature branch's work is complete and ready " +
      "to merge into the base branch. Opened for human review.",
  });
  console.log(`[merge-up] Opened feature→base PR ${pr.url} for ${rollUp.identifier} (awaiting human merge)`);
}
