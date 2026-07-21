import type { RepoMapping } from "./config.js";
import { getInstallationToken } from "./github-app-auth.js";
import {
  listOpenPullRequests, getCombinedChecksState, hasChangesRequestedReview, mergePullRequest,
} from "./github.js";

export interface AutoMergeDeps {
  githubAppId: string;
  githubAppPrivateKey: string;
  notify?: (message: string) => Promise<void>;
}

/** Only ai-implement/feature/* and ai-implement/multi-issue/* are grouping branches.
 *  A leaf child's own branch (ai-implement/<key>-<slug>) is NOT a grouping base. */
export function isGroupingBranch(base: string): boolean {
  return base.startsWith("ai-implement/feature/") || base.startsWith("ai-implement/multi-issue/");
}

export async function runAutoMerges(mappings: RepoMapping[], deps: AutoMergeDeps): Promise<void> {
  const seen = new Set<string>();
  for (const mapping of mappings) {
    if (!mapping.autoMerge || mapping.paused) continue;
    const repoKey = `${mapping.owner}/${mapping.repo}`;
    if (seen.has(repoKey)) continue;
    seen.add(repoKey);
    try {
      await autoMergeRepo(mapping, deps);
    } catch (err) {
      console.error(`[auto-merge] Failed for ${repoKey}:`, err);
    }
  }
}

async function autoMergeRepo(mapping: RepoMapping, deps: AutoMergeDeps): Promise<void> {
  const { owner, repo, defaultBranch } = mapping;
  const token = await getInstallationToken(deps.githubAppId, deps.githubAppPrivateKey, owner);
  const prs = await listOpenPullRequests(token, owner, repo);
  for (const pr of prs) {
    try {
      if (!isGroupingBranch(pr.base) || pr.base === defaultBranch) continue;
      if (pr.draft) continue;
      const checks = await getCombinedChecksState(token, owner, repo, pr.headSha);
      if (checks === "pending") { console.log(`[auto-merge] Waiting on checks: PR #${pr.number} -> ${pr.base}`); continue; }
      if (checks === "failure") { console.log(`[auto-merge] Skipping PR #${pr.number} -> ${pr.base}: checks failed`); continue; }
      if (await hasChangesRequestedReview(token, owner, repo, pr.number)) {
        console.log(`[auto-merge] Skipping PR #${pr.number} -> ${pr.base}: changes requested`);
        continue;
      }
      const result = await mergePullRequest(token, owner, repo, pr.number, pr.headSha, "merge");
      if (result === "merged") {
        console.log(`[auto-merge] Merged PR #${pr.number} -> ${pr.base} (${owner}/${repo})`);
        if (deps.notify) {
          await deps.notify(`Auto-merged child PR #${pr.number} into \`${pr.base}\` (${owner}/${repo})`).catch(() => {});
        }
      } else {
        console.log(`[auto-merge] PR #${pr.number} -> ${pr.base}: ${result} — leaving for a human`);
      }
    } catch (err) {
      console.error(`[auto-merge] Failed on PR #${pr.number} (${owner}/${repo}):`, err);
    }
  }
}
