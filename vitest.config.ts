import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    setupFiles: ["src/__tests__/setup/clear-runner-credentials.ts"],
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".worktrees/**"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
