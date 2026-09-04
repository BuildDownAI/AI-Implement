import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeKgRefresh, MATERIALIZE_ARGS, type KgRefreshHandle, type KgRefreshStage } from "../kg-refresh.js";
import { COMPLETION_MARKER } from "../kg-sidecar.js";

const NAMESPACE = "https://kg.test.example/";
const OLD_STAMP = "2026-08-20T00:10:10+00:00";
const NEW_STAMP = "2026-08-24T12:00:00+00:00";
// GitHub API always returns Z-suffix; the graph dcterms:modified uses +00:00.
// Use Z-suffixed constants wherever fetchSnapshotCommitDate is mocked.
const OLD_STAMP_Z = "2026-08-20T00:10:10Z"; // same instant as OLD_STAMP
const NEW_STAMP_Z = "2026-08-24T12:00:00Z"; // same instant as NEW_STAMP
// Always newer than any stamp produced in tests — default for fetchSnapshotCommitDate.
const FUTURE_STAMP_Z = "2099-01-01T00:00:00Z";

function makeTarball(dir: string): Buffer {
  // extractSource strips one leading component, so wrap in a top-level dir.
  const wrap = mkdtempSync(join(tmpdir(), "kgtar-"));
  const top = join(wrap, "repo");
  mkdirSync(top, { recursive: true });
  // `dir/.` copies CONTENTS on both BSD (macOS) and GNU (Linux) cp — a bare
  // trailing slash nests the directory on GNU, which broke this fixture in CI.
  execSync(`cp -R ${dir}/. ${top}/`);
  const out = join(wrap, "src.tar.gz");
  execSync(`tar -czf ${out} -C ${wrap} repo`);
  return readFileSync(out) as Buffer;
}

describe("kg-refresh", () => {
  let dataRoot: string;
  let fixtureRepo: string;
  let tarball: Buffer;
  let servedStamp: string;
  let canary: { count: number; degraded: boolean };
  let sidecarUp: boolean;
  let restart: ReturnType<typeof vi.fn>;
  let materialize: ReturnType<typeof vi.fn>;
  let handle: KgRefreshHandle;
  let deployHeld: boolean;
  let free: number;

  const mcpToolCall = vi.fn(async (_url: string, tool: string) => {
    if (!sidecarUp) throw new Error("ECONNREFUSED");
    if (tool === "kg_neighbors") {
      return {
        edges: [
          { predicate_iri: "http://purl.org/dc/terms/modified", neighbor: servedStamp },
        ],
      };
    }
    if (tool === "kg_hybrid_search") return { count: canary.count, degraded: canary.degraded, results: [] };
    throw new Error(`unexpected tool ${tool}`);
  });

  function build(overrides: Record<string, unknown> = {}) {
    handle = makeKgRefresh({
      sidecar: { restart: restart as unknown as () => Promise<void> },
      githubAppId: "1",
      githubAppPrivateKey: "key",
      kgSourceRepo: "TestOrg/test-kg",
      dataRoot,
      kgDir: "/nonexistent-kg",
      sidecarMcpUrl: "http://127.0.0.1:1/mcp",
      minFreeBytes: 1000,
      deployHeld: () => deployHeld,
      freeBytes: () => free,
      mintToken: vi.fn(async () => ({ token: "tok", expiresAt: "" })) as never,
      fetchTarball: vi.fn(async () => tarball) as never,
      fetchDefaultBranch: vi.fn(async () => "main") as never,
      // Default: always newer than any served stamp in these tests.
      fetchSnapshotCommitDate: vi.fn(async () => FUTURE_STAMP_Z) as never,
      materialize: materialize as never,
      mcpToolCall: mcpToolCall as never,
      canaryDeadlineMs: 300,
      canaryRetryMs: 30,
      ...overrides,
    });
  }

  async function waitDone(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (!(await handle.status()).running) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("refresh did not finish");
  }

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "kgroot-"));
    fixtureRepo = mkdtempSync(join(tmpdir(), "kgrepo-"));
    writeFileSync(join(fixtureRepo, "sources.yml"), `namespace: ${NAMESPACE}\n`);
    mkdirSync(join(fixtureRepo, "snapshot"), { recursive: true });
    tarball = makeTarball(fixtureRepo);

    servedStamp = OLD_STAMP;
    canary = { count: 3, degraded: false };
    sidecarUp = true;
    deployHeld = false;
    free = 10_000;
    process.env.KG_SIDECAR_URL = "http://127.0.0.1:1/mcp";

    // A successful restart serves the new graph: stamp flips to the staged one.
    restart = vi.fn(async () => {
      servedStamp = NEW_STAMP;
    });
    // Materialize produces the loadable form inside the fetched tree (KGB-9 contract).
    materialize = vi.fn(async (_python: string, cwd: string) => {
      mkdirSync(join(cwd, "out"), { recursive: true });
      writeFileSync(join(cwd, "out", "graph.trig"), "@prefix kg: <x> .");
      writeFileSync(join(cwd, "out", "embeddings.npz"), "vectors");
    });
    build();
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(fixtureRepo, { recursive: true, force: true });
    delete process.env.KG_SIDECAR_URL;
    vi.clearAllMocks();
  });

  it("returns 202, refreshes, and records the stamp movement", async () => {
    const r = await handle.trigger();
    expect(r.status).toBe(202);
    await waitDone();

    const s = await handle.status();
    expect(s.lastRefresh?.ok).toBe(true);
    expect(s.lastRefresh?.stampBefore).toBe(OLD_STAMP);
    expect(s.lastRefresh?.stampAfter).toBe(NEW_STAMP);
    expect(restart).toHaveBeenCalledTimes(1);

    const current = join(dataRoot, "current");
    expect(existsSync(join(current, "graph.trig"))).toBe(true);
    expect(existsSync(join(current, "embeddings.npz"))).toBe(true);
    expect(existsSync(join(current, COMPLETION_MARKER))).toBe(true);
    expect(existsSync(join(dataRoot, "fetch"))).toBe(false);
  });

  it("refuses with 409 while a refresh is running", async () => {
    let release: (() => void) | undefined;
    materialize.mockImplementationOnce(async (_p: string, cwd: string) => {
      mkdirSync(join(cwd, "out"), { recursive: true });
      writeFileSync(join(cwd, "out", "graph.trig"), "x");
      writeFileSync(join(cwd, "out", "embeddings.npz"), "y");
      await new Promise<void>((r) => {
        release = r;
      });
    });
    const first = await handle.trigger();
    expect(first.status).toBe(202);
    const second = await handle.trigger();
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("refresh-in-progress");
    // The blocking materialize starts a few awaits into the async run.
    for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 10));
    release!();
    await waitDone();
  });

  it("refuses with 409 while the deploy hold is set, and does not run", async () => {
    deployHeld = true;
    const r = await handle.trigger();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("deploy-in-progress");
    expect(materialize).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("refuses with 507 below the free-space threshold", async () => {
    free = 10;
    const r = await handle.trigger();
    expect(r.status).toBe(507);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("returns 501 with no configured KG source repo", async () => {
    build({ kgSourceRepo: null });
    const r = await handle.trigger();
    expect(r.status).toBe(501);
  });

  it("a crash during staging leaves current untouched and never restarts", async () => {
    const current = join(dataRoot, "current");
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, "graph.trig"), "SERVING");
    writeFileSync(join(current, COMPLETION_MARKER), "ok");

    materialize.mockImplementationOnce(async () => {
      throw new Error("OOM-killed");
    });
    await handle.trigger();
    await waitDone();

    const s = await handle.status();
    expect(s.lastRefresh?.ok).toBe(false);
    expect(s.lastRefresh?.gate).toBe("staging");
    expect(readFileSync(join(current, "graph.trig"), "utf8")).toBe("SERVING");
    expect(existsSync(join(dataRoot, "staging"))).toBe(false);
    expect(restart).not.toHaveBeenCalled();
  });

  it("a failed canary gate reverts to the previous overlay and restarts again", async () => {
    const current = join(dataRoot, "current");
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, "graph.trig"), "OLD-OVERLAY");
    writeFileSync(join(current, COMPLETION_MARKER), "ok");

    restart.mockImplementation(async () => {
      // After the failed swap the canary reports degraded; after revert it recovers.
      canary = restart.mock.calls.length === 1 ? { count: 0, degraded: true } : { count: 3, degraded: false };
    });
    await handle.trigger();
    await waitDone();

    const s = await handle.status();
    expect(s.lastRefresh?.ok).toBe(false);
    expect(s.lastRefresh?.gate).toBe("canary");
    expect(restart).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(current, "graph.trig"), "utf8")).toBe("OLD-OVERLAY");
    expect(existsSync(join(dataRoot, "previous"))).toBe(false);
  });

  it("the canary tolerates a cold sidecar: passes on a retry within the deadline", async () => {
    let calls = 0;
    restart.mockImplementation(async () => {
      servedStamp = NEW_STAMP;
      calls = 0;
    });
    const flaky = vi.fn(async (_url: string, tool: string) => {
      if (tool === "kg_hybrid_search") {
        calls += 1;
        if (calls < 3) throw new Error("mcp request timeout"); // model still loading
        return { count: 3, degraded: false, results: [] };
      }
      return mcpToolCall("u", tool);
    });
    build({ mcpToolCall: flaky as never });
    await handle.trigger();
    await waitDone();
    const s = await handle.status();
    expect(s.lastRefresh?.ok).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("a stamp that did not move fails the stamp gate and reverts", async () => {
    restart.mockImplementation(async () => {
      /* served stamp stays OLD_STAMP */
    });
    await handle.trigger();
    await waitDone();

    const s = await handle.status();
    expect(s.lastRefresh?.ok).toBe(false);
    expect(s.lastRefresh?.gate).toBe("stamp");
    // No previous existed: the failed overlay is withdrawn, baked graph serves.
    expect(existsSync(join(dataRoot, "current"))).toBe(false);
  });

  it("a sidecar that never comes back fails the answers gate", async () => {
    restart.mockImplementation(async () => {
      delete process.env.KG_SIDECAR_URL;
      sidecarUp = false;
    });
    await handle.trigger();
    await waitDone();
    const s = await handle.status();
    expect(s.lastRefresh?.ok).toBe(false);
    expect(s.lastRefresh?.gate).toBe("answers");
  });

  it("retains exactly one previous overlay across successive refreshes", async () => {
    await handle.trigger();
    await waitDone();
    servedStamp = NEW_STAMP;
    const newer = "2026-08-25T00:00:00+00:00";
    restart.mockImplementation(async () => {
      servedStamp = newer;
    });
    await handle.trigger();
    await waitDone();

    const s = await handle.status();
    expect(s.lastRefresh?.ok).toBe(true);
    expect(s.lastRefresh?.stampAfter).toBe(newer);
    expect(existsSync(join(dataRoot, "previous"))).toBe(true);
    expect(existsSync(join(dataRoot, "staging"))).toBe(false);
  });

  it("never reaches an embedding path: the staging command is materialize, full pass", () => {
    expect([...MATERIALIZE_ARGS]).toEqual(["-m", "kg_ingest.materialize"]);
    expect(MATERIALIZE_ARGS.join(" ")).not.toMatch(/embed|cli/);
  });

  it("returns ingest-needed when the source snapshot commit is not newer than the served stamp", async () => {
    build({ fetchSnapshotCommitDate: vi.fn(async () => OLD_STAMP_Z) });
    await handle.trigger();
    await waitDone();

    const s = await handle.status();
    expect(s.lastRefresh?.ok).toBe(false);
    expect(s.lastRefresh?.gate).toBe("ingest-needed");
    expect(s.lastRefresh?.stampBefore).toBe(OLD_STAMP);
    expect(s.lastRefresh?.stampAfter).toBe(OLD_STAMP);
    expect(materialize).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(existsSync(join(dataRoot, "fetch"))).toBe(false);
  });

  it("returns ingest-needed when the snapshot commit is strictly older than the served stamp", async () => {
    // snapshotCommitDate < stampBefore: strictly older is also not newer
    const olderStamp = "2026-08-01T00:00:00Z";
    build({ fetchSnapshotCommitDate: vi.fn(async () => olderStamp) });
    await handle.trigger();
    await waitDone();

    const s = await handle.status();
    expect(s.lastRefresh?.gate).toBe("ingest-needed");
    expect(materialize).not.toHaveBeenCalled();
  });

  it("falls through to a full refresh when fetchSnapshotCommitDate returns null", async () => {
    build({ fetchSnapshotCommitDate: vi.fn(async () => null) });
    await handle.trigger();
    await waitDone();

    const s = await handle.status();
    expect(s.lastRefresh?.ok).toBe(true);
    expect(materialize).toHaveBeenCalled();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("falls through to a full refresh when stampBefore is null (readServedStamp returns null)", async () => {
    const noEdgeMcp = vi.fn(async (_url: string, tool: string) => {
      if (tool === "kg_neighbors") return { edges: [] };
      if (tool === "kg_hybrid_search") return { count: 3, degraded: false, results: [] };
      throw new Error(`unexpected tool ${tool}`);
    });
    // fetchSnapshotCommitDate returns a non-null date, but stampBefore is null → guard does not fire
    build({ mcpToolCall: noEdgeMcp as never, fetchSnapshotCommitDate: vi.fn(async () => NEW_STAMP_Z) });
    await handle.trigger();
    await waitDone();

    // materialize ran — no early exit from the ingest-needed guard
    expect(materialize).toHaveBeenCalled();
  });

  it("absorbs a fetchSnapshotCommitDate throw as a staging failure, not ingest-needed", async () => {
    build({
      fetchSnapshotCommitDate: vi.fn(async () => {
        throw new Error("network timeout");
      }),
    });
    await handle.trigger();
    await waitDone();

    const s = await handle.status();
    expect(s.lastRefresh?.ok).toBe(false);
    expect(s.lastRefresh?.gate).toBe("staging");
    expect(materialize).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("returns ingest-needed when snapshotCommitDate (Z-suffix) is strictly older than served stamp (+00:00) (mixed format, different instants)", async () => {
    // GitHub returns Z; the graph's dcterms:modified uses +00:00. Verify Date.parse
    // normalises both so a strictly-older Z-suffix is correctly identified as not newer
    // even when the two timestamps use different timezone representations.
    servedStamp = NEW_STAMP; // sidecar serves a newer +00:00-format stamp
    build({ fetchSnapshotCommitDate: vi.fn(async () => OLD_STAMP_Z) }); // snapshot is older, Z format
    await handle.trigger();
    await waitDone();

    const s = await handle.status();
    expect(s.lastRefresh?.gate).toBe("ingest-needed");
    expect(materialize).not.toHaveBeenCalled();
  });

  it("GET /api/kg/status reflects ingest-needed gate and running=false after trigger resolves", async () => {
    build({ fetchSnapshotCommitDate: vi.fn(async () => OLD_STAMP_Z) });
    await handle.trigger();
    await waitDone();

    const s = await handle.status();
    expect(s.running).toBe(false);
    expect(s.lastRefresh?.gate).toBe("ingest-needed");
  });

  // ---- AII-495: dispatch-path tests ----------------------------------------

  describe("dispatch path", () => {
    let dispatchRun: ReturnType<typeof vi.fn>;
    let mintRunTokenFn: ReturnType<typeof vi.fn>;
    let fetchCommitVisible: ReturnType<typeof vi.fn>;
    let stageStore: { stage: KgRefreshStage; startedAt: number } | null;
    let persistedStages: Array<{ stage: KgRefreshStage; startedAt: number }>;

    // fetchSnapshotCommitDate: old on first call (→ ingest-needed → dispatch),
    // new on subsequent calls (→ rail proceeds after runner pushes commit).
    function makeSnapshotDateMock() {
      return vi.fn()
        .mockResolvedValueOnce(OLD_STAMP_Z)
        .mockResolvedValue(FUTURE_STAMP_Z);
    }

    function buildDispatch(overrides: Record<string, unknown> = {}) {
      dispatchRun = vi.fn(async () => {});
      mintRunTokenFn = vi.fn(() => ({ token: "run-tok", dispatchId: "disp-1" }));
      fetchCommitVisible = vi.fn(async () => true);
      stageStore = null;
      persistedStages = [];
      handle = makeKgRefresh({
        sidecar: { restart: restart as unknown as () => Promise<void> },
        githubAppId: "1",
        githubAppPrivateKey: "key",
        kgSourceRepo: "TestOrg/test-kg",
        dataRoot,
        kgDir: "/nonexistent-kg",
        sidecarMcpUrl: "http://127.0.0.1:1/mcp",
        minFreeBytes: 1000,
        deployHeld: () => deployHeld,
        freeBytes: () => free,
        mintToken: vi.fn(async () => ({ token: "tok", expiresAt: "" })) as never,
        fetchTarball: vi.fn(async () => tarball) as never,
        fetchDefaultBranch: vi.fn(async () => "main") as never,
        fetchSnapshotCommitDate: makeSnapshotDateMock() as never,
        materialize: materialize as never,
        mcpToolCall: mcpToolCall as never,
        canaryDeadlineMs: 300,
        canaryRetryMs: 30,
        runnerCallbackBaseUrl: "http://localhost:8080",
        runnerTokenSecret: "secret",
        mintRunTokenFn: mintRunTokenFn as never,
        dispatchRun: dispatchRun as never,
        fetchCommitVisible: fetchCommitVisible as never,
        snapshotCommitRetryMs: 0,
        persistStage: (s: KgRefreshStage, t: number) => {
          stageStore = { stage: s, startedAt: t };
          persistedStages.push({ stage: s, startedAt: t });
        },
        loadStage: () => stageStore,
        ...overrides,
      });
    }

    async function waitForStage(targetStage: KgRefreshStage): Promise<void> {
      for (let i = 0; i < 200; i++) {
        if ((await handle.status()).stage === targetStage) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`stage never reached ${targetStage}`);
    }

    it("returns 422 when dispatchRun configured but runnerCallbackBaseUrl missing", async () => {
      buildDispatch({ runnerCallbackBaseUrl: null });
      const r = await handle.trigger();
      expect(r.status).toBe(422);
      expect((r.body as { precondition?: string }).precondition).toBe("callback-unconfigured");
      expect(dispatchRun).not.toHaveBeenCalled();
    });

    it("returns 422 when dispatchRun configured but runnerTokenSecret missing", async () => {
      buildDispatch({ runnerTokenSecret: null });
      const r = await handle.trigger();
      expect(r.status).toBe(422);
      expect((r.body as { precondition?: string }).precondition).toBe("callback-unconfigured");
      expect(dispatchRun).not.toHaveBeenCalled();
    });

    it("dispatches runner when ingest-needed and dispatchRun configured", async () => {
      buildDispatch();
      const r = await handle.trigger();
      expect(r.status).toBe(202);
      await waitForStage("ingest-running");
      expect(dispatchRun).toHaveBeenCalledOnce();
      const call = dispatchRun.mock.calls[0][0] as { runToken: string; dispatchId: string; runConfig: string };
      expect(call.runToken).toBe("run-tok");
      expect(call.dispatchId).toBe("disp-1");
      expect(call.runConfig).toBeTruthy();
      expect((await handle.status()).running).toBe(true);
    });

    it("stage transitions checking → ingest-running when dispatch fires", async () => {
      buildDispatch();
      await handle.trigger();
      await waitForStage("ingest-running");
      expect((await handle.status()).stage).toBe("ingest-running");
    });

    it("second trigger during ingest-running returns 409 refresh-in-progress", async () => {
      buildDispatch();
      await handle.trigger();
      await waitForStage("ingest-running");
      const second = await handle.trigger();
      expect(second.status).toBe(409);
      expect(second.body.error).toBe("refresh-in-progress");
    });

    it("onRunnerComplete failure sets stage to failed and clears running", async () => {
      buildDispatch();
      await handle.trigger();
      await waitForStage("ingest-running");
      handle.onRunnerComplete("failure", { failureCode: "TIMEOUT", failureReason: "job timed out" });
      await waitDone();
      const s = await handle.status();
      expect(s.stage).toBe("failed");
      expect(s.running).toBe(false);
    });

    it("onRunnerComplete success with snapshotCommit verifies commit then runs rail", async () => {
      buildDispatch();
      await handle.trigger();
      await waitForStage("ingest-running");
      handle.onRunnerComplete("success", { snapshotCommit: "abc123" });
      await waitDone();
      expect(fetchCommitVisible).toHaveBeenCalledWith("tok", "TestOrg", "test-kg", "abc123");
      const s = await handle.status();
      expect(s.lastRefresh?.ok).toBe(true);
      expect(s.stage).toBe("serving");
    });

    it("onRunnerComplete success without snapshotCommit skips commit check and runs rail", async () => {
      buildDispatch();
      await handle.trigger();
      await waitForStage("ingest-running");
      handle.onRunnerComplete("success", {});
      await waitDone();
      expect(fetchCommitVisible).not.toHaveBeenCalled();
      const s = await handle.status();
      expect(s.lastRefresh?.ok).toBe(true);
      expect(s.stage).toBe("serving");
    });

    it("git-cache retry: commit visible on second check proceeds to rail", async () => {
      let visibleCalls = 0;
      buildDispatch({
        fetchCommitVisible: vi.fn(async () => {
          visibleCalls += 1;
          return visibleCalls >= 2; // false first, true second
        }) as never,
      });
      await handle.trigger();
      await waitForStage("ingest-running");
      handle.onRunnerComplete("success", { snapshotCommit: "abc123" });
      await waitDone();
      expect(visibleCalls).toBe(2);
      const s = await handle.status();
      expect(s.lastRefresh?.ok).toBe(true);
      expect(s.stage).toBe("serving");
    });

    it("git-cache fails after both attempts: stage set to failed", async () => {
      buildDispatch({
        fetchCommitVisible: vi.fn(async () => false) as never,
      });
      await handle.trigger();
      await waitForStage("ingest-running");
      handle.onRunnerComplete("success", { snapshotCommit: "abc123" });
      await waitDone();
      const s = await handle.status();
      expect(s.stage).toBe("failed");
      expect(s.lastRefresh?.ok).toBe(false);
    });

    it("persistStage called with ingest-running when runner dispatched", async () => {
      buildDispatch();
      await handle.trigger();
      await waitForStage("ingest-running");
      expect(persistedStages.some((e) => e.stage === "ingest-running")).toBe(true);
    });

    it("status() stage field reflects lifecycle: idle → ingest-running → serving", async () => {
      buildDispatch();
      expect((await handle.status()).stage).toBe("idle");
      await handle.trigger();
      await waitForStage("ingest-running");
      expect((await handle.status()).stage).toBe("ingest-running");
      handle.onRunnerComplete("success", {});
      await waitDone();
      expect((await handle.status()).stage).toBe("serving");
    });

    it("TTL expiry on construction clears stale ingest-running lock", async () => {
      const staleTime = Date.now() - 5 * 60 * 60 * 1000; // 5h ago > 4h TTL
      buildDispatch({
        loadStage: () => ({ stage: "ingest-running" as KgRefreshStage, startedAt: staleTime }),
      });
      const s = await handle.status();
      expect(s.running).toBe(false);
      expect(s.stage).toBe("idle");
    });

    it("within-TTL ingest-running on construction restores running=true", async () => {
      const recentTime = Date.now() - 30 * 1000; // 30s ago — well within 4h TTL
      buildDispatch({
        loadStage: () => ({ stage: "ingest-running" as KgRefreshStage, startedAt: recentTime }),
      });
      const s = await handle.status();
      expect(s.running).toBe(true);
      expect(s.stage).toBe("ingest-running");
    });
  });
});
