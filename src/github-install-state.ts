import { getInstallation, installationIncludesRepo, getAppSlug, type InstallationDetails } from "./github-app-auth.js";
import { GitHubApiError } from "./github-errors.js";

export type InstallState =
  | { state: "app-not-installed"; installUrl: string }
  | { state: "repo-not-selected"; installUrl: string }
  | { state: "ready" };

export interface ProbeInstallStateParams {
  appId: string;
  privateKey: string;
  owner: string;
  repo: string;
}

/**
 * Determines whether the GitHub App is ready to sync to owner/repo, and if not, the exact next action:
 *   - app-not-installed: the App isn't on this owner -> deep-link to install it
 *   - repo-not-selected: installed with "selected repositories" but this repo isn't included -> deep-link to add it
 *   - ready: installed and can see the repo ("all repositories", or this repo is selected)
 */
export async function probeInstallState(params: ProbeInstallStateParams): Promise<InstallState> {
  const { appId, privateKey, owner, repo } = params;
  const slug = await getAppSlug(appId, privateKey);
  const installUrl = `https://github.com/apps/${slug}/installations/new`;

  let install: InstallationDetails;
  try {
    install = await getInstallation(appId, privateKey, owner);
  } catch (err) {
    // Only a 404 (no installation on this owner) means "not installed". A 401/403 is a credential or
    // permission failure, not an install state — rethrow it rather than telling the user to install an
    // App that may already be there.
    if (err instanceof GitHubApiError && err.status === 404) {
      return { state: "app-not-installed", installUrl };
    }
    throw err;
  }

  // Whether the installation can see this repo:
  // an "all" install sees everything; a "selected" install sees it only if the repo was explicitly added
  const repoVisible = install.repositorySelection === "all" ? true : await installationIncludesRepo(install.token, repo);
  if (repoVisible) {
    return { state: "ready" };
  }

  // Same install-flow URL as app-not-installed: GitHub's install entry lets owners add the repo and
  // routes non-owners through the "request the owner to install" flow.
  return { state: "repo-not-selected", installUrl };
}