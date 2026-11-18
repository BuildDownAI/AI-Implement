import type { RepoMapping } from "./config.js";
import { getInFlightIssueIds, getLatestPrUrlForIssue } from "./log.js";
import { getDb } from "./dedup.js";
import { listLinksByOutcome, setLinkOutcome } from "./pr-links.js";
import type { PullRequestLink } from "./pr-links.js";
import {
  enqueueReconciliation,
  hasReconciliationForPr,
  recordReconciliationTombstone,
} from "./reconciliation.js";

export interface DetectDeps {
  mappingForRepo: (repo: string) => RepoMapping | undefined;
  tokenForOwner: (owner: string) => Promise<string>;
  getPullRequestState: (
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<{ merged: boolean; state: "open" | "closed" } | null>;
  /** Marks a grouping parent whose own PR closed unmerged as Done. Resolves true once the
   *  parent is finalized; false (nothing resolvable) leaves the PR untombstoned for a retry.
   *  A provider error throws, with the same effect. */
  finalizeGroupingParent: (link: Pick<PullRequestLink, "repository" | "number" | "issue">) => Promise<boolean>;
}

/** Parse the PR number from a stored html PR URL ending in /pull/<n>. */
export function prNumberFromUrl(url: string): number | null {
  const m = /\/pull\/(\d+)(?:$|[/?#])/.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * Guaranteed (webhook-independent) path: checks every open stored PR link,
 * records terminal outcomes, and queues reconciliation independently of log retention.
 */
export async function detectMergedPrs(deps: DetectDeps): Promise<void> {
  for (const link of listLinksByOutcome("open")) {
    const { repository: repo, number: prNumber, issue } = link;
    const mapping = deps.mappingForRepo(repo);
    if (!mapping) continue;
    const [owner] = repo.split("/");
    let token: string;
    try {
      token = await deps.tokenForOwner(owner);
    } catch (err) {
      console.error(`[merge-poll] token error for ${repo}:`, err);
      continue;
    }
    const state = await deps.getPullRequestState(token, mapping.owner, mapping.repo, prNumber);
    if (!state) continue;
    if (!state.merged && state.state !== "closed") continue;
    const outcome = state.merged ? "merged" : "closed-unmerged";
    // Existing queue rows (including webhook deliveries during the read) only need
    // outcome repair. Roll-ups are finalized by merge-up, never this queue.
    if (link.role === "roll-up" || hasReconciliationForPr(repo, prNumber)) {
      setLinkOutcome(repo, prNumber, outcome, Date.now());
      continue;
    }
    if (state.merged) {
      enqueueReconciliation({
        issueId: issue.trackerIssueId,
        issueIdentifier: issue.identifier,
        prNumber,
        repo,
        mergeCommitSha: "",
      });
      console.log(`[merge-poll] Detected merge of PR #${prNumber} in ${repo}; queued reconciliation`);
    } else if (state.state === "closed") {
      // Any surviving grouping row wins over later gap-fill rows.
      const groupingParent = getDb().prepare(
        "SELECT 1 FROM dispatch_log WHERE pr_url = ? AND grouping_parent = 1 LIMIT 1",
      ).get(link.url);
      if (groupingParent && getLatestPrUrlForIssue(issue.trackerIssueId) === link.url) {
        // A run in flight may still change the picture; the next poll re-checks.
        if (getInFlightIssueIds().has(issue.trackerIssueId)) continue;
        try {
          if (!(await deps.finalizeGroupingParent(link))) continue;
        } catch (err) {
          console.error(`[merge-poll] failed to finalize grouping parent ${issue.identifier} for closed PR #${prNumber} in ${repo}:`, err);
          continue;
        }
        console.log(`[merge-poll] Grouping parent ${issue.identifier} finalized: own PR #${prNumber} in ${repo} closed unmerged`);
      }
      recordReconciliationTombstone({
        issueId: issue.trackerIssueId,
        issueIdentifier: issue.identifier,
        prNumber,
        repo,
      });
      console.log(`[merge-poll] PR #${prNumber} in ${repo} closed unmerged; tombstoned`);
    }
    setLinkOutcome(repo, prNumber, outcome, Date.now());
  }
}
