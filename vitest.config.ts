import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Set before test-module imports: dedup.ts captures its path at import time.
    // Never inherit a developer or runner application's database by default.
    env: { DEDUP_DB_PATH: ":memory:" },
    pool: "forks",
    // Creates the run's own temp directory, which the scrub points TMPDIR, TMP and TEMP at, and fails the run if anything is left in it.
    globalSetup: ["src/__tests__/setup/run-temp-root.ts"],
    // The scrub must finish before any other setup file loads.
    // "list" is vitest's runtime default, but its bundled types document "parallel", so it is stated here.
    sequence: { setupFiles: "list" },
    setupFiles: ["src/__tests__/setup/scrub-ambient-env.ts", "src/__tests__/setup/clear-runner-credentials.ts"],
    include: ["src/**/*.test.ts"],
    // src/__tests__/restate/** boots a `restate-server` and runs separately via
    // `npm run test:restate` / vitest.restate.config.ts — never here, so the
    // default suite stays fast and server-free on every machine, including dispatched runners.
    exclude: ["node_modules/**", "dist/**", ".worktrees/**", "src/__tests__/restate/**"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
