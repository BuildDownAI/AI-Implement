import { defineConfig } from "vitest/config";
import { resolveRestateLogLevel } from "./src/restate/log-level.js";

// Isolated from vitest.config.ts on purpose (AII-612): these tests boot the
// `restate-server` binary from node_modules (no Docker). `npm test` never loads this file.
export default defineConfig({
  test: {
    env: {
      DEDUP_DB_PATH: ":memory:",
      // Restate SDK log level (TRACE|DEBUG|INFO|WARN|ERROR; the SDK defaults to INFO). INFO writes one
      // line per invocation step: ~48 000 lines per CI job (AII-1161). An operator who needs them sets
      // RESTATE_LOGGING=INFO on the command line; that value wins here. The helper keeps the WARN
      // default for an empty value and refuses an unknown name with one warning, because the SDK
      // would otherwise throw at module load inside every fork (src/restate/log-level.ts).
      RESTATE_LOGGING: resolveRestateLogLevel(process.env.RESTATE_LOGGING),
    },
    pool: "forks",
    setupFiles: ["src/__tests__/setup/clear-runner-credentials.ts"],
    include: ["src/__tests__/restate/**/*.restate.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".worktrees/**"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
