import * as childProcess from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testDir } from "./helpers/test-dir.js";
import { loadPipelineDefinition } from "../pipeline/pipeline-loader.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { feedbackLoopStep } from "../pipeline/steps/feedback-loop.js";
import { implementStep } from "../pipeline/steps/implement.js";
import { reviewStep } from "../pipeline/steps/review.js";
import { postPushReviewStep } from "../pipeline/steps/post-push-review.js";
import { describe, expect, it, vi } from "vitest";
import { runReviewOnly } from "../pipeline/steps/post-push-review.js";
import { makeContext } from "./helpers/builders.js";
import { NoopStepReporter } from "../pipeline/reporter.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const diff = "diff --git a/earlier.ts b/earlier.ts\n+earlier commit\ndiff --git a/package-lock.json b/package-lock.json\n+lockfile change";

describe("advisory roll-up review", () => {
  it("publishes one bounded verdict for oversized reports from multiple reviewers", async () => {
    const invoke = vi.fn(async () => ({ stdout: "", exitCode: 0, tokensUsed: 1, terminalStatus: { subtype: "success", isError: false },
      structuredOutput: { approved: false, summary: "Summary ".repeat(30_000), checks: [{ check: "Integration", result: "passed", evidence: "Reviewed diff" }],
        findings: Array.from({ length: 75 }, (_, i) => ({ severity: "blocking", path: `file-${i}.ts`, line: 7,
          body: `Finding ${i}: ` + "Detailed evidence 😀 ".repeat(2_000) })) } }));
    let body = "";
    const gh = vi.fn((args: string[]) => {
      if (args[1] === "comment") {
        expect(args[3]).toBe("--body-file");
        body = readFileSync(args[4], "utf8");
      }
      return { stdout: args[1] === "diff" ? diff : "", exitCode: 0 };
    });
    const ctx = makeContext({ prNumber: "42", reviewOnly: { reviewers: [
      { id: "integration-review", gates: true }, { id: "code-review", gates: true },
    ] } }, { invoke });
    await runReviewOnly(ctx, "/unused", new NoopStepReporter(), gh);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(gh.mock.calls.filter(([args]) => args[1] === "comment")).toHaveLength(1);
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body).toContain("Roll-up review: Changes recommended");
    expect(body).toContain("**blocking** file-0.ts:7 — Finding 0:");
    expect(body).toContain("[truncated]");
    expect(body).toContain("50 additional findings omitted");
  });

  it("reports diff buffer overflow without reviewing partial output", async () => {
    const invoke = vi.fn();
    let body = "";
    const realSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawnSync;
    const spawn = vi.mocked(childProcess.spawnSync).mockImplementation(((_command: string, args: string[]) => {
      if (args[1] === "diff") return { status: null, stdout: Buffer.from("partial diff"),
        stderr: Buffer.from(""), error: new Error("spawnSync gh ENOBUFS") };
      body = readFileSync(args[4], "utf8");
      return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
    }) as typeof childProcess.spawnSync);
    try {
      const ctx = makeContext({ prNumber: "42", reviewOnly: { reviewers: [{ id: "code-review", gates: true }] } }, { invoke });
      await runReviewOnly(ctx, "/unused", new NoopStepReporter());
      expect(invoke).not.toHaveBeenCalled();
      expect(body).toContain("Review incomplete");
      expect(body).toContain("ENOBUFS");
    } finally {
      spawn.mockImplementation(realSpawn);
    }
  });

  it.each(["findings", "clean", "failure"])("runs reviewers once and posts one verdict: %s", async (kind) => {
    const invoke = vi.fn(async () => kind === "failure"
      ? { stdout: "", exitCode: 1, tokensUsed: 0, errorMessage: "reviewer unavailable" }
      : { stdout: "", exitCode: 0, tokensUsed: 1, terminalStatus: { subtype: "success", isError: false }, structuredOutput: {
        approved: kind === "clean", findings: kind === "clean" ? [] : [
          { severity: "blocking", path: "earlier.ts", line: 7, body: "Missing shared contract" },
        ], summary: "Integration checked", checks: [{ check: "Shared contract", result: "passed", evidence: "earlier.ts" }],
      } });
    let body = "";
    const gh = vi.fn((args: string[]) => {
      if (args[1] === "comment") body = readFileSync(args[4], "utf8");
      return { stdout: args[1] === "diff" ? diff : "", exitCode: 0 };
    });
    const ctx = makeContext({ prNumber: "42", reviewOnly: { reviewers: [
      { id: "integration-review", gates: true }, { id: "code-review", gates: true },
    ] } }, { invoke });
    const result = await runReviewOnly(ctx, "/unused", new NoopStepReporter(), gh);
    expect(invoke).toHaveBeenCalledTimes(2);
    for (const [params] of invoke.mock.calls as unknown as [{ prompt: string; agentStage: string; builtinTools: string[] }][]) {
      expect(params.prompt).toContain(diff);
      expect(params.agentStage).toBe("review");
      expect(params.builtinTools).toEqual(["Read", "Glob", "Grep"]);
    }
    expect(gh.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([["pr", "diff"], ["pr", "comment"]]);
    expect(existsSync(gh.mock.calls[1][0][4])).toBe(false);
    expect(body).toContain("<!-- ai-implement rollup-review -->");
    expect(body).toContain(kind === "failure" ? "Review incomplete" : kind === "clean" ? "Approved" : "Changes recommended");
    if (kind === "findings") {
      expect(body).toContain("blocking");
      expect(body).toContain("earlier.ts:7");
      expect(body).toContain("Missing shared contract");
    }
    expect(result.terminationReason).toBe(kind === "failure" ? "review_error" : "approved");
  });
});

// Exercise production routing with committed changes: a working-tree diff (or
// HEAD^ diff) would silently omit the first PR commit in this fixture.
describe("review-only pipeline integration", () => {
  it.each(["findings", "clean", "failure"])("reviews the complete clean PR once: %s", async (kind) => {
    const workspaceDir = testDir("review-only-pr");
    const realSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawnSync;
    const git = (...args: string[]) => {
      const result = realSpawn("git", args, { cwd: workspaceDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    git("init");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    writeFileSync(join(workspaceDir, "base.ts"), "export const base = true;\n");
    git("add", ".");
    git("commit", "-m", "base");
    const base = git("rev-parse", "HEAD").trim();
    writeFileSync(join(workspaceDir, "earlier.ts"), "export const earlier = true;\n");
    git("add", ".");
    git("commit", "-m", "first PR change");
    writeFileSync(join(workspaceDir, "later.ts"), "export const later = true;\n");
    writeFileSync(join(workspaceDir, "package-lock.json"), "lockfile line\n".repeat(100_000));
    git("add", ".");
    git("commit", "-m", "second PR change");
    const head = git("rev-parse", "HEAD");
    const fullDiff = git("diff", `${base}...HEAD`);
    expect(Buffer.byteLength(fullDiff)).toBeGreaterThan(1024 * 1024);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("diff", "HEAD")).toBe("");

    const commands: string[][] = [];
    const comments: string[] = [];
    const spawn = vi.mocked(childProcess.spawnSync).mockImplementation(((command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
      commands.push([command, ...args]);
      if (command === "gh") {
        if (args.join(" ") === "pr diff 42") {
          // Model GitHub's PR diff using the actual committed base and head.
          return realSpawn("git", ["diff", `${base}...HEAD`], options);
        }
        if (args.slice(0, 4).join(" ") === "pr comment 42 --body-file") {
          comments.push(readFileSync(args[4], "utf8"));
          return realSpawn("git", ["status", "--porcelain"], options);
        }
        throw new Error(`Unexpected GitHub call (polling/publication): ${args.join(" ")}`);
      }
      if (command === "git" && ["commit", "push"].includes(args[0])) {
        throw new Error(`Unexpected git mutation: ${args[0]}`);
      }
      return realSpawn(command, args, options);
    }) as typeof childProcess.spawnSync);
    const implement = vi.spyOn(implementStep, "run");
    const ordinaryReview = vi.spyOn(reviewStep, "run");
    const ordinaryPublication = vi.spyOn(postPushReviewStep, "run");
    try {
      const invoke = vi.fn(async () => kind === "failure"
        ? { stdout: "", exitCode: 1, tokensUsed: 0, errorMessage: "reviewer unavailable" }
        : { stdout: "", exitCode: 0, tokensUsed: 1, terminalStatus: { subtype: "success", isError: false }, structuredOutput: {
          approved: kind === "clean", findings: kind === "clean" ? [] : [
            { severity: "blocking", path: "earlier.ts", line: 1, body: "Missing shared contract" },
          ], summary: "Integration checked", checks: [{ check: "Shared contract", result: "passed", evidence: "earlier.ts" }],
        } });
      const ctx = makeContext({ workspaceDir, branch: git("branch", "--show-current").trim(), prNumber: "42", reviewOnly: { reviewers: [
        { id: "integration-review", gates: true }, { id: "code-review", gates: true },
      ] } }, { invoke });
      const pipeline = loadPipelineDefinition("pipelines/autonomous.yml");
      const runner = new PipelineRunner();
      // Checkout is already prepared above; all other production steps retain
      // their real loader predicates, and feedback-loop retains its real body.
      runner.register("clone", { run: async () => ({ workspaceDir }) });
      runner.register("feedback-loop", feedbackLoopStep);
      const forbidden = vi.fn(async () => { throw new Error("Unexpected non-review step"); });
      for (const step of pipeline.steps) {
        if (!["clone", "feedback-loop"].includes(step.id)) {
          runner.register(step.moduleId ?? step.type, { run: forbidden });
        }
      }
      await runner.run(pipeline, ctx, new NoopStepReporter());
      expect(forbidden).not.toHaveBeenCalled();
      expect(implement).not.toHaveBeenCalled();
      expect(ordinaryReview).not.toHaveBeenCalled();
      expect(ordinaryPublication).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledTimes(2);
      const calls = invoke.mock.calls as unknown as [{ prompt: string; stage: string; agentStage: string; builtinTools: string[] }][];
      expect(calls.map(([params]) => params.stage)).toEqual([
        "post-push-review/code-review-review-1",
        "post-push-review/integration-review-review-1",
      ]);
      for (const [params] of calls) {
        expect(params.prompt).toContain(fullDiff);
        expect(params.agentStage).toBe("review");
        expect(params.builtinTools).toEqual(["Read", "Glob", "Grep"]);
      }
      expect(commands.filter(([command]) => command === "gh").map(([, ...args]) => args.slice(0, 2)))
        .toEqual([["pr", "diff"], ["pr", "comment"]]);
      expect(commands.filter(([command, action]) => command === "git" && ["commit", "push"].includes(action))).toEqual([]);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toContain("<!-- ai-implement rollup-review -->");
      expect(comments[0]).toContain(kind === "failure" ? "Review incomplete" : kind === "clean" ? "Approved" : "Changes recommended");
      if (kind === "findings") {
        expect(comments[0]).toContain("blocking");
        expect(comments[0]).toContain("earlier.ts:1");
        expect(comments[0]).toContain("Missing shared contract");
      }
      expect(ctx.getOutputs("feedback-loop").terminationReason).toBe(kind === "failure" ? "review_error" : "approved");
      expect(git("rev-parse", "HEAD")).toBe(head);
      expect(git("status", "--porcelain")).toBe("");
    } finally {
      spawn.mockImplementation(realSpawn);
      implement.mockRestore();
      ordinaryReview.mockRestore();
      ordinaryPublication.mockRestore();
    }
  });
});
