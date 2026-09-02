const MODEL_CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

const RUNNER_CREDENTIAL_KEYS = [
  "RUN_PROGRESS_TOKEN",
  "RUN_PUBLICATION_TOKEN",
  "RUN_TOKEN",
] as const;

const GITHUB_WRITE_CREDENTIAL_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GIT_PASSWORD",
] as const;

/**
 * Environment for runner-owned repository processes (install, setup, verify, teardown).
 * Strips model credentials so repository code cannot read the model authorization.
 *
 * Note: a hook that exports ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN into
 * GITHUB_ENV would re-inject the credential into process.env after mergeGithubEnv
 * runs. That re-injected value is visible to subsequent Claude invocations (which
 * read process.env at call time) but not to subsequent repo-process invocations,
 * because each call to repoProcessEnv() takes a fresh snapshot and strips again.
 */
export function repoProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of MODEL_CREDENTIAL_KEYS) delete env[key];
  return env;
}

/**
 * Environment for the Claude Code model process. Applies OAuth-wins selection:
 * if CLAUDE_CODE_OAUTH_TOKEN is present, ANTHROPIC_API_KEY is removed so the
 * model process receives exactly one credential. Runner callback tokens are
 * always stripped. GitHub write tokens are stripped unless allowRepositoryWrites
 * is true (gap-fill sessions that own their existing PR branch).
 */
export function modelProcessEnv(allowRepositoryWrites: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    delete env.ANTHROPIC_API_KEY;
  }
  for (const key of RUNNER_CREDENTIAL_KEYS) delete env[key];
  if (!allowRepositoryWrites) {
    for (const key of GITHUB_WRITE_CREDENTIAL_KEYS) delete env[key];
  }
  return env;
}
