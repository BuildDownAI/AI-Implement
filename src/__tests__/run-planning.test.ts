import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlanning } from "../run-planning.js";
import { encodeRunConfig } from "../run-config.js";

type RunnerResultPayload = {
  phase: "planning";
  outcome: "success" | "failure";
  comments: Array<{ body: string }>;
  failureReason?: string;
};

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
    delete process.env.AI_IMPLEMENT_RUN_CONFIG;
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
    const posted: RunnerResultPayload[] = [];
    const fakeFetch = async (_u: string, init: RequestInit = {}) => {
      posted.push(JSON.parse(String(init.body)) as RunnerResultPayload);
      return { ok: true, text: async () => "" } as Response;
    };
    process.env.RUNNER_CALLBACK_URL = "http://orch";
    process.env.RUN_TOKEN = "tok";

    const result = await runPlanning({
      workspaceDir: ws,
      executor: fakeExecutor,
      fetchImpl: fakeFetch,
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
    const posted: RunnerResultPayload[] = [];
    process.env.RUNNER_CALLBACK_URL = "http://orch";
    process.env.RUN_TOKEN = "tok";
    const fakeFetch = async (_u: string, init: RequestInit = {}) => {
      posted.push(JSON.parse(String(init.body)) as RunnerResultPayload);
      return { ok: true, text: async () => "" } as Response;
    };
    const result = await runPlanning({
      workspaceDir: ws,
      executor: () => ({ status: 1, stdout: "", stderr: "boom" }),
      fetchImpl: fakeFetch,
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

  it("resolves issue fields and planning context from the AI_IMPLEMENT_RUN_CONFIG envelope, ignoring legacy env", async () => {
    delete process.env.ISSUE_ID;
    delete process.env.ISSUE_IDENTIFIER;
    delete process.env.ISSUE_TITLE;
    delete process.env.ISSUE_DESCRIPTION;
    process.env.AI_IMPLEMENT_RUN_CONFIG = encodeRunConfig({
      v: 1,
      issue: { id: "e-1", identifier: "AII-9", title: "Envelope issue", description: "From envelope." },
      planningContext: { parent: "AII-1", siblings: "AII-2", dependencies: "AII-3" },
    });
    let capturedPrompt = "";
    const fakeExecutor = (prompt: string) => {
      capturedPrompt = prompt;
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = await runPlanning({ workspaceDir: ws, executor: fakeExecutor });
    expect(result.exitCode).toBe(0);
    expect(capturedPrompt).toContain("AII-9");
    expect(capturedPrompt).toContain("Envelope issue");
    expect(capturedPrompt).toContain("From envelope.");
    expect(capturedPrompt).toContain("**Parent:** AII-1");
    expect(capturedPrompt).toContain("**Siblings:** AII-2");
    expect(capturedPrompt).toContain("**Dependencies:** AII-3");
  });

  it("posts the runner-callback result using the envelope's runnerCallbackUrl when RUNNER_CALLBACK_URL is unset (GHA envelope mode)", async () => {
    delete process.env.RUNNER_CALLBACK_URL;
    process.env.RUN_TOKEN = "tok";
    process.env.AI_IMPLEMENT_RUN_CONFIG = encodeRunConfig({
      v: 1,
      issue: { id: "e-1", identifier: "AII-9", title: "Envelope issue", description: "From envelope." },
      runnerCallbackUrl: "https://orch.example/callback",
    });
    const posted: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = async (u: string, init: RequestInit = {}) => {
      posted.push({ url: u, body: JSON.parse(String(init.body)) });
      return { ok: true, text: async () => "" } as Response;
    };
    const result = await runPlanning({
      workspaceDir: ws,
      executor: () => ({ status: 0, stdout: "", stderr: "" }),
      fetchImpl: fakeFetch,
    });
    expect(result.exitCode).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("https://orch.example/callback/runner/result");
    expect(posted[0].body).toMatchObject({ phase: "planning", outcome: "success" });
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
