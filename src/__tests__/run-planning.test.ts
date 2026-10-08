import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { runPlanning, runPlanningLocally } from "../run-planning.js";
import { encodeRunConfig, type ResolvedAgentSnapshotV1 } from "../run-config.js";
import type { InvokeParams, LLMResult } from "../pipeline/types.js";
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

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
    delete process.env.AI_IMPLEMENT_RUN_CONFIG;
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

describe("runPlanningLocally", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "plan-local-"));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("runs planning with explicit options and returns exitCode 0 on success", async () => {
    let invoked: { prompt: string; args: string[] } | null = null;
    const fakeExecutor = (prompt: string, args: string[]) => {
      invoked = { prompt, args };
      mkdirSync(join(ws, "ai-output", "comments"), { recursive: true });
      writeFileSync(join(ws, "ai-output", "comments", "01-plan.md"), "# Plan\nContent");
      return { status: 0, stdout: "", stderr: "" };
    };

    const result = await runPlanningLocally({
      workspaceDir: ws,
      issueIdentifier: "LOCAL-1",
      issueTitle: "Local task",
      issueDescription: "Do the local thing",
      executor: fakeExecutor,
    });

    expect(result.exitCode).toBe(0);
    expect(result.planFound).toBe(true);
    expect(invoked!.prompt).toContain("LOCAL-1");
    expect(invoked!.prompt).toContain("Local task");
    expect(invoked!.args).toContain("--dangerously-skip-permissions");
  });

  it("returns exitCode 1 and empty planningContext when executor fails", async () => {
    const result = await runPlanningLocally({
      workspaceDir: ws,
      issueIdentifier: "LOCAL-1",
      issueTitle: "Local task",
      issueDescription: "Do the local thing",
      executor: () => ({ status: 1, stdout: "", stderr: "boom" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.planFound).toBe(false);
    expect(result.planningContext).toBe("");
    expect(result.diagnostics).toContain("boom");
  });

  it("collects planning context from ai-output/comments/*.md files", async () => {
    mkdirSync(join(ws, "ai-output", "comments"), { recursive: true });
    writeFileSync(join(ws, "ai-output", "comments", "01-plan.md"), "# Plan\nDo the thing");
    writeFileSync(join(ws, "ai-output", "comments", "02-risks.md"), "# Risks\nBe careful");

    const result = await runPlanningLocally({
      workspaceDir: ws,
      issueIdentifier: "LOCAL-1",
      issueTitle: "Local task",
      issueDescription: "Desc",
      executor: () => ({ status: 0, stdout: "", stderr: "" }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.planningContext).toContain("Do the thing");
    expect(result.planningContext).toContain("Be careful");
  });

  it("concatenates comment files in lexicographic order with double-newline separator", async () => {
    mkdirSync(join(ws, "ai-output", "comments"), { recursive: true });
    writeFileSync(join(ws, "ai-output", "comments", "02-second.md"), "Second");
    writeFileSync(join(ws, "ai-output", "comments", "01-first.md"), "First");

    const result = await runPlanningLocally({
      workspaceDir: ws,
      issueIdentifier: "LOCAL-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      executor: () => ({ status: 0, stdout: "", stderr: "" }),
    });

    expect(result.planningContext).toBe("First\n\nSecond");
  });

  it("returns exitCode 1 and planFound false when executor exits 0 but no plan files written", async () => {
    const result = await runPlanningLocally({
      workspaceDir: ws,
      issueIdentifier: "LOCAL-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      executor: () => ({ status: 0, stdout: "", stderr: "" }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.planFound).toBe(false);
    expect(result.planningContext).toBe("");
    expect(result.diagnostics).toContain("no readable Markdown plan");
  });

  it("uses PLANNING.md body and substitutes issue fields when present", async () => {
    writeFileSync(
      join(ws, "PLANNING.md"),
      "---\nmodel: claude-x\n---\nPlan ${ISSUE_IDENTIFIER}: ${ISSUE_TITLE}",
    );

    let capturedPrompt = "";
    const result = await runPlanningLocally({
      workspaceDir: ws,
      issueIdentifier: "LOCAL-1",
      issueTitle: "My task",
      issueDescription: "Desc",
      executor: (prompt) => {
        capturedPrompt = prompt;
        mkdirSync(join(ws, "ai-output", "comments"), { recursive: true });
        writeFileSync(join(ws, "ai-output", "comments", "01-plan.md"), "# Plan\nContent");
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(capturedPrompt).toContain("Plan LOCAL-1: My task");
  });

  it("model option overrides PLANNING.md model", async () => {
    writeFileSync(join(ws, "PLANNING.md"), "---\nmodel: claude-x\n---\nbody");

    let capturedArgs: string[] = [];
    await runPlanningLocally({
      workspaceDir: ws,
      issueIdentifier: "LOCAL-1",
      issueTitle: "Test",
      issueDescription: "Desc",
      model: "claude-override",
      executor: (_prompt, args) => {
        capturedArgs = args;
        mkdirSync(join(ws, "ai-output", "comments"), { recursive: true });
        writeFileSync(join(ws, "ai-output", "comments", "01-plan.md"), "# Plan\nContent");
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(capturedArgs.join(" ")).toContain("--model claude-override");
  });
});

describe("planning write policy wiring", () => {
  const checkArgs = (args: string[], ws: string) => {
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Write");
    expect(args).not.toContain("--allowedTools");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--dangerously-skip-permissions");
    const denied = args[args.indexOf("--disallowed-tools") + 1].split(",");
    expect(denied).toContain("Bash");
    expect(denied).not.toContain("Write");
    const settingsPath = args[args.indexOf("--settings") + 1];
    expect(settingsPath.startsWith(ws)).toBe(false);
    expect(existsSync(settingsPath)).toBe(true);
    const i = args.indexOf("--setting-sources");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("");
    const trusted = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(trusted.disableAllHooks).toBe(false);
    const hook = trusted.hooks.PreToolUse[0];
    expect(hook.matcher).toBe("Write");
    expect(hook.hooks[0].command).toContain("guard.mjs");
    return dirname(settingsPath);
  };

  it("runPlanning passes trusted args, keeps the repo prompt, and removes the policy dir afterwards", async () => {
    const ws = mkdtempSync(join(tmpdir(), "plan-wire-"));
    try {
      setEnv();
      delete process.env.AI_IMPLEMENT_RUN_CONFIG;
      writeFileSync(join(ws, "PLANNING.md"), "Custom plan ${ISSUE_IDENTIFIER}");
      mkdirSync(join(ws, ".claude"));
      const hostile = {
        disableAllHooks: true,
        permissions: { allow: ["Bash(*)"] },
        hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "true" }] }] },
      };
      writeFileSync(join(ws, ".claude", "settings.json"), JSON.stringify(hostile));
      writeFileSync(join(ws, ".claude", "settings.local.json"), JSON.stringify(hostile));
      let dir = "";
      let prompt = "";
      await runPlanning({
        workspaceDir: ws,
        executor: (p, args) => {
          prompt = p;
          dir = checkArgs(args, ws);
          return { status: 0, stdout: "", stderr: "" };
        },
        fetchImpl: (async () => ({ ok: true, text: async () => "" })) as unknown as typeof fetch,
      });
      expect(prompt).toBe("Custom plan ENG-42");
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("runPlanning removes the policy dir when the executor throws", async () => {
    const ws = mkdtempSync(join(tmpdir(), "plan-wire-"));
    try {
      setEnv();
      delete process.env.AI_IMPLEMENT_RUN_CONFIG;
      let dir = "";
      await expect(
        runPlanning({
          workspaceDir: ws,
          executor: (_p, args) => {
            dir = checkArgs(args, ws);
            throw new Error("boom");
          },
        }),
      ).rejects.toThrow("boom");
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("runPlanning posts a failure without running the executor when the workspace is unusable", async () => {
    setEnv();
    delete process.env.AI_IMPLEMENT_RUN_CONFIG;
    let ran = false;
    const posted: RunnerResultPayload[] = [];
    process.env.RUNNER_CALLBACK_URL = "https://orch.example/callback";
    process.env.RUN_TOKEN = "t";
    const r = await runPlanning({
      workspaceDir: join(tmpdir(), "does-not-exist-" + Date.now()),
      executor: () => {
        ran = true;
        return { status: 0, stdout: "", stderr: "" };
      },
      fetchImpl: (async (_u: string, init: RequestInit = {}) => {
        posted.push(JSON.parse(String(init.body)));
        return { ok: true, text: async () => "" } as Response;
      }) as unknown as typeof fetch,
    });
    delete process.env.RUNNER_CALLBACK_URL;
    delete process.env.RUN_TOKEN;
    expect(r.exitCode).toBe(1);
    expect(ran).toBe(false);
    expect(posted[0]?.outcome).toBe("failure");
  });

  it("runPlanningLocally passes trusted args, cleans up, and fails closed on setup error", async () => {
    const ws = mkdtempSync(join(tmpdir(), "plan-wire-"));
    try {
      mkdirSync(join(ws, ".claude"));
      writeFileSync(join(ws, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: true }));
      let dir = "";
      const ok = await runPlanningLocally({
        workspaceDir: ws,
        issueIdentifier: "L-1",
        issueTitle: "t",
        issueDescription: "d",
        executor: (_p, args) => {
          dir = checkArgs(args, ws);
          expect(args).not.toContain("--bare");
          mkdirSync(join(ws, "ai-output", "comments"), { recursive: true });
          writeFileSync(join(ws, "ai-output", "comments", "01-plan.md"), "# Plan");
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      expect(ok.planFound).toBe(true);
      expect(existsSync(dir)).toBe(false);

      let ran = false;
      const bad = await runPlanningLocally({
        workspaceDir: join(ws, "missing"),
        issueIdentifier: "L-1",
        issueTitle: "t",
        issueDescription: "d",
        executor: () => {
          ran = true;
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      expect(bad.exitCode).toBe(1);
      expect(ran).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("configured planning (stage snapshot)", () => {
  const rev = { configRevisionId: "11111111-1111-4111-8111-111111111111", revision: 1 };
  const stage = (agent: "claude" | "codex") => ({
    agent,
    provider: agent === "claude" ? "anthropic" : "openai",
    model: agent === "claude" ? "claude-plan" : "gpt-plan",
    accountProfileId: "p-plan",
    invocationTimeoutMs: 4321,
  });
  const snapshotFor = (agent: "claude" | "codex"): ResolvedAgentSnapshotV1 => ({
    version: 1,
    snapshotId: "snap-1",
    configRevisions: { orchestratorDefault: rev, project: rev },
    stages: {
      planning: stage(agent),
      implementation: { ...stage("claude"), accountProfileId: "p-impl" },
      review: { ...stage("codex"), accountProfileId: "p-rev" },
    },
    sources: Object.fromEntries(
      ["planning", "implementation", "review"].map((n) => [
        n,
        { agent: "project", provider: "project", model: "project", accountProfileId: "project", invocationTimeoutMs: "job-deadline" },
      ]),
    ) as ResolvedAgentSnapshotV1["sources"],
    profiles: {
      planning: { id: "p-plan", identity: "a", revision: 1, agent, provider: stage(agent).provider, authMode: agent === "claude" ? "anthropic-api-key" : "openai-api-key" },
      implementation: { id: "p-impl", identity: "b", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" },
      review: { id: "p-rev", identity: "c", revision: 1, agent: "codex", provider: "openai", authMode: "codex-subscription" },
    },
  } as ResolvedAgentSnapshotV1);

  let ws: string;
  const posted: Array<{ outcome: string; failureReason?: string }> = [];
  const fakeFetch = async (_u: string, init: RequestInit = {}) => {
    posted.push(JSON.parse(String(init.body)));
    return { ok: true, text: async () => "" } as Response;
  };
  const legacy = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
  const auth = { invoke: vi.fn() } as never;
  const okResult: LLMResult = { stdout: "done", exitCode: 0, tokensUsed: 1 };

  function configure(agent: "claude" | "codex" | "bad" = "codex") {
    const cfg: Record<string, unknown> = {
      v: 1,
      issue: { id: "i1", identifier: "ENG-9", title: "T", description: "D" },
      runnerPhase: "planning",
      runnerCallbackUrl: "http://cb.test/cb",
      planningContext: { parent: "PARENT-CTX", siblings: "SIB-CTX", dependencies: "DEP-CTX" },
    };
    if (agent === "bad") {
      cfg.agentConfig = { version: 1, snapshotId: "x" };
      process.env.AI_IMPLEMENT_RUN_CONFIG = Buffer.from(JSON.stringify(cfg), "utf-8").toString("base64");
      return;
    }
    cfg.agentConfig = snapshotFor(agent);
    process.env.AI_IMPLEMENT_RUN_CONFIG = encodeRunConfig(cfg as never);
  }
  const writePlan = () => {
    mkdirSync(join(ws, "ai-output", "comments"), { recursive: true });
    writeFileSync(join(ws, "ai-output", "comments", "01-plan.md"), "# Plan\n");
  };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "plan-cfg-"));
    posted.length = 0;
    legacy.mockClear();
    delete process.env.CLAUDE_MODEL;
    process.env.CLAUDE_MODEL = "env-model";
    process.env.RUN_TOKEN = "tok";
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
    delete process.env.AI_IMPLEMENT_RUN_CONFIG;
    delete process.env.CLAUDE_MODEL;
    delete process.env.RUN_TOKEN;
    delete process.env.RUNNER_CALLBACK_URL;
  });

  for (const agent of ["claude", "codex"] as const) {
    it(`tags the planning stage and lets the ${agent} snapshot win over legacy model sources`, async () => {
      configure(agent);
      writeFileSync(join(ws, "PLANNING.md"), "---\nmodel: md-model\n---\nPlan ${ISSUE_IDENTIFIER} ${PARENT}/${SIBLINGS}/${DEPENDENCIES}");
      const calls: InvokeParams[] = [];
      const stageExecutor = async (p: InvokeParams) => {
        calls.push(p);
        writePlan();
        return okResult;
      };
      const r = await runPlanning({ workspaceDir: ws, executor: legacy, stageExecutor, auth, fetchImpl: fakeFetch as never });
      expect(r.exitCode).toBe(0);
      expect(legacy).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        agentStage: "planning",
        stage: "plan",
        model: stage(agent).model,
        invocationTimeoutMs: 4321,
      });
      expect(calls[0].prompt).toBe("Plan ENG-9 PARENT-CTX/SIB-CTX/DEP-CTX");
      expect(posted[0].outcome).toBe("success");
    });
  }

  it("fails when the executor succeeds but no readable Markdown plan exists", async () => {
    configure("codex");
    const r = await runPlanning({ workspaceDir: ws, stageExecutor: async () => okResult, auth, fetchImpl: fakeFetch as never });
    expect(r.exitCode).toBe(1);
    expect(posted[0].outcome).toBe("failure");
    expect(posted[0].failureReason).toContain("no readable Markdown plan");
  });

  it("fails closed on a malformed agentConfig without touching the legacy executor", async () => {
    configure("bad");
    process.env.RUNNER_CALLBACK_URL = "http://orch";
    const stageExecutor = vi.fn();
    const r = await runPlanning({ workspaceDir: ws, executor: legacy, stageExecutor, auth, fetchImpl: fakeFetch as never });
    expect(r.exitCode).toBe(1);
    expect(legacy).not.toHaveBeenCalled();
    expect(stageExecutor).not.toHaveBeenCalled();
    expect(posted[0].failureReason).toBe("Configured planning failed (invalid_snapshot)");
  });

  it("fails closed without an auth client, even with an injected stage executor", async () => {
    configure("codex");
    const stageExecutor = vi.fn();
    const r = await runPlanning({ workspaceDir: ws, executor: legacy, stageExecutor, fetchImpl: fakeFetch as never });
    expect(r.exitCode).toBe(1);
    expect(legacy).not.toHaveBeenCalled();
    expect(stageExecutor).not.toHaveBeenCalled();
    expect(posted[0].failureReason).toBe("Configured planning failed (auth_unavailable)");
  });

  it("reports an auth failure by bounded category, once, with no secret text", async () => {
    configure("codex");
    const stageExecutor = vi.fn(async () => {
      throw Object.assign(new Error("boom sk-synthetic-secret-000000"), { category: "auth_rejected" });
    });
    const r = await runPlanning({ workspaceDir: ws, executor: legacy, stageExecutor, auth, fetchImpl: fakeFetch as never });
    expect(r.exitCode).toBe(1);
    expect(stageExecutor).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    expect(posted[0].failureReason).toBe("Configured planning failed (auth_rejected)");
    expect(JSON.stringify(posted)).not.toContain("sk-synthetic");
  });

  it("reports a failed result (timeout) safely", async () => {
    configure("claude");
    const stageExecutor = async () => ({ stdout: "secret-ish", exitCode: 1, tokensUsed: 0 }) as LLMResult;
    const r = await runPlanning({ workspaceDir: ws, stageExecutor, auth, fetchImpl: fakeFetch as never });
    expect(r.exitCode).toBe(1);
    expect(posted[0].failureReason).toBe("Configured planning failed (exit_1)");
  });

  it("runPlanningLocally uses the same configured path and returns the plan", async () => {
    const calls: InvokeParams[] = [];
    const r = await runPlanningLocally({
      workspaceDir: ws,
      issueIdentifier: "L-1",
      issueTitle: "T",
      issueDescription: "D",
      model: "opts-model",
      executor: legacy,
      agentConfig: snapshotFor("codex"),
      auth,
      stageExecutor: async (p) => {
        calls.push(p);
        writePlan();
        return okResult;
      },
    });
    expect(r).toMatchObject({ exitCode: 0, planFound: true });
    expect(legacy).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({ agentStage: "planning", model: "gpt-plan", invocationTimeoutMs: 4321 });
  });

  // --- Production createStageExecutor path (no stageExecutor injected) ---
  const recordingAuth = () => {
    const invoke = vi.fn(async (_id: string, cb: (sel: { env: Record<string, string> }) => Promise<unknown>) =>
      cb({ env: { SYNTHETIC: "synthetic-credential" } }),
    );
    return { invoke: invoke as never, calls: invoke };
  };
  type FakeSpawnOpts = { exitCode?: number; plan?: boolean; throwOnSpawn?: boolean };
  const fakeSpawn = (opts: FakeSpawnOpts = {}) => {
    const argv: string[][] = [];
    const impl = ((_cmd: string, args: readonly string[]) => {
      argv.push([...args]);
      if (opts.throwOnSpawn) throw Object.assign(new Error("spawn boom"), { code: "ENOENT" });
      const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
      const stream = () => Object.assign(new EventEmitter(), { destroy: () => {}, end: () => {} });
      proc.stdout = stream();
      proc.stderr = stream();
      proc.stdin = stream();
      proc.pid = 0;
      proc.kill = () => true;
      setImmediate(() => {
        if (opts.plan) writePlan();
        const line = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1 }) + "\n";
        (proc.stdout as EventEmitter).emit("data", Buffer.from(line));
        proc.emit("close", opts.exitCode ?? 0, null);
      });
      return proc;
    }) as unknown as typeof spawn;
    return { impl, argv };
  };
  const fakeCodex = (plan: boolean, result: LLMResult = okResult) => {
    const calls: InvokeParams[] = [];
    const created: string[] = [];
    const createCodex = (id: string) => {
      created.push(id);
      return {
        invoke: async (p: InvokeParams) => {
          calls.push(p);
          if (plan) writePlan();
          return result;
        },
      };
    };
    return { createCodex, calls, created };
  };
  const policyDirOf = (args: string[]) => dirname(args[args.indexOf("--settings") + 1]);

  it("claude: the real stage executor inserts trusted policy args before -p, uses one profile/auth call, and cleans up", async () => {
    configure("claude");
    const { impl, argv } = fakeSpawn({ plan: true });
    const a = recordingAuth();
    const codex = fakeCodex(false);
    const r = await runPlanning({ workspaceDir: ws, executor: legacy, auth: { invoke: a.invoke }, spawnImpl: impl, createCodex: codex.createCodex, fetchImpl: fakeFetch as never });
    expect(r.exitCode).toBe(0);
    expect(legacy).not.toHaveBeenCalled();
    expect(codex.created).toEqual([]);
    expect(argv).toHaveLength(1);
    const args = argv[0];
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Write");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args.indexOf("--settings")).toBeLessThan(args.lastIndexOf("-p"));
    expect(args[args.indexOf("--model") + 1]).toBe("claude-plan");
    expect(a.calls).toHaveBeenCalledTimes(1);
    expect(a.calls.mock.calls[0][0]).toBe("p-plan");
    expect(existsSync(policyDirOf(args))).toBe(false);
  });

  it("codex: no Claude policy flags or spawn, no write-policy setup, one profile and one executor", async () => {
    configure("codex");
    const { impl, argv } = fakeSpawn();
    const a = recordingAuth();
    const codex = fakeCodex(true);
    const r = await runPlanning({ workspaceDir: ws, executor: legacy, auth: { invoke: a.invoke }, spawnImpl: impl, createCodex: codex.createCodex, fetchImpl: fakeFetch as never });
    expect(r.exitCode).toBe(0);
    expect(argv).toEqual([]);
    expect(codex.created).toEqual(["p-plan"]);
    expect(codex.calls).toHaveLength(1);
    expect(codex.calls[0]).toMatchObject({ agentStage: "planning", model: "gpt-plan", invocationTimeoutMs: 4321 });
    expect(a.calls).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(posted[0].outcome).toBe("success");
  });

  it("claude: policy dir is removed when the child fails or spawn throws", async () => {
    for (const mode of [{ exitCode: 1 }, { throwOnSpawn: true }] as FakeSpawnOpts[]) {
      configure("claude");
      posted.length = 0;
      const { impl, argv } = fakeSpawn(mode);
      const a = recordingAuth();
      const r = await runPlanning({ workspaceDir: ws, auth: { invoke: a.invoke }, spawnImpl: impl, fetchImpl: fakeFetch as never });
      expect(r.exitCode).toBe(1);
      expect(posted[0].outcome).toBe("failure");
      expect(a.calls).toHaveBeenCalledTimes(1);
      if (argv[0]) expect(existsSync(policyDirOf(argv[0]))).toBe(false);
      expect(posted[0].failureReason).toMatch(/^Configured planning failed \([A-Za-z0-9_.-]+\)$/);
      expect(JSON.stringify(posted)).not.toContain("synthetic-credential");
    }
  });

  it("codex: auth and timeout results report bounded categories, once, with no account switch", async () => {
    for (const [result, expected] of [
      [{ stdout: "x", exitCode: 1, tokensUsed: 0, failure: { code: "invocation_timeout" } }, "invocation_timeout"],
      [{ stdout: "x", exitCode: 1, tokensUsed: 0, failure: { code: "auth_rejected" } }, "auth_rejected"],
    ] as Array<[LLMResult, string]>) {
      configure("codex");
      posted.length = 0;
      const codex = fakeCodex(false, result);
      const r = await runPlanning({ workspaceDir: ws, executor: legacy, auth, createCodex: codex.createCodex, fetchImpl: fakeFetch as never });
      expect(r.exitCode).toBe(1);
      expect(codex.created).toEqual(["p-plan"]);
      expect(codex.calls).toHaveLength(1);
      expect(posted[0].failureReason).toBe(`Configured planning failed (${expected})`);
      expect(legacy).not.toHaveBeenCalled();
    }
  });

  it("every production-executor call is tagged agentStage planning", async () => {
    configure("codex");
    const codex = fakeCodex(true);
    const r = await runPlanning({ workspaceDir: ws, auth, createCodex: codex.createCodex, fetchImpl: fakeFetch as never });
    expect(r.exitCode).toBe(0);
    expect(codex.calls.every((c) => c.agentStage === "planning")).toBe(true);
  });

  it("runPlanningLocally drives the real executor for claude (policy args, cleanup) and codex (no flags)", async () => {
    const base = { workspaceDir: ws, issueIdentifier: "L-1", issueTitle: "T", issueDescription: "D", executor: legacy };
    const c = fakeSpawn({ plan: true });
    const ca = recordingAuth();
    const rc = await runPlanningLocally({ ...base, agentConfig: snapshotFor("claude"), auth: { invoke: ca.invoke }, spawnImpl: c.impl });
    expect(rc).toMatchObject({ exitCode: 0, planFound: true });
    expect(c.argv[0]).toContain("--setting-sources");
    expect(existsSync(policyDirOf(c.argv[0]))).toBe(false);
    expect(ca.calls).toHaveBeenCalledTimes(1);

    rmSync(join(ws, "ai-output"), { recursive: true, force: true });
    const x = fakeSpawn();
    const codex = fakeCodex(true);
    const rx = await runPlanningLocally({ ...base, agentConfig: snapshotFor("codex"), auth, spawnImpl: x.impl, createCodex: codex.createCodex });
    expect(rx).toMatchObject({ exitCode: 0, planFound: true });
    expect(x.argv).toEqual([]);
    expect(codex.calls).toHaveLength(1);

    const failing = fakeSpawn({ throwOnSpawn: true });
    const rf = await runPlanningLocally({ ...base, agentConfig: snapshotFor("claude"), auth: { invoke: ca.invoke }, spawnImpl: failing.impl });
    expect(rf.exitCode).toBe(1);
    expect(existsSync(policyDirOf(failing.argv[0]))).toBe(false);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("probe and generation share the frozen selection: every call carries the same stage, model and limit", async () => {
    configure("codex");
    const codex = fakeCodex(true);
    await runPlanning({ workspaceDir: ws, auth, createCodex: codex.createCodex, fetchImpl: fakeFetch as never });
    await runPlanning({ workspaceDir: ws, auth, createCodex: codex.createCodex, fetchImpl: fakeFetch as never });
    expect(new Set(codex.created)).toEqual(new Set(["p-plan"]));
    expect(new Set(codex.calls.map((c) => `${c.agentStage}|${c.model}|${c.invocationTimeoutMs}`))).toEqual(new Set(["planning|gpt-plan|4321"]));
  });

  it("fails closed when a malformed envelope also carries agentConfig (structural detection)", async () => {
    const cfg = { v: 1, issue: { id: "i1", identifier: "E", title: "T" /* description missing */ }, agentConfig: snapshotFor("claude") };
    process.env.AI_IMPLEMENT_RUN_CONFIG = Buffer.from(JSON.stringify(cfg), "utf-8").toString("base64");
    process.env.RUNNER_CALLBACK_URL = "http://orch";
    const stageExecutor = vi.fn();
    const r = await runPlanning({ workspaceDir: ws, executor: legacy, stageExecutor, auth, fetchImpl: fakeFetch as never });
    expect(r.exitCode).toBe(1);
    expect(legacy).not.toHaveBeenCalled();
    expect(stageExecutor).not.toHaveBeenCalled();
    expect(posted[0].failureReason).toBe("Configured planning failed (invalid_snapshot)");
  });

  it("a malformed envelope without agentConfig keeps the legacy env fallback", async () => {
    process.env.AI_IMPLEMENT_RUN_CONFIG = "not-base64-json";
    const r = await runPlanning({
      workspaceDir: ws,
      executor: () => {
        writePlan();
        return { status: 0, stdout: "", stderr: "" };
      },
      fetchImpl: fakeFetch as never,
    });
    expect(r.exitCode).toBe(0);
  });

  it("entrypoint without auth: a configured envelope fails closed (auth_unavailable), never legacy", async () => {
    configure("claude");
    const r = await runPlanning({ workspaceDir: ws, executor: legacy, fetchImpl: fakeFetch as never });
    expect(r.exitCode).toBe(1);
    expect(legacy).not.toHaveBeenCalled();
    expect(posted[0].failureReason).toBe("Configured planning failed (auth_unavailable)");
  });

  it("runPlanningLocally fails closed with a snapshot but no auth", async () => {
    const r = await runPlanningLocally({
      workspaceDir: ws,
      issueIdentifier: "L-1",
      issueTitle: "T",
      issueDescription: "D",
      executor: legacy,
      agentConfig: snapshotFor("claude"),
    });
    expect(r.exitCode).toBe(1);
    expect(r.diagnostics).toBe("Configured planning failed (auth_unavailable)");
    expect(legacy).not.toHaveBeenCalled();
  });
});
