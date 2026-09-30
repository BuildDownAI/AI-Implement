/**
 * Contract: kg-refresh envelope runnerCallbackUrl is the bare base URL.
 * Every runner-side client appends its own path segment.
 *
 * Served routes (src/index.ts):
 *   POST /runner/result
 *   POST /api/runner/kg-tracker-data
 *   POST /api/runner/dependency-token
 *   GET  /runner/planning-context
 *
 * This file is red on the pre-fix code (where the envelope carried
 * BASE + "/api/runner/result") and green after the fix.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeKgRefresh } from "../kg-refresh.js";
import { decodeRunConfig } from "../run-config.js";
import { postRunnerResult } from "../runner-result.js";
import { kgTrackerDataStep } from "../pipeline/steps/kg-tracker-data.js";

const BASE = "http://orchestrator.test";
const SNAPSHOT_SHA = "abc123def456abc123def456abc123def456abc1";
const NEW_SNAPSHOT_SHA = "999newsha000999newsha000999newsha000999n";
const OLD_STAMP = "2026-08-20T00:10:10+00:00";
const NEW_STAMP = "2026-08-24T12:00:00+00:00";

// Routes served by src/index.ts — every resolved kg-refresh callback path must be in this set.
const SERVED_ROUTES = new Set([
  "POST /runner/result",
  "POST /api/runner/kg-tracker-data",
  "POST /api/runner/dependency-token",
  "GET /runner/planning-context",
]);

function makeTarball(dir: string): Buffer {
  const wrap = mkdtempSync(join(tmpdir(), "kgtar-"));
  const top = join(wrap, "repo");
  mkdirSync(top, { recursive: true });
  execSync(`cp -R ${dir}/. ${top}/`);
  const out = join(wrap, "src.tar.gz");
  execSync(`tar -czf ${out} -C ${wrap} repo`);
  return readFileSync(out) as Buffer;
}

describe("kg-refresh callback-URL contract", () => {
  let dataRoot: string;
  let fixtureRepo: string;
  let tarball: Buffer;
  let dispatchRun: ReturnType<typeof vi.fn>;
  let mintRunTokenFn: ReturnType<typeof vi.fn>;
  let restart: ReturnType<typeof vi.fn>;
  let materialize: ReturnType<typeof vi.fn>;
  let servedStamp: string;
  let canary: { count: number; degraded: boolean };

  const mcpToolCall = vi.fn(async (_url: string, tool: string) => {
    if (tool === "kg_neighbors") {
      return { edges: [{ predicate_iri: "http://purl.org/dc/terms/modified", neighbor: servedStamp }] };
    }
    if (tool === "kg_hybrid_search") return { count: canary.count, degraded: canary.degraded, results: [] };
    throw new Error(`unexpected tool ${tool}`);
  });

  function buildHandle() {
    dispatchRun = vi.fn(async () => ({ machineNonce: "test-nonce" }));
    mintRunTokenFn = vi.fn()
      .mockReturnValueOnce({ token: "run-tok", dispatchId: "disp-1" })
      .mockReturnValue({ token: "progress-tok", dispatchId: "disp-1" });
    return makeKgRefresh({
      sidecar: { restart: restart as unknown as () => Promise<void> },
      githubAppId: "1",
      githubAppPrivateKey: "key",
      kgSourceRepo: "TestOrg/test-kg",
      dataRoot,
      kgDir: "/nonexistent-kg",
      sidecarMcpUrl: "http://127.0.0.1:1/mcp",
      minFreeBytes: 1000,
      deployHeld: () => false,
      freeBytes: () => 10_000,
      mintToken: vi.fn(async () => ({ token: "tok", expiresAt: "" })) as never,
      fetchTarball: vi.fn(async () => tarball) as never,
      fetchDefaultBranch: vi.fn(async () => "main") as never,
      fetchWorkflowFile: vi.fn(async () => ({
        status: 200,
        content: "on:\n  workflow_dispatch:\n    inputs:\n      run_config:\n        required: true\n      runner_phase:\n        required: false\n",
      })) as never,
      // First call returns same SHA as recorded (→ ingest-needed → dispatch fires).
      fetchSnapshotCommitSha: vi.fn()
        .mockResolvedValueOnce(SNAPSHOT_SHA)
        .mockResolvedValue(NEW_SNAPSHOT_SHA) as never,
      persistSnapshotSha: vi.fn() as never,
      loadSnapshotSha: vi.fn().mockReturnValue(SNAPSHOT_SHA) as never,
      materialize: materialize as never,
      mcpToolCall: mcpToolCall as never,
      canaryDeadlineMs: 300,
      canaryRetryMs: 30,
      runnerCallbackBaseUrl: BASE,
      runnerTokenSecret: "secret",
      resolveMappingTeamKey: (repo: string) => repo === "TestOrg/test-kg" ? { teamKey: "KGA", dependencyTokenScope: "installation" } : undefined,
      mintRunTokenFn: mintRunTokenFn as never,
      dispatchRun: dispatchRun as never,
      fetchCommitVisible: vi.fn(async () => true) as never,
      snapshotCommitRetryMs: 0,
    });
  }

  async function waitForDispatch(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (dispatchRun.mock.calls.length > 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("dispatchRun was never called");
  }

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "kgroot-"));
    fixtureRepo = mkdtempSync(join(tmpdir(), "kgrepo-"));
    writeFileSync(join(fixtureRepo, "sources.yml"), `namespace: https://kg.test.example/\n`);
    mkdirSync(join(fixtureRepo, "snapshot"), { recursive: true });
    writeFileSync(join(fixtureRepo, "snapshot", "embeddings.npz"), "vectors");
    writeFileSync(join(fixtureRepo, "snapshot", "embeddings.meta.json"), "{}");
    tarball = makeTarball(fixtureRepo);
    servedStamp = OLD_STAMP;
    canary = { count: 3, degraded: false };
    restart = vi.fn(async () => { servedStamp = NEW_STAMP; });
    materialize = vi.fn(async (_python: string, cwd: string) => {
      mkdirSync(join(cwd, "out"), { recursive: true });
      writeFileSync(join(cwd, "out", "graph.trig"), "@prefix kg: <x> .");
      writeFileSync(join(cwd, "out", "embeddings.npz"), "vectors");
    });
    process.env.KG_SIDECAR_URL = "http://127.0.0.1:1/mcp";
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(fixtureRepo, { recursive: true, force: true });
    delete process.env.KG_SIDECAR_URL;
    vi.clearAllMocks();
  });

  // ---- Envelope contract ----

  it("dispatch runConfig carries bare base as runnerCallbackUrl (no suffix)", async () => {
    const handle = buildHandle();
    await handle.trigger();
    await waitForDispatch();

    const call = dispatchRun.mock.calls[0][0] as { runConfig: string };
    const cfg = decodeRunConfig(call.runConfig);
    expect(cfg.runnerCallbackUrl).toBe(BASE);
  });

  it("runnerCallbackUrl in envelope does not contain /api/runner/result", async () => {
    const handle = buildHandle();
    await handle.trigger();
    await waitForDispatch();

    const call = dispatchRun.mock.calls[0][0] as { runConfig: string };
    const cfg = decodeRunConfig(call.runConfig);
    expect(cfg.runnerCallbackUrl).not.toContain("/api/runner/result");
  });

  // ---- Runner-side client contracts ----

  it("postRunnerResult resolves to POST /runner/result — a served route", async () => {
    const captured: string[] = [];
    const mockFetch = vi.fn(async (url: string) => {
      captured.push(url);
      return new Response("{}", { status: 200 });
    });

    const savedToken = process.env.RUN_TOKEN;
    process.env.RUN_TOKEN = "tok-123";
    try {
      await postRunnerResult({
        phase: "kg-refresh",
        workspaceDir: dataRoot,
        outcome: "success",
        callbackUrl: BASE,
        fetchImpl: mockFetch as typeof fetch,
      });
    } finally {
      if (savedToken === undefined) delete process.env.RUN_TOKEN;
      else process.env.RUN_TOKEN = savedToken;
    }

    expect(captured).toHaveLength(1);
    const path = new URL(captured[0]).pathname;
    expect(path).toBe("/runner/result");
    expect(SERVED_ROUTES.has(`POST ${path}`)).toBe(true);
  });

  it("kgTrackerDataStep resolves to POST /api/runner/kg-tracker-data — a served route", async () => {
    const captured: string[] = [];
    const mockFetch = vi.fn(async (url: string) => {
      captured.push(url);
      return new Response(
        JSON.stringify({ issues: [{ id: "1", identifier: "AII-1", title: "t", description: "", state: { name: "Todo", type: "unstarted" }, comments: [] }], pageInfo: { hasNextPage: false, endCursor: null } }),
        { status: 200 },
      );
    });

    const savedToken = process.env.RUN_PROGRESS_TOKEN;
    process.env.RUN_PROGRESS_TOKEN = "prog-tok";
    try {
      await kgTrackerDataStep.run(
        {} as never,
        {
          callbackUrl: BASE,
          workspaceDir: dataRoot,
          fetchImpl: mockFetch as typeof fetch,
          writeFileSyncImpl: () => {},
          sourcesYmlReaderImpl: () => ["AII"],
        },
        {} as never,
      );
    } finally {
      if (savedToken === undefined) delete process.env.RUN_PROGRESS_TOKEN;
      else process.env.RUN_PROGRESS_TOKEN = savedToken;
    }

    expect(captured).toHaveLength(1);
    const path = new URL(captured[0]).pathname;
    expect(path).toBe("/api/runner/kg-tracker-data");
    expect(SERVED_ROUTES.has(`POST ${path}`)).toBe(true);
  });
});

// AII-899: the kg-refresh result/progress callbacks verify without consuming and hand off to the workflow.
describe("kg-refresh callback is verify-only and reports to the KgRefresh workflow (AII-899)", () => {
  const SECRET = "s3cret";
  const SLUG = "acme/kg-source";
  let dbPath: string;
  let dedup: typeof import("../dedup.js");
  let tokens: typeof import("../runner-tokens.js");
  let callback: typeof import("../runner-callback.js");

  beforeEach(async () => {
    vi.resetModules();
    dbPath = join(tmpdir(), `kg-cb-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    process.env.DEDUP_DB_PATH = dbPath;
    dedup = await import("../dedup.js");
    tokens = await import("../runner-tokens.js");
    callback = await import("../runner-callback.js");
    dedup.getDb();
  });

  afterEach(() => {
    dedup.closeDb();
    rmSync(dbPath, { force: true });
  });

  function client(over: Record<string, unknown> = {}) {
    return {
      repoStatus: vi.fn(async () => ({ status: "accepted", value: { triggerId: "trg-1", startedAt: 1 } })),
      report: vi.fn(async () => ({ status: "accepted", value: { status: "accepted" } })),
      progress: vi.fn(async () => ({ status: "accepted" })),
      ...over,
    };
  }

  function mint(audience: "result" | "progress" = "result", phase: "kg-refresh" | "planning" = "kg-refresh") {
    return tokens.mintRunToken({
      issueId: "kg", phase, audience, secret: SECRET, ttlSeconds: 600, mappingTeamKey: "",
    } as never);
  }

  const resultBody = { phase: "kg-refresh", outcome: "success", comments: [], snapshotPr: 7, snapshotCommit: "abc" } as never;

  function run(token: string, c: ReturnType<typeof client>, body = resultBody) {
    return callback.handleRunnerResult({
      authorization: `Bearer ${token}`,
      body,
      secret: SECRET,
      resolveProvider: async () => null,
      kgRefreshClient: c as never,
      kgSourceRepo: SLUG,
    });
  }

  function consumedAt(dispatchId: string): number | null {
    const row = dedup.getDb().prepare("SELECT consumed_at FROM runner_tokens WHERE dispatch_id = ? AND audience = 'result'").get(dispatchId) as { consumed_at: number | null };
    return row.consumed_at;
  }

  it("accepts an identical callback twice without consuming the token", async () => {
    const { token, dispatchId } = mint();
    const c = client();
    expect(await run(token, c)).toEqual({ status: 200, body: { acknowledged: true } });
    expect(consumedAt(dispatchId)).toBeNull();
    expect(await run(token, c)).toEqual({ status: 200, body: { acknowledged: true } });
    expect(consumedAt(dispatchId)).toBeNull();
    expect(c.repoStatus).toHaveBeenCalledWith("acme/kg-source");
    expect(c.report).toHaveBeenCalledWith(
      "trg-1",
      expect.objectContaining({ ok: true, snapshotPr: 7, snapshotCommit: "abc" }),
      { idempotencyKey: dispatchId },
    );
  });

  it("refuses bad signature, wrong audience, and unknown rows with 401 and never calls the client", async () => {
    const c = client();
    const { token } = mint();
    expect((await run(`${token}x`, c)).status).toBe(401);
    expect((await run(mint("progress").token, c)).status).toBe(401);
    const forged = tokens.mintRunToken({ issueId: "kg", phase: "kg-refresh", audience: "result", secret: SECRET, ttlSeconds: 600, mappingTeamKey: "" } as never);
    dedup.getDb().prepare("DELETE FROM runner_tokens WHERE dispatch_id = ?").run(forged.dispatchId);
    expect((await run(forged.token, c)).status).toBe(401);
    expect(c.repoStatus).not.toHaveBeenCalled();
    expect(c.report).not.toHaveBeenCalled();
  });

  it("maps unavailable to 503 and conflict to 409", async () => {
    const { token } = mint();
    expect((await run(token, client({ report: vi.fn(async () => ({ status: "unavailable" })) }))).status).toBe(503);
    expect((await run(token, client({ report: vi.fn(async () => ({ status: "conflict" })) }))).status).toBe(409);
    expect((await run(token, client({ repoStatus: vi.fn(async () => ({ status: "unavailable" })) }))).status).toBe(503);
  });

  it("answers 409 no-refresh-in-flight when no marker exists, without reporting", async () => {
    const { token } = mint();
    const c = client({ repoStatus: vi.fn(async () => ({ status: "accepted", value: null })) });
    const out = await run(token, c);
    expect(out).toEqual({ status: 409, body: { error: "no-refresh-in-flight" } });
    expect(c.report).not.toHaveBeenCalled();
  });

  it("answers 503 when the client or source repo is not configured", async () => {
    const { token } = mint();
    const out = await callback.handleRunnerResult({
      authorization: `Bearer ${token}`, body: resultBody, secret: SECRET, resolveProvider: async () => null,
    });
    expect(out.status).toBe(503);
  });

  it("progress resolves the triggerId then calls progress(triggerId)", async () => {
    const { token } = mint("progress");
    const c = client();
    const out = await callback.handleRunnerProgress({
      authorization: `Bearer ${token}`, body: {}, secret: SECRET, kgRefreshClient: c as never, kgSourceRepo: SLUG,
    });
    expect(out).toEqual({ status: 200, body: { acknowledged: true } });
    expect(c.progress).toHaveBeenCalledWith("trg-1");

    const none = client({ repoStatus: vi.fn(async () => ({ status: "accepted", value: null })) });
    const out2 = await callback.handleRunnerProgress({
      authorization: `Bearer ${token}`, body: {}, secret: SECRET, kgRefreshClient: none as never, kgSourceRepo: SLUG,
    });
    expect(out2.status).toBe(409);
    const down = client({ progress: vi.fn(async () => ({ status: "unavailable" })) });
    const out3 = await callback.handleRunnerProgress({
      authorization: `Bearer ${token}`, body: {}, secret: SECRET, kgRefreshClient: down as never, kgSourceRepo: SLUG,
    });
    expect(out3.status).toBe(503);
  });
});
