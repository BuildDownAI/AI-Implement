import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Set before test-module imports: dedup.ts captures its path at import time.
    // Never inherit a developer or runner application's database by default.
    env: { DEDUP_DB_PATH: ":memory:" },
    pool: "forks",
    setupFiles: ["src/__tests__/setup/clear-runner-credentials.ts"],
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".worktrees/**"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
