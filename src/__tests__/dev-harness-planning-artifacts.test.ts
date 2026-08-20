import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectPlanningArtifact } from "../dev-harness/planning-artifacts.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("collectPlanningArtifact", () => {
  it("saves ordered planning comments as plan.md in the run artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "dev-plan-artifact-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const artifactsDir = join(root, "artifacts");
    const commentsDir = join(workspace, "ai-output", "comments");
    mkdirSync(commentsDir, { recursive: true });
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(commentsDir, "02-acceptance.md"), "## Acceptance\nShip it.\n");
    writeFileSync(join(commentsDir, "01-map.md"), "## Map\nChange one file.\n");

    await collectPlanningArtifact(workspace, artifactsDir);

    const planPath = join(artifactsDir, "plan.md");
    expect(existsSync(planPath)).toBe(true);
    expect(readFileSync(planPath, "utf-8")).toBe(
      "## Map\nChange one file.\n\n## Acceptance\nShip it.\n",
    );
  });
});
