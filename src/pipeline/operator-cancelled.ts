/**
 * Thrown when a closed-and-not-merged PR is detected during the post-push finalize path.
 * Detection occurs proactively (via `gh pr view`) at step start and before any push,
 * as well as reactively when `gh pr comment` fails with "issue is locked".
 * Locking on close is an opt-in GitHub setting; the proactive check fires regardless.
 */
export class OperatorCancelledError extends Error {
  readonly code = "OPERATOR_CANCELLED";
  constructor(prNumber: string) {
    super(`PR #${prNumber} was closed by an operator while the pipeline was running`);
    this.name = "OperatorCancelledError";
  }
}

/**
 * Thrown when a merged PR is detected mid-review (auto-merged into the grouping branch
 * while the post-push review loop was still running). The run exits cleanly as
 * terminationReason="pr_merged" rather than propagating a pipeline failure.
 */
export class PrMergedError extends Error {
  readonly code = "PR_MERGED";
  constructor(prNumber: string) {
    super(`PR #${prNumber} was merged while the post-push review was running`);
    this.name = "PrMergedError";
  }
}
