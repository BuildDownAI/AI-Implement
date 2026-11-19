export class GitHubApiError extends Error {
  readonly status: number;
  readonly path: string | null;
  readonly bodyText: string;

  constructor(params: {
    status: number;
    path?: string | null;
    bodyText?: string;
    message?: string;
  }) {
    const { status, path = null, bodyText = "", message } = params;
    // Default to the GitHubClient shape; callers with their own wording (github.ts) pass `message`.
    super(message ?? `GitHub ${status}${path ? ` ${path}` : ""}: ${bodyText.slice(0, 500)}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "GitHubApiError";
    this.status = status;
    this.path = path;
    this.bodyText = bodyText;
  }
}

/** What a GitHub App error says about setup. */
export type GitHubAppErrorCategory =
  | "app-not-installed"
  | "repo-not-found"
  | "permission-denied"
  | "clock-skew-suspected"
  | "unknown";

/** Decides a GitHub App error's category from its status and the path GitHub answered for. */
export function classifyGitHubAppError(err: unknown): GitHubAppErrorCategory {
  if (!(err instanceof GitHubApiError)) return "unknown";
  // 401 first: a bad/expired App JWT is rejected at GitHub's auth layer regardless of endpoint,
  // so catch every 401 here before the 404 "not installed" check.
  // Host clock skew is the usual cause — the JWT tolerates ±300s of drift (AII-199), so a 401 implies drift beyond that or bad credentials.
  if (err.status === 401) return "clock-skew-suspected";
  if (err.status === 403) return "permission-denied"; // incl. missing `workflows` perm on .github/workflows PUT

  // Same status, different meaning by endpoint — disambiguate on the path.
  if (err.status === 404 && err.path) {
    if (/\/installation$/.test(err.path)) return "app-not-installed";
    // Matches ONLY the bare-repo existence probe (`/repos/owner/repo`, the first repo call in syncWorkflowTemplates).
    // Intentionally narrow: deeper 404s (e.g. a missing base branch at /repos/owner/repo/git/ref/heads/...) are not "repo not found" and correctly fall to unknown.
    if (/^\/repos\/[^/]+\/[^/]+$/.test(err.path)) return "repo-not-found";
  }
  return "unknown";
}
