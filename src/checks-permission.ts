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
 * matched on stderr/stdout instead. A 404 is also treated as a permission
 * error: every call site only reaches a check-runs read once the same token
 * has already read the owning repo/PR successfully this run, so a 404 here
 * is "repo the token can otherwise see" per the issue's required behaviour,
 * not an unrelated not-found. `gh api`'s rendering of a 404 carries no
 * distinguishing message text (just "Not Found"), so the text match instead
 * looks for the CLI's own "(HTTP 404)" suffix, the same way it does for 403.
 */
export function isChecksPermissionError(input: { status?: number | null; text?: string }): boolean {
  if (input.status === 403 || input.status === 404) return true;
  const text = input.text ?? "";
  return /resource not accessible by integration/i.test(text) || /\(HTTP 404\)/.test(text);
}
