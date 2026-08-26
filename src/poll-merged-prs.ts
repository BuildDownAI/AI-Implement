import type { RepoMapping } from "./config.js";
import { listLog } from "./log.js";
import type { JobStatus } from "./log.js";
import {
  enqueueReconciliation,
  hasReconciliationForPr,
  recordReconciliationTombstone,
} from "./reconciliation.js";

// AII-264 r6: any terminal row with a recorded PR is a candidate — if the PR merged, the
// ticket must complete regardless of how the job row was classified (a run declared
// "failed" whose PR later turns out merged was a monitor misread, not a real failure).
// Keying by repo+PR (hasReconciliationForPr) makes this idempotent and reset-proof.
const CANDIDATE_STATUSES = new Set<JobStatus>(["completed", "review_failed", "failed", "timed_out"]);

export interface DetectDeps {
  mappingForRepo: (repo: string) => RepoMapping | undefined;
  tokenForOwner: (owner: string) => Promise<string>;
  getPullRequestState: (
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<{ merged: boolean; state: "open" | "closed" } | null>;
}

/** Parse the PR number from a stored html PR URL ending in /pull/<n>. */
export function prNumberFromUrl(url: string): number | null {
  const m = /\/pull\/(\d+)(?:$|[/?#])/.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * Guaranteed (webhook-independent) path: scans recent dispatches whose PR is
 * not yet reconciled, asks GitHub whether each PR merged, and enqueues a
 * reconciliation (merged) or a tombstone (closed-unmerged). Open PRs are
 * re-checked next tick.
 */
export async function detectMergedPrs(deps: DetectDeps): Promise<void> {
  for (const job of listLog({ limit: 500 })) {
    if (!job.repo || !job.prUrl) continue;
    if (!CANDIDATE_STATUSES.has(job.status)) continue;
    const prNumber = prNumberFromUrl(job.prUrl);
    if (prNumber === null) continue;
    if (hasReconciliationForPr(job.repo, prNumber)) continue;
    const mapping = deps.mappingForRepo(job.repo);
    if (!mapping) continue;
    const [owner] = job.repo.split("/");
    let token: string;
    try {
      token = await deps.tokenForOwner(owner);
    } catch (err) {
      console.error(`[merge-poll] token error for ${job.repo}:`, err);
      continue;
    }
    const state = await deps.getPullRequestState(token, mapping.owner, mapping.repo, prNumber);
    if (!state) continue;
    if (state.merged) {
      enqueueReconciliation({
        issueId: job.issueId,
        issueIdentifier: job.issueIdentifier,
        prNumber,
        repo: job.repo,
        mergeCommitSha: "",
      });
      console.log(`[merge-poll] Detected merge of PR #${prNumber} in ${job.repo}; queued reconciliation`);
    } else if (state.state === "closed") {
      recordReconciliationTombstone({
        issueId: job.issueId,
        issueIdentifier: job.issueIdentifier,
        prNumber,
        repo: job.repo,
      });
      console.log(`[merge-poll] PR #${prNumber} in ${job.repo} closed unmerged; tombstoned`);
    }
  }
}
