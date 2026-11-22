/**
 * Thrown when a closed-and-not-merged PR is detected during the post-push finalize path.
 * Detection occurs via `assertPrWritable` at the start of each write function and before any
 * push, as well as reactively when `gh pr comment` fails with "issue is locked".
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
 * Thrown when a merged PR is detected during the post-push finalize path.
 * Detection occurs via `assertPrWritable` at the start of each write function and before any
 * push. A PR merged under the run is a benign terminal — the step exits as `pr_merged`
 * with `approved: true`, unless a genuine LLM failure occurred first.
 */
export class PrMergedError extends Error {
  readonly code = "PR_MERGED";
  constructor(prNumber: string) {
    super(`PR #${prNumber} was merged while the pipeline was running`);
    this.name = "PrMergedError";
  }
}
