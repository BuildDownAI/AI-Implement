import { describe, expect, it, vi } from "vitest";
import { encodeRunConfig } from "../run-config.js";
import { runPlanningLocally } from "../run-planning.js";
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

  it("forwards planning context, agentConfig and configured-run sources to the planning runner", async () => {
    const rev = { configRevisionId: "11111111-1111-4111-8111-111111111111", revision: 1 };
    const st = { agent: "codex", provider: "openai", model: "gpt-plan", accountProfileId: "p", invocationTimeoutMs: 1000 };
    const pr = { id: "p", identity: "a", revision: 1, agent: "codex", provider: "openai", authMode: "openai-api-key" };
    const agentConfig = {
      version: 1,
      snapshotId: "s",
      configRevisions: { orchestratorDefault: rev, project: rev },
      stages: { planning: st, implementation: { ...st, agent: "claude", provider: "anthropic", model: "c", accountProfileId: "pi" }, review: { ...st, accountProfileId: "pr" } },
      sources: Object.fromEntries(["planning", "implementation", "review"].map((n) => [n, { agent: "project", provider: "project", model: "project", accountProfileId: "project", invocationTimeoutMs: "job-deadline" }])),
      profiles: { planning: pr, implementation: { ...pr, id: "pi", agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" }, review: { ...pr, id: "pr" } },
    };
    const runPlanning = vi.fn().mockResolvedValue({ exitCode: 0, planningContext: "x", planFound: true, diagnostics: "" });
    const configured = { localCredentialPort: { load: vi.fn() } } as never;
    const runConfig = encodeRunConfig({
      v: 1,
      issue: { id: "i", identifier: "L-2", title: "T", description: "D" },
      runnerPhase: "planning",
      planningContext: { parent: "P", siblings: "S", dependencies: "D2" },
      agentConfig,
    } as never);
    const code = await runLocalPlanningFromEnv(
      { AI_IMPLEMENT_RUN_CONFIG: runConfig, WORKSPACE_DIR: "/workspace" },
      { runPlanning, writeStdout: vi.fn(), writeStderr: vi.fn(), configured },
    );
    expect(code).toBe(0);
    const arg = runPlanning.mock.calls[0][0];
    expect(arg).toMatchObject({ parent: "P", siblings: "S", dependencies: "D2", configured });
    expect(arg.agentConfig.snapshotId).toBe("s");
  });

  it("with the real planning runner and no credential source, a configured envelope fails closed before any model work", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "local-plan-cfg-"));
    try {
      const rev = { configRevisionId: "11111111-1111-4111-8111-111111111111", revision: 1 };
      const st = { agent: "codex", provider: "openai", model: "gpt-plan", accountProfileId: "p", invocationTimeoutMs: 1000 };
      const pr = { id: "p", identity: "a", revision: 1, agent: "codex", provider: "openai", authMode: "openai-api-key" };
      const agentConfig = {
        version: 1,
        snapshotId: "s",
        configRevisions: { orchestratorDefault: rev, project: rev },
        stages: { planning: st, implementation: { ...st, accountProfileId: "pi" }, review: { ...st, accountProfileId: "pr" } },
        sources: Object.fromEntries(["planning", "implementation", "review"].map((n) => [n, { agent: "project", provider: "project", model: "project", accountProfileId: "project", invocationTimeoutMs: "job-deadline" }])),
        profiles: { planning: pr, implementation: { ...pr, id: "pi" }, review: { ...pr, id: "pr" } },
      };
      const runConfig = encodeRunConfig({ v: 1, issue: { id: "i", identifier: "L-3", title: "T", description: "D" }, runnerPhase: "planning", agentConfig } as never);
      const writeStderr = vi.fn();
      const code = await runLocalPlanningFromEnv(
        { AI_IMPLEMENT_RUN_CONFIG: runConfig, WORKSPACE_DIR: workspace },
        { runPlanning: runPlanningLocally, writeStdout: vi.fn(), writeStderr },
      );
      expect(code).toBe(1);
      expect(writeStderr).toHaveBeenCalledWith("[dev:run] planning failed: Configured planning failed (bootstrap_missing)\n");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("forwards the envelope skillsRepo to planning", async () => {
    const runPlanning = vi.fn().mockResolvedValue({ exitCode: 0, planningContext: "x", planFound: true, diagnostics: "" });
    const runConfig = encodeRunConfig({
      v: 1,
      issue: { id: "i", identifier: "LOCAL-1", title: "T", description: "D" },
      runnerPhase: "planning",
      skillsRepo: "org/skills",
    });
    await runLocalPlanningFromEnv(
      { AI_IMPLEMENT_RUN_CONFIG: runConfig, WORKSPACE_DIR: "/workspace" },
      { runPlanning, writeStdout: vi.fn(), writeStderr: vi.fn() },
    );
    expect(runPlanning).toHaveBeenCalledWith(expect.objectContaining({ skillsRepo: "org/skills" }));
  });
});
