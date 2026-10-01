// Exported (alongside GITHUB_WRITE_CREDENTIAL_KEYS and parseForwardedSecrets below)
// so other modules that need to recognise these same credential surfaces — e.g. the
// activity reporter's redaction pass — can reuse this list instead of maintaining a
// second one that could drift from what actually gets stripped here.
export const MODEL_CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export const RUNNER_CREDENTIAL_KEYS = [
  "RUN_PROGRESS_TOKEN",
  "RUN_PUBLICATION_TOKEN",
  "RUN_TOKEN",
] as const;

// Install-step credentials. NPM_TOKEN normally arrives through the forwarded-
// secrets rail and is stripped by name below, but it is also stripped here so
// a token injected outside that rail (e.g. an app-wide Fly secret or a local
// Docker env) still never reaches the model.
export const INSTALL_CREDENTIAL_KEYS = ["NPM_TOKEN"] as const;

export const GITHUB_WRITE_CREDENTIAL_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GIT_PASSWORD",
] as const;

/**
 * Parses AI_IMPLEMENT_FORWARDED_SECRETS into a list of key names.
 * Splits on commas, trims, and drops empties. Returns [] when unset or empty.
 */
export function parseForwardedSecrets(): string[] {
  const raw = process.env.AI_IMPLEMENT_FORWARDED_SECRETS ?? "";
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

// Derived by dependency-auth. The git credential helper returns its cached token
// when these are present even without a progress bearer, so git subprocesses must
// not inherit them by default.
export const DEPENDENCY_CREDENTIAL_KEYS = [
  "GIT_DEPENDENCY_TOKEN_FILE",
  "GIT_DEPENDENCY_CALLBACK_URL",
  "COMPOSER_AUTH",
] as const;

const DEPENDENCY_HELPER_KEYS = [
  "GIT_DEPENDENCY_TOKEN_FILE",
  "GIT_DEPENDENCY_CALLBACK_URL",
  "RUN_PROGRESS_TOKEN",
] as const;

/**
 * Environment for runner-owned repository processes (install, setup, verify, teardown).
 * Strips model credentials so repository code cannot read the model authorization.
 * Forwarded secrets (AI_IMPLEMENT_FORWARDED_SECRETS) are kept so hooks can use them.
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
 * is true (gap-fill sessions that own their existing PR branch). Forwarded
 * secrets named in AI_IMPLEMENT_FORWARDED_SECRETS are also stripped — they are
 * available to hooks but must never reach the model process — as is the
 * install step's NPM_TOKEN regardless of how it was injected.
 *
 * `base` defaults to `process.env`; a selected per-invocation environment (stage executor)
 * is passed instead so the same stripping applies and `process.env` is never consulted for it.
 */
export function modelProcessEnv(
  allowRepositoryWrites: boolean,
  base: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    delete env.ANTHROPIC_API_KEY;
  }
  for (const key of RUNNER_CREDENTIAL_KEYS) delete env[key];
  if (!allowRepositoryWrites) {
    for (const key of GITHUB_WRITE_CREDENTIAL_KEYS) delete env[key];
  }
  for (const key of INSTALL_CREDENTIAL_KEYS) delete env[key];
  for (const key of parseForwardedSecrets()) delete env[key];
  // The list variable itself must not reach the model — it names what was hidden
  delete env.AI_IMPLEMENT_FORWARDED_SECRETS;
  return env;
}

/**
 * Environment for git subprocesses spawned by the clone, install-skills and
 * reference-repos steps. Git needs PATH, HOME (global config and credential
 * helpers), and TLS/proxy variables, and nothing else from the runner's
 * credential surface: callback tokens, model credentials, install credentials,
 * ambient GitHub tokens, forwarded secrets, and the credential-bearing run
 * config are all removed. Operation-scoped credentials (GIT_ASKPASS/GIT_PASSWORD,
 * GIT_CONFIG_* headers) are passed as `extra` and applied after stripping.
 * process.env is never mutated.
 */
export function gitProcessEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of MODEL_CREDENTIAL_KEYS) delete env[key];
  for (const key of RUNNER_CREDENTIAL_KEYS) delete env[key];
  for (const key of INSTALL_CREDENTIAL_KEYS) delete env[key];
  for (const key of GITHUB_WRITE_CREDENTIAL_KEYS) delete env[key];
  for (const key of parseForwardedSecrets()) delete env[key];
  delete env.AI_IMPLEMENT_FORWARDED_SECRETS;
  delete env.AI_IMPLEMENT_RUN_CONFIG;
  for (const key of DEPENDENCY_CREDENTIAL_KEYS) delete env[key];
  return { ...env, ...extra };
}

/**
 * Environment for the explicit dependency clones (clone.ts `targetDir` / `targets`
 * network operations, bare remote URL). Starts from gitProcessEnv and restores only
 * what the globally registered git-credential-helper needs: the cache handle, the
 * callback URL and the progress bearer. COMPOSER_AUTH is never restored. Read from
 * process.env at call time because dependency-auth sets these mid-pipeline.
 */
export function gitDependencyProcessEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const restored: NodeJS.ProcessEnv = {};
  for (const key of DEPENDENCY_HELPER_KEYS) {
    const value = process.env[key];
    if (value !== undefined) restored[key] = value;
  }
  return gitProcessEnv({ ...restored, ...extra });
}
