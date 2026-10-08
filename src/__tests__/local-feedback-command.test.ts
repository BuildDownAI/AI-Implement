import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The local feedback command is a Node ESM script with pure helper exports.
// @ts-ignore no declaration file for the repo-local .mjs command module
const localFeedbackCommand = await import("../../scripts/local-feedback.mjs");
const {
  assertSafeEnvironment,
  createSourceContext,
  buildDevHarnessArgs,
  buildLocalFeedbackOptions,
  buildSyntheticAgentConfig,
  gateMarkerPath,
  parseArgs,
  parseGitHubProjectKey,
  pathAbsent,
  makeCliDeps,
  resolveSourceIdentity,
  runScenarioFinally,
  subscriptionUnknownProof,
  summarizeResult,
} = localFeedbackCommand;

const tempRoots: string[] = [];

function tempDir(name: string) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  tempRoots.push(root);
  return root;
}

function runGit(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local feedback command helpers", () => {
  it("parses synthetic and live modes with the expected gate rules", () => {
    expect(parseArgs([])).toMatchObject({ live: false, rebuild: false });
    expect(parseArgs(["--rebuild", "--artifacts-dir", "/tmp/out"])).toMatchObject({
      rebuild: true,
      artifactsDir: "/tmp/out",
    });
    expect(() => parseArgs(["--scenario", "success"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--agent-config", "cfg.json"])).toThrow(/only valid with --live/);
    expect(() => parseArgs(["--live", "--agent-config", "cfg.json"])).toThrow(/requires --agent-config, --workspace, and --task/);
    expect(parseArgs(["--live", "--agent-config", "cfg.json", "--workspace", "repo", "--task", "task.md"])).toMatchObject({
      live: true,
      agentConfig: "cfg.json",
      workspace: "repo",
      task: "task.md",
    });
  });

  it("rejects credential and preload collisions while allowing inherited Codex app metadata", () => {
    expect(assertSafeEnvironment({ PATH: "/bin", CODEX_HOME: "/active/codex", CODEX_SESSION_ID: "metadata" }, "synthetic")).toBe(true);
    expect(() => assertSafeEnvironment({ PATH: "/bin", OPENAI_BASE_URL: "http://ambient.invalid" }, "synthetic")).toThrow(/OPENAI_BASE_URL/);
    expect(() => assertSafeEnvironment({ PATH: "/bin", AI_IMPLEMENT_MODEL_AUTH_TOKEN: "secret" }, "synthetic")).toThrow(/AI_IMPLEMENT_MODEL_AUTH_TOKEN/);
    expect(() => assertSafeEnvironment({ PATH: "/bin", NODE_OPTIONS: "--require ./preload.js" }, "synthetic")).toThrow(/NODE_OPTIONS/);
  });

  it("keeps the live gate marker outside the checkout", () => {
    const marker = gateMarkerPath("/tmp/example-checkout");
    expect(marker).toContain(tmpdir());
    expect(marker).toContain("bd-local-feedback-gates");
    expect(marker).not.toContain("/tmp/example-checkout/.local-feedback-gate.json");
  });


  it("parses only exact GitHub origins for live project keys", () => {
    expect(parseGitHubProjectKey("git@github.com:BuildDownAI/AI-Implement.git")).toBe("BuildDownAI/AI-Implement");
    expect(parseGitHubProjectKey("https://github.com/BuildDownAI/repo.with.dots.git")).toBe("BuildDownAI/repo.with.dots");
    expect(parseGitHubProjectKey("https://evilgithub.com/BuildDownAI/AI-Implement.git")).toBeNull();
    expect(parseGitHubProjectKey("https://github.com/BuildDownAI/AI-Implement/extra.git")).toBeNull();
  });

  it("builds local feedback options and dev-harness args for a full copy-mode configured run", () => {
    expect(buildLocalFeedbackOptions({ providerPort: 8080, bridgePort: 8090, networkName: "bd-local-feedback-net", hostGateway: "172.18.0.2" })).toEqual({
      providerPort: 8080,
      bridgePort: 8090,
      networkName: "bd-local-feedback-net",
      hostGateway: "172.18.0.2",
    });
    expect(buildDevHarnessArgs({ workspace: "/repo", task: "/task.md", imageId: "sha256:image", agentConfig: "/cfg.json" })).toEqual([
      "--workspace", "/repo",
      "--task", "/task.md",
      "--phase", "full",
      "--workspace-mode", "copy",
      "--image", "sha256:image",
      "--agent-config", "/cfg.json",
    ]);
  });

  it("writes a three-stage synthetic local config with private key paths under the requested private root", () => {
    const privateRoot = tempDir("lf-private");
    const { configPath, config, profileIds } = buildSyntheticAgentConfig({ root: privateRoot });
    expect(configPath.startsWith(privateRoot)).toBe(true);
    expect(profileIds).toEqual(["local-feedback-planning", "local-feedback-implementation", "local-feedback-review"]);
    expect(Object.keys(config.stages)).toEqual(["planning", "implementation", "review"]);
    expect(config.stages.planning.model).toBe("gpt-local-planning");
    expect(config.stages.implementation.invocationTimeoutMs).toBeGreaterThan(config.stages.review.invocationTimeoutMs);
    for (const profile of config.profiles) {
      expect(profile.credentialPath.startsWith(privateRoot)).toBe(true);
      expect(readFileSync(profile.credentialPath, "utf8")).toMatch(/^sk-local-feedback-/);
    }
  });

  it("rejects untracked source that would be missing from archive plus tracked patch proof", async () => {
    const repo = tempDir("lf-source");
    await mkdir(join(repo, "represented"), { recursive: true });
    writeFileSync(join(repo, "represented", "file.txt"), "ok\n");
    const responses = new Map<string, { status: number; stdout: string; stderr: string }>([
      ["git rev-parse HEAD", { status: 0, stdout: "abc123\n", stderr: "" }],
      ["git diff --binary HEAD", { status: 0, stdout: "", stderr: "" }],
      ["git status --porcelain", { status: 0, stdout: "?? scratch.txt\n?? .local-feedback/cache.json\n", stderr: "" }],
    ]);
    const exec = (command: string, args: string[]) => responses.get(`${command} ${args.join(" ")}`) ?? { status: 1, stdout: "", stderr: "unexpected" };
    expect(() => resolveSourceIdentity(repo, exec)).toThrow(/scratch.txt/);
  });


  it("creates represented source contexts from git archive plus tracked diff without corrupting binary files", () => {
    const repo = tempDir("lf-binary-source");
    const binary = Buffer.from([0, 255, 1, 2, 128, 10, 13, 90]);
    writeFileSync(join(repo, "blob.bin"), binary);
    writeFileSync(join(repo, "text.txt"), "before\n");
    expect(runGit(repo, ["init"]).status).toBe(0);
    expect(runGit(repo, ["config", "user.email", "local-feedback@example.invalid"]).status).toBe(0);
    expect(runGit(repo, ["config", "user.name", "Local Feedback"]).status).toBe(0);
    expect(runGit(repo, ["add", "."]).status).toBe(0);
    expect(runGit(repo, ["commit", "-m", "base"]).status).toBe(0);
    writeFileSync(join(repo, "text.txt"), "after\n");
    const source = resolveSourceIdentity(repo);
    const context = createSourceContext({ repoRoot: repo, source });
    tempRoots.push(context);
    expect(readFileSync(join(context, "blob.bin"))).toEqual(binary);
    expect(readFileSync(join(context, "text.txt"), "utf8")).toBe("after\n");
  });


  it("wires and disposes process signal cancellation for wrapped CLI runs", () => {
    const signalProcess = new EventEmitter() as EventEmitter & {
      once(event: "SIGINT" | "SIGTERM", listener: () => void): EventEmitter;
      off(event: "SIGINT" | "SIGTERM", listener: () => void): EventEmitter;
    };
    const cliModule = {
      startDevRun: async () => ({ containerName: "runner", containerId: "cid", task: {}, startedAt: new Date(), artifactsDir: "/tmp/a", workspace: "/tmp/w", phase: "full" }),
      streamLogs: async () => undefined,
      streamLogsUntilShellReady: async () => ({ ready: false, exitCode: null }),
      getRunStatus: async () => ({ running: false, exitCode: 130 }),
      collectRunArtifacts: async () => undefined,
      stopDevRun: async () => undefined,
    };
    const { deps, dispose } = makeCliDeps({ cliModule, artifactsDir: "/tmp/artifacts", signalProcess });
    expect(deps.cancelSignal.aborted).toBe(false);
    signalProcess.emit("SIGTERM");
    expect(deps.cancelSignal.aborted).toBe(true);
    expect(signalProcess.listenerCount("SIGINT")).toBe(1);
    dispose();
    expect(signalProcess.listenerCount("SIGINT")).toBe(0);
    expect(signalProcess.listenerCount("SIGTERM")).toBe(0);
  });

  it("captures unknown termination hold before confirmed release retry", () => {
    expect(subscriptionUnknownProof({
      category: "termination_unconfirmed",
      heldBeforeRetry: true,
      busyCategory: "session_busy",
      releasedAfterRetry: true,
    })).toEqual({
      unknownTerminationCategory: "termination_unconfirmed",
      unknownTerminationHeldLock: true,
      unknownTerminationBlocksOtherOwner: true,
      unknownRetryConfirmedReleased: true,
    });
    expect(subscriptionUnknownProof({
      category: "termination_unconfirmed",
      heldBeforeRetry: false,
      busyCategory: "session_busy",
      releasedAfterRetry: true,
    }).unknownTerminationHeldLock).toBe(false);
  });


  it("always cleans a scenario peer even when disposer fails", async () => {
    const events: string[] = [];
    await expect(runScenarioFinally({
      dispose: async () => { events.push("dispose"); throw new Error("dispose failed"); },
      cleanup: async () => { events.push("cleanup"); },
    })).rejects.toThrow(/dispose failed/);
    expect(events).toEqual(["dispose", "cleanup"]);
  });

  it("only treats ENOENT as confirmed path absence", async () => {
    await expect(pathAbsent("/tmp/missing", async () => { const error = new Error("missing") as NodeJS.ErrnoException; error.code = "ENOENT"; throw error; })).resolves.toBe(true);
    await expect(pathAbsent("/tmp/eio", async () => { const error = new Error("io") as NodeJS.ErrnoException; error.code = "EIO"; throw error; })).resolves.toBe(false);
    await expect(pathAbsent("/tmp/present", async () => ({}))).resolves.toBe(false);
  });

  it("summarizes redacted result evidence without credential material", () => {
    const summary = summarizeResult({
      ok: true,
      mode: "synthetic",
      source: { head: "abc", trackedDiffSha256: "def" },
      image: { imageId: "sha256:123" },
      artifactsDir: "/tmp/artifacts",
      stages: { planning: { model: "gpt-local-planning", authMode: "openai-api-key" } },
      note: "Scenarios: success=ok",
    });
    expect(summary).toContain("outcome: success");
    expect(summary).toContain("gpt-local-planning");
    expect(summary).not.toContain("sk-local-feedback");
  });
});
