import { defineConfig } from "vitest/config";

// Isolated from vitest.config.ts on purpose (AII-612): these tests boot a Restate
// container via testcontainers and need Docker. `npm test` never loads this file.
export default defineConfig({
  test: {
    env: { DEDUP_DB_PATH: ":memory:" },
    pool: "forks",
    setupFiles: ["src/__tests__/setup/clear-runner-credentials.ts"],
    include: ["src/**/*.restate.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".worktrees/**"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
