/**
 * Recognises a GitHub check-runs read that failed because the token lacks the
 * Checks: read permission, or the installation has not accepted an updated
 * permission set — distinct from a transient read failure (a 5xx, a network
 * error), which must stay on its existing retry path rather than fail closed
 * immediately.
 *
 * Shared by every check-runs read site (`post-push-review.ts`'s two `gh api`
 * reads via their stderr text, `github.ts`'s `fetch` via the HTTP status) so
 * the same underlying misconfiguration is classified identically regardless
 * of which read path hit it first (AII-736).
 *
 * A 403 is unambiguous and is matched on status when available. `gh api` has
 * no separate status field on a spawn result, so the CLI's own rendering of a
 * 403 — the literal "Resource not accessible by integration" text — is
 * matched on stderr/stdout instead. A 404 is deliberately NOT treated as a
 * permission error here: it collides with "repo not visible for an unrelated
 * reason", and telling the two apart needs cross-call context (e.g. that the
 * same token already read the repo successfully this run) that isn't
 * available at this shared, stateless check.
 */
export function isChecksPermissionError(input: { status?: number | null; text?: string }): boolean {
  if (input.status === 403) return true;
  return /resource not accessible by integration/i.test(input.text ?? "");
}
