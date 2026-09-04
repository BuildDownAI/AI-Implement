import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".worktrees/**"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
