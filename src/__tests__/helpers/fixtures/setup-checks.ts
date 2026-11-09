import { LINEAR_LABELS } from "../../../providers/linear.js";
import type { FoundLabel, LinearSetupFacts } from "../../../providers/types.js";
import type { SetupCheckContext } from "../../../setup-checks/index.js";
import { makeMapping } from "../builders.js";

/** Every secret variable a check could read, each set to a value that names itself, so a test can assert none reaches any output. */
export const SECRET_SENTINELS = {
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
    runnerMode: () => ({ mode: "default", source: "default" }),
    flySessions: () => ({ token: null, app: null, region: null, source: { app: null, region: null } }),
    mappings: () => ({}),
    workflowCapabilities: async () => ({ contract: "envelope", supportsRunPublicationToken: true, supportsAttemptCorrelation: true, supportsPrivateRunConfig: true, supportsStageAgentConfig: true, hasStageAgentConfigMarker: true, hasStageAgentLaunchContextMarker: true }),
    defaultBranchFileExists: async () => false,
    storedAccessEntries: () => [],
    effectiveAllowlist: () => ({ entries: [], source: "env" }),
    allowlistReadAvailable: () => true,
    restateStatus: () => ({ sidecar: { state: "ready" }, registration: { state: "registered" } }),
    databasePath: () => ({ path: "/data/dedup.sqlite", configured: "/data/dedup.sqlite", fellBack: false }),
    onSeparateFilesystem: () => true,
    trackerProvider: (providerId) => Promise.reject(new Error(`No project uses the ${providerId} tracker`)),
    // A provider that cannot be built has no facts to read either, as in createSetupCheckContext.
    trackerSetupFacts: (providerId) => Promise.reject(new Error(`No project uses the ${providerId} tracker`)),
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
