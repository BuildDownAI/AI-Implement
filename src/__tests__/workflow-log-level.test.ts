import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("claude-implement.yml forwards AI_IMPLEMENT_LOG_LEVEL", () => {
  it("passes the repo variable into the pipeline container env", () => {
    const yml = readFileSync(join(process.cwd(), "workflows/claude-implement.yml"), "utf-8");
    expect(yml).toContain("AI_IMPLEMENT_LOG_LEVEL: ${{ vars.AI_IMPLEMENT_LOG_LEVEL }}");
  });
});
