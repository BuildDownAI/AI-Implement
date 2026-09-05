import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { encodeRunConfig, decodeRunConfig } from "../run-config.js";
import { buildEnvelopeDispatchInputs } from "../github.js";
import type { RepoMapping } from "../config.js";

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

import { kgSnapshotPushStep, KgSnapshotMissingError, KgSnapshotStaleError } from "../pipeline/steps/kg-snapshot-push.js";
import { kgTrackerDataStep, KgTrackerDataFetchError } from "../pipeline/steps/kg-tracker-data.js";
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
      },
      noopReporter,
    );
    expect(result).toEqual({ fetched: true, issueCount: 1 });
    expect(written).toHaveLength(1);
    expect(written[0][0]).toBe(join(tmpDir, "tracker-data.json"));
    expect(JSON.parse(written[0][1])).toEqual(issues);
  });

  it("paginates and concatenates issues across multiple pages", async () => {
    process.env.RUN_PROGRESS_TOKEN = "test-token";
    const page1Issues = [{ id: "1" }];
    const page2Issues = [{ id: "2" }];
    const fetchCalls: Array<{ cursor?: string }> = [];
    let callIndex = 0;
    const fetchImpl: typeof fetch = async (_, init) => {
      const body = init?.body ? JSON.parse(init.body as string) as { cursor?: string } : {};
      fetchCalls.push({ cursor: body.cursor });
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
      },
      noopReporter,
    );
    expect(result).toEqual({ fetched: true, issueCount: 2 });
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].cursor).toBeUndefined();
    expect(fetchCalls[1].cursor).toBe("cursor1");
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
        { callbackUrl: "http://orch", workspaceDir: tmpDir, fetchImpl },
        noopReporter,
      ),
    ).rejects.toBeInstanceOf(KgTrackerDataFetchError);
  });

  it("sends Authorization: Bearer <token> on each request", async () => {
    process.env.RUN_PROGRESS_TOKEN = "my-secret-token";
    const capturedAuth: string[] = [];
    const fetchImpl: typeof fetch = async (_, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedAuth.push(headers?.["Authorization"] ?? "");
      return { ok: true, status: 200, json: async () => makeTrackerPage([], false) } as Response;
    };
    await kgTrackerDataStep.run(
      makeContext(),
      {
        callbackUrl: "http://orch",
        workspaceDir: tmpDir,
        fetchImpl,
        writeFileSyncImpl: () => {},
      },
      noopReporter,
    );
    expect(capturedAuth).toHaveLength(1);
    expect(capturedAuth[0]).toBe("Bearer my-secret-token");
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
        feedbackLoop: makeStepModule({ approved: false }),
        kgSnapshotPush: makeStepModule({}, new KgSnapshotMissingError("no parts")),
      },
      reporter: { report: async () => undefined },
    });
    expect(result.exitCode).toBe(1);
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

// ── KG-REFRESH.md playbook — tracker-data step ────────────────────────────────

describe("KG-REFRESH.md playbook — tracker-data step", () => {
  const playbookPath = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "..",
    "workflows",
    "KG-REFRESH.md",
  );

  it("states that tracker-data.json is written by the pipeline before the feedback loop", () => {
    const playbook = readFileSync(playbookPath, "utf-8");
    expect(playbook).toContain("tracker-data.json");
    // Pipeline pre-fetches; agent does not invoke the shell script directly
    expect(playbook).not.toContain("/app/session/fetch-kg-tracker-data.sh");
  });

  it("documents the --tracker-data flag for the ingest invocation", () => {
    const playbook = readFileSync(playbookPath, "utf-8");
    expect(playbook).toContain("--tracker-data");
  });

  it("includes a capability check before passing --tracker-data to the ingest", () => {
    const playbook = readFileSync(playbookPath, "utf-8");
    expect(playbook).toContain("TRACKER_DATA_SUPPORTED");
  });

  it("instructs the agent to proceed when tracker-data.json is absent (local/dev runs)", () => {
    const playbook = readFileSync(playbookPath, "utf-8");
    expect(playbook).toContain("absent");
  });
});
