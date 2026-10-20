import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectPlanningArtifact } from "../dev-harness/planning-artifacts.js";
import { testDir } from "./helpers/test-dir.js";

describe("collectPlanningArtifact", () => {
  it("saves ordered planning comments as plan.md in the run artifacts", async () => {
    const root = testDir("dev-plan-artifact");
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

  it("does not create plan.md when the run produced no planning comments", async () => {
    const root = testDir("dev-plan-artifact");
    const workspace = join(root, "workspace");
    const artifactsDir = join(root, "artifacts");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(artifactsDir, { recursive: true });

    const collected = await collectPlanningArtifact(workspace, artifactsDir);

    expect(collected).toBe(false);
    expect(existsSync(join(artifactsDir, "plan.md"))).toBe(false);
  });
});
