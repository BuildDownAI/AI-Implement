import { LINEAR_LABELS } from "../../../providers/linear.js";
import type { FoundLabel, LinearSetupFacts } from "../../../providers/types.js";
import type { GitHubSetupFacts, SetupCheckContext } from "../../../setup-checks/index.js";
import { makeMapping } from "../builders.js";

/** Every secret variable a check could read, each set to a value that names itself, so a test can assert none reaches any output. */
export const SECRET_SENTINELS = {
  ANTHROPIC_API_KEY: "sentinel-anthropic-key",
  CLAUDE_CODE_OAUTH_TOKEN: "sentinel-claude-token",
  GITHUB_APP_PRIVATE_KEY: "sentinel-app-key",
  ADMIN_ACCESS_CODE: "sentinel-access-code",
  RUNNER_TOKEN_SECRET: "sentinel-token-secret",
  FLY_SESSIONS_TOKEN: "sentinel-fly-sessions-token",
  GOOGLE_OAUTH_CLIENT_SECRET: "sentinel-google-secret",
  MICROSOFT_OAUTH_CLIENT_SECRET: "sentinel-microsoft-secret",
  BUILDDOWN_OIDC_CLIENT_SECRET: "sentinel-builddown-secret",
  LINEAR_CLIENT_SECRET: "sentinel-linear-secret",
} as const;

/**
 * A setup-check context for an orchestrator with nothing configured: no environment, no saved
 * settings or projects, the allowlist read from that empty environment, Restate ready and
 * registered, and the database at its default path. Each reader is a plain function, so a test
 * overrides only what its check reads.
 */
export function makeSetupCheckContext(overrides: Partial<SetupCheckContext> = {}): SetupCheckContext {
  return {
    env: {},
    readSetting: () => null,
    orchestratorDefaults: () => null,
    projectStageConfig: () => null,
    runnerBackendSource: () => "restate",
    runnerMode: () => ({ mode: "default", source: "default" }),
    flySessions: () => ({ token: null, app: null, region: null, source: { app: null, region: null } }),
    mappings: () => ({}),
    storedAccessEntries: () => [],
    effectiveAllowlist: () => ({ entries: [], source: "env" }),
    allowlistReadAvailable: () => true,
    restateStatus: () => ({ sidecar: { state: "ready" }, registration: { state: "registered" } }),
    databasePath: () => ({ path: "/data/dedup.sqlite", configured: "/data/dedup.sqlite", fellBack: false }),
    onSeparateFilesystem: () => true,
    trackerProvider: (providerId) => Promise.reject(new Error(`No project uses the ${providerId} ticketing system`)),
    // A provider that cannot be built has no facts to read either, as in createSetupCheckContext.
    trackerSetupFacts: (providerId) => Promise.reject(new Error(`No project uses the ${providerId} ticketing system`)),
    githubSetupFacts: () => makeGitHubSetupFacts(),
    // Nothing answers at any address, as on a refused connection.
    orchestratorHealthAt: () => Promise.resolve({ outcome: "no-response", timedOut: false, error: "fetch failed: connect ECONNREFUSED" }),
    orchestratorInstanceId: () => "this-orchestrator",
    ...overrides,
  };
}

/**
 * GitHub's side for an orchestrator with no App credentials: every GitHub read refuses as the production reads do
 * without them, and no project has ever been synced. A test overrides only the reads its check makes.
 */
export function makeGitHubSetupFacts(overrides: Partial<GitHubSetupFacts> = {}): GitHubSetupFacts {
  const noApp = () => Promise.reject(new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are not both set"));
  return {
    app: noApp,
    installation: noApp,
    installationRepositories: noApp,
    repositories: noApp,
    publicRepository: noApp,
    deliveries: noApp,
    kgSourceRepo: () => null,
    kgPreflight: () => Promise.resolve(null),
    workflowSync: () => null,
    ...overrides,
  };
}

/**
 * A context where every secret is set to its sentinel and every check has something to read: the App, the callback,
 * all three sign-in providers, and one Fly project whose sessions token is the sentinel.
 */
export function makeSentinelSetupCheckContext(): SetupCheckContext {
  return makeSetupCheckContext({
    env: {
      ...SECRET_SENTINELS,
      GITHUB_APP_ID: "123456",
      RUNNER_CALLBACK_BASE_URL: "https://orchestrator.example.com",
      GOOGLE_OAUTH_CLIENT_ID: "gid",
      MICROSOFT_OAUTH_CLIENT_ID: "mid",
      MICROSOFT_OAUTH_TENANT: "tenant-id",
      BUILDDOWN_OIDC_ISSUER: "https://cp.example.com",
      BUILDDOWN_OIDC_CLIENT_ID: "bid",
      OAUTH_REDIRECT_BASE_URL: "https://orchestrator.example.com",
      LINEAR_CLIENT_ID: "lid",
    },
    mappings: () => ({ ENG: makeMapping({ executionMode: "fly-machines" }) }),
    flySessions: () => ({ token: SECRET_SENTINELS.FLY_SESSIONS_TOKEN, app: null, region: null, source: { app: null, region: null } }),
  });
}

/**
 * Linear's setup facts after a minted token, built as `LinearProvider.fetchSetupFacts` builds them: every label
 * the read asks for, under each name it matches ignoring case. By default one team, ENG, with a started and a
 * completed state, and the pickup and Ready for Review labels at workspace level.
 */
export function makeLinearSetupFacts({
  pickupLabel = "AI-Implement",
  teams = { ENG: ["started", "completed"] },
  found = [{ name: "AI-Implement", teamKey: null }, { name: LINEAR_LABELS.readyForReview.name, teamKey: null }],
}: { pickupLabel?: string; teams?: Record<string, string[]>; found?: FoundLabel[] } = {}): Extract<LinearSetupFacts, { token: "minted" }> {
  const names = [pickupLabel, ...Object.values(LINEAR_LABELS).map((label) => label.name)];
  return {
    kind: "linear",
    token: "minted",
    pickupLabel,
    teams,
    labels: Object.fromEntries(names.map((name) => [name, found.filter((label) => label.name.toLowerCase() === name.toLowerCase())])),
  };
}
