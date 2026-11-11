/** Every repository permission the GitHub App needs, declared once for the setup checks and the install guide. */

/** A permission's level on an installation; `write` includes `read`. */
export type GitHubPermissionLevel = "read" | "write";

export interface GitHubAppPermission {
  /** Its key in an installation's `permissions` object and in a token request. */
  name: string;
  /** Its label on GitHub's permissions page and in `docs/deployment.md`. */
  title: string;
  level: GitHubPermissionLevel;
  /** Dispatch, or the pull request a run opens, fails without it. Otherwise one feature does. */
  required: boolean;
  /** What stops working without it, as an operator reads it. */
  whenMissing: string;
}

// Mints that request no permissions get every grant below, so a feature can rely on a row no `permissions: {…}` literal names (`actions`, `issues`).
export const GITHUB_APP_PERMISSIONS = [
  { name: "contents", title: "Contents", level: "write", required: true, whenMissing: "Runs cannot clone the repository or push their branch." },
  { name: "pull_requests", title: "Pull requests", level: "write", required: true, whenMissing: "Runs cannot open or update their pull request." },
  { name: "workflows", title: "Workflows", level: "write", required: true, whenMissing: "Workflow sync, and runs that change a workflow file, cannot push." },
  // Actions is required on every project: forcing the gha runner mode during an outage sends any project's runs through Actions.
  { name: "actions", title: "Actions", level: "write", required: true, whenMissing: "GitHub Actions dispatches fail, and their run status cannot be read." },
  { name: "issues", title: "Issues", level: "write", required: true, whenMissing: "Pull request comments and the /ai-implement reactions fail." },
  { name: "metadata", title: "Metadata", level: "read", required: true, whenMissing: "Every repository read fails." },
  { name: "checks", title: "Checks", level: "read", required: false, whenMissing: "Post-push review and auto-merge cannot read a pull request's check runs." },
  { name: "statuses", title: "Commit statuses", level: "write", required: false, whenMissing: "The knowledge graph dry-run status is not posted, and self-deploy cannot see that an image was published." },
] as const satisfies readonly GitHubAppPermission[];

export type GitHubAppPermissionName = (typeof GITHUB_APP_PERMISSIONS)[number]["name"];

/** True when `held`, a level from GitHub (absent when not granted), grants at least `needed`. */
export function permissionLevelCovers(held: string | undefined, needed: GitHubPermissionLevel): boolean {
  return held === "write" || (held === "read" && needed === "read");
}