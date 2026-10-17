/**
 * Repository visibility/trust decision shared by dispatch preparation and the runner's configured-run
 * validation. Pure and dependency-free so the runner image does not load the orchestrator's data layer.
 */

export type RepoVisibility = "public" | "private" | "internal" | "unknown";

export interface RepoTrust {
  readonly visibility: RepoVisibility;
  /** True only when the repository is an authorized trusted testing repository for hosted subscriptions. */
  readonly trustedForSubscription: boolean;
}

export type RepoTrustRejection = "repository_visibility_unknown" | "repository_public" | "repository_not_trusted";

/**
 * Unknown or unrecognised visibility, public repositories and repositories not authorized for
 * subscription testing are all rejected; `null` means the repository may be executed.
 */
export function repoTrustRejection(trust: RepoTrust | undefined): RepoTrustRejection | null {
  if (!trust || (trust.visibility !== "public" && trust.visibility !== "private" && trust.visibility !== "internal")) {
    return "repository_visibility_unknown";
  }
  if (trust.visibility === "public") return "repository_public";
  if (trust.trustedForSubscription !== true) return "repository_not_trusted";
  return null;
}
