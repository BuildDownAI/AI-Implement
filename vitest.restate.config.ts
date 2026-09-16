import { defineConfig } from "vitest/config";

// Separate from vitest.config.ts by design: *.restate.test.ts needs Docker
// (testcontainers) and must never run as part of the default `npm test`.
// Invoked only by `npm run test:restate` and the restate-tests CI job.
export default defineConfig({
  test: {
    env: { DEDUP_DB_PATH: ":memory:" },
    pool: "forks",
    setupFiles: ["src/__tests__/setup/clear-runner-credentials.ts"],
    include: ["src/__tests__/*.restate.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".worktrees/**"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
