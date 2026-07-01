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
