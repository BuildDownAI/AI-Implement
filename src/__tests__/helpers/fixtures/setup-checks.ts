import type { SetupCheckContext } from "../../../setup-checks/index.js";

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
    storedAccessEntries: () => [],
    effectiveAllowlist: () => ({ entries: [], source: "env" }),
    restateStatus: () => ({ sidecar: { state: "ready" }, registration: { state: "registered" } }),
    databasePath: () => ({ path: "/data/dedup.sqlite", configured: "/data/dedup.sqlite", fellBack: false }),
    onSeparateFilesystem: () => true,
    ...overrides,
  };
}
