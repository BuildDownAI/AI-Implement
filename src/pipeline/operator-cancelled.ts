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
