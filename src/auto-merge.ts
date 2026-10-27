import { resolveReviewFixLifecycle, type RepoMapping } from "./config.js";
import { getInstallationToken } from "./github-app-auth.js";
import {
  listOpenPullRequests, getCombinedChecksState, hasChangesRequestedReview, mergePullRequest, mergeBranch,
} from "./github.js";
import {
  countConflictAttempts, enqueueConflictResolution, hasPendingConflictResolution,
} from "./comment-gapfill-queue.js";
import { getRunRecordMergeVerdict } from "./log.js";
import { resolveReviewProcess } from "./review-process.js";
import { headHasBlockingFinding, headReviewedClean } from "./review-head-clean.js";

export interface AutoMergeDeps {
  githubAppId: string;
  githubAppPrivateKey: string;
  notify?: (message: string) => Promise<void>;
}

export const MAX_CONFLICT_RESOLUTION_ATTEMPTS = 2;

// AII-277 (Finding 4): cap-exhausted notifications fired every poll cycle for the
// same PR (observed ~60s Slack spam). Notify once per PR per process; a restart
// re-notifies at most once more. The log line stays every cycle (cheap, greppable).
const capExhaustedNotified = new Set<string>();
// Same once-per-process rule for a default-branch sync conflict, keyed per feature branch.
const syncConflictNotified = new Set<string>();
export function resetCapExhaustedNotifications(): void {
  capExhaustedNotified.clear();
  syncConflictNotified.clear();
}

/** No issue key and no branch name: a key in the commit makes Linear's GitHub integration mark the parent Done (AII-1412). */
export const SYNC_DEFAULT_COMMIT_MESSAGE = "Merge default branch into feature branch";

/** Merge the default branch into a grouping branch after a child merged. Never throws. */
async function syncDefaultIntoFeature(
  token: string, mapping: RepoMapping, featureBranch: string, deps: AutoMergeDeps,
): Promise<void> {
  const { owner, repo, defaultBranch } = mapping;
  try {
    const result = await mergeBranch(token, owner, repo, featureBranch, defaultBranch, SYNC_DEFAULT_COMMIT_MESSAGE);
    if (result === "merged") {
      console.log(`[auto-merge] Synced ${defaultBranch} into ${featureBranch}`);
    } else if (result === "conflict") {
      console.log(`[auto-merge] Conflict syncing ${defaultBranch} into ${featureBranch} (${owner}/${repo}) — leaving the branch as is`);
      const key = `${owner}/${repo}:${featureBranch}`;
      if (!syncConflictNotified.has(key)) {
        syncConflictNotified.add(key);
        if (deps.notify) {
          await deps.notify(
            `Conflict syncing \`${defaultBranch}\` into \`${featureBranch}\` (${owner}/${repo}) — needs a manual merge.`
          ).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error(`[auto-merge] Failed syncing ${defaultBranch} into ${featureBranch} (${owner}/${repo}):`, err);
  }
}
export type StalledChildKind = "conflict" | "other";

/** Named seam: AII-263 (max_turns/draft stalls) extends this classification later. */
export function classifyStalledChild(mergeResult: string): StalledChildKind {
  return mergeResult === "blocked" || mergeResult === "conflict" ? "conflict" : "other";
}

/** Only ai-implement/feature/* and ai-implement/multi-issue/* are grouping branches.
 *  A leaf child's own branch (ai-implement/<key>-<slug>) is NOT a grouping base. */
export function isGroupingBranch(base: string): boolean {
  return base.startsWith("ai-implement/feature/") || base.startsWith("ai-implement/multi-issue/");
}

/**
 * Merge approved child PRs into grouping branches (feature/multi-issue). A mapping is
 * processed only when its `autoMerge` setting is on and it is not paused; a child merges
 * only then, and only when its run left the approval mark. With the setting off, approved
 * children are left for a person to merge. The top-of-tree feature→base PR still requires
 * human review.
 */
export async function runAutoMerges(mappings: RepoMapping[], deps: AutoMergeDeps): Promise<void> {
  const seen = new Set<string>();
  const offLogged = new Set<string>();
  for (const mapping of mappings) {
    if (mapping.paused) continue;
    const repoKey = `${mapping.owner}/${mapping.repo}`;
    if (!mapping.autoMerge) {
      if (!offLogged.has(repoKey)) {
        offLogged.add(repoKey);
        console.log(`[auto-merge] Skipping ${repoKey}: Auto-merge setting is off — approved child PRs are left for a person to merge`);
      }
      continue;
    }
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
      // If the PR title format ever changes (e.g. a leading emoji or prefix is added), non-matching
      // PRs will fall silently into the "no issue key" hold bucket rather than raising a visible error.
      const issueKeyMatch = pr.title.match(/^([A-Z][A-Z0-9]*-\d+):/);
      if (!issueKeyMatch) {
        console.log(`[auto-merge] Holding PR #${pr.number} -> ${pr.base}: no issue key in title`);
        continue;
      }
      const verdict = getRunRecordMergeVerdict(issueKeyMatch[1], pr.url);
      if (verdict === "in_flight") {
        console.log(`[auto-merge] Deferring merge of PR #${pr.number} -> ${pr.base}: run still in flight`);
        continue;
      }
      if (verdict === "hold") {
        console.log(`[auto-merge] Holding PR #${pr.number} -> ${pr.base}: no approval mark`);
        continue;
      }
      // The repository's auto-fix pushes by design, so the mark may predate the current head.
      if (resolveReviewProcess(mapping.reviewProcess).fixer === "repository"
        && !(await headReviewedClean(token, owner, repo, pr.number, pr.headSha))) {
        console.log(`[auto-merge] Holding PR #${pr.number} -> ${pr.base}: current head not reviewed clean`);
        continue;
      }
      // The mark records no head SHA: a verdict posted after it (AII-1291) must still hold the PR.
      if (await headHasBlockingFinding(token, owner, repo, pr.number, pr.headSha)) {
        console.log(`[auto-merge] Holding PR #${pr.number} -> ${pr.base}: blocking finding on current head`);
        continue;
      }
      const result = await mergePullRequest(token, owner, repo, pr.number, pr.headSha, "merge");
      if (result === "merged") {
        console.log(`[auto-merge] Merged PR #${pr.number} -> ${pr.base} (${owner}/${repo})`);
        if (deps.notify) {
          await deps.notify(`Auto-merged child PR #${pr.number} into \`${pr.base}\` (${owner}/${repo})`).catch(() => {});
        }
        // After the child merge, not before: moving the base first can make the child look blocked.
        if (resolveReviewFixLifecycle(mapping) === "restate") {
          await syncDefaultIntoFeature(token, mapping, pr.base, deps);
        }
      } else {
        const kind = classifyStalledChild(result);
        if (kind === "conflict") {
          if (hasPendingConflictResolution(owner, repo, pr.number)) {
            console.log(`[auto-merge] PR #${pr.number} -> ${pr.base}: resolution in flight`);
          } else {
            const attempts = countConflictAttempts(owner, repo, pr.number);
            if (attempts >= MAX_CONFLICT_RESOLUTION_ATTEMPTS) {
              const capKey = `${owner}/${repo}#${pr.number}`;
              const firstSighting = !capExhaustedNotified.has(capKey);
              if (firstSighting) {
                capExhaustedNotified.add(capKey);
                console.log(`[auto-merge] PR #${pr.number} -> ${pr.base}: conflict resolution cap (${attempts}) exhausted — leaving for a human`);
              }
              if (deps.notify && firstSighting) {
                await deps.notify(
                  `Conflict on PR #${pr.number} → \`${pr.base}\` (${owner}/${repo}): ${attempts} resolution attempt${attempts === 1 ? "" : "s"} exhausted — leaving for a human.`
                ).catch(() => {});
              }
            } else {
              enqueueConflictResolution({ owner, repo, prNumber: pr.number, featureBranch: pr.base });
              console.log(`[auto-merge] PR #${pr.number} -> ${pr.base}: enqueued conflict resolution (attempt ${attempts + 1})`);
            }
          }
        } else {
          console.log(`[auto-merge] PR #${pr.number} -> ${pr.base}: ${result} — leaving for a human`);
        }
      }
    } catch (err) {
      console.error(`[auto-merge] Failed on PR #${pr.number} (${owner}/${repo}):`, err);
    }
  }
}
