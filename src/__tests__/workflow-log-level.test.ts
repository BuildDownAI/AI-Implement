import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILES = [
  "workflows/claude-implement.yml",
  ".github/workflows/claude-implement.yml",
];

describe("workflows forward AI_IMPLEMENT_LOG_LEVEL", () => {
  for (const f of FILES) {
    it(`${f} passes the repo variable into the pipeline container env`, () => {
      const yml = readFileSync(join(process.cwd(), f), "utf-8");
      expect(yml).toContain("AI_IMPLEMENT_LOG_LEVEL: ${{ vars.AI_IMPLEMENT_LOG_LEVEL }}");
    });
  }
});
