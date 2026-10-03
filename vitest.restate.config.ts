import { defineConfig } from "vitest/config";

// Isolated from vitest.config.ts on purpose (AII-612): these tests boot a Restate
// container via testcontainers and need Docker. `npm test` never loads this file.
export default defineConfig({
  test: {
    env: { DEDUP_DB_PATH: ":memory:" },
    pool: "forks",
    // The scrub must finish before any other setup file loads; see vitest.config.ts.
    sequence: { setupFiles: "list" },
    setupFiles: ["src/__tests__/setup/scrub-ambient-env.restate.ts", "src/__tests__/setup/clear-runner-credentials.ts"],
    include: ["src/__tests__/restate/**/*.restate.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".worktrees/**"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
