import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { encodeRunConfig, decodeRunConfig } from "../run-config.js";
import { buildEnvelopeDispatchInputs, buildKgRefreshGhaDispatchBody } from "../github.js";
import type { RepoMapping } from "../config.js";
import { resolveRunnerImageForDispatch, __clearRepoImageCacheForTests } from "../repo-image.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMapping(overrides: Partial<RepoMapping> = {}): RepoMapping {
  return {
    owner: "test-org",
    repo: "test-repo",
    workflowFile: "claude-implement.yml",
    defaultBranch: "main",
    maxInProgressAiIssues: 3,
    executionMode: "github-actions",
    sessionMode: "autonomous",
    machineCpus: 2,
    machineMemoryMb: 4096,
    planningEnabled: false,
    planningWorkflowFile: "",
    autoApprovePlans: true,
    extraEnv: {},
    provider: "anthropic",
    ticketingProvider: "linear",
    ticketingConfig: { kind: "linear" },
    awsRegion: null,
    paused: false,
    maxTurns: null,
    maxIterations: null,
    maxJobMinutes: null,
    branchPrefix: null,
    skillsRepo: null,
    sensitiveAddPatterns: null,
    sensitiveAllowPatterns: null,
    autoMerge: false,
    dependencyTokenScope: null,
    memoryProviderId: null,
    ...overrides,
  };
}

const baseIssue = {
  id: "issue-kg-1",
  identifier: "AII-493",
  title: "KG refresh",
  description: "Refresh the knowledge-graph snapshot",
};

// ── RunConfigV1 envelope roundtrip ────────────────────────────────────────────

describe("RunConfigV1 kg-refresh fields", () => {
  it("encodes and decodes runnerPhase kg-refresh", () => {
    const encoded = encodeRunConfig({
      v: 1,
      issue: baseIssue,
      runnerPhase: "kg-refresh",
    });
    const decoded = decodeRunConfig(encoded);
    expect(decoded.runnerPhase).toBe("kg-refresh");
  });

  it("encodes and decodes kgSourceRepo", () => {
    const encoded = encodeRunConfig({
      v: 1,
      issue: baseIssue,
      runnerPhase: "kg-refresh",
      kgSourceRepo: "BuildDownAI/knowledge-graph-ai-implement",
    });
    const decoded = decodeRunConfig(encoded);
    expect(decoded.kgSourceRepo).toBe("BuildDownAI/knowledge-graph-ai-implement");
    expect(decoded.runnerPhase).toBe("kg-refresh");
  });

  it("kgSourceRepo survives pickKnownKeys", () => {
    const encoded = encodeRunConfig({
      v: 1,
      issue: baseIssue,
      runnerPhase: "kg-refresh",
      kgSourceRepo: "org/kg-repo",
    });
    const decoded = decodeRunConfig(encoded);
    expect(decoded.kgSourceRepo).toBe("org/kg-repo");
  });

  it("kgSourceRepo is absent when not provided", () => {
    const encoded = encodeRunConfig({ v: 1, issue: baseIssue, runnerPhase: "kg-refresh" });
    const decoded = decodeRunConfig(encoded);
    expect(decoded.kgSourceRepo).toBeUndefined();
  });
});

// ── Envelope dispatch: publication token exclusion for kg-refresh ─────────────

describe("buildEnvelopeDispatchInputs — kg-refresh phase", () => {
  it("sets runnerPhase to kg-refresh inside run_config", () => {
    const inputs = buildEnvelopeDispatchInputs(makeMapping(), baseIssue, {
      runnerPhase: "kg-refresh",
      runToken: "run-tok",
    });
    const decoded = decodeRunConfig(inputs.run_config!);
    expect(decoded.runnerPhase).toBe("kg-refresh");
  });

  it("never includes a publication token for kg-refresh", () => {
    const inputs = buildEnvelopeDispatchInputs(makeMapping(), baseIssue, {
      runnerPhase: "kg-refresh",
      runToken: "run-tok",
      runPublicationToken: "must-not-leak",
    });
    expect("run_publication_token" in inputs).toBe(false);
  });
});

// ── kg-snapshot-push step ─────────────────────────────────────────────────────

import { kgSnapshotPushStep, KgSnapshotMissingError, KgSnapshotStaleError, KgSnapshotTrackerRegressionError } from "../pipeline/steps/kg-snapshot-push.js";
import { kgTrackerDataStep, KgTrackerDataFetchError, readCodeRepoFromSourcesYml, readSecondaryReposFromSourcesYml } from "../pipeline/steps/kg-tracker-data.js";
import { kgIngestStep, KgIngestError } from "../pipeline/steps/kg-ingest.js";
import { cloneSecondaryReposStep } from "../pipeline/steps/clone-secondary-repos.js";
import { modelProcessEnv } from "../pipeline/process-env.js";
import { DefaultPipelineContext } from "../pipeline/context.js";
import type { PipelineContextData } from "../pipeline/types.js";

function makeContext(overrides: Partial<PipelineContextData> = {}): DefaultPipelineContext {
  return new DefaultPipelineContext({
    jobId: 1,
    issueId: "kg-1",
    issueIdentifier: "KG-REFRESH",
    issueTitle: "KG refresh",
    issueDescription: "desc",
    nonce: "nonce",
    orchestratorUrl: "http://localhost:8080",
    ...overrides,
  });
}

const noopReporter = { report: async () => undefined };

function initGitRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name bot", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email bot@example.com", { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# KG\n");
  execSync("git add README.md", { cwd: dir, stdio: "ignore" });
  execSync("git commit -m init", { cwd: dir, stdio: "ignore" });
}

function resolveHead(dir: string): string {
  return execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
}

describe("kgSnapshotPushStep", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kgpush-"));
    // Undo mounted-workspace env if set
    delete process.env.AI_IMPLEMENT_WORKSPACE_MODE;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AI_IMPLEMENT_WORKSPACE_MODE;
  });

  function makeInputs(overrides: Record<string, unknown> = {}) {
    return {
      workspaceDir: tmpDir,
      githubToken: "fake-token",
      defaultBranch: "main",
      clonedRef: resolveHead(tmpDir),
      ...overrides,
    };
  }

  it("fails with KG_SNAPSHOT_MISSING when snapshot/parts/ is absent", async () => {
    initGitRepo(tmpDir);
    const ctx = makeContext();
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs(), noopReporter),
    ).rejects.toBeInstanceOf(KgSnapshotMissingError);
  });

  it("fails with KG_SNAPSHOT_MISSING when no .nt files exist", async () => {
    initGitRepo(tmpDir);
    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    const ctx = makeContext();
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs(), noopReporter),
    ).rejects.toBeInstanceOf(KgSnapshotMissingError);
  });

  it("fails with KG_SNAPSHOT_MISSING when embeddings.npz is absent", async () => {
    initGitRepo(tmpDir);
    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
    const ctx = makeContext();
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs(), noopReporter),
    ).rejects.toBeInstanceOf(KgSnapshotMissingError);
  });

  it("fails with KG_SNAPSHOT_MISSING when stamp file is absent", async () => {
    initGitRepo(tmpDir);
    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    const ctx = makeContext();
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs(), noopReporter),
    ).rejects.toBeInstanceOf(KgSnapshotMissingError);
  });

  it("fails with KG_SNAPSHOT_STALE when stamp equals previous stamp", async () => {
    initGitRepo(tmpDir);
    mkdirSync(join(tmpDir, "snapshot"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-01T00:00:00Z");
    execSync("git add snapshot/", { cwd: tmpDir, stdio: "ignore" });
    execSync("git commit -m 'add old stamp'", { cwd: tmpDir, stdio: "ignore" });
    const clonedRef = resolveHead(tmpDir);

    // New snapshot with same stamp
    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-01T00:00:00Z");

    const ctx = makeContext();
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter),
    ).rejects.toBeInstanceOf(KgSnapshotStaleError);
  });

  it("fails with KG_SNAPSHOT_STALE when stamp is older than previous", async () => {
    initGitRepo(tmpDir);
    mkdirSync(join(tmpDir, "snapshot"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-01T12:00:00Z");
    execSync("git add snapshot/", { cwd: tmpDir, stdio: "ignore" });
    execSync("git commit -m 'add stamp'", { cwd: tmpDir, stdio: "ignore" });
    const clonedRef = resolveHead(tmpDir);

    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-01T00:00:00Z");

    const ctx = makeContext();
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter),
    ).rejects.toBeInstanceOf(KgSnapshotStaleError);
  });

  it("accepts a new stamp when no previous stamp exists in clonedRef", async () => {
    initGitRepo(tmpDir);
    const clonedRef = resolveHead(tmpDir);

    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-03T10:00:00Z");

    const ctx = makeContext();
    // Will fail at git push (no real remote) — confirm it reaches that stage
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter),
    ).rejects.toThrow(/git push failed/);
  });

  it("fails with KG_SNAPSHOT_STALE when snapshot/ has no changes since clone", async () => {
    initGitRepo(tmpDir);
    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-03T10:00:00Z");
    execSync("git add snapshot/", { cwd: tmpDir, stdio: "ignore" });
    execSync("git commit -m 'commit snapshot'", { cwd: tmpDir, stdio: "ignore" });
    const clonedRef = resolveHead(tmpDir);

    // No changes to snapshot since clonedRef → should fail STALE at "no staged changes"
    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 5 });
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter),
    ).rejects.toBeInstanceOf(KgSnapshotStaleError);
  });

  it("includes stats in the commit message when ai-output/kg-stats.json is present", async () => {
    initGitRepo(tmpDir);
    const clonedRef = resolveHead(tmpDir);

    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-03T10:00:00Z");
    mkdirSync(join(tmpDir, "ai-output"), { recursive: true });
    writeFileSync(
      join(tmpDir, "ai-output", "kg-stats.json"),
      JSON.stringify({ quads: 12345, vectors: 500, docPages: 80, durationSec: 42 }),
    );

    const ctx = makeContext();
    // Reaches git push (no remote) — the commit message is already written at this point
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter),
    ).rejects.toThrow(/git push failed/);

    const log = execSync("git log --format=%B -1", { cwd: tmpDir }).toString();
    expect(log).toContain("quads=12345");
    expect(log).toContain("vectors=500");
    expect(log).toContain("docPages=80");
    expect(log).toContain("durationSec=42");
  });

  it("commits without stats when ai-output/kg-stats.json is absent", async () => {
    initGitRepo(tmpDir);
    const clonedRef = resolveHead(tmpDir);

    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-03T10:00:00Z");

    const ctx = makeContext();
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter),
    ).rejects.toThrow(/git push failed/);

    const log = execSync("git log --format=%B -1", { cwd: tmpDir }).toString();
    expect(log).toContain("kg-refresh: update snapshot");
    // No stats line when file is absent
    expect(log).not.toContain("quads=");
  });

  it("returns immediately without pushing in mounted workspace mode", async () => {
    process.env.AI_IMPLEMENT_WORKSPACE_MODE = "mounted";
    initGitRepo(tmpDir);

    const ctx = makeContext();
    const result = await kgSnapshotPushStep.run(ctx, makeInputs(), noopReporter);
    expect(result.snapshotPushed).toBe(false);
    expect(result.commitSha).toBeNull();
  });

  it("fails with KG_SNAPSHOT_MISSING when current stamp has unrecognised format", async () => {
    initGitRepo(tmpDir);
    const clonedRef = resolveHead(tmpDir);

    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    // Not ISO 8601: date only, no time component
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-03");

    const ctx = makeContext();
    const err = await kgSnapshotPushStep
      .run(ctx, makeInputs({ clonedRef }), noopReporter)
      .catch((e) => e);
    expect(err).toBeInstanceOf(KgSnapshotMissingError);
    expect(err.message).toContain("unrecognised format");
  });

  it("accepts a +00:00 offset stamp with no previous stamp (reaches git push)", async () => {
    initGitRepo(tmpDir);
    const clonedRef = resolveHead(tmpDir);

    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-03T10:00:00+00:00");

    const ctx = makeContext();
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter),
    ).rejects.toThrow(/git push failed/);
  });

  it("fails with KG_SNAPSHOT_STALE when Z and +00:00 stamps represent the same instant (Z previous)", async () => {
    initGitRepo(tmpDir);
    mkdirSync(join(tmpDir, "snapshot"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-01T00:00:00Z");
    execSync("git add snapshot/", { cwd: tmpDir, stdio: "ignore" });
    execSync("git commit -m 'add old stamp'", { cwd: tmpDir, stdio: "ignore" });
    const clonedRef = resolveHead(tmpDir);

    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-01T00:00:00+00:00");

    const ctx = makeContext();
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter),
    ).rejects.toBeInstanceOf(KgSnapshotStaleError);
  });

  it("fails with KG_SNAPSHOT_STALE when Z and +00:00 stamps represent the same instant (+00:00 previous)", async () => {
    initGitRepo(tmpDir);
    mkdirSync(join(tmpDir, "snapshot"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-01T00:00:00+00:00");
    execSync("git add snapshot/", { cwd: tmpDir, stdio: "ignore" });
    execSync("git commit -m 'add old stamp'", { cwd: tmpDir, stdio: "ignore" });
    const clonedRef = resolveHead(tmpDir);

    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-01T00:00:00Z");

    const ctx = makeContext();
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter),
    ).rejects.toBeInstanceOf(KgSnapshotStaleError);
  });

  it("pushes when a later +00:00 stamp follows an earlier Z stamp", async () => {
    const bareDir = mkdtempSync(join(tmpdir(), "kgpush-bare-offset-"));
    try {
      execSync("git init --bare", { cwd: bareDir, stdio: "ignore" });

      initGitRepo(tmpDir);
      mkdirSync(join(tmpDir, "snapshot"), { recursive: true });
      writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-01T00:00:00Z");
      execSync("git add snapshot/", { cwd: tmpDir, stdio: "ignore" });
      execSync("git commit -m 'add old stamp'", { cwd: tmpDir, stdio: "ignore" });

      execSync(`git remote add origin "${bareDir}"`, { cwd: tmpDir, stdio: "ignore" });
      execSync("git push origin HEAD:refs/heads/main", { cwd: tmpDir, stdio: "ignore" });
      const clonedRef = resolveHead(tmpDir);

      mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
      writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
      writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
      writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-02T00:00:00+00:00");

      const ctx = makeContext();
      const result = await kgSnapshotPushStep.run(
        ctx,
        makeInputs({ clonedRef, defaultBranch: "main" }),
        noopReporter,
      );
      expect(result.snapshotPushed).toBe(true);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("pushes snapshot and returns snapshotPushed=true against a local bare remote", async () => {
    const bareDir = mkdtempSync(join(tmpdir(), "kgpush-bare-"));
    try {
      execSync("git init --bare", { cwd: bareDir, stdio: "ignore" });

      initGitRepo(tmpDir);
      execSync(`git remote add origin "${bareDir}"`, { cwd: tmpDir, stdio: "ignore" });
      execSync("git push origin HEAD:refs/heads/main", { cwd: tmpDir, stdio: "ignore" });
      const clonedRef = resolveHead(tmpDir);

      mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
      writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
      writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
      writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-03T10:00:00Z");

      const ctx = makeContext();
      const result = await kgSnapshotPushStep.run(
        ctx,
        makeInputs({ clonedRef, defaultBranch: "main" }),
        noopReporter,
      );
      expect(result.snapshotPushed).toBe(true);
      expect(typeof result.commitSha).toBe("string");
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("--force-with-lease rejects a push when the remote advanced concurrently", async () => {
    const bareDir = mkdtempSync(join(tmpdir(), "kgpush-bare2-"));
    // Derive a non-existing path for the clone so git clone creates it fresh.
    const otherDir = `${bareDir}-other`;
    try {
      execSync("git init --bare", { cwd: bareDir, stdio: "ignore" });
      // Point HEAD to main so that clones default to the main branch.
      execSync("git symbolic-ref HEAD refs/heads/main", { cwd: bareDir, stdio: "ignore" });

      initGitRepo(tmpDir);
      execSync(`git remote add origin "${bareDir}"`, { cwd: tmpDir, stdio: "ignore" });
      execSync("git push origin HEAD:refs/heads/main", { cwd: tmpDir, stdio: "ignore" });
      const clonedRef = resolveHead(tmpDir);

      // Simulate a concurrent commit landing on origin after we cloned.
      execSync(`git clone "${bareDir}" "${otherDir}"`, { stdio: "ignore" });
      execSync("git config user.name other", { cwd: otherDir, stdio: "ignore" });
      execSync("git config user.email other@example.com", { cwd: otherDir, stdio: "ignore" });
      writeFileSync(join(otherDir, "concurrent.txt"), "concurrent\n");
      execSync("git add concurrent.txt", { cwd: otherDir, stdio: "ignore" });
      execSync("git commit -m concurrent", { cwd: otherDir, stdio: "ignore" });
      execSync("git push origin HEAD:refs/heads/main", { cwd: otherDir, stdio: "ignore" });

      // Now origin/main is ahead of our refs/remotes/origin/main tracking ref.
      mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
      writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
      writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
      writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-03T10:00:00Z");

      const ctx = makeContext();
      await expect(
        kgSnapshotPushStep.run(
          ctx,
          makeInputs({ clonedRef, defaultBranch: "main" }),
          noopReporter,
        ),
      ).rejects.toThrow(/git push failed/);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
      if (existsSync(otherDir)) rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("warns but accepts push when previous stamp has unrecognised format", async () => {
    const bareDir = mkdtempSync(join(tmpdir(), "kgpush-bare3-"));
    try {
      execSync("git init --bare", { cwd: bareDir, stdio: "ignore" });

      initGitRepo(tmpDir);
      // Commit old snapshot with a malformed stamp so the previous-stamp path is exercised.
      mkdirSync(join(tmpDir, "snapshot"), { recursive: true });
      writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "not-iso-format");
      execSync("git add snapshot/", { cwd: tmpDir, stdio: "ignore" });
      execSync("git commit -m 'old snapshot'", { cwd: tmpDir, stdio: "ignore" });

      execSync(`git remote add origin "${bareDir}"`, { cwd: tmpDir, stdio: "ignore" });
      execSync("git push origin HEAD:refs/heads/main", { cwd: tmpDir, stdio: "ignore" });
      const clonedRef = resolveHead(tmpDir);

      // New snapshot with valid stamp and new parts.
      mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
      writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n");
      writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
      writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-03T10:00:00Z");

      const ctx = makeContext();
      const result = await kgSnapshotPushStep.run(
        ctx,
        makeInputs({ clonedRef, defaultBranch: "main" }),
        noopReporter,
      );
      // Stale check is skipped (warned); push should succeed.
      expect(result.snapshotPushed).toBe(true);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });
});

// ── kgSnapshotPushStep — tracker regression guard ─────────────────────────────

describe("kgSnapshotPushStep — tracker regression guard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kgpush-guard-"));
    delete process.env.AI_IMPLEMENT_WORKSPACE_MODE;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AI_IMPLEMENT_WORKSPACE_MODE;
  });

  function makeGuardInputs(overrides: Record<string, unknown> = {}) {
    return {
      workspaceDir: tmpDir,
      githubToken: "fake-token",
      defaultBranch: "main",
      clonedRef: resolveHead(tmpDir),
      ...overrides,
    };
  }

  it("throws KgSnapshotTrackerRegressionError when tracker not fetched and previous snapshot has issue.nt/comment.nt", async () => {
    initGitRepo(tmpDir);
    // Commit tracker-derived .nt files so the previous ref has tracker parts.
    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "issue.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "parts", "comment.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-01-01T00:00:00Z");
    execSync("git add snapshot/", { cwd: tmpDir, stdio: "ignore" });
    execSync("git commit -m 'snapshot with tracker parts'", { cwd: tmpDir, stdio: "ignore" });
    const clonedRef = resolveHead(tmpDir);

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: false, issueCount: 0 });

    await expect(
      kgSnapshotPushStep.run(ctx, makeGuardInputs({ clonedRef }), noopReporter),
    ).rejects.toBeInstanceOf(KgSnapshotTrackerRegressionError);
  });

  it("does not throw tracker regression when fetched=false and previous snapshot has only non-tracker .nt files (docs, decisions, etc.)", async () => {
    initGitRepo(tmpDir);
    // Commit only doc-type .nt files — these exist on every snapshot and must not trigger the guard.
    // Use a fresh repo with no snapshot committed so clonedRef has no stamp and the guard
    // is the only check that could throw KgSnapshotTrackerRegressionError.
    const clonedRef = resolveHead(tmpDir);

    // Write non-tracker .nt files in the working tree only (not committed, so the snapshot is "new")
    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "docs.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "parts", "decisions.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-09-03T10:00:00Z");

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: false, issueCount: 0 });

    // Guard does not fire (no tracker files in previous snapshot) → falls through to git push failure
    await expect(
      kgSnapshotPushStep.run(ctx, makeGuardInputs({ clonedRef }), noopReporter),
    ).rejects.toThrow(/git push failed/);
  });

  it("does not throw tracker regression when fetched=false but previous snapshot has no .nt files", async () => {
    initGitRepo(tmpDir);
    const clonedRef = resolveHead(tmpDir);

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: false, issueCount: 0 });

    // Guard skips (no previous .nt files) — falls through to KgSnapshotMissingError
    await expect(
      kgSnapshotPushStep.run(ctx, makeGuardInputs({ clonedRef }), noopReporter),
    ).rejects.toBeInstanceOf(KgSnapshotMissingError);
  });

  it("does not throw tracker regression when fetched=true even if previous snapshot has tracker .nt files", async () => {
    initGitRepo(tmpDir);
    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "issue.nt"), "<s> <p> <o> .\n");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), "2026-01-01T00:00:00Z");
    execSync("git add snapshot/", { cwd: tmpDir, stdio: "ignore" });
    execSync("git commit -m 'snapshot with tracker parts'", { cwd: tmpDir, stdio: "ignore" });
    const clonedRef = resolveHead(tmpDir);

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 10 });

    // Guard does not fire; falls through to KgSnapshotStaleError (snapshot unchanged since clone)
    await expect(
      kgSnapshotPushStep.run(ctx, makeGuardInputs({ clonedRef }), noopReporter),
    ).rejects.toBeInstanceOf(KgSnapshotStaleError);
  });

  it("skips tracker regression guard when clonedRef is 'unknown'", async () => {
    initGitRepo(tmpDir);
    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: false, issueCount: 0 });

    // clonedRef=unknown → guard skips → falls through to KgSnapshotMissingError
    await expect(
      kgSnapshotPushStep.run(ctx, makeGuardInputs({ clonedRef: "unknown" }), noopReporter),
    ).rejects.toBeInstanceOf(KgSnapshotMissingError);
  });

  it("treats missing fetched output (empty getOutputs result) as fetched=false", async () => {
    initGitRepo(tmpDir);
    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "issue.nt"), "<s> <p> <o> .\n");
    execSync("git add snapshot/", { cwd: tmpDir, stdio: "ignore" });
    execSync("git commit -m 'snapshot with tracker parts'", { cwd: tmpDir, stdio: "ignore" });
    const clonedRef = resolveHead(tmpDir);

    const ctx = makeContext();
    // Intentionally do NOT set kg-tracker-data outputs → getOutputs returns {}

    await expect(
      kgSnapshotPushStep.run(ctx, makeGuardInputs({ clonedRef }), noopReporter),
    ).rejects.toBeInstanceOf(KgSnapshotTrackerRegressionError);
  });
});

// ── kgSnapshotPushStep — content-based regression guard ──────────────────────

describe("kgSnapshotPushStep — content-based regression guard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kgpush-content-"));
    delete process.env.AI_IMPLEMENT_WORKSPACE_MODE;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AI_IMPLEMENT_WORKSPACE_MODE;
  });

  function makeInputs(overrides: Record<string, unknown> = {}) {
    return {
      workspaceDir: tmpDir,
      githubToken: "fake-token",
      defaultBranch: "main",
      clonedRef: resolveHead(tmpDir),
      ...overrides,
    };
  }

  function makeLines(n: number): string {
    return "<s> <p> <o> .\n".repeat(n);
  }

  function commitPreviousSnapshot(partsContent: Record<string, string>, stamp = "2026-01-01T00:00:00Z"): void {
    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    for (const [name, content] of Object.entries(partsContent)) {
      writeFileSync(join(tmpDir, "snapshot", "parts", name), content);
    }
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), stamp);
    execSync("git add snapshot/", { cwd: tmpDir, stdio: "ignore" });
    execSync("git commit -m 'prev snapshot'", { cwd: tmpDir, stdio: "ignore" });
  }

  function writeWorkingTree(partsContent: Record<string, string>, stamp = "2026-09-03T10:00:00Z"): void {
    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    for (const [name, content] of Object.entries(partsContent)) {
      writeFileSync(join(tmpDir, "snapshot", "parts", name), content);
    }
    writeFileSync(join(tmpDir, "snapshot", "embeddings.npz"), "binary");
    writeFileSync(join(tmpDir, "snapshot", "embeddings.stamp"), stamp);
  }

  it("refuses when a previous part is missing from the working tree", async () => {
    initGitRepo(tmpDir);
    commitPreviousSnapshot({ "issue.nt": makeLines(100) });
    const clonedRef = resolveHead(tmpDir);

    // Remove issue.nt from the working tree; add an unrelated file
    rmSync(join(tmpDir, "snapshot", "parts", "issue.nt"));
    writeWorkingTree({ "doc.nt": makeLines(50) });

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 100 });
    const err = await kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter).catch((e) => e);
    expect(err).toBeInstanceOf(KgSnapshotTrackerRegressionError);
    expect(err.message).toContain("issue.nt");
    expect(err.message).toContain("missing");
  });

  it("refuses with KgSnapshotTrackerRegressionError when the entire snapshot/parts/ directory is absent and previous snapshot had parts", async () => {
    initGitRepo(tmpDir);
    commitPreviousSnapshot({ "issue.nt": makeLines(100), "doc.nt": makeLines(200) });
    const clonedRef = resolveHead(tmpDir);

    // Simulate total ingest failure: remove the entire parts directory
    rmSync(join(tmpDir, "snapshot", "parts"), { recursive: true, force: true });

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 100 });
    // Content-based guard runs before section 1's existence check, so KgSnapshotTrackerRegressionError surfaces first
    const err = await kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter).catch((e) => e);
    expect(err).toBeInstanceOf(KgSnapshotTrackerRegressionError);
    expect(err.message).toContain("missing");
    expect(err.message).toContain("issue.nt");
  });

  it("refuses when a part shrinks below the 50% threshold", async () => {
    initGitRepo(tmpDir);
    commitPreviousSnapshot({ "doc.nt": makeLines(100) });
    const clonedRef = resolveHead(tmpDir);

    // 49 lines < 50% of 100 → general threshold fires
    writeFileSync(join(tmpDir, "snapshot", "parts", "doc.nt"), makeLines(49));

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 500 });
    const err = await kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter).catch((e) => e);
    expect(err).toBeInstanceOf(KgSnapshotTrackerRegressionError);
    expect(err.message).toContain("doc.nt");
  });

  it("refuses when issue.nt shrinks by any amount and issueCount > 0 (above 50% floor)", async () => {
    initGitRepo(tmpDir);
    commitPreviousSnapshot({ "issue.nt": makeLines(100) });
    const clonedRef = resolveHead(tmpDir);

    // 99 lines — above the 50% general threshold, but zero-shrink rule applies when issueCount > 0
    writeFileSync(join(tmpDir, "snapshot", "parts", "issue.nt"), makeLines(99));

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 654 });
    const err = await kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter).catch((e) => e);
    expect(err).toBeInstanceOf(KgSnapshotTrackerRegressionError);
    expect(err.message).toContain("issue.nt");
  });

  it("refuses when comment.nt shrinks by any amount and issueCount > 0 (above 50% floor)", async () => {
    initGitRepo(tmpDir);
    commitPreviousSnapshot({ "comment.nt": makeLines(100) });
    const clonedRef = resolveHead(tmpDir);

    // 99 lines — above the 50% general threshold, but zero-shrink rule applies to tracker parts when issueCount > 0
    writeFileSync(join(tmpDir, "snapshot", "parts", "comment.nt"), makeLines(99));

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 654 });
    const err = await kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter).catch((e) => e);
    expect(err).toBeInstanceOf(KgSnapshotTrackerRegressionError);
    expect(err.message).toContain("comment.nt");
  });

  it("permits doc.nt to shrink above the 50% floor (zero-shrink applies only to tracker parts)", async () => {
    initGitRepo(tmpDir);
    commitPreviousSnapshot({ "doc.nt": makeLines(100) });
    const clonedRef = resolveHead(tmpDir);

    // 99 lines — above the 50% general threshold; doc.nt is not a tracker part so zero-shrink does not apply
    writeWorkingTree({ "doc.nt": makeLines(99) });

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 654 });
    // Guard passes → falls through to git push failure
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter),
    ).rejects.toThrow(/git push failed/);
  });

  it("permits issue.nt to shrink when issueCount is 0", async () => {
    initGitRepo(tmpDir);
    commitPreviousSnapshot({ "issue.nt": makeLines(100) });
    const clonedRef = resolveHead(tmpDir);

    // 99 lines — above 50% and zero-shrink does not apply (issueCount=0)
    writeWorkingTree({ "issue.nt": makeLines(99) });

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 0 });
    // Guard passes → falls through to git push failure
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter),
    ).rejects.toThrow(/git push failed/);
  });

  it("passes a healthy snapshot where all parts grow", async () => {
    const bareDir = mkdtempSync(join(tmpdir(), "kgpush-bare-content-"));
    try {
      execSync("git init --bare", { cwd: bareDir, stdio: "ignore" });
      initGitRepo(tmpDir);
      commitPreviousSnapshot({ "issue.nt": makeLines(100), "doc.nt": makeLines(200) });
      execSync(`git remote add origin "${bareDir}"`, { cwd: tmpDir, stdio: "ignore" });
      execSync("git push origin HEAD:refs/heads/main", { cwd: tmpDir, stdio: "ignore" });
      const clonedRef = resolveHead(tmpDir);

      writeWorkingTree({ "issue.nt": makeLines(110), "doc.nt": makeLines(210) });

      const ctx = makeContext();
      ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 654 });
      const result = await kgSnapshotPushStep.run(
        ctx,
        makeInputs({ clonedRef, defaultBranch: "main" }),
        noopReporter,
      );
      expect(result.snapshotPushed).toBe(true);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("skips the guard when no previous snapshot parts exist (first ever push)", async () => {
    initGitRepo(tmpDir);
    // clonedRef has no snapshot/parts/ at all
    const clonedRef = resolveHead(tmpDir);

    writeWorkingTree({ "issue.nt": makeLines(100) });

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 100 });
    // Guard skips (no previous parts) → falls through to git push failure
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter),
    ).rejects.toThrow(/git push failed/);
  });

  it("skips the guard when clonedRef is 'unknown'", async () => {
    initGitRepo(tmpDir);
    writeWorkingTree({ "issue.nt": makeLines(5) });

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 100 });
    // Guard skips (clonedRef=unknown) → falls through to git push failure
    await expect(
      kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef: "unknown" }), noopReporter),
    ).rejects.toThrow(/git push failed/);
  });

  it("refuses the incident shape: issue.nt 9534 → 3 lines", async () => {
    initGitRepo(tmpDir);
    commitPreviousSnapshot({ "issue.nt": makeLines(9534) });
    const clonedRef = resolveHead(tmpDir);

    writeFileSync(join(tmpDir, "snapshot", "parts", "issue.nt"), makeLines(3));

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 654 });
    const err = await kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter).catch((e) => e);
    expect(err).toBeInstanceOf(KgSnapshotTrackerRegressionError);
    expect(err.message).toContain("issue.nt");
    expect(err.message).toContain("9534");
    expect(err.message).toMatch(/\b3\b/);
  });

  it("reports multiple regressions in a single error", async () => {
    initGitRepo(tmpDir);
    commitPreviousSnapshot({ "issue.nt": makeLines(100), "doc.nt": makeLines(200) });
    const clonedRef = resolveHead(tmpDir);

    // Delete doc.nt; shrink issue.nt to 30 lines (violates both zero-shrink and 50% threshold)
    rmSync(join(tmpDir, "snapshot", "parts", "doc.nt"));
    writeFileSync(join(tmpDir, "snapshot", "parts", "issue.nt"), makeLines(30));

    const ctx = makeContext();
    ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 654 });
    const err = await kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter).catch((e) => e);
    expect(err).toBeInstanceOf(KgSnapshotTrackerRegressionError);
    expect(err.message).toContain("issue.nt");
    expect(err.message).toContain("doc.nt");
  });

  it("emits a [kg-snapshot-push] parts: log line before throwing on a regression", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      initGitRepo(tmpDir);
      commitPreviousSnapshot({ "issue.nt": makeLines(100), "doc.nt": makeLines(200) });
      const clonedRef = resolveHead(tmpDir);

      // issue.nt at 3 lines → regression; doc.nt grows
      writeFileSync(join(tmpDir, "snapshot", "parts", "issue.nt"), makeLines(3));
      writeFileSync(join(tmpDir, "snapshot", "parts", "doc.nt"), makeLines(210));

      const ctx = makeContext();
      ctx.setOutputs("kg-tracker-data", { fetched: true, issueCount: 654 });
      const err = await kgSnapshotPushStep.run(ctx, makeInputs({ clonedRef }), noopReporter).catch((e) => e);

      expect(err).toBeInstanceOf(KgSnapshotTrackerRegressionError);
      const logCall = logSpy.mock.calls.find((c) => String(c[0]).includes("[kg-snapshot-push] parts:"));
      expect(logCall).toBeDefined();
      const logMsg = String(logCall![0]);
      expect(logMsg).toContain("issue.nt");
      expect(logMsg).toContain("doc.nt");
      expect(logMsg).toContain("prev=");
      expect(logMsg).toContain("new=");
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ── kgTrackerDataStep ─────────────────────────────────────────────────────────

describe("kgTrackerDataStep", () => {
  let tmpDir: string;
  let savedToken: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kgtracker-"));
    savedToken = process.env.RUN_PROGRESS_TOKEN;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedToken === undefined) delete process.env.RUN_PROGRESS_TOKEN;
    else process.env.RUN_PROGRESS_TOKEN = savedToken;
  });

  function makeTrackerPage(issues: unknown[], hasNextPage: boolean, endCursor: string | null = null) {
    return { issues, pageInfo: { hasNextPage, endCursor } };
  }

  function makeFetch(pages: Array<{ ok: boolean; status?: number; body?: unknown }>): typeof fetch {
    let i = 0;
    return async () => {
      const p = pages[i++] ?? { ok: false, status: 500 };
      return {
        ok: p.ok,
        status: p.status ?? (p.ok ? 200 : 500),
        json: async () => p.body,
      } as Response;
    };
  }

  it("returns { fetched: false } when callbackUrl is absent", async () => {
    process.env.RUN_PROGRESS_TOKEN = "tok";
    const capturedCalls: unknown[] = [];
    const fetchImpl: typeof fetch = async (...args) => { capturedCalls.push(args); return {} as Response; };
    const result = await kgTrackerDataStep.run(
      makeContext(),
      { callbackUrl: null, workspaceDir: tmpDir, fetchImpl },
      noopReporter,
    );
    expect(result).toEqual({ fetched: false, issueCount: 0 });
    expect(capturedCalls).toHaveLength(0);
  });

  it("returns { fetched: false } when RUN_PROGRESS_TOKEN is absent", async () => {
    delete process.env.RUN_PROGRESS_TOKEN;
    const capturedCalls: unknown[] = [];
    const fetchImpl: typeof fetch = async (...args) => { capturedCalls.push(args); return {} as Response; };
    const result = await kgTrackerDataStep.run(
      makeContext(),
      { callbackUrl: "http://orch", workspaceDir: tmpDir, fetchImpl },
      noopReporter,
    );
    expect(result).toEqual({ fetched: false, issueCount: 0 });
    expect(capturedCalls).toHaveLength(0);
  });

  it("writes tracker-data.json as a flat JSON array and returns fetched: true", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    const issues = [{ id: "1", identifier: "AII-1", title: "T", description: "D", state: { name: "S", type: "started" }, comments: [] }];
    const written: Array<[string, string]> = [];
    const result = await kgTrackerDataStep.run(
      makeContext(),
      {
        callbackUrl: "http://orch",
        workspaceDir: tmpDir,
        fetchImpl: makeFetch([{ ok: true, body: makeTrackerPage(issues, false) }]),
        writeFileSyncImpl: (p, d) => written.push([p, d]),
        sourcesYmlReaderImpl: () => ["AII"],
      },
      noopReporter,
    );
    expect(result).toEqual({ fetched: true, issueCount: 1 });
    expect(written).toHaveLength(1);
    expect(written[0][0]).toBe(join(tmpDir, "tracker-data.json"));
    expect(JSON.parse(written[0][1])).toEqual(issues);
  });

  it("paginates and concatenates issues across multiple pages for a single team", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    const page1Issues = [{ id: "1" }];
    const page2Issues = [{ id: "2" }];
    const fetchCalls: Array<{ cursor?: string; teamKey?: string }> = [];
    let callIndex = 0;
    const fetchImpl: typeof fetch = async (_, init) => {
      const body = init?.body ? JSON.parse(init.body as string) as { cursor?: string; teamKey?: string } : {};
      fetchCalls.push({ cursor: body.cursor, teamKey: body.teamKey });
      const page = callIndex++ === 0
        ? makeTrackerPage(page1Issues, true, "cursor1")
        : makeTrackerPage(page2Issues, false);
      return { ok: true, status: 200, json: async () => page } as Response;
    };
    const written: Array<[string, string]> = [];
    const result = await kgTrackerDataStep.run(
      makeContext(),
      {
        callbackUrl: "http://orch",
        workspaceDir: tmpDir,
        fetchImpl,
        writeFileSyncImpl: (p, d) => written.push([p, d]),
        sourcesYmlReaderImpl: () => ["AII"],
      },
      noopReporter,
    );
    expect(result).toEqual({ fetched: true, issueCount: 2 });
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].cursor).toBeUndefined();
    expect(fetchCalls[0].teamKey).toBe("AII");
    expect(fetchCalls[1].cursor).toBe("cursor1");
    expect(fetchCalls[1].teamKey).toBe("AII");
    expect(JSON.parse(written[0][1])).toEqual([...page1Issues, ...page2Issues]);
  });

  it("throws KgTrackerDataFetchError when endpoint returns non-2xx", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    await expect(
      kgTrackerDataStep.run(
        makeContext(),
        {
          callbackUrl: "http://orch",
          workspaceDir: tmpDir,
          fetchImpl: makeFetch([{ ok: false, status: 502 }]),
          sourcesYmlReaderImpl: () => ["AII"],
        },
        noopReporter,
      ),
    ).rejects.toBeInstanceOf(KgTrackerDataFetchError);
  });

  it("returns { fetched: false } when endpoint returns 503 (tracker not configured)", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    const result = await kgTrackerDataStep.run(
      makeContext(),
      {
        callbackUrl: "http://orch",
        workspaceDir: tmpDir,
        fetchImpl: makeFetch([{ ok: false, status: 503 }]),
        sourcesYmlReaderImpl: () => ["AII"],
      },
      noopReporter,
    );
    expect(result).toEqual({ fetched: false, issueCount: 0 });
  });

  it("throws KgTrackerDataFetchError when fetchImpl rejects (network error)", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    const fetchImpl: typeof fetch = async () => { throw new Error("network error"); };
    await expect(
      kgTrackerDataStep.run(
        makeContext(),
        { callbackUrl: "http://orch", workspaceDir: tmpDir, fetchImpl, sourcesYmlReaderImpl: () => ["AII"] },
        noopReporter,
      ),
    ).rejects.toBeInstanceOf(KgTrackerDataFetchError);
  });

  it("sends Authorization: Bearer <token> and teamKey on each request", async () => {
    process.env.RUN_PROGRESS_TOKEN = "my-secret-token";
    const capturedAuth: string[] = [];
    const capturedTeamKeys: string[] = [];
    const fetchImpl: typeof fetch = async (_, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth.push(headers?.["Authorization"] ?? "");
      const body = init?.body ? JSON.parse(init.body as string) as { teamKey?: string } : {};
      capturedTeamKeys.push(body.teamKey ?? "");
      return { ok: true, status: 200, json: async () => makeTrackerPage([{ id: "1" }], false) } as Response;
    };
    await kgTrackerDataStep.run(
      makeContext(),
      {
        callbackUrl: "http://orch",
        workspaceDir: tmpDir,
        fetchImpl,
        writeFileSyncImpl: () => {},
        sourcesYmlReaderImpl: () => ["AII"],
      },
      noopReporter,
    );
    expect(capturedAuth).toHaveLength(1);
    expect(capturedAuth[0]).toBe("Bearer my-secret-token");
    expect(capturedTeamKeys).toEqual(["AII"]);
  });

  it("iterates over multiple teams from sources.yml and combines results", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    const aiiIssues = [{ id: "aii-1" }];
    const bdsIssues = [{ id: "bds-1" }, { id: "bds-2" }];
    const requestBodies: Array<{ teamKey?: string; cursor?: string }> = [];
    const fetchImpl: typeof fetch = async (_, init) => {
      const body = init?.body ? JSON.parse(init.body as string) as { teamKey?: string; cursor?: string } : {};
      requestBodies.push(body);
      const issues = body.teamKey === "AII" ? aiiIssues : bdsIssues;
      return { ok: true, status: 200, json: async () => makeTrackerPage(issues, false) } as Response;
    };
    const written: Array<[string, string]> = [];
    const result = await kgTrackerDataStep.run(
      makeContext(),
      {
        callbackUrl: "http://orch",
        workspaceDir: tmpDir,
        fetchImpl,
        writeFileSyncImpl: (p, d) => written.push([p, d]),
        sourcesYmlReaderImpl: () => ["AII", "BDS"],
      },
      noopReporter,
    );
    expect(result).toEqual({ fetched: true, issueCount: 3 });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0].teamKey).toBe("AII");
    expect(requestBodies[1].teamKey).toBe("BDS");
    expect(JSON.parse(written[0][1])).toEqual([...aiiIssues, ...bdsIssues]);
  });

  it("throws KgTrackerDataFetchError when any configured team returns zero issues", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    const aiiIssues = [{ id: "aii-1" }, { id: "aii-2" }];
    const fetchImpl: typeof fetch = async (_, init) => {
      const body = init?.body ? JSON.parse(init.body as string) as { teamKey?: string } : {};
      const issues = body.teamKey === "AII" ? aiiIssues : [];
      return { ok: true, status: 200, json: async () => makeTrackerPage(issues, false) } as Response;
    };
    await expect(
      kgTrackerDataStep.run(
        makeContext(),
        {
          callbackUrl: "http://orch",
          workspaceDir: tmpDir,
          fetchImpl,
          writeFileSyncImpl: () => {},
          sourcesYmlReaderImpl: () => ["AII", "BDS"],
        },
        noopReporter,
      ),
    ).rejects.toBeInstanceOf(KgTrackerDataFetchError);
  });

  it("returns { fetched: false } when sources.yml is absent or has no teams", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    const capturedCalls: unknown[] = [];
    const fetchImpl: typeof fetch = async (...args) => { capturedCalls.push(args); return {} as Response; };
    const result = await kgTrackerDataStep.run(
      makeContext(),
      {
        callbackUrl: "http://orch",
        workspaceDir: tmpDir,
        fetchImpl,
        sourcesYmlReaderImpl: () => [],
      },
      noopReporter,
    );
    expect(result).toEqual({ fetched: false, issueCount: 0 });
    expect(capturedCalls).toHaveLength(0);
  });

  // ── sources.yml parsing (real file shapes) ─────────────────────────────────

  const REAL_SOURCES_YML = `\
trackers:
  - kind: linear
    team: AII                           # AI-Implement  (PRIMARY — bound to code_repo)
    tier: primary
  - kind: linear
    team: BDS                           # BuildDown Skills  (SECONDARY)
    tier: secondary
`;

  function makeEmptyPageFetch(): { fetchImpl: typeof fetch; requestBodies: Array<Record<string, string>> } {
    const requestBodies: Array<Record<string, string>> = [];
    const fetchImpl: typeof fetch = async (_, init) => {
      const body = init?.body ? JSON.parse(init.body as string) as Record<string, string> : {};
      requestBodies.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ issues: [{ id: "i1" }], pageInfo: { hasNextPage: false, endCursor: null } }),
      } as Response;
    };
    return { fetchImpl, requestBodies };
  }

  it("parses the real multi-block sources.yml format and fetches AII and BDS", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    writeFileSync(join(tmpDir, "sources.yml"), REAL_SOURCES_YML);
    const { fetchImpl, requestBodies } = makeEmptyPageFetch();
    const result = await kgTrackerDataStep.run(
      makeContext(),
      { callbackUrl: "http://orch", workspaceDir: tmpDir, fetchImpl, writeFileSyncImpl: () => {} },
      noopReporter,
    );
    expect(result.fetched).toBe(true);
    expect(requestBodies.map((b) => b.teamKey)).toEqual(["AII", "BDS"]);
  });

  it("parses the inline `- team:` format", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    writeFileSync(join(tmpDir, "sources.yml"), "trackers:\n  - team: AII\n  - team: BDS\n");
    const { fetchImpl, requestBodies } = makeEmptyPageFetch();
    await kgTrackerDataStep.run(
      makeContext(),
      { callbackUrl: "http://orch", workspaceDir: tmpDir, fetchImpl, writeFileSyncImpl: () => {} },
      noopReporter,
    );
    expect(requestBodies.map((b) => b.teamKey)).toEqual(["AII", "BDS"]);
  });

  it("extracts team name without trailing comment", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    writeFileSync(
      join(tmpDir, "sources.yml"),
      "trackers:\n  - kind: linear\n    team: XYZ                           # some comment\n",
    );
    const { fetchImpl, requestBodies } = makeEmptyPageFetch();
    await kgTrackerDataStep.run(
      makeContext(),
      { callbackUrl: "http://orch", workspaceDir: tmpDir, fetchImpl, writeFileSyncImpl: () => {} },
      noopReporter,
    );
    expect(requestBodies.map((b) => b.teamKey)).toEqual(["XYZ"]);
  });

  it("returns { fetched: false } when sources.yml file is absent (no file written)", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    // tmpDir has no sources.yml — existsSync returns false
    const capturedCalls: unknown[] = [];
    const fetchImpl: typeof fetch = async (...args) => { capturedCalls.push(args); return {} as Response; };
    const result = await kgTrackerDataStep.run(
      makeContext(),
      { callbackUrl: "http://orch", workspaceDir: tmpDir, fetchImpl },
      noopReporter,
    );
    expect(result).toEqual({ fetched: false, issueCount: 0 });
    expect(capturedCalls).toHaveLength(0);
  });

  it("falls back to regex when YAML is unparseable but an indented team: line is present", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    // Leading `[broken` makes the YAML parser throw; the fallback regex finds `team: AII`
    writeFileSync(join(tmpDir, "sources.yml"), "[broken\n  team: AII\n");
    const { fetchImpl, requestBodies } = makeEmptyPageFetch();
    const result = await kgTrackerDataStep.run(
      makeContext(),
      { callbackUrl: "http://orch", workspaceDir: tmpDir, fetchImpl, writeFileSyncImpl: () => {} },
      noopReporter,
    );
    expect(result.fetched).toBe(true);
    expect(requestBodies.map((b) => b.teamKey)).toEqual(["AII"]);
  });

  it("returns { fetched: false } when trackers block has no team keys", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    writeFileSync(join(tmpDir, "sources.yml"), "trackers:\n  - kind: linear\n    tier: primary\n");
    const capturedCalls: unknown[] = [];
    const fetchImpl: typeof fetch = async (...args) => { capturedCalls.push(args); return {} as Response; };
    const result = await kgTrackerDataStep.run(
      makeContext(),
      { callbackUrl: "http://orch", workspaceDir: tmpDir, fetchImpl },
      noopReporter,
    );
    expect(result).toEqual({ fetched: false, issueCount: 0 });
    expect(capturedCalls).toHaveLength(0);
  });

  it("logs the team list after parsing sources.yml", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    writeFileSync(join(tmpDir, "sources.yml"), REAL_SOURCES_YML);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await kgTrackerDataStep.run(
        makeContext(),
        { callbackUrl: "http://orch", workspaceDir: tmpDir, fetchImpl: makeEmptyPageFetch().fetchImpl, writeFileSyncImpl: () => {} },
        noopReporter,
      );
      expect(logSpy).toHaveBeenCalledWith("[kg-tracker-data] teams from sources.yml: AII, BDS");
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ── AII-458 regression: RUN_PROGRESS_TOKEN must not reach the model process ───

describe("AII-458 regression: RUN_PROGRESS_TOKEN stripped from model env", () => {
  it("modelProcessEnv strips RUN_PROGRESS_TOKEN even when present in process.env", () => {
    const saved = process.env.RUN_PROGRESS_TOKEN;
    process.env.RUN_PROGRESS_TOKEN = "must-not-leak";
    try {
      const env = modelProcessEnv(false);
      expect("RUN_PROGRESS_TOKEN" in env).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.RUN_PROGRESS_TOKEN;
      else process.env.RUN_PROGRESS_TOKEN = saved;
    }
  });
});

// ── pipeline-loader wiring for kg-snapshot-push ───────────────────────────────

import { loadPipelineDefinition } from "../pipeline/pipeline-loader.js";

const KG_REFRESH_PIPELINE_YAML = `id: kg-refresh
steps:
  - id: clone
    type: clone
  - id: kg-tracker-data
    type: custom
    moduleId: kg-tracker-data
  - id: feedback-loop
    type: custom
    moduleId: feedback-loop
  - id: kg-snapshot-push
    type: custom
    moduleId: kg-snapshot-push
`;

describe("applyWiring for kg-snapshot-push", () => {
  it("wires inputs from clone outputs", () => {
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_REFRESH_PIPELINE_YAML,
    });

    const step = pipeline.steps.find((s) => s.id === "kg-snapshot-push");
    expect(step).toBeDefined();
    expect(step!.inputs).toBeDefined();

    const ctx = makeContext({ branch: "main" });
    ctx.setOutputs("clone", {
      workspaceDir: "/ws",
      repoOwner: "org",
      repoRepo: "repo",
      githubToken: "tok",
      clonedRef: "abc123",
    });

    const inputs = ctx.resolveInputs(step!.inputs);
    expect(inputs.workspaceDir).toBe("/ws");
    expect(inputs.githubToken).toBe("tok");
    expect(inputs.clonedRef).toBe("abc123");
    expect(inputs.defaultBranch).toBe("main");
  });
});

// ── pipeline-loader wiring for kg-tracker-data ────────────────────────────────

describe("applyWiring for kg-tracker-data", () => {
  it("wires callbackUrl from context data and workspaceDir from clone outputs", () => {
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_REFRESH_PIPELINE_YAML,
    });

    const step = pipeline.steps.find((s) => s.id === "kg-tracker-data");
    expect(step).toBeDefined();
    expect(step!.inputs).toBeDefined();

    const ctx = makeContext({ callbackUrl: "http://orchestrator" });
    ctx.setOutputs("clone", {
      workspaceDir: "/ws",
      repoOwner: "org",
      repoRepo: "repo",
      githubToken: "tok",
      clonedRef: "abc123",
    });

    const inputs = ctx.resolveInputs(step!.inputs);
    expect(inputs.callbackUrl).toBe("http://orchestrator");
    expect(inputs.workspaceDir).toBe("/ws");
  });
});

// ── runKgRefresh() happy and failure paths ────────────────────────────────────

import { runKgRefresh } from "../pipeline/kg-refresh-run.js";
import type { StepModule } from "../pipeline/types.js";

function makeStepModule(outputs: Record<string, unknown> = {}, throwErr?: Error): StepModule {
  return {
    run: async () => {
      if (throwErr) throw throwErr;
      return outputs;
    },
  };
}

describe("runKgRefresh", () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kgrun-"));
    originalEnv = { ...process.env };
    process.env.GITHUB_OWNER = "org";
    process.env.GITHUB_REPO = "kg-repo";
    process.env.GITHUB_TOKEN = "tok";
    process.env.GITHUB_DEFAULT_BRANCH = "main";
    process.env.WORKSPACE_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Restore env
    for (const k of ["GITHUB_OWNER", "GITHUB_REPO", "GITHUB_TOKEN", "GITHUB_DEFAULT_BRANCH", "WORKSPACE_DIR", "RUN_TOKEN", "RUNNER_CALLBACK_URL", "RUN_PROGRESS_TOKEN", "AI_IMPLEMENT_RUN_CONFIG"]) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns exitCode 0 when all steps succeed", async () => {
    const result = await runKgRefresh({
      workspaceDir: tmpDir,
      stepsOverride: {
        clone: makeStepModule({ workspaceDir: tmpDir, repoOwner: "org", repoRepo: "repo", githubToken: "tok", clonedRef: "abc" }),
        kgIngest: makeStepModule({ statsFile: null }),
        feedbackLoop: makeStepModule({ approved: false }),
        kgSnapshotPush: makeStepModule({ snapshotPushed: true, commitSha: "sha123" }),
      },
      reporter: { report: async () => undefined },
    });
    expect(result.exitCode).toBe(0);
  });

  it("returns exitCode 1 when kg-snapshot-push throws KG_SNAPSHOT_MISSING", async () => {
    const result = await runKgRefresh({
      workspaceDir: tmpDir,
      stepsOverride: {
        clone: makeStepModule({ workspaceDir: tmpDir, repoOwner: "org", repoRepo: "repo", githubToken: "tok", clonedRef: "abc" }),
        kgIngest: makeStepModule({ statsFile: null }),
        feedbackLoop: makeStepModule({ approved: false }),
        kgSnapshotPush: makeStepModule({}, new KgSnapshotMissingError("no parts")),
      },
      reporter: { report: async () => undefined },
    });
    expect(result.exitCode).toBe(1);
  });

  it("reports failureCode KG_SNAPSHOT_TRACKER_REGRESSION when push step throws KgSnapshotTrackerRegressionError", async () => {
    process.env.RUNNER_CALLBACK_URL = "http://orch";
    process.env.RUN_TOKEN = "run-tok";
    const capturedResults: Array<{ failureCode?: string }> = [];
    const result = await runKgRefresh({
      workspaceDir: tmpDir,
      stepsOverride: {
        clone: makeStepModule({ workspaceDir: tmpDir, repoOwner: "org", repoRepo: "repo", githubToken: "tok", clonedRef: "abc" }),
        kgIngest: makeStepModule({ statsFile: null }),
        feedbackLoop: makeStepModule({ approved: false }),
        kgSnapshotPush: makeStepModule({}, new KgSnapshotTrackerRegressionError("previous snapshot has tracker files")),
      },
      reporter: { report: async () => undefined },
      fetchImpl: async (_url, init) => {
        const body = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
        capturedResults.push(body as { failureCode?: string });
        return new Response(JSON.stringify({ acknowledged: true }), { status: 200 });
      },
    });
    delete process.env.RUNNER_CALLBACK_URL;
    delete process.env.RUN_TOKEN;
    expect(result.exitCode).toBe(1);
    expect(capturedResults.some((r) => r.failureCode === "KG_SNAPSHOT_TRACKER_REGRESSION")).toBe(true);
  });

  it("returns exitCode 1 when kgTrackerData throws KgTrackerDataFetchError", async () => {
    const result = await runKgRefresh({
      workspaceDir: tmpDir,
      stepsOverride: {
        clone: makeStepModule({ workspaceDir: tmpDir, repoOwner: "org", repoRepo: "repo", githubToken: "tok", clonedRef: "abc" }),
        kgTrackerData: makeStepModule({}, new KgTrackerDataFetchError("orchestrator returned 502")),
        feedbackLoop: makeStepModule({ approved: false }),
        kgSnapshotPush: makeStepModule({ snapshotPushed: true, commitSha: "sha123" }),
      },
      reporter: { report: async () => undefined },
    });
    expect(result.exitCode).toBe(1);
  });

  it("envelope kgSourceRepo survives decode and runnerPhase is kg-refresh", () => {
    const encoded = encodeRunConfig({
      v: 1,
      issue: { id: "kg-1", identifier: "AII-493", title: "KG refresh", description: "refresh" },
      runnerPhase: "kg-refresh",
      kgSourceRepo: "BuildDownAI/knowledge-graph-ai-implement",
    });
    const decoded = decodeRunConfig(encoded);
    expect(decoded.runnerPhase).toBe("kg-refresh");
    expect(decoded.kgSourceRepo).toBe("BuildDownAI/knowledge-graph-ai-implement");
  });

  it("passes maxIterations=1 to the feedback-loop step (report-only, ingest is a deterministic step)", async () => {
    let capturedInputs: Record<string, unknown> = {};
    const capturingFeedbackLoop: StepModule = {
      run: async (_ctx, inputs) => {
        capturedInputs = inputs;
        return { approved: false };
      },
    };

    await runKgRefresh({
      workspaceDir: tmpDir,
      stepsOverride: {
        clone: makeStepModule({ workspaceDir: tmpDir, repoOwner: "org", repoRepo: "repo", githubToken: "tok", clonedRef: "abc" }),
        kgIngest: makeStepModule({ statsFile: null }),
        feedbackLoop: capturingFeedbackLoop,
        kgSnapshotPush: makeStepModule({ snapshotPushed: true, commitSha: "sha123" }),
      },
      reporter: { report: async () => undefined },
    });

    expect(capturedInputs.maxIterations).toBe(1);
  });

  it("passes reviewRubric with snapshot/ and ingest-check clauses to the feedback-loop step", async () => {
    let capturedInputs: Record<string, unknown> = {};
    const capturingFeedbackLoop: StepModule = {
      run: async (_ctx, inputs) => {
        capturedInputs = inputs;
        return { approved: false };
      },
    };

    await runKgRefresh({
      workspaceDir: tmpDir,
      stepsOverride: {
        clone: makeStepModule({ workspaceDir: tmpDir, repoOwner: "org", repoRepo: "repo", githubToken: "tok", clonedRef: "abc" }),
        kgIngest: makeStepModule({ statsFile: null }),
        feedbackLoop: capturingFeedbackLoop,
        kgSnapshotPush: makeStepModule({ snapshotPushed: true, commitSha: "sha123" }),
      },
      reporter: { report: async () => undefined },
    });

    const rubric = capturedInputs.reviewRubric;
    expect(typeof rubric).toBe("string");
    const rubricStr = rubric as string;
    // Must mention that uncommitted output is expected
    expect(rubricStr).toContain("snapshot/");
    expect(rubricStr).toContain("uncommitted");
    // Must include all four ingest-check criteria
    expect(rubricStr).toContain("embeddings.npz");
    expect(rubricStr).toContain("embeddings.stamp");
    expect(rubricStr).toContain("kg-stats.json");
  });
});

// ── kg-refresh execution-path selection ──────────────────────────────────────

import { resolveExecutionPath } from "../runner-mode.js";
import { makeKgRefresh } from "../kg-refresh.js";

describe("kg-refresh execution path selection (resolveExecutionPath with github-actions default)", () => {
  it("default mode resolves to github-actions (the kg-refresh fallback)", () => {
    expect(resolveExecutionPath("default", "github-actions")).toBe("github-actions");
  });

  it("gha mode resolves to github-actions regardless of mapping default", () => {
    expect(resolveExecutionPath("gha", "fly-machines")).toBe("github-actions");
  });

  it("fly mode resolves to fly-machines", () => {
    expect(resolveExecutionPath("fly", "github-actions")).toBe("fly-machines");
  });

  it("local mode resolves to local-docker", () => {
    expect(resolveExecutionPath("local", "github-actions")).toBe("local-docker");
  });

  it("shadow mode returns both, which kg-refresh collapses to github-actions", () => {
    const resolved = resolveExecutionPath("shadow", "github-actions");
    expect(resolved).toBe("both");
    // dispatchKgRefreshRun collapses "both" to "github-actions" to prevent two
    // concurrent ingest runs racing to push the same snapshot commit.
    const effective = resolved === "both" ? "github-actions" : resolved;
    expect(effective).toBe("github-actions");
  });
});

// ── makeKgRefresh dispatch result threading ───────────────────────────────────
// Verifies that trigger() correctly threads workflowRunId / machineNonce
// from dispatchRun's result into updateJobMachine.

function makeTarballForDispatchTest(): Buffer {
  const wrap = mkdtempSync(join(tmpdir(), "kgtar-"));
  const top = join(wrap, "repo");
  mkdirSync(top, { recursive: true });
  writeFileSync(join(top, "sources.yml"), "namespace: https://kg.test/\n");
  const out = join(wrap, "src.tar.gz");
  execSync(`tar -czf ${out} -C ${wrap} repo`);
  const buf = readFileSync(out) as Buffer;
  rmSync(wrap, { recursive: true, force: true });
  return buf;
}

describe("makeKgRefresh — dispatch result threading to updateJobMachine", () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "kgdispatch-"));
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function waitFor(fn: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 300; i++) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for: ${label}`);
  }

  function buildHandle(overrides: {
    dispatchResult: { machineId?: string; machineNonce?: string; logsUrl?: string; workflowRunId?: number };
    appendJobLogId?: number;
    updateJobMachineMock: ReturnType<typeof vi.fn>;
  }) {
    const tarball = makeTarballForDispatchTest();
    const id = overrides.appendJobLogId ?? 99;
    return makeKgRefresh({
      sidecar: { restart: vi.fn(async () => {}) },
      githubAppId: "1",
      githubAppPrivateKey: "key",
      kgSourceRepo: "TestOrg/test-kg",
      dataRoot,
      kgDir: "/nonexistent-kg",
      minFreeBytes: 1,
      freeBytes: () => 999_999,
      deployHeld: () => false,
      mintToken: vi.fn(async () => ({ token: "tok", expiresAt: "" })) as never,
      fetchTarball: vi.fn(async () => tarball) as never,
      fetchDefaultBranch: vi.fn(async () => "main") as never,
      // SHA matches recorded SHA → runRefresh() returns ingest-needed → dispatch fires
      fetchSnapshotCommitSha: vi.fn(async () => "sha-abc") as never,
      persistSnapshotSha: vi.fn() as never,
      loadSnapshotSha: vi.fn(() => "sha-abc") as never,
      mcpToolCall: vi.fn(async () => ({ edges: [] })) as never,
      canaryDeadlineMs: 50,
      canaryRetryMs: 10,
      runnerCallbackBaseUrl: "http://localhost:8080",
      runnerTokenSecret: "secret",
      resolveMappingTeamKey: (repo: string) => repo === "TestOrg/test-kg" ? { teamKey: "KGA", dependencyTokenScope: "installation" } : undefined,
      mintRunTokenFn: vi.fn(() => ({ token: "run-tok", dispatchId: "disp-1" })) as never,
      dispatchRun: vi.fn(async () => overrides.dispatchResult) as never,
      appendJobLog: vi.fn(() => id) as never,
      updateJobMachine: overrides.updateJobMachineMock as never,
      closeJobLog: vi.fn() as never,
      onOutcome: vi.fn() as never,
      persistStage: vi.fn() as never,
      loadStage: vi.fn(() => null) as never,
    });
  }

  it("passes workflowRunId and undefined machineNonce for a GHA dispatch result", async () => {
    const updateJobMachineMock = vi.fn();
    const handle = buildHandle({
      dispatchResult: {
        workflowRunId: 12345,
        logsUrl: "https://github.com/TestOrg/test-kg/actions/runs/12345",
      },
      appendJobLogId: 99,
      updateJobMachineMock,
    });

    const r = await handle.trigger();
    expect(r.status).toBe(202);

    await waitFor(() => updateJobMachineMock.mock.calls.length > 0, "updateJobMachine called");

    expect(updateJobMachineMock).toHaveBeenCalledWith(99, {
      machineNonce: undefined,
      machineId: undefined,
      logsUrl: "https://github.com/TestOrg/test-kg/actions/runs/12345",
      workflowRunId: 12345,
    });
  });

  it("passes machineNonce and machineId for a Fly dispatch result", async () => {
    const updateJobMachineMock = vi.fn();
    const handle = buildHandle({
      dispatchResult: {
        machineId: "machine-abc",
        machineNonce: "nonce-xyz",
        logsUrl: "https://fly.io/apps/sessions/machines/machine-abc",
      },
      appendJobLogId: 88,
      updateJobMachineMock,
    });

    const r = await handle.trigger();
    expect(r.status).toBe(202);

    await waitFor(() => updateJobMachineMock.mock.calls.length > 0, "updateJobMachine called");

    expect(updateJobMachineMock).toHaveBeenCalledWith(88, {
      machineNonce: "nonce-xyz",
      machineId: "machine-abc",
      logsUrl: "https://fly.io/apps/sessions/machines/machine-abc",
      workflowRunId: undefined,
    });
  });
});

// ── KG-REFRESH.md template assertions ────────────────────────────────────────

describe("KG-REFRESH.md template — report-only, no ingest instructions", () => {
  const playbookPath = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "..",
    "workflows",
    "KG-REFRESH.md",
  );

  it("states that the reviewer treats uncommitted snapshot/ output as expected", () => {
    const playbook = readFileSync(playbookPath, "utf-8");
    expect(playbook).toContain("uncommitted");
    expect(playbook).toContain("reviewer");
  });

  it("does not instruct Claude to run the ingest (no python/venv/kg_ingest references)", () => {
    const playbook = readFileSync(playbookPath, "utf-8");
    expect(playbook).not.toContain("python");
    expect(playbook).not.toContain("venv");
    expect(playbook).not.toContain("kg_ingest");
    expect(playbook).not.toContain("--code-repo");
    expect(playbook).not.toContain("--tracker-data");
    expect(playbook).not.toContain("TRACKER_DATA_SUPPORTED");
  });

  it("instructs Claude to read kg-stats.json and write 01-report.md", () => {
    const playbook = readFileSync(playbookPath, "utf-8");
    expect(playbook).toContain("kg-stats.json");
    expect(playbook).toContain("01-report.md");
  });
});

// ── kgIngestStep unit tests ───────────────────────────────────────────────────

type FakeProcess = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

function makeFakeProcess(
  exitCode: number,
  stdoutLines: string[] = [],
  stderrLines: string[] = [],
): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => {
    for (const line of stdoutLines) {
      proc.stdout.emit("data", Buffer.from(line + "\n"));
    }
    proc.stdout.emit("end");
    for (const line of stderrLines) {
      proc.stderr.emit("data", Buffer.from(line + "\n"));
    }
    proc.stderr.emit("end");
    proc.emit("close", exitCode);
  });
  return proc;
}

describe("kgIngestStep", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kgingest-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("spawns python -m kg_ingest refresh with --code-repo and --tracker-data when both present", async () => {
    const capturedArgs: string[][] = [];
    const capturedCwd: string[] = [];
    const spawnImpl = (cmd: string, args: string[], opts: { cwd: string }) => {
      capturedArgs.push([cmd, ...args]);
      capturedCwd.push(opts.cwd);
      return makeFakeProcess(0, ['{"quads":100,"vectors":50,"docPages":5,"durationSec":10}']) as unknown as ChildProcess;
    };
    const writtenFiles: Array<[string, string]> = [];

    writeFileSync(join(tmpDir, "tracker-data.json"), "[]");

    await kgIngestStep.run(
      makeContext(),
      {
        workspaceDir: tmpDir,
        codeRepoDir: "/some/code-repo",
        spawnImpl,
        writeFileSyncImpl: (p, d) => writtenFiles.push([p, d]),
        mkdirSyncImpl: () => undefined,
        existsSyncImpl: (p) => p === join(tmpDir, "tracker-data.json"),
      },
      noopReporter,
    );

    // venv setup: python3 -m venv .venv, then pip install -r requirements.txt
    expect(capturedArgs[0]).toEqual(["python3", "-m", "venv", ".venv"]);
    expect(capturedArgs[1]).toEqual([join(tmpDir, ".venv", "bin", "pip"), "install", "-r", "requirements.txt"]);
    // main ingest uses the venv python
    expect(capturedArgs[2]).toEqual([join(tmpDir, ".venv", "bin", "python"), "-m", "kg_ingest", "refresh", "--code-repo", "/some/code-repo", "--tracker-data", join(tmpDir, "tracker-data.json")]);
    expect(capturedCwd[2]).toBe(tmpDir);
    expect(writtenFiles).toHaveLength(1);
    expect(writtenFiles[0][0]).toBe(join(tmpDir, "ai-output", "kg-stats.json"));
    const stats = JSON.parse(writtenFiles[0][1]) as Record<string, unknown>;
    expect(stats.quads).toBe(100);
    expect(stats.vectors).toBe(50);
  });

  it("spawns without --tracker-data when tracker-data.json is absent", async () => {
    const capturedArgs: string[][] = [];
    const spawnImpl = (cmd: string, args: string[]) => {
      capturedArgs.push([cmd, ...args]);
      return makeFakeProcess(0, ['{"quads":50}']) as unknown as ChildProcess;
    };

    await kgIngestStep.run(
      makeContext(),
      {
        workspaceDir: tmpDir,
        codeRepoDir: "/repo",
        spawnImpl,
        writeFileSyncImpl: () => undefined,
        mkdirSyncImpl: () => undefined,
        existsSyncImpl: () => false,
      },
      noopReporter,
    );

    expect(capturedArgs[2]).toEqual([join(tmpDir, ".venv", "bin", "python"), "-m", "kg_ingest", "refresh", "--code-repo", "/repo"]);
    expect(capturedArgs[2]).not.toContain("--tracker-data");
  });

  it("throws KgIngestError with 'no code repo in workspace' when codeRepoDir is absent", async () => {
    const spawnImpl = vi.fn(() => makeFakeProcess(0, ['{"quads":0}']) as unknown as ChildProcess);

    const err = await kgIngestStep
      .run(
        makeContext(),
        {
          workspaceDir: tmpDir,
          spawnImpl,
          writeFileSyncImpl: () => undefined,
          mkdirSyncImpl: () => undefined,
          existsSyncImpl: () => false,
        },
        noopReporter,
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(KgIngestError);
    expect((err as KgIngestError).outputTail).toContain("no code repo in workspace");
  });

  it("does not call spawnImpl when codeRepoDir is absent", async () => {
    const spawnImpl = vi.fn(() => makeFakeProcess(0, []) as unknown as ChildProcess);

    await kgIngestStep
      .run(
        makeContext(),
        {
          workspaceDir: tmpDir,
          spawnImpl,
          writeFileSyncImpl: () => undefined,
          mkdirSyncImpl: () => undefined,
          existsSyncImpl: () => false,
        },
        noopReporter,
      )
      .catch(() => {});

    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("throws KgIngestError with exit code and last 40 lines on non-zero exit", async () => {
    const errorLines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const spawnImpl = () =>
      makeFakeProcess(2, [], errorLines) as unknown as ChildProcess;

    const err = await kgIngestStep
      .run(makeContext(), { workspaceDir: tmpDir, codeRepoDir: "/fake/code-repo", spawnImpl, existsSyncImpl: () => false }, noopReporter)
      .catch((e) => e);

    expect(err).toBeInstanceOf(KgIngestError);
    expect((err as KgIngestError).exitCode).toBe(2);
    expect((err as KgIngestError).code).toBe("KG_INGEST_FAILED");
    // tail should contain only the last 40 of 50 lines
    const tail = (err as KgIngestError).outputTail;
    expect(tail).toContain("line 49");
    expect(tail).not.toContain("line 9\n");
  });

  it("throws KgIngestError when python3 -m venv exits non-zero", async () => {
    let callCount = 0;
    const spawnImpl = () => {
      callCount++;
      // only venv setup fails; pip install and ingest would succeed but won't be reached
      return makeFakeProcess(callCount === 1 ? 1 : 0, []) as unknown as ChildProcess;
    };

    const err = await kgIngestStep
      .run(makeContext(), { workspaceDir: tmpDir, codeRepoDir: "/fake/code-repo", spawnImpl, existsSyncImpl: () => false }, noopReporter)
      .catch((e) => e);

    expect(err).toBeInstanceOf(KgIngestError);
    expect((err as KgIngestError).exitCode).toBe(1);
    expect(callCount).toBe(1);
  });

  it("throws KgIngestError when pip install -r requirements.txt exits non-zero", async () => {
    let callCount = 0;
    const spawnImpl = () => {
      callCount++;
      // venv setup succeeds, pip install fails
      return makeFakeProcess(callCount === 2 ? 3 : 0, []) as unknown as ChildProcess;
    };

    const err = await kgIngestStep
      .run(makeContext(), { workspaceDir: tmpDir, codeRepoDir: "/fake/code-repo", spawnImpl, existsSyncImpl: () => false }, noopReporter)
      .catch((e) => e);

    expect(err).toBeInstanceOf(KgIngestError);
    expect((err as KgIngestError).exitCode).toBe(3);
    expect(callCount).toBe(2);
  });

  it("ingest failure tail does not contain venv-setup or pip-install output", async () => {
    let callCount = 0;
    const spawnImpl = (cmd: string, args: string[]) => {
      callCount++;
      if (callCount <= 2) {
        // setup phases succeed but emit recognisable output
        return makeFakeProcess(0, [`setup-output-${callCount}`]) as unknown as ChildProcess;
      }
      // main ingest fails
      return makeFakeProcess(2, [], ["ingest-error-line"]) as unknown as ChildProcess;
    };

    const err = await kgIngestStep
      .run(makeContext(), { workspaceDir: tmpDir, codeRepoDir: "/fake/code-repo", spawnImpl, existsSyncImpl: () => false }, noopReporter)
      .catch((e) => e);

    expect(err).toBeInstanceOf(KgIngestError);
    const tail = (err as KgIngestError).outputTail;
    expect(tail).toContain("ingest-error-line");
    expect(tail).not.toContain("setup-output-1");
    expect(tail).not.toContain("setup-output-2");
  });

  it("parses stats JSON from stdout and writes ai-output/kg-stats.json", async () => {
    const statsJson = '{"quads":1234,"vectors":56,"docPages":7,"durationSec":8.9}';
    const spawnImpl = () =>
      makeFakeProcess(0, ["some log line", statsJson, "another log"]) as unknown as ChildProcess;

    const written: Array<[string, string]> = [];
    await kgIngestStep.run(
      makeContext(),
      {
        workspaceDir: tmpDir,
        codeRepoDir: "/fake/code-repo",
        spawnImpl,
        writeFileSyncImpl: (p, d) => written.push([p, d]),
        mkdirSyncImpl: () => undefined,
        existsSyncImpl: () => false,
      },
      noopReporter,
    );

    expect(written).toHaveLength(1);
    const stats = JSON.parse(written[0][1]) as Record<string, unknown>;
    expect(stats.quads).toBe(1234);
    expect(stats.vectors).toBe(56);
    expect(stats.docPages).toBe(7);
  });

  it("falls back to counting .nt lines when no stats JSON on stdout", async () => {
    const spawnImpl = () =>
      makeFakeProcess(0, ["ingesting...", "done"]) as unknown as ChildProcess;

    const written: Array<[string, string]> = [];
    mkdirSync(join(tmpDir, "snapshot", "parts"), { recursive: true });
    writeFileSync(join(tmpDir, "snapshot", "parts", "a.nt"), "<s> <p> <o> .\n".repeat(100));
    writeFileSync(join(tmpDir, "snapshot", "parts", "b.nt"), "<s> <p> <o> .\n".repeat(50));

    await kgIngestStep.run(
      makeContext(),
      {
        workspaceDir: tmpDir,
        codeRepoDir: "/fake/code-repo",
        spawnImpl,
        writeFileSyncImpl: (p, d) => written.push([p, d]),
        mkdirSyncImpl: () => undefined,
        existsSyncImpl: (p) => !p.endsWith("tracker-data.json"),
      },
      noopReporter,
    );

    expect(written).toHaveLength(1);
    const stats = JSON.parse(written[0][1]) as Record<string, unknown>;
    expect(stats.quads).toBe(150);
    expect(stats.vectors).toBe(0);
    expect(stats.docPages).toBe(0);
  });

  it("writes stats with quads=0 when no stats JSON and snapshot/parts is absent", async () => {
    const spawnImpl = () =>
      makeFakeProcess(0, []) as unknown as ChildProcess;

    const written: Array<[string, string]> = [];
    await kgIngestStep.run(
      makeContext(),
      {
        workspaceDir: tmpDir,
        codeRepoDir: "/fake/code-repo",
        spawnImpl,
        writeFileSyncImpl: (p, d) => written.push([p, d]),
        mkdirSyncImpl: () => undefined,
        existsSyncImpl: () => false,
      },
      noopReporter,
    );

    expect(written).toHaveLength(1);
    const stats = JSON.parse(written[0][1]) as Record<string, unknown>;
    expect(stats.quads).toBe(0);
    expect(stats.vectors).toBe(0);
    expect(stats.docPages).toBe(0);
  });
});

// ── kg-refresh pipeline order ─────────────────────────────────────────────────

describe("kg-refresh pipeline order", () => {
  it("step IDs are clone → dependency-auth → clone-code-repo → clone-secondary-repos → kg-tracker-data → kg-ingest → feedback-loop → kg-snapshot-push", () => {
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml");
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).toEqual([
      "clone",
      "dependency-auth",
      "clone-code-repo",
      "clone-secondary-repos",
      "kg-tracker-data",
      "kg-ingest",
      "feedback-loop",
      "kg-snapshot-push",
    ]);
  });
});

// ── kg-ingest wiring in pipeline-loader ──────────────────────────────────────

describe("applyWiring for kg-ingest", () => {
  const KG_INGEST_PIPELINE_YAML = `id: kg-refresh
steps:
  - id: clone
    type: clone
  - id: clone-code-repo
    type: clone
  - id: kg-ingest
    type: custom
    moduleId: kg-ingest
`;

  it("wires workspaceDir from clone outputs and codeRepoDir from clone-code-repo outputs", () => {
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_INGEST_PIPELINE_YAML,
    });

    const step = pipeline.steps.find((s) => s.id === "kg-ingest");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: "/ws", githubToken: "tok", clonedRef: "abc" });
    ctx.setOutputs("clone-code-repo", { workspaceDir: "/ws/code-repo" });

    const inputs = ctx.resolveInputs(step!.inputs);
    expect(inputs.workspaceDir).toBe("/ws");
    expect(inputs.codeRepoDir).toBe("/ws/code-repo");
  });

  it("omits codeRepoDir when clone-code-repo was skipped (outputs empty)", () => {
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_INGEST_PIPELINE_YAML,
    });

    const step = pipeline.steps.find((s) => s.id === "kg-ingest");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: "/ws", githubToken: "tok", clonedRef: "abc" });
    ctx.setOutputs("clone-code-repo", {}); // skipped — no outputs

    const inputs = ctx.resolveInputs(step!.inputs);
    expect(inputs.workspaceDir).toBe("/ws");
    expect(inputs.codeRepoDir).toBeUndefined();
  });

  it("wires reposRootDir when clone-secondary-repos ran (outputs contain clonedCount)", () => {
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_INGEST_PIPELINE_YAML,
    });

    const step = pipeline.steps.find((s) => s.id === "kg-ingest");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: "/ws", githubToken: "tok", clonedRef: "abc" });
    ctx.setOutputs("clone-code-repo", {});
    ctx.setOutputs("clone-secondary-repos", { clonedCount: 0 });

    const inputs = ctx.resolveInputs(step!.inputs);
    expect(inputs.reposRootDir).toBe("/ws/repos");
  });

  it("omits reposRootDir when clone-secondary-repos was skipped (no outputs)", () => {
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_INGEST_PIPELINE_YAML,
    });

    const step = pipeline.steps.find((s) => s.id === "kg-ingest");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: "/ws", githubToken: "tok", clonedRef: "abc" });
    ctx.setOutputs("clone-code-repo", {});
    // clone-secondary-repos outputs not set — step was skipped

    const inputs = ctx.resolveInputs(step!.inputs);
    expect(inputs.reposRootDir).toBeUndefined();
  });
});

// ── KgIngestError → KG_INGEST_FAILED failure code ────────────────────────────

describe("runKgRefresh — KgIngestError maps to KG_INGEST_FAILED", () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kgrun-ingest-"));
    originalEnv = { ...process.env };
    process.env.GITHUB_OWNER = "org";
    process.env.GITHUB_REPO = "kg-repo";
    process.env.GITHUB_TOKEN = "tok";
    process.env.GITHUB_DEFAULT_BRANCH = "main";
    process.env.WORKSPACE_DIR = tmpDir;
    process.env.RUNNER_CALLBACK_URL = "http://orch";
    process.env.RUN_TOKEN = "run-tok";
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const k of ["GITHUB_OWNER", "GITHUB_REPO", "GITHUB_TOKEN", "GITHUB_DEFAULT_BRANCH", "WORKSPACE_DIR", "RUN_TOKEN", "RUNNER_CALLBACK_URL"]) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns exitCode 1 and posts failureCode KG_INGEST_FAILED when kgIngestStep throws KgIngestError", async () => {
    const capturedResults: Array<Record<string, unknown>> = [];
    const result = await runKgRefresh({
      workspaceDir: tmpDir,
      stepsOverride: {
        clone: makeStepModule({ workspaceDir: tmpDir, repoOwner: "org", repoRepo: "repo", githubToken: "tok", clonedRef: "abc" }),
        kgIngest: makeStepModule({}, new KgIngestError(1, "output tail from ingest")),
      },
      reporter: { report: async () => undefined },
      fetchImpl: async (_url, init) => {
        const body = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
        capturedResults.push(body);
        return new Response(JSON.stringify({ acknowledged: true }), { status: 200 });
      },
    });
    expect(result.exitCode).toBe(1);
    expect(capturedResults.some((r) => r.failureCode === "KG_INGEST_FAILED")).toBe(true);
  });
});

// ── GHA kg-refresh dispatch — runner_image resolution ────────────────────────
// Verifies that dispatchKgRefreshRun's GHA branch forwards runner_image using
// the same channel-policy helper as the implement dispatch path.
//
// dispatchKgRefreshRun is not exported (index.ts is the application entry
// point with side-effectful startup; it has no exports). The tests below cover
// two layers:
//   1. resolveRunnerImageForDispatch in isolation — ensures the helper returns
//      the right value for the three decision branches.
//   2. Dispatch body wiring via buildKgRefreshGhaDispatchBody — calls the same
//      exported function that production uses, so a key-name change or logic
//      inversion in the real code will fail these assertions.

describe("GHA kg-refresh dispatch — runner_image resolution via resolveRunnerImageForDispatch", () => {
  beforeEach(() => {
    __clearRepoImageCacheForTests();
  });

  it("includes runner_image when orchestrator image is explicitly pinned (runnerImageExplicit=true)", async () => {
    // No per-repo override — fetch returns 404
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;

    const result = await resolveRunnerImageForDispatch({
      owner: "BuildDownAI",
      repo: "knowledge-graph-ai-implement",
      token: "gh-tok",
      defaultImage: "ghcr.io/builddownai/ai-implement-runner:next",
      runnerImageExplicit: true,
      fetchImpl,
    });

    // Explicit orchestrator pin → image forwarded; KG repo needs no AI_IMPLEMENT_RUNNER_IMAGE
    expect(result).toBe("ghcr.io/builddownai/ai-implement-runner:next");
  });

  it("omits runner_image when orchestrator uses built-in default and KG repo has no override", async () => {
    // No per-repo override — fetch returns 404
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;

    const result = await resolveRunnerImageForDispatch({
      owner: "BuildDownAI",
      repo: "knowledge-graph-ai-implement",
      token: "gh-tok",
      defaultImage: "ghcr.io/builddownai/ai-implement-runner:latest",
      runnerImageExplicit: false,
      fetchImpl,
    });

    // No explicit pin, no per-repo override → undefined; workflow's own
    // AI_IMPLEMENT_RUNNER_IMAGE variable (or its built-in default) applies
    expect(result).toBeUndefined();
  });

  it("includes runner_image when KG repo has a per-repo .ai-implement/image.yml override", async () => {
    const yamlContent = "image: ghcr.io/org/custom-runner:sha-abc\n";
    const b64 = Buffer.from(yamlContent).toString("base64");
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ type: "file", encoding: "base64", content: b64 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof fetch;

    const result = await resolveRunnerImageForDispatch({
      owner: "BuildDownAI",
      repo: "knowledge-graph-ai-implement",
      token: "gh-tok",
      defaultImage: "ghcr.io/builddownai/ai-implement-runner:latest",
      runnerImageExplicit: false,
      fetchImpl,
    });

    // Per-repo override wins regardless of orchestrator flag
    expect(result).toBe("ghcr.io/org/custom-runner:sha-abc");
  });

  it("GHA and Fly resolve the same image ref for the same orchestrator (parity)", async () => {
    // GHA calls resolveRunnerImageForDispatch (which delegates to resolveSessionImage);
    // Fly calls resolveSessionImage directly — verify the two produce the same result.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;

    const opts = {
      owner: "BuildDownAI",
      repo: "knowledge-graph-ai-implement",
      token: "gh-tok",
      defaultImage: "ghcr.io/builddownai/ai-implement-runner:next",
      runnerImageExplicit: true,
      fetchImpl,
    };

    const ghaImage = await resolveRunnerImageForDispatch(opts);
    __clearRepoImageCacheForTests();
    const flyImage = await resolveRunnerImageForDispatch(opts);

    expect(ghaImage).toBe(flyImage);
    expect(ghaImage).toBe("ghcr.io/builddownai/ai-implement-runner:next");
  });
});

// ── GHA kg-refresh dispatch — body wiring invariant ───────────────────────────
// Exercises the full pipeline from image resolution to fetch-body by composing
// resolveRunnerImageForDispatch with the exported buildKgRefreshGhaDispatchBody
// (the same function dispatchKgRefreshRun uses). Tests call the real exported
// function rather than a local copy of the spread, so a key-name change or
// logic inversion in production will fail these assertions.

describe("GHA kg-refresh dispatch — fetch body wiring (runner_image spread)", () => {
  beforeEach(() => {
    __clearRepoImageCacheForTests();
  });

  it("body includes runner_image when image is resolved (explicit orchestrator pin)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const runnerImage = await resolveRunnerImageForDispatch({
      owner: "BuildDownAI",
      repo: "knowledge-graph-ai-implement",
      token: "gh-tok",
      defaultImage: "ghcr.io/builddownai/ai-implement-runner:next",
      runnerImageExplicit: true,
      fetchImpl,
    });

    const body = JSON.parse(buildKgRefreshGhaDispatchBody({ ref: "main", runConfig: "cfg", runToken: "tok", runProgressToken: "prog-tok", runnerImage })) as { ref: string; inputs: Record<string, string> };
    expect(body.inputs.runner_image).toBe("ghcr.io/builddownai/ai-implement-runner:next");
    expect(body.inputs.run_progress_token).toBe("prog-tok");
  });

  it("body omits runner_image when image is not resolved (default image, no override)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    const runnerImage = await resolveRunnerImageForDispatch({
      owner: "BuildDownAI",
      repo: "knowledge-graph-ai-implement",
      token: "gh-tok",
      defaultImage: "ghcr.io/builddownai/ai-implement-runner:latest",
      runnerImageExplicit: false,
      fetchImpl,
    });

    const body = JSON.parse(buildKgRefreshGhaDispatchBody({ ref: "main", runConfig: "cfg", runToken: "tok", runProgressToken: "prog-tok", runnerImage })) as { ref: string; inputs: Record<string, string> };
    expect("runner_image" in body.inputs).toBe(false);
    expect(body.inputs.run_progress_token).toBe("prog-tok");
  });

  it("body includes runner_image when KG repo has a per-repo image.yml override", async () => {
    const yamlContent = "image: ghcr.io/org/custom-runner:sha-abc\n";
    const b64 = Buffer.from(yamlContent).toString("base64");
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ type: "file", encoding: "base64", content: b64 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof fetch;

    const runnerImage = await resolveRunnerImageForDispatch({
      owner: "BuildDownAI",
      repo: "knowledge-graph-ai-implement",
      token: "gh-tok",
      defaultImage: "ghcr.io/builddownai/ai-implement-runner:latest",
      runnerImageExplicit: false,
      fetchImpl,
    });

    const body = JSON.parse(buildKgRefreshGhaDispatchBody({ ref: "main", runConfig: "cfg", runToken: "tok", runProgressToken: "prog-tok", runnerImage })) as { ref: string; inputs: Record<string, string> };
    expect(body.inputs.runner_image).toBe("ghcr.io/org/custom-runner:sha-abc");
    expect(body.inputs.run_progress_token).toBe("prog-tok");
  });

  it("body always includes run_progress_token regardless of runner_image presence", () => {
    const bodyWithImage = JSON.parse(
      buildKgRefreshGhaDispatchBody({ ref: "main", runConfig: "cfg", runToken: "tok", runProgressToken: "secret-prog", runnerImage: "ghcr.io/org/runner:v1" }),
    ) as { inputs: Record<string, string> };
    expect(bodyWithImage.inputs.run_progress_token).toBe("secret-prog");

    const bodyNoImage = JSON.parse(
      buildKgRefreshGhaDispatchBody({ ref: "main", runConfig: "cfg", runToken: "tok", runProgressToken: "secret-prog", runnerImage: undefined }),
    ) as { inputs: Record<string, string> };
    expect(bodyNoImage.inputs.run_progress_token).toBe("secret-prog");
    expect("runner_image" in bodyNoImage.inputs).toBe(false);
  });

  it("body includes runner_callback_url when provided", () => {
    const body = JSON.parse(
      buildKgRefreshGhaDispatchBody({
        ref: "main",
        runConfig: "cfg",
        runToken: "tok",
        runProgressToken: "prog",
        runnerImage: undefined,
        runnerCallbackUrl: "https://orchestrator.example.com",
      }),
    ) as { inputs: Record<string, string> };
    expect(body.inputs.runner_callback_url).toBe("https://orchestrator.example.com");
  });

  it("body omits runner_callback_url when absent — entrypoint falls back to RunConfig", () => {
    const body = JSON.parse(
      buildKgRefreshGhaDispatchBody({ ref: "main", runConfig: "cfg", runToken: "tok", runProgressToken: "prog", runnerImage: undefined }),
    ) as { inputs: Record<string, string> };
    expect("runner_callback_url" in body.inputs).toBe(false);
  });

  it("core fields (run_config, run_token) are present regardless of optional fields", () => {
    const body = JSON.parse(
      buildKgRefreshGhaDispatchBody({ ref: "main", runConfig: "b64cfg", runToken: "runtok", runProgressToken: "prog", runnerImage: undefined }),
    ) as { inputs: Record<string, string> };
    expect(body.inputs.run_config).toBe("b64cfg");
    expect(body.inputs.run_token).toBe("runtok");
  });
});

// ── GHA dispatch: run ID polling (pollForKgWorkflowRunId) ─────────────────────
// AII-551: verifies the polling loop binds the run ID on a delayed appearance.

import { pollForKgWorkflowRunId } from "../github.js";

describe("GHA kg-refresh dispatch — run ID polling (pollForKgWorkflowRunId)", () => {
  it("binds the run ID that appears on the third poll", async () => {
    let calls = 0;
    const findRunId = vi.fn(async () => {
      calls++;
      if (calls < 3) return null;
      return 44444;
    });

    const runId = await pollForKgWorkflowRunId({
      token: "tok",
      owner: "org",
      repo: "kg-repo",
      workflowFile: "kg-refresh.yml",
      branch: "main",
      dispatchTime: new Date(),
      pollDelaysMs: [0, 0, 0, 0, 0],
      findRunId,
    });

    expect(runId).toBe(44444);
    expect(findRunId).toHaveBeenCalledTimes(3);
  });

  it("returns undefined when run ID never appears", async () => {
    const findRunId = vi.fn(async () => null);

    const runId = await pollForKgWorkflowRunId({
      token: "tok",
      owner: "org",
      repo: "kg-repo",
      workflowFile: "kg-refresh.yml",
      branch: "main",
      dispatchTime: new Date(),
      pollDelaysMs: [0, 0, 0],
      findRunId,
    });

    expect(runId).toBeUndefined();
    expect(findRunId).toHaveBeenCalledTimes(3);
  });

  it("returns the run ID found on the first poll without further calls", async () => {
    const findRunId = vi.fn(async () => 11111);

    const runId = await pollForKgWorkflowRunId({
      token: "tok",
      owner: "org",
      repo: "kg-repo",
      workflowFile: "kg-refresh.yml",
      branch: "main",
      dispatchTime: new Date(),
      pollDelaysMs: [0, 0, 0],
      findRunId,
    });

    expect(runId).toBe(11111);
    expect(findRunId).toHaveBeenCalledTimes(1);
  });

  it("treats a thrown findRunId error as null and continues polling", async () => {
    let calls = 0;
    const findRunId = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("GitHub API error");
      return calls >= 3 ? 55555 : null;
    });

    const runId = await pollForKgWorkflowRunId({
      token: "tok",
      owner: "org",
      repo: "kg-repo",
      workflowFile: "kg-refresh.yml",
      branch: "main",
      dispatchTime: new Date(),
      pollDelaysMs: [0, 0, 0],
      findRunId,
    });

    expect(runId).toBe(55555);
    expect(findRunId).toHaveBeenCalledTimes(3);
  });
});

// ── Real-artifact entrypoint smoke test ───────────────────────────────────────
//
// Two-level testing strategy for the entrypoint→image handoff (AII-534):
//
// LEVEL 1 — source-level (this vitest test): runs `tsx kg-refresh-run.ts` as a
// subprocess. Catches import resolution failures in the dev environment and
// proves all transitive imports compile. The runKgRefresh tests above use
// stepsOverride, so they are blind to a missing module — this subprocess test is
// not.
//
// LEVEL 2 — real-artifact CI gate (.github/workflows/build-runner.yml "Smoke-test"
// step): runs `node /app/dist/pipeline/kg-refresh-run.js` inside the actual built
// session image via `docker run`. This is the gate that catches the AII-534 class
// of failure — a Fly machine booting a stale image that lacks the compiled file
// exits immediately with "Cannot find module" before any callback fires. The CI
// gate runs after every push to main/testing and blocks channel promotion when it
// fails, so no stale image can reach a Fly dispatch.
//
// The distinction matters: tsx never touches /app/dist; only the CI gate does.

describe("pipeline/kg-refresh-run.ts module-load (entrypoint smoke test)", () => {
  it("exits with env validation error, not Cannot find module, when GITHUB_TOKEN is absent", () => {
    const workspaceRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
    // Build subprocess env: keep PATH and HOME but strip tokens so the module
    // hits env validation before any network call.
    const env: NodeJS.ProcessEnv = { ...process.env };
    env["GITHUB_OWNER"] = "test-org";
    env["GITHUB_REPO"] = "test-repo";
    delete env["GITHUB_TOKEN"];
    delete env["GH_TOKEN"];
    // Prevent AI_IMPLEMENT_RUN_CONFIG from carrying a callbackUrl that could
    // cause a callback attempt before the env check fails.
    delete env["AI_IMPLEMENT_RUN_CONFIG"];

    const result = spawnSync(
      join(workspaceRoot, "node_modules/.bin/tsx"),
      [join(workspaceRoot, "src/pipeline/kg-refresh-run.ts")],
      {
        env,
        cwd: workspaceRoot,
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const output = (result.stderr?.toString() ?? "") + (result.stdout?.toString() ?? "");
    // If any import in kg-refresh-run.ts cannot be resolved, tsx emits
    // "Cannot find module" or ERR_MODULE_NOT_FOUND before the process exits.
    // That error would surface here — proving the check catches the Fly boot failure.
    expect(output).not.toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/i);
    // Exits non-zero because GITHUB_TOKEN is absent (env validation in resolveKgRefreshInputs).
    expect(result.status).not.toBe(0);
  });
});

// ── readCodeRepoFromSourcesYml ────────────────────────────────────────────────

describe("readCodeRepoFromSourcesYml", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kgcrepo-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when sources.yml is absent", () => {
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBeNull();
  });

  it("returns owner/repo when code_repo key is present", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo: BuildDownAI/AI-Implement\n");
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBe("BuildDownAI/AI-Implement");
  });

  it("returns null when code_repo key is absent", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "trackers:\n  - team: AII\n");
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBeNull();
  });

  it("trims trailing comments from the code_repo value", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo: BuildDownAI/AI-Implement  # main code repo\n");
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBe("BuildDownAI/AI-Implement");
  });

  it("returns null for malformed YAML that lacks code_repo", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "[broken\n");
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBeNull();
  });

  it("returns owner/repo when code_repo is present alongside trackers block", () => {
    writeFileSync(join(tmpDir, "sources.yml"),
      "code_repo: org/my-repo\ntrackers:\n  - team: AII\n",
    );
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBe("org/my-repo");
  });

  it("returns null when code_repo value has no slash (not owner/repo format)", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo: justarepo\n");
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBeNull();
  });

  it("returns null when code_repo value has a leading slash (empty owner)", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo: /repo\n");
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBeNull();
  });

  // ── mapping form (code_repo: { slug: owner/name, ... }) ───────────────────

  const REAL_CODE_REPO_BLOCK = `\
code_repo:
  slug: BuildDownAI/AI-Implement        # GitHub owner/name
  path: ../AI-Implement                 # local clone for the git spine
  docs_url: https://docs.builddown.ai/latest/introduction
  doc_globs: []
`;

  it("returns slug from the real verbatim mapping form", () => {
    writeFileSync(join(tmpDir, "sources.yml"), REAL_CODE_REPO_BLOCK);
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBe("BuildDownAI/AI-Implement");
  });

  it("returns slug when code_repo is a mapping with only the slug key", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo:\n  slug: org/my-repo\n");
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBe("org/my-repo");
  });

  it("returns null when code_repo mapping has no slug key", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo:\n  path: ../repo\n");
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBeNull();
  });

  it("returns null when code_repo mapping slug is not owner/repo format (no slash)", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo:\n  slug: justarepo\n");
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBeNull();
  });

  it("strips trailing comment from slug line", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo:\n  slug: org/my-repo  # main repo\n");
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBe("org/my-repo");
  });

  it("returns slug when mapping form coexists with trackers block", () => {
    writeFileSync(
      join(tmpDir, "sources.yml"),
      "code_repo:\n  slug: org/repo\ntrackers:\n  - team: AII\n",
    );
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBe("org/repo");
  });

  it("returns slug via regex fallback when YAML is malformed but mapping hint present", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "[broken\ncode_repo:\n  slug: org/repo\n");
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBe("org/repo");
  });

  it("returns null when code_repo mapping slug value is numeric (42)", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo:\n  slug: 42\n");
    expect(readCodeRepoFromSourcesYml(tmpDir)).toBeNull();
  });
});

// ── readSecondaryReposFromSourcesYml ─────────────────────────────────────────

const REAL_SECONDARY_REPOS_BLOCK = `\
secondary_repos:
  - slug: BuildDownAI/bd-knowledge-graph-base
  - slug: BuildDownAI/docs
  - slug: BuildDownAI/skills
`;

describe("readSecondaryReposFromSourcesYml", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kgsec-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns [] when sources.yml is absent", () => {
    expect(readSecondaryReposFromSourcesYml(tmpDir)).toEqual([]);
  });

  it("returns [] when sources.yml has no secondary_repos key", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo: org/repo\ntrackers:\n  - team: AII\n");
    expect(readSecondaryReposFromSourcesYml(tmpDir)).toEqual([]);
  });

  it("returns [] when secondary_repos is an empty list", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "secondary_repos: []\n");
    expect(readSecondaryReposFromSourcesYml(tmpDir)).toEqual([]);
  });

  it("filters out entries without slug", () => {
    writeFileSync(
      join(tmpDir, "sources.yml"),
      "secondary_repos:\n  - name: foo\n  - slug: org/bar\n",
    );
    expect(readSecondaryReposFromSourcesYml(tmpDir)).toEqual([{ slug: "org/bar" }]);
  });

  it("filters out string-only (non-object) entries", () => {
    writeFileSync(
      join(tmpDir, "sources.yml"),
      "secondary_repos:\n  - just-a-string\n  - slug: org/bar\n",
    );
    expect(readSecondaryReposFromSourcesYml(tmpDir)).toEqual([{ slug: "org/bar" }]);
  });

  it("returns three entries from the real verbatim secondary_repos block", () => {
    writeFileSync(join(tmpDir, "sources.yml"), REAL_SECONDARY_REPOS_BLOCK);
    expect(readSecondaryReposFromSourcesYml(tmpDir)).toEqual([
      { slug: "BuildDownAI/bd-knowledge-graph-base" },
      { slug: "BuildDownAI/docs" },
      { slug: "BuildDownAI/skills" },
    ]);
  });

  it("returns [] for malformed YAML", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "[broken yaml\n");
    expect(readSecondaryReposFromSourcesYml(tmpDir)).toEqual([]);
  });

  it("filters out slugs that are not owner/repo format (no slash)", () => {
    writeFileSync(
      join(tmpDir, "sources.yml"),
      "secondary_repos:\n  - slug: justarepo\n  - slug: org/valid\n",
    );
    expect(readSecondaryReposFromSourcesYml(tmpDir)).toEqual([{ slug: "org/valid" }]);
  });

  it("filters out slugs with spaces", () => {
    writeFileSync(
      join(tmpDir, "sources.yml"),
      "secondary_repos:\n  - slug: org/with spaces\n  - slug: org/valid\n",
    );
    expect(readSecondaryReposFromSourcesYml(tmpDir)).toEqual([{ slug: "org/valid" }]);
  });

  it("returns [] when secondary_repos exists but all entries lack valid slugs", () => {
    writeFileSync(
      join(tmpDir, "sources.yml"),
      "secondary_repos:\n  - name: foo\n  - name: bar\n",
    );
    expect(readSecondaryReposFromSourcesYml(tmpDir)).toEqual([]);
  });

  it("coexists with code_repo and trackers blocks", () => {
    writeFileSync(
      join(tmpDir, "sources.yml"),
      "code_repo: org/main\ntrackers:\n  - team: AII\nsecondary_repos:\n  - slug: org/extra\n",
    );
    expect(readSecondaryReposFromSourcesYml(tmpDir)).toEqual([{ slug: "org/extra" }]);
  });
});

// ── clone-secondary-repos step module ────────────────────────────────────────

describe("cloneSecondaryReposStep", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kgclone-"));
    delete process.env.AI_IMPLEMENT_WORKSPACE_MODE;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AI_IMPLEMENT_WORKSPACE_MODE;
  });

  const ctx = makeContext();

  it("returns clonedCount 0 when sources.yml is absent", async () => {
    const spawnCalls: unknown[] = [];
    const result = await cloneSecondaryReposStep.run(
      ctx,
      {
        workspaceDir: tmpDir,
        spawnSyncImpl: (cmd, args) => { spawnCalls.push([cmd, args]); return { status: 0 }; },
        mkdirSyncImpl: () => undefined,
      },
      noopReporter,
    );
    expect(result.clonedCount).toBe(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it("returns clonedCount 0 when secondary_repos is empty", async () => {
    writeFileSync(join(tmpDir, "sources.yml"), "secondary_repos: []\n");
    const spawnCalls: unknown[] = [];
    const result = await cloneSecondaryReposStep.run(
      ctx,
      {
        workspaceDir: tmpDir,
        spawnSyncImpl: (cmd, args) => { spawnCalls.push([cmd, args]); return { status: 0 }; },
        mkdirSyncImpl: () => undefined,
      },
      noopReporter,
    );
    expect(result.clonedCount).toBe(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it("clones all three real secondary repos into repos/<basename>/", async () => {
    writeFileSync(join(tmpDir, "sources.yml"), REAL_SECONDARY_REPOS_BLOCK);
    const spawnCalls: Array<[string, string[]]> = [];
    const mkdirCalls: string[] = [];
    const result = await cloneSecondaryReposStep.run(
      ctx,
      {
        workspaceDir: tmpDir,
        spawnSyncImpl: (cmd, args) => { spawnCalls.push([cmd, args]); return { status: 0 }; },
        mkdirSyncImpl: (p) => { mkdirCalls.push(p); },
      },
      noopReporter,
    );
    expect(result.clonedCount).toBe(3);
    expect(spawnCalls).toHaveLength(3);
    // Verify each clone targets repos/<basename>/
    const targets = spawnCalls.map((c) => c[1].at(-1) ?? "");
    expect(targets).toContain(join(tmpDir, "repos", "bd-knowledge-graph-base"));
    expect(targets).toContain(join(tmpDir, "repos", "docs"));
    expect(targets).toContain(join(tmpDir, "repos", "skills"));
    // repos/ directory created
    expect(mkdirCalls).toContain(join(tmpDir, "repos"));
  });

  it("logs warning and continues when one repo clone fails", async () => {
    writeFileSync(join(tmpDir, "sources.yml"), REAL_SECONDARY_REPOS_BLOCK);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let callIndex = 0;
    const result = await cloneSecondaryReposStep.run(
      ctx,
      {
        workspaceDir: tmpDir,
        spawnSyncImpl: () => {
          // Fail the second repo (docs), succeed the others
          const status = callIndex++ === 1 ? 128 : 0;
          return { status, stderr: Buffer.from("not found") };
        },
        mkdirSyncImpl: () => undefined,
      },
      noopReporter,
    );
    expect(result.clonedCount).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("clone failed for BuildDownAI/docs"),
    );
    warnSpy.mockRestore();
  });

  it("skips all clones and warns in mounted mode", async () => {
    process.env.AI_IMPLEMENT_WORKSPACE_MODE = "mounted";
    writeFileSync(join(tmpDir, "sources.yml"), REAL_SECONDARY_REPOS_BLOCK);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spawnCalls: unknown[] = [];
    const result = await cloneSecondaryReposStep.run(
      ctx,
      {
        workspaceDir: tmpDir,
        spawnSyncImpl: (cmd, args) => { spawnCalls.push([cmd, args]); return { status: 0 }; },
        mkdirSyncImpl: () => undefined,
      },
      noopReporter,
    );
    expect(result.clonedCount).toBe(0);
    expect(spawnCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      "[clone-secondary-repos] mounted mode: skipping all secondary clones",
    );
    warnSpy.mockRestore();
  });

  it("skips and warns when slug basename resolves to '..'", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spawnCalls: unknown[] = [];
    const result = await cloneSecondaryReposStep.run(
      ctx,
      {
        workspaceDir: tmpDir,
        secondaryReposReaderImpl: () => [{ slug: "org/.." }],
        spawnSyncImpl: (cmd, args) => { spawnCalls.push([cmd, args]); return { status: 0 }; },
        mkdirSyncImpl: () => undefined,
      },
      noopReporter,
    );
    expect(result.clonedCount).toBe(0);
    expect(spawnCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('repo name resolves to ".."'),
    );
    warnSpy.mockRestore();
  });

  it("skips and warns when slug basename resolves to '.'", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spawnCalls: unknown[] = [];
    const result = await cloneSecondaryReposStep.run(
      ctx,
      {
        workspaceDir: tmpDir,
        secondaryReposReaderImpl: () => [{ slug: "org/." }],
        spawnSyncImpl: (cmd, args) => { spawnCalls.push([cmd, args]); return { status: 0 }; },
        mkdirSyncImpl: () => undefined,
      },
      noopReporter,
    );
    expect(result.clonedCount).toBe(0);
    expect(spawnCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('repo name resolves to "."'),
    );
    warnSpy.mockRestore();
  });
});

// ── applyWiring for clone-secondary-repos ────────────────────────────────────

const KG_REFRESH_WITH_SECONDARY_YAML = `id: kg-refresh
steps:
  - id: clone
    type: clone
  - id: dependency-auth
    type: custom
    moduleId: dependency-auth
  - id: clone-code-repo
    type: clone
  - id: clone-secondary-repos
    type: custom
    moduleId: clone-secondary-repos
  - id: kg-tracker-data
    type: custom
    moduleId: kg-tracker-data
  - id: kg-ingest
    type: custom
    moduleId: kg-ingest
  - id: feedback-loop
    type: custom
    moduleId: feedback-loop
  - id: kg-snapshot-push
    type: custom
    moduleId: kg-snapshot-push
`;

describe("applyWiring for clone-secondary-repos", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kgsecwire-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skip returns true when dependency-auth was not acquired", () => {
    writeFileSync(join(tmpDir, "sources.yml"), REAL_SECONDARY_REPOS_BLOCK);
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_REFRESH_WITH_SECONDARY_YAML,
    });
    const step = pipeline.steps.find((s) => s.id === "clone-secondary-repos");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: tmpDir });
    ctx.setOutputs("dependency-auth", { acquired: false });
    expect(step!.skip!(ctx)).toBe(true);
  });

  it("skip returns true when dependency-auth never ran (no outputs)", () => {
    writeFileSync(join(tmpDir, "sources.yml"), REAL_SECONDARY_REPOS_BLOCK);
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_REFRESH_WITH_SECONDARY_YAML,
    });
    const step = pipeline.steps.find((s) => s.id === "clone-secondary-repos");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: tmpDir });
    // dependency-auth outputs not set
    expect(step!.skip!(ctx)).toBe(true);
  });

  it("skip returns false when dependency-auth acquired and secondary_repos present", () => {
    writeFileSync(join(tmpDir, "sources.yml"), REAL_SECONDARY_REPOS_BLOCK);
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_REFRESH_WITH_SECONDARY_YAML,
    });
    const step = pipeline.steps.find((s) => s.id === "clone-secondary-repos");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: tmpDir });
    ctx.setOutputs("dependency-auth", { acquired: true });
    expect(step!.skip!(ctx)).toBe(false);
  });

  it("skip returns true and warns when dependency-auth acquired but no secondary_repos", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo: org/repo\n");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_REFRESH_WITH_SECONDARY_YAML,
    });
    const step = pipeline.steps.find((s) => s.id === "clone-secondary-repos");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: tmpDir });
    ctx.setOutputs("dependency-auth", { acquired: true });
    expect(step!.skip!(ctx)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      "[clone-secondary-repos] no secondary_repos in sources.yml — skipping",
    );
    warnSpy.mockRestore();
  });

  it("inputs include workspaceDir from clone outputs", () => {
    writeFileSync(join(tmpDir, "sources.yml"), REAL_SECONDARY_REPOS_BLOCK);
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_REFRESH_WITH_SECONDARY_YAML,
    });
    const step = pipeline.steps.find((s) => s.id === "clone-secondary-repos");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: tmpDir });
    const inputs = ctx.resolveInputs(step!.inputs);
    expect(inputs.workspaceDir).toBe(tmpDir);
  });

  it("clone-secondary-repos step has type custom and moduleId clone-secondary-repos", () => {
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml");
    const step = pipeline.steps.find((s) => s.id === "clone-secondary-repos");
    expect(step?.type).toBe("custom");
    expect(step?.moduleId).toBe("clone-secondary-repos");
  });
});

// ── kgIngestStep — --repos-root flag ─────────────────────────────────────────

describe("kgIngestStep — --repos-root flag", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kgingest-repos-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes --repos-root in ingest args when reposRootDir is provided", async () => {
    const capturedArgs: string[][] = [];
    const spawnImpl = (cmd: string, args: string[]) => {
      capturedArgs.push([cmd, ...args]);
      return makeFakeProcess(0, ['{"quads":10,"vectors":0,"docPages":0,"durationSec":1}']) as unknown as ChildProcess;
    };

    await kgIngestStep.run(
      makeContext(),
      {
        workspaceDir: tmpDir,
        codeRepoDir: "/ws/code-repo",
        reposRootDir: "/ws/repos",
        spawnImpl,
        writeFileSyncImpl: () => undefined,
        mkdirSyncImpl: () => undefined,
        existsSyncImpl: () => false,
        readdirSyncImpl: () => [],
        readFileSyncImpl: () => "",
      },
      noopReporter,
    );

    // capturedArgs[2] is the ingest subprocess (0=venv, 1=pip, 2=ingest)
    const ingestArgs = capturedArgs[2];
    expect(ingestArgs).toContain("--repos-root");
    const idx = ingestArgs.indexOf("--repos-root");
    expect(ingestArgs[idx + 1]).toBe("/ws/repos");
  });

  it("omits --repos-root when reposRootDir is absent", async () => {
    const capturedArgs: string[][] = [];
    const spawnImpl = (cmd: string, args: string[]) => {
      capturedArgs.push([cmd, ...args]);
      return makeFakeProcess(0, ['{"quads":10,"vectors":0,"docPages":0,"durationSec":1}']) as unknown as ChildProcess;
    };

    await kgIngestStep.run(
      makeContext(),
      {
        workspaceDir: tmpDir,
        codeRepoDir: "/ws/code-repo",
        // reposRootDir deliberately absent
        spawnImpl,
        writeFileSyncImpl: () => undefined,
        mkdirSyncImpl: () => undefined,
        existsSyncImpl: () => false,
        readdirSyncImpl: () => [],
        readFileSyncImpl: () => "",
      },
      noopReporter,
    );

    const ingestArgs = capturedArgs[2];
    expect(ingestArgs).not.toContain("--repos-root");
  });
});

// ── dependencyTokenScope round-trip in kg-refresh RunConfigV1 ─────────────────

describe("RunConfigV1 kg-refresh — dependencyTokenScope field", () => {
  it("encodes and decodes dependencyTokenScope installation", () => {
    const encoded = encodeRunConfig({
      v: 1,
      issue: baseIssue,
      runnerPhase: "kg-refresh",
      dependencyTokenScope: "installation",
    });
    const decoded = decodeRunConfig(encoded);
    expect(decoded.dependencyTokenScope).toBe("installation");
  });

  it("dependencyTokenScope is absent when not provided", () => {
    const encoded = encodeRunConfig({ v: 1, issue: baseIssue, runnerPhase: "kg-refresh" });
    const decoded = decodeRunConfig(encoded);
    expect(decoded.dependencyTokenScope).toBeUndefined();
  });

  it("dependencyTokenScope and kgSourceRepo both survive pickKnownKeys", () => {
    const encoded = encodeRunConfig({
      v: 1,
      issue: baseIssue,
      runnerPhase: "kg-refresh",
      kgSourceRepo: "BuildDownAI/knowledge-graph-ai-implement",
      dependencyTokenScope: "installation",
    });
    const decoded = decodeRunConfig(encoded);
    expect(decoded.kgSourceRepo).toBe("BuildDownAI/knowledge-graph-ai-implement");
    expect(decoded.dependencyTokenScope).toBe("installation");
  });
});

// ── kg-refresh pipeline step order (real pipelines/kg-refresh.yml) ────────────

describe("kg-refresh pipeline definition step order", () => {
  it("includes dependency-auth, clone-code-repo, clone-secondary-repos, and kg-ingest in correct position", () => {
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml");
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).toEqual([
      "clone",
      "dependency-auth",
      "clone-code-repo",
      "clone-secondary-repos",
      "kg-tracker-data",
      "kg-ingest",
      "feedback-loop",
      "kg-snapshot-push",
    ]);
  });

  it("clone-code-repo step has type clone", () => {
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml");
    const step = pipeline.steps.find((s) => s.id === "clone-code-repo");
    expect(step?.type).toBe("clone");
  });

  it("dependency-auth step has type custom and moduleId dependency-auth", () => {
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml");
    const step = pipeline.steps.find((s) => s.id === "dependency-auth");
    expect(step?.type).toBe("custom");
    expect(step?.moduleId).toBe("dependency-auth");
  });
});

// ── clone-code-repo wiring (applyWiring) ─────────────────────────────────────

const KG_REFRESH_FULL_PIPELINE_YAML = `id: kg-refresh
steps:
  - id: clone
    type: clone
  - id: dependency-auth
    type: custom
    moduleId: dependency-auth
  - id: clone-code-repo
    type: clone
  - id: kg-tracker-data
    type: custom
    moduleId: kg-tracker-data
  - id: feedback-loop
    type: custom
    moduleId: feedback-loop
  - id: kg-snapshot-push
    type: custom
    moduleId: kg-snapshot-push
`;

describe("applyWiring for clone-code-repo", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kgwire-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skip returns true when sources.yml has no code_repo", () => {
    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_REFRESH_FULL_PIPELINE_YAML,
    });
    const step = pipeline.steps.find((s) => s.id === "clone-code-repo");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: tmpDir });
    // No sources.yml in tmpDir → skip
    expect(step!.skip!(ctx)).toBe(true);
  });

  it("skip returns false when sources.yml declares code_repo and dependency-auth acquired", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo: BuildDownAI/AI-Implement\n");

    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_REFRESH_FULL_PIPELINE_YAML,
    });
    const step = pipeline.steps.find((s) => s.id === "clone-code-repo");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: tmpDir });
    ctx.setOutputs("dependency-auth", { acquired: true });
    expect(step!.skip!(ctx)).toBe(false);
  });

  it("skip returns true when dependency-auth acquired=false even with code_repo present", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo: BuildDownAI/AI-Implement\n");

    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_REFRESH_FULL_PIPELINE_YAML,
    });
    const step = pipeline.steps.find((s) => s.id === "clone-code-repo");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: tmpDir });
    ctx.setOutputs("dependency-auth", { acquired: false });
    expect(step!.skip!(ctx)).toBe(true);
  });

  it("skip returns true when dependency-auth never ran (no outputs) even with code_repo present", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo: BuildDownAI/AI-Implement\n");

    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_REFRESH_FULL_PIPELINE_YAML,
    });
    const step = pipeline.steps.find((s) => s.id === "clone-code-repo");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: tmpDir });
    // dependency-auth outputs deliberately not set (simulates no scope / missing progress token)
    expect(step!.skip!(ctx)).toBe(true);
  });

  it("inputs include repoOwner, repoRepo, targetDir and empty githubToken", () => {
    writeFileSync(join(tmpDir, "sources.yml"), "code_repo: BuildDownAI/AI-Implement\n");

    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_REFRESH_FULL_PIPELINE_YAML,
    });
    const step = pipeline.steps.find((s) => s.id === "clone-code-repo");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: tmpDir });
    const inputs = ctx.resolveInputs(step!.inputs);

    expect(inputs.repoOwner).toBe("BuildDownAI");
    expect(inputs.repoRepo).toBe("AI-Implement");
    expect(inputs.targetDir).toBe("code-repo");
    expect(inputs.githubToken).toBe("");
    expect(inputs.workspaceDir).toBe(tmpDir);
  });

  it("emits console.warn when sources.yml has no code_repo and skip returns true", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
        existsSyncImpl: () => false,
        readFileSyncImpl: () => KG_REFRESH_FULL_PIPELINE_YAML,
      });
      const step = pipeline.steps.find((s) => s.id === "clone-code-repo");
      expect(step).toBeDefined();

      const ctx = makeContext();
      ctx.setOutputs("clone", { workspaceDir: tmpDir });
      // tmpDir has no sources.yml
      expect(step!.skip!(ctx)).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        "[clone-code-repo] sources.yml has no code_repo.slug — skipping",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not emit console.warn when sources.yml has mapping-form code_repo and dependency-auth acquired", () => {
    writeFileSync(
      join(tmpDir, "sources.yml"),
      "code_repo:\n  slug: BuildDownAI/AI-Implement\n",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
        existsSyncImpl: () => false,
        readFileSyncImpl: () => KG_REFRESH_FULL_PIPELINE_YAML,
      });
      const step = pipeline.steps.find((s) => s.id === "clone-code-repo");
      expect(step).toBeDefined();

      const ctx = makeContext();
      ctx.setOutputs("clone", { workspaceDir: tmpDir });
      ctx.setOutputs("dependency-auth", { acquired: true });
      expect(step!.skip!(ctx)).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("skip returns false when sources.yml uses mapping form and dependency-auth acquired", () => {
    writeFileSync(
      join(tmpDir, "sources.yml"),
      "code_repo:\n  slug: BuildDownAI/AI-Implement\n  path: ../AI-Implement\n",
    );

    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_REFRESH_FULL_PIPELINE_YAML,
    });
    const step = pipeline.steps.find((s) => s.id === "clone-code-repo");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: tmpDir });
    ctx.setOutputs("dependency-auth", { acquired: true });
    expect(step!.skip!(ctx)).toBe(false);
  });

  it("inputs resolve repoOwner and repoRepo from mapping-form code_repo.slug", () => {
    writeFileSync(
      join(tmpDir, "sources.yml"),
      "code_repo:\n  slug: BuildDownAI/AI-Implement\n  path: ../AI-Implement\n",
    );

    const pipeline = loadPipelineDefinition("pipelines/kg-refresh.yml", {
      existsSyncImpl: () => false,
      readFileSyncImpl: () => KG_REFRESH_FULL_PIPELINE_YAML,
    });
    const step = pipeline.steps.find((s) => s.id === "clone-code-repo");
    expect(step).toBeDefined();

    const ctx = makeContext();
    ctx.setOutputs("clone", { workspaceDir: tmpDir });
    const inputs = ctx.resolveInputs(step!.inputs);

    expect(inputs.repoOwner).toBe("BuildDownAI");
    expect(inputs.repoRepo).toBe("AI-Implement");
  });
});

// ── dependency-auth step registered and dependencyTokenScope threaded ─────────

describe("runKgRefresh — dependency-auth step and dependencyTokenScope", () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kgdep-"));
    originalEnv = { ...process.env };
    process.env.GITHUB_OWNER = "org";
    process.env.GITHUB_REPO = "kg-repo";
    process.env.GITHUB_TOKEN = "tok";
    process.env.GITHUB_DEFAULT_BRANCH = "main";
    process.env.WORKSPACE_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const k of ["GITHUB_OWNER", "GITHUB_REPO", "GITHUB_TOKEN", "GITHUB_DEFAULT_BRANCH", "WORKSPACE_DIR", "AI_IMPLEMENT_RUN_CONFIG"]) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("dependency-auth step override is called when dependencyTokenScope is set in run_config", async () => {
    const encoded = encodeRunConfig({
      v: 1,
      issue: { id: "kg-refresh", identifier: "KG-REFRESH", title: "KG ingest", description: "" },
      runnerPhase: "kg-refresh",
      dependencyTokenScope: "installation",
    });
    process.env.AI_IMPLEMENT_RUN_CONFIG = encoded;

    let depAuthCalled = false;
    const capturingDepAuth: StepModule = {
      run: async () => {
        depAuthCalled = true;
        return { acquired: false, expiresAt: null };
      },
    };

    await runKgRefresh({
      workspaceDir: tmpDir,
      stepsOverride: {
        clone: makeStepModule({ workspaceDir: tmpDir, repoOwner: "org", repoRepo: "repo", githubToken: "tok", clonedRef: "abc" }),
        dependencyAuth: capturingDepAuth,
        kgIngest: makeStepModule({ statsFile: null }),
        feedbackLoop: makeStepModule({ approved: false }),
        kgSnapshotPush: makeStepModule({ snapshotPushed: true, commitSha: "sha123" }),
      },
      reporter: { report: async () => undefined },
    });

    expect(depAuthCalled).toBe(true);
  });

  it("dependencyTokenScope from run_config is threaded into pipeline context", async () => {
    const encoded = encodeRunConfig({
      v: 1,
      issue: { id: "kg-refresh", identifier: "KG-REFRESH", title: "KG ingest", description: "" },
      runnerPhase: "kg-refresh",
      kgSourceRepo: "BuildDownAI/knowledge-graph-ai-implement",
      dependencyTokenScope: "installation",
    });
    process.env.AI_IMPLEMENT_RUN_CONFIG = encoded;

    let capturedScope: unknown;
    const capturingDepAuth: StepModule = {
      run: async (ctx) => {
        capturedScope = ctx.data.dependencyTokenScope;
        return { acquired: false, expiresAt: null };
      },
    };

    await runKgRefresh({
      workspaceDir: tmpDir,
      stepsOverride: {
        clone: makeStepModule({ workspaceDir: tmpDir, repoOwner: "org", repoRepo: "repo", githubToken: "tok", clonedRef: "abc" }),
        dependencyAuth: capturingDepAuth,
        kgIngest: makeStepModule({ statsFile: null }),
        feedbackLoop: makeStepModule({ approved: false }),
        kgSnapshotPush: makeStepModule({ snapshotPushed: true, commitSha: "sha123" }),
      },
      reporter: { report: async () => undefined },
    });

    expect(capturedScope).toBe("installation");
  });

  it("dependency-auth step is skipped and pipeline succeeds when run_config has no dependencyTokenScope", async () => {
    // No AI_IMPLEMENT_RUN_CONFIG → dependencyTokenScope is undefined → dep-auth skip fires
    let depAuthCalled = false;
    const capturingDepAuth: StepModule = {
      run: async () => {
        depAuthCalled = true;
        return { acquired: false, expiresAt: null };
      },
    };

    const result = await runKgRefresh({
      workspaceDir: tmpDir,
      stepsOverride: {
        clone: makeStepModule({ workspaceDir: tmpDir, repoOwner: "org", repoRepo: "repo", githubToken: "tok", clonedRef: "abc" }),
        dependencyAuth: capturingDepAuth,
        kgIngest: makeStepModule({ statsFile: null }),
        feedbackLoop: makeStepModule({ approved: false }),
        kgSnapshotPush: makeStepModule({ snapshotPushed: true, commitSha: "sha123" }),
      },
      reporter: { report: async () => undefined },
    });

    expect(depAuthCalled).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});
