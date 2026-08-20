import { describe, expect, it, vi } from "vitest";
import { encodeRunConfig } from "../run-config.js";
import { runLocalPlanningFromEnv } from "../run-local-planning.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

describe("runLocalPlanningFromEnv", () => {
  it("fails unless the planning phase produces a readable plan", async () => {
    const runPlanning = vi.fn().mockResolvedValue({
      exitCode: 1,
      planningContext: "",
      planFound: false,
      diagnostics: "Planning process produced no readable Markdown plan",
    });
    const output: string[] = [];
    const runConfig = encodeRunConfig({
      v: 1,
      issue: {
        id: "issue-1",
        identifier: "LOCAL-1",
        title: "Plan the health check",
        description: "Map the implementation.",
      },
      runnerPhase: "planning",
    });

    const exitCode = await runLocalPlanningFromEnv(
      { AI_IMPLEMENT_RUN_CONFIG: runConfig, WORKSPACE_DIR: "/workspace" },
      {
        runPlanning,
        writeStdout: (text) => output.push(text),
        writeStderr: (text) => output.push(text),
      },
    );

    expect(runPlanning).toHaveBeenCalledWith(expect.objectContaining({
      workspaceDir: "/workspace",
      issueIdentifier: "LOCAL-1",
      issueTitle: "Plan the health check",
      issueDescription: "Map the implementation.",
    }));
    expect(exitCode).toBe(1);
    expect(output.join("\n")).toContain("no readable Markdown plan");
  });

  it("keeps planning artifacts out of the target repository status", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "local-planning-runner-"));
    try {
      spawnSync("git", ["init"], { cwd: workspace });
      spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
      spawnSync("git", ["config", "user.name", "Test"], { cwd: workspace });
      writeFileSync(join(workspace, "source.txt"), "original\n");
      spawnSync("git", ["add", "source.txt"], { cwd: workspace });
      spawnSync("git", ["commit", "-m", "initial"], { cwd: workspace });

      const runConfig = encodeRunConfig({
        v: 1,
        issue: { id: "issue-1", identifier: "LOCAL-1", title: "Plan", description: "Plan it" },
        runnerPhase: "planning",
      });
      const runPlanning = vi.fn().mockImplementation(async () => {
        const comments = join(workspace, "ai-output", "comments");
        mkdirSync(comments, { recursive: true });
        writeFileSync(join(comments, "01-plan.md"), "# Plan\n");
        return { exitCode: 0, planningContext: "# Plan\n", planFound: true, diagnostics: "" };
      });

      await runLocalPlanningFromEnv(
        { AI_IMPLEMENT_RUN_CONFIG: runConfig, WORKSPACE_DIR: workspace },
        { runPlanning, writeStdout: vi.fn(), writeStderr: vi.fn() },
      );

      const status = spawnSync("git", ["status", "--porcelain"], { cwd: workspace });
      expect(status.stdout.toString()).not.toContain("ai-output");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
