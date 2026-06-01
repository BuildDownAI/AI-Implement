import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlanning } from "../run-planning.js";

function setEnv() {
  process.env.ISSUE_ID = "uuid-1";
  process.env.ISSUE_IDENTIFIER = "ENG-42";
  process.env.ISSUE_TITLE = "Add widget";
  process.env.ISSUE_DESCRIPTION = "Build the widget.";
  process.env.GITHUB_OWNER = "o";
  process.env.GITHUB_REPO = "r";
  process.env.PARENT = "None";
  process.env.SIBLINGS = "None";
  process.env.DEPENDENCIES = "None";
}

describe("runPlanning", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "plan-"));
    setEnv();
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
    delete process.env.RUNNER_CALLBACK_URL;
    delete process.env.RUN_TOKEN;
    delete process.env.CLAUDE_MODEL;
  });

  it("renders PLANNING.md, runs the executor, collects comments, posts a planning callback", async () => {
    writeFileSync(
      join(ws, "PLANNING.md"),
      "---\nmodel: claude-x\n---\nPlan ${ISSUE_IDENTIFIER}: ${ISSUE_TITLE}",
    );
    let invoked: { prompt: string; args: string[] } | null = null;
    const fakeExecutor = (prompt: string, args: string[]) => {
      invoked = { prompt, args };
      mkdirSync(join(ws, "ai-output", "comments"), { recursive: true });
      writeFileSync(
        join(ws, "ai-output", "comments", "01-architecture-analysis.md"),
        "## 🏗️ AI Planning: Architecture Analysis\nok",
      );
      return { status: 0, stdout: "", stderr: "" };
    };
    const posted: any[] = [];
    const fakeFetch = async (_u: string, init: any) => {
      posted.push(JSON.parse(init.body));
      return { ok: true, text: async () => "" } as any;
    };
    process.env.RUNNER_CALLBACK_URL = "http://orch";
    process.env.RUN_TOKEN = "tok";

    const result = await runPlanning({
      workspaceDir: ws,
      executor: fakeExecutor,
      fetchImpl: fakeFetch as any,
    });

    expect(result.exitCode).toBe(0);
    expect(invoked!.prompt).toContain("Plan ENG-42: Add widget");
    expect(invoked!.args).toContain("--dangerously-skip-permissions");
    expect(invoked!.args.join(" ")).toContain("--model claude-x");
    expect(invoked!.args.join(" ")).not.toContain("push");
    expect(posted[0]).toMatchObject({ phase: "planning", outcome: "success" });
    expect(posted[0].comments).toHaveLength(1);
  });

  it("posts outcome=failure with a reason when the executor exits non-zero", async () => {
    writeFileSync(join(ws, "PLANNING.md"), "---\nmodel: m\n---\nbody");
    const posted: any[] = [];
    process.env.RUNNER_CALLBACK_URL = "http://orch";
    process.env.RUN_TOKEN = "tok";
    const fakeFetch = async (_u: string, init: any) => {
      posted.push(JSON.parse(init.body));
      return { ok: true, text: async () => "" } as any;
    };
    const result = await runPlanning({
      workspaceDir: ws,
      executor: () => ({ status: 1, stdout: "", stderr: "boom" }),
      fetchImpl: fakeFetch as any,
    });
    expect(result.exitCode).toBe(1);
    expect(posted[0]).toMatchObject({ phase: "planning", outcome: "failure" });
  });

  it("uses built-in prompt when PLANNING.md is absent", async () => {
    let capturedPrompt = "";
    const fakeExecutor = (prompt: string) => {
      capturedPrompt = prompt;
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = await runPlanning({ workspaceDir: ws, executor: fakeExecutor });
    expect(result.exitCode).toBe(0);
    expect(capturedPrompt).toContain("ENG-42");
    expect(capturedPrompt).toContain("Add widget");
  });

  it("CLAUDE_MODEL env overrides PLANNING.md model", async () => {
    writeFileSync(join(ws, "PLANNING.md"), "---\nmodel: claude-x\n---\nbody");
    process.env.CLAUDE_MODEL = "claude-override";
    let capturedArgs: string[] = [];
    const fakeExecutor = (_prompt: string, args: string[]) => {
      capturedArgs = args;
      return { status: 0, stdout: "", stderr: "" };
    };
    await runPlanning({ workspaceDir: ws, executor: fakeExecutor });
    expect(capturedArgs.join(" ")).toContain("--model claude-override");
  });
});
