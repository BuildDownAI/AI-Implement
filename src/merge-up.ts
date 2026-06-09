import type { RepoMapping } from "./config.js";
import type { FeatureNodeRollUp } from "./providers/types.js";
import { getInstallationToken } from "./github-app-auth.js";
import { buildFeatureBranchName } from "./pipeline/branch-name.js";
import { compareBranches, createPullRequest, findOpenPullRequest, mergePullRequest } from "./github.js";

/**
 * Feature-branch roll-up (the merge-up half of feature-branch grouping).
 *
 * When a feature-node issue completes, its feature branch should be merged into its
 * parent's branch. This module turns the provider's list of completed feature nodes into
 * real merges:
 *
 *   - parent is a feature node → open a PR `feature/<child>` → `feature/<parent>` and
 *     auto-merge it (the roll-up is internal to the grouping).
 *   - no feature-node parent (top of the tree) → open a `feature/<top>` → base PR and
 *     leave it for a human to review and merge.
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
  // Top of the tree (rolling into the base branch) is a human-reviewed PR, never auto-merged.
  const autoMerge = rollUp.parentIdentifier !== null;

  const ahead = await compareBranches(ghToken, owner, repo, target, branch);
  if (ahead === null || ahead === 0) return; // branch missing, or already fully merged

  const existing = await findOpenPullRequest(ghToken, owner, repo, branch, target);
  const pr =
    existing ??
    (await createPullRequest(ghToken, owner, repo, {
      head: branch,
      base: target,
      title: `[ai-implement] Roll up ${branch} → ${target}`,
      body:
        `Automated feature-branch roll-up for ${rollUp.identifier} (feature-branch grouping).` +
        (autoMerge
          ? ""
          : `\n\nThis is the top-level **feature → base** PR — left open for human review and merge.`),
    }));

  if (!autoMerge) {
    if (!existing) {
      console.log(`[merge-up] Opened feature→base PR for ${rollUp.identifier}: ${pr.url} (awaiting human merge)`);
    }
    return;
  }

  const merged = await mergePullRequest(ghToken, owner, repo, pr.number);
  if (merged) {
    console.log(`[merge-up] Rolled up ${branch} → ${target} (${rollUp.identifier}, PR #${pr.number})`);
  } else {
    console.warn(
      `[merge-up] Could not auto-merge ${branch} → ${target} ` +
        `(${rollUp.identifier}, PR #${pr.number}) — left open for a human (likely a conflict)`,
    );
  }
}
