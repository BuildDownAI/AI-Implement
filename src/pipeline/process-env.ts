import { decodeTrustedRunConfig } from "../run-config.js";

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

/**
 * Private-envelope and model-auth bootstrap material (AII-981). The encoded run config may
 * carry a `credentials` namespace, so it is credential-bearing; the model-auth names are the
 * protected bootstrap handles (grant, sealed blob, protection key, bearer). Neither may reach
 * a model or repository child. The selected model credential is delivered separately by
 * ModelAuthClient's invocation environment, which this module does not touch.
 */
export const PROTECTED_BOOTSTRAP_KEYS = ["AI_IMPLEMENT_RUN_CONFIG"] as const;
export const PROTECTED_BOOTSTRAP_PREFIXES = ["AI_IMPLEMENT_MODEL_AUTH_"] as const;

/** Model credential and session-handle names beyond MODEL_CREDENTIAL_KEYS that repository code must not inherit. */
export const MODEL_SESSION_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;

function deleteBootstrapKeys(env: NodeJS.ProcessEnv): void {
  for (const key of PROTECTED_BOOTSTRAP_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (PROTECTED_BOOTSTRAP_PREFIXES.some((p) => key.startsWith(p))) delete env[key];
  }
}

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
 * Strips model credentials, session handles, the encoded run config and model-auth
 * bootstrap material so repository code cannot read the model authorization.
 * Forwarded secrets (AI_IMPLEMENT_FORWARDED_SECRETS) are kept so hooks can use them.
 *
 * Note: a hook that exports ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN into
 * GITHUB_ENV would re-inject the credential into process.env after mergeGithubEnv
 * runs. That re-injected value is visible to subsequent Claude invocations (which
 * read process.env at call time) but not to subsequent repo-process invocations,
 * because each call to repoProcessEnv() takes a fresh snapshot and strips again.
 */
export function repoProcessEnv(options: { configured?: boolean } = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const configured = options.configured ?? isConfiguredModelRun(process.env);
  const forwarded = new Set(parseForwardedSecrets());
  for (const key of MODEL_CREDENTIAL_KEYS) delete env[key];
  // Legacy only: an explicitly approved forwarded secret keeps its name even if it collides
  // with a model key. A configured (opted-in) run never keeps one, so a forwarded-secret
  // alias cannot reintroduce a model credential, auth directory or provider redirect.
  for (const key of MODEL_SESSION_KEYS) if (configured || !forwarded.has(key)) delete env[key];
  if (configured) {
    for (const key of Object.keys(env)) {
      if (CONFIGURED_MODEL_PREFIXES.some((p) => key.startsWith(p))) delete env[key];
    }
  }
  deleteBootstrapKeys(env);
  return env;
}

/** Extra name prefixes (credentials, auth directories, provider routing) removed from repository children of configured runs. */
const CONFIGURED_MODEL_PREFIXES = ["OPENAI_", "CODEX_", "ANTHROPIC_", "CLAUDE_CODE_", "CLAUDE_CONFIG_", "AWS_"] as const;

/**
 * True when the encoded run config selects per-stage agent configuration (opt-in). Mirrors
 * session/lib.sh classify_run_config: an empty value, or an envelope the trusted decoder accepts
 * with neither `agentConfig` nor `credentials.modelAuthGrant` (e.g. a callback/publication-only
 * credentials namespace), is legacy. Everything else is configured so the stricter stripping
 * applies: configured intent, and any nonempty envelope the decoder rejects (fail closed, so bad
 * protected input can never fall into the legacy forwarded-model-name exception).
 */
export function isConfiguredModelRun(env: NodeJS.ProcessEnv): boolean {
  const encoded = env.AI_IMPLEMENT_RUN_CONFIG;
  if (!encoded) return false;
  try {
    const decoded = decodeTrustedRunConfig(encoded);
    return decoded.agentConfig !== undefined || decoded.credentials?.modelAuthGrant !== undefined;
  } catch {
    return true;
  }
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
 */
export function modelProcessEnv(
  allowRepositoryWrites: boolean,
  selectedAuth?: { readonly env: Readonly<Record<string, string | undefined>> },
): NodeJS.ProcessEnv {
  if (selectedAuth) return selectedModelEnv(allowRepositoryWrites, selectedAuth.env);
  const env = { ...process.env };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    delete env.ANTHROPIC_API_KEY;
  }
  for (const key of RUNNER_CREDENTIAL_KEYS) delete env[key];
  if (!allowRepositoryWrites) {
    for (const key of GITHUB_WRITE_CREDENTIAL_KEYS) delete env[key];
  }
  for (const key of INSTALL_CREDENTIAL_KEYS) delete env[key];
  for (const key of parseForwardedSecrets()) delete env[key];
  deleteBootstrapKeys(env);
  // The list variable itself must not reach the model — it names what was hidden
  delete env.AI_IMPLEMENT_FORWARDED_SECRETS;
  return env;
}

/**
 * Explicit selected-authentication form: `selected` is the environment ModelAuthClient's
 * buildModelInvocationEnv produced for the one selected credential (positive allowlist of
 * safe context plus that credential). It is copied, never merged with process.env, so no
 * other profile's credential, bootstrap, callback or install secret can ride along.
 * Defensive deletes repeat the protected names in case a caller hands in a wider map.
 * `allowRepositoryWrites` only decides whether GitHub write tokens already present in
 * `selected` survive; ambient process.env GitHub credentials are never restored.
 * Forwarded-secret names are deliberately not stripped here: a forwarded secret that
 * collides with the selected credential's name must not remove the selection.
 *
 * Trust limit: this filters what the model process inherits; commands the agent starts can
 * still read that process's environment, so this is not hostile-code isolation.
 */
function selectedModelEnv(
  allowRepositoryWrites: boolean,
  selected: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...selected };
  for (const key of RUNNER_CREDENTIAL_KEYS) delete env[key];
  for (const key of INSTALL_CREDENTIAL_KEYS) delete env[key];
  if (!allowRepositoryWrites) {
    for (const key of GITHUB_WRITE_CREDENTIAL_KEYS) delete env[key];
  }
  delete env.AI_IMPLEMENT_FORWARDED_SECRETS;
  deleteBootstrapKeys(env);
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
  for (const key of MODEL_SESSION_KEYS) delete env[key];
  for (const key of RUNNER_CREDENTIAL_KEYS) delete env[key];
  for (const key of INSTALL_CREDENTIAL_KEYS) delete env[key];
  for (const key of GITHUB_WRITE_CREDENTIAL_KEYS) delete env[key];
  for (const key of parseForwardedSecrets()) delete env[key];
  delete env.AI_IMPLEMENT_FORWARDED_SECRETS;
  deleteBootstrapKeys(env);
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
