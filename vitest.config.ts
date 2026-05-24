import { defineConfig } from "vitest/config";

// Default test discovery + explicit excludes for sibling packages that use a
// different test runner (agentica-agent/ uses node:test, has its own deps).
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "agentica-agent/**",
      "agentica-spike/**",
      "agentica-spike-2/**",
    ],
  },
});
