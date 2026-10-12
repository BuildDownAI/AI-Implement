import { getCommitTime, listCheckRuns } from "./github.js";
import { listOpenReviewFindings } from "./review-ledger-store.js";
import { isReviewCheckRun, REVIEW_PROCESSES } from "./review-process.js";

// Matches the check pairs of the one process with `fixer: "repository"`. A second repository-fixer
// process with different pairs must pass its own process here instead of this constant.
export async function reviewCheckSucceeded(token: string, owner: string, repo: string, headSha: string): Promise<boolean> {
  const runs = await listCheckRuns(token, owner, repo, headSha);
  return runs.some((r) => r.status === "completed" && r.conclusion === "success"
    && isReviewCheckRun(r, REVIEW_PROCESSES["claude-code-review-repository-fix"]));
}

/**
 * The per-head test for the repository-fix process: the review check on `headSha` completed with
 * `success`, and no open `blocking` ledger finding was last seen at or after the head's commit time
 * (a finding seen earlier was not reported by a review of this head). Throws on an unreadable commit.
 */
export async function headReviewedClean(token: string, owner: string, repo: string, prNumber: number, headSha: string): Promise<boolean> {
  if (!(await reviewCheckSucceeded(token, owner, repo, headSha))) return false;
  const commitMs = await getCommitTime(token, owner, repo, headSha);
  // The ledger is keyed by "owner/repo" (see the review-fix queue in src/index.ts).
  return !listOpenReviewFindings(`${owner}/${repo}`, prNumber)
    .some((f) => f.severity === "blocking" && f.lastSeenAt >= commitMs);
}
