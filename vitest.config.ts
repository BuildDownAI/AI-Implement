import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Set before test-module imports: dedup.ts captures its path at import time.
    // Never inherit a developer or runner application's database by default.
    env: { DEDUP_DB_PATH: ":memory:" },
    pool: "forks",
    setupFiles: ["src/__tests__/setup/clear-runner-credentials.ts"],
    include: ["src/**/*.test.ts"],
    // *.restate.test.ts needs Docker (testcontainers) and runs only via
    // `npm run test:restate` / the restate-tests CI job — never the default
    // suite, which must stay Docker-free on every machine, including a
    // dispatched runner's implement pass (docs/restate.md).
    exclude: ["node_modules/**", "dist/**", ".worktrees/**", "src/**/*.restate.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
