/** Thrown when `gh pr comment` fails with "issue is locked" on a closed-and-not-merged PR. */
export class OperatorCancelledError extends Error {
  readonly code = "OPERATOR_CANCELLED";
  constructor(prNumber: string) {
    super(`PR #${prNumber} was closed by an operator while the pipeline was running`);
    this.name = "OperatorCancelledError";
  }
}
