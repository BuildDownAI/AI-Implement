import { defineConfig } from "vitest/config";

// Isolated from vitest.config.ts on purpose (AII-612): these tests boot a Restate
// container via testcontainers and need Docker. `npm test` never loads this file.
export default defineConfig({
  test: {
    env: {
      DEDUP_DB_PATH: ":memory:",
      // Restate SDK log level (TRACE|DEBUG|INFO|WARN|ERROR; the SDK defaults to INFO). INFO writes one
      // line per invocation step: ~48 000 lines per CI job (AII-1161). An operator who needs them sets
      // RESTATE_LOGGING=INFO on the command line; that value wins here.
      RESTATE_LOGGING: process.env.RESTATE_LOGGING ?? "WARN",
    },
    pool: "forks",
    setupFiles: ["src/__tests__/setup/clear-runner-credentials.ts"],
    include: ["src/__tests__/restate/**/*.restate.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".worktrees/**"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
