import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "../pipeline/default-model.js";
import { parseWorkflowMd } from "../workflow-md.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

describe("seed templates match DEFAULT_MODEL", () => {
  it.each(["workflows/WORKFLOW.md", "workflows/PLANNING.md"])("%s model: front matter", (rel) => {
    const raw = readFileSync(resolve(REPO_ROOT, rel), "utf8");
    expect(parseWorkflowMd(raw, {}).frontMatter.model).toBe(DEFAULT_MODEL);
  });
});
