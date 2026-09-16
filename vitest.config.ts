import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Set before test-module imports: dedup.ts captures its path at import time.
    // Never inherit a developer or runner application's database by default.
    env: { DEDUP_DB_PATH: ":memory:" },
    pool: "forks",
    setupFiles: ["src/__tests__/setup/clear-runner-credentials.ts"],
    include: ["src/**/*.test.ts"],
    // *.restate.test.ts needs Docker (testcontainers) and runs separately via
    // `npm run test:restate` / vitest.restate.config.ts — never here, so the
    // default suite stays Docker-free on every machine, including dispatched runners.
    exclude: ["node_modules/**", "dist/**", ".worktrees/**", "src/**/*.restate.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
