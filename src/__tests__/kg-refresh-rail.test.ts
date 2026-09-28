import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fetchGate, stageGate, swapGate, verifyGate, revertRail, runRail,
  RailGateError, outcomeToStage, readServedStamp, readNamespace,
  mergeSnapshotPr, deleteSnapshotBranch, closeSnapshotPr, postDryRunReport,
  type KgRailDeps, type RailContext,
} from "../kg-refresh-rail.js";
import { COMPLETION_MARKER } from "../kg-sidecar.js";
import type { RefreshOutcome, KgDryRunReportTarget } from "../kg-refresh.js";

const NAMESPACE = "https://kg.test.example/";
const OLD_STAMP = "2026-08-20T00:10:10+00:00";
const NEW_STAMP = "2026-08-24T12:00:00+00:00";
const SNAPSHOT_SHA = "abc123def456abc123def456abc123def456abc1";

/** extractSource strips one leading component, so wrap the fixture in a top-level dir. */
function makeTarball(dir: string): Buffer {
  const wrap = mkdtempSync(join(tmpdir(), "kgrailtar-"));
  const top = join(wrap, "repo");
  mkdirSync(top, { recursive: true });
  execSync(`cp -R ${dir}/. ${top}/`);
  const out = join(wrap, "src.tar.gz");
  execSync(`tar -czf ${out} -C ${wrap} repo`);
  return readFileSync(out) as Buffer;
}

describe("kg-refresh-rail", () => {
  let dataRoot: string;
  let fixtureRepo: string;
  let tarball: Buffer;
  let servedStamp: string;
  let canary: { count: number; degraded: boolean };
  let sidecarUp: boolean;
  let restart: ReturnType<typeof vi.fn>;
  let materialize: ReturnType<typeof vi.fn>;
  let persistSnapshotSha: ReturnType<typeof vi.fn>;

  const mcpToolCall = vi.fn(async (_url: string, tool: string) => {
    if (!sidecarUp) throw new Error("ECONNREFUSED");
    if (tool === "kg_neighbors") {
      return { edges: [{ predicate_iri: "http://purl.org/dc/terms/modified", neighbor: servedStamp }] };
    }
    if (tool === "kg_hybrid_search") return { count: canary.count, degraded: canary.degraded, results: [] };
    throw new Error(`unexpected tool ${tool}`);
  });

  function makeDeps(overrides: Partial<KgRailDeps> = {}): KgRailDeps {
    return {
      sidecar: { restart: restart as unknown as () => Promise<void> },
      githubAppId: "1",
      githubAppPrivateKey: "key",
      kgSourceRepo: "TestOrg/test-kg",
      dataRoot,
      kgDir: "/nonexistent-kg",
      sidecarMcpUrl: "http://127.0.0.1:1/mcp",
      canaryDeadlineMs: 300,
      canaryRetryMs: 30,
      mintToken: vi.fn(async () => ({ token: "tok", expiresAt: "" })) as never,
      fetchTarball: vi.fn(async () => tarball) as never,
      fetchDefaultBranch: vi.fn(async () => "main") as never,
      fetchSnapshotCommitSha: vi.fn(async () => SNAPSHOT_SHA) as never,
      materialize: materialize as never,
      mcpToolCall: mcpToolCall as never,
      persistSnapshotSha: persistSnapshotSha as never,
      loadSnapshotSha: vi.fn(() => null) as never,
      mergePullRequestFn: vi.fn(async () => "merged") as never,
      closePullRequestFn: vi.fn(async () => {}) as never,
      deleteBranchFn: vi.fn(async () => {}) as never,
      postPrCommentFn: vi.fn(async () => {}) as never,
      postOrUpdateStickyCommentFn: vi.fn(async () => {}) as never,
      setCommitStatusFn: vi.fn(async () => {}) as never,
      ...overrides,
    };
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
    process.env.KG_SIDECAR_URL = "http://127.0.0.1:1/mcp";

    restart = vi.fn(async () => {
      servedStamp = NEW_STAMP;
    });
    materialize = vi.fn(async (_python: string, cwd: string) => {
      mkdirSync(join(cwd, "out"), { recursive: true });
      writeFileSync(join(cwd, "out", "graph.trig"), "@prefix kg: <x> .");
      writeFileSync(join(cwd, "out", "embeddings.npz"), "vectors");
    });
    persistSnapshotSha = vi.fn();
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(fixtureRepo, { recursive: true, force: true });
    delete process.env.KG_SIDECAR_URL;
    vi.clearAllMocks();
  });

  // ── fetchGate ────────────────────────────────────────────────────────────

  describe("fetchGate", () => {
    it("succeeds: fetches, extracts, and reports namespace/stamp/SHA", async () => {
      const result = await fetchGate(makeDeps(), {});
      expect(result.gate).toBe("ok");
      expect(result.namespace).toBe(NAMESPACE);
      expect(result.stampBefore).toBe(OLD_STAMP);
      expect(result.snapshotCommitSha).toBe(SNAPSHOT_SHA);
      expect(result.wasFirstRun).toBe(true);
      expect(existsSync(join(result.sourceDir!, "sources.yml"))).toBe(true);
    });

    it("short-circuits to ingest-needed when the snapshot SHA matches the recorded SHA", async () => {
      const deps = makeDeps({ loadSnapshotSha: vi.fn(() => SNAPSHOT_SHA) as never });
      const result = await fetchGate(deps, {});
      expect(result.gate).toBe("ingest-needed");
      expect(result.detail).toContain("Graph is current");
      expect(existsSync(join(dataRoot, "fetch"))).toBe(false);
    });

    it("permanent failure: a mint failure throws RailGateError(staging)", async () => {
      const deps = makeDeps({
        mintToken: vi.fn(async () => {
          throw new Error("mint failed");
        }) as never,
      });
      await expect(fetchGate(deps, {})).rejects.toMatchObject(
        expect.objectContaining({ gate: "staging" }) as Partial<RailGateError>,
      );
      await expect(fetchGate(deps, {})).rejects.toBeInstanceOf(RailGateError);
    });
  });

  // ── stageGate ────────────────────────────────────────────────────────────

  describe("stageGate", () => {
    async function fetchedInput(): Promise<RailContext> {
      return fetchGate(makeDeps(), {});
    }

    it("succeeds: materializes and copies into staging/, writing COMPLETION_MARKER last", async () => {
      const input = await fetchedInput();
      const result = await stageGate(makeDeps(), input);
      expect(result).toBe(input);
      const staging = join(dataRoot, "staging");
      expect(existsSync(join(staging, "graph.trig"))).toBe(true);
      expect(existsSync(join(staging, "embeddings.npz"))).toBe(true);
      expect(existsSync(join(staging, COMPLETION_MARKER))).toBe(true);
    });

    it("permanent failure: a materialize failure throws RailGateError(staging)", async () => {
      const input = await fetchedInput();
      const failingMaterialize = vi.fn(async () => {
        throw new Error("OOM-killed");
      });
      const deps = makeDeps({ materialize: failingMaterialize as never });
      await expect(stageGate(deps, input)).rejects.toBeInstanceOf(RailGateError);
      await expect(stageGate(deps, input)).rejects.toMatchObject({ gate: "staging" });
    });

    it("permanent failure: no sourceDir throws RailGateError(staging) without calling materialize", async () => {
      const deps = makeDeps();
      await expect(stageGate(deps, {})).rejects.toMatchObject({ gate: "staging" });
      expect(materialize).not.toHaveBeenCalled();
    });
  });

  // ── swapGate ─────────────────────────────────────────────────────────────

  describe("swapGate", () => {
    it("succeeds: current -> previous, staging -> current, then restarts the sidecar", async () => {
      const current = join(dataRoot, "current");
      const staging = join(dataRoot, "staging");
      mkdirSync(current, { recursive: true });
      writeFileSync(join(current, "graph.trig"), "OLD");
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, "graph.trig"), "NEW");

      const deps = makeDeps();
      await swapGate(deps, {});

      expect(readFileSync(join(dataRoot, "previous", "graph.trig"), "utf8")).toBe("OLD");
      expect(readFileSync(join(current, "graph.trig"), "utf8")).toBe("NEW");
      expect(existsSync(staging)).toBe(false);
      expect(restart).toHaveBeenCalledTimes(1);
    });

    it("permanent failure: a missing staging/ propagates uncaught, not as a RailGateError", async () => {
      const deps = makeDeps();
      let caught: unknown;
      try {
        await swapGate(deps, {});
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught).not.toBeInstanceOf(RailGateError);
      expect(restart).not.toHaveBeenCalled();
    });
  });

  // ── verifyGate ───────────────────────────────────────────────────────────

  describe("verifyGate", () => {
    function primeCurrent(): void {
      const current = join(dataRoot, "current");
      mkdirSync(current, { recursive: true });
      writeFileSync(join(current, "embeddings.npz"), "vectors");
    }

    it("succeeds: advances the stamp and persists the snapshot SHA", async () => {
      primeCurrent();
      servedStamp = NEW_STAMP; // simulates the swap having already flipped the served graph
      const deps = makeDeps();
      const result = await verifyGate(deps, { namespace: NAMESPACE, stampBefore: OLD_STAMP, snapshotCommitSha: SNAPSHOT_SHA, wasFirstRun: false });
      expect(result.stampAfter).toBe(NEW_STAMP);
      expect(persistSnapshotSha).toHaveBeenCalledWith(SNAPSHOT_SHA);
      expect(existsSync(join(dataRoot, "fetch"))).toBe(false);
    });

    it("permanent failure: no sidecar URL fails the answers gate", async () => {
      primeCurrent();
      delete process.env.KG_SIDECAR_URL;
      const deps = makeDeps();
      await expect(verifyGate(deps, { namespace: NAMESPACE, stampBefore: OLD_STAMP })).rejects.toMatchObject({ gate: "answers" });
    });

    it("permanent failure: missing vectors fails the vectors gate", async () => {
      mkdirSync(join(dataRoot, "current"), { recursive: true }); // no embeddings.npz
      const deps = makeDeps();
      await expect(verifyGate(deps, { namespace: NAMESPACE, stampBefore: OLD_STAMP })).rejects.toMatchObject({ gate: "vectors" });
    });

    it("permanent failure: a canary that never passes fails the canary gate", async () => {
      primeCurrent();
      const flakyMcp = vi.fn(async (_url: string, tool: string) => {
        if (tool === "kg_hybrid_search") return { count: 0, degraded: true, results: [] };
        throw new Error(`unexpected tool ${tool}`);
      });
      const deps = makeDeps({ mcpToolCall: flakyMcp as never, canaryDeadlineMs: 20, canaryRetryMs: 5 });
      await expect(verifyGate(deps, { namespace: NAMESPACE, stampBefore: OLD_STAMP })).rejects.toMatchObject({ gate: "canary" });
    });

    it("permanent failure: a stamp that did not move fails the stamp gate and still persists the snapshot SHA", async () => {
      primeCurrent();
      // servedStamp is left at OLD_STAMP — the swap did not actually advance it.
      const deps = makeDeps();
      await expect(
        verifyGate(deps, { namespace: NAMESPACE, stampBefore: OLD_STAMP, snapshotCommitSha: SNAPSHOT_SHA, wasFirstRun: true }),
      ).rejects.toMatchObject({ gate: "stamp" });
      expect(persistSnapshotSha).toHaveBeenCalledWith(SNAPSHOT_SHA);
    });
  });

  // ── revertRail ───────────────────────────────────────────────────────────

  describe("revertRail", () => {
    it("withdraws the failed overlay to rejected/, restores previous, and restarts", async () => {
      const current = join(dataRoot, "current");
      const previous = join(dataRoot, "previous");
      mkdirSync(current, { recursive: true });
      writeFileSync(join(current, "graph.trig"), "FAILED-OVERLAY");
      mkdirSync(previous, { recursive: true });
      writeFileSync(join(previous, "graph.trig"), "GOOD-OVERLAY");

      const deps = makeDeps();
      const outcome = await revertRail(deps, { namespace: NAMESPACE, gate: "canary", detail: "canary failed", stampBefore: OLD_STAMP });

      expect(outcome.ok).toBe(false);
      expect(outcome.gate).toBe("canary");
      expect(outcome.detail).toContain("canary failed");
      expect(outcome.detail).toContain("reverted, serving stamp");
      expect(readFileSync(join(current, "graph.trig"), "utf8")).toBe("GOOD-OVERLAY");
      expect(readFileSync(join(dataRoot, "rejected", "graph.trig"), "utf8")).toBe("FAILED-OVERLAY");
      expect(restart).toHaveBeenCalledTimes(1);
    });

    it("with no previous overlay, withdraws current and leaves nothing serving (falls back to baked)", async () => {
      const current = join(dataRoot, "current");
      mkdirSync(current, { recursive: true });
      writeFileSync(join(current, "graph.trig"), "FAILED-OVERLAY");

      const deps = makeDeps();
      await revertRail(deps, { namespace: NAMESPACE, gate: "stamp", detail: "stamp did not move", stampBefore: OLD_STAMP });

      expect(existsSync(current)).toBe(false);
      expect(readFileSync(join(dataRoot, "rejected", "graph.trig"), "utf8")).toBe("FAILED-OVERLAY");
    });
  });

  // ── runRail ──────────────────────────────────────────────────────────────

  describe("runRail", () => {
    it("runs fetch -> stage -> swap -> verify to a success outcome", async () => {
      const deps = makeDeps();
      const outcome = await runRail(deps);
      expect(outcome.ok).toBe(true);
      expect(outcome.stampBefore).toBe(OLD_STAMP);
      expect(outcome.stampAfter).toBe(NEW_STAMP);
      expect(existsSync(join(dataRoot, "current", COMPLETION_MARKER))).toBe(true);
      expect(restart).toHaveBeenCalledTimes(1);
    });

    it("short-circuits to ingest-needed without staging, swapping, or restarting", async () => {
      const deps = makeDeps({ loadSnapshotSha: vi.fn(() => SNAPSHOT_SHA) as never });
      const outcome = await runRail(deps);
      expect(outcome.ok).toBe(false);
      expect(outcome.gate).toBe("ingest-needed");
      expect(materialize).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
    });

    it("a fetchGate failure resolves to a staging outcome, never reverts", async () => {
      const deps = makeDeps({
        mintToken: vi.fn(async () => {
          throw new Error("mint failed");
        }) as never,
      });
      const outcome = await runRail(deps);
      expect(outcome.ok).toBe(false);
      expect(outcome.gate).toBe("staging");
      expect(restart).not.toHaveBeenCalled();
    });

    it("a fetchGate failure after the served stamp was read reports that stamp, not null", async () => {
      const deps = makeDeps({
        fetchSnapshotCommitSha: vi.fn(async () => {
          throw new Error("commit lookup failed");
        }) as never,
      });
      const outcome = await runRail(deps);
      expect(outcome.ok).toBe(false);
      expect(outcome.gate).toBe("staging");
      expect(outcome.stampBefore).toBe(OLD_STAMP);
      expect(outcome.stampAfter).toBe(OLD_STAMP);
      expect(restart).not.toHaveBeenCalled();
    });

    it("a plain Error thrown from swapGate propagates out of runRail unchanged, without reverting", async () => {
      const failingRestart = vi.fn(async () => {
        throw new Error("sidecar restart failed");
      });
      const deps = makeDeps({ sidecar: { restart: failingRestart } });
      await expect(runRail(deps)).rejects.toThrow("sidecar restart failed");
      // A single call means only swapGate's restart ran — a second call would mean
      // revertRail (which also calls sidecar.restart) incorrectly ran too.
      expect(failingRestart).toHaveBeenCalledTimes(1);
    });

    it("a stageGate failure resolves to a staging outcome and cleans up staging/", async () => {
      const deps = makeDeps({
        materialize: vi.fn(async () => {
          throw new Error("OOM-killed");
        }) as never,
      });
      const outcome = await runRail(deps);
      expect(outcome.ok).toBe(false);
      expect(outcome.gate).toBe("staging");
      expect(existsSync(join(dataRoot, "staging"))).toBe(false);
      expect(restart).not.toHaveBeenCalled();
    });

    it("calls revertRail exactly once on a verifyGate failure", async () => {
      // Canary never recovers -> verifyGate throws RailGateError("canary", ...).
      // swapGate restarts once; a single revertRail call restarts a second time.
      // Two restarts (not more, not fewer) is only possible if the revert path
      // ran exactly once — the linear gate sequence has no other way to reach it.
      canary = { count: 0, degraded: true };
      const deps = makeDeps({ canaryDeadlineMs: 20, canaryRetryMs: 5 });

      const outcome = await runRail(deps);

      expect(outcome.ok).toBe(false);
      expect(outcome.gate).toBe("canary");
      expect(outcome.detail).toContain("reverted, serving stamp");
      expect(restart).toHaveBeenCalledTimes(2);
    });
  });

  // ── other exported functions (smoke coverage) ───────────────────────────

  describe("other exported functions", () => {
    it("outcomeToStage maps every outcome shape to its terminal stage", () => {
      expect(outcomeToStage({ ok: true, at: 0, detail: "", stampBefore: null, stampAfter: null })).toBe("serving");
      expect(outcomeToStage({ ok: false, at: 0, gate: "staging", detail: "", stampBefore: null, stampAfter: null })).toBe("failed");
      expect(outcomeToStage({ ok: false, at: 0, gate: "ingest-needed", detail: "", stampBefore: null, stampAfter: null })).toBe("idle");
      expect(outcomeToStage({ ok: false, at: 0, gate: "canary", detail: "", stampBefore: null, stampAfter: null })).toBe("reverted");
    });

    it("readNamespace and readServedStamp round-trip against a fixture and the sidecar", async () => {
      expect(await readNamespace(fixtureRepo)).toBe(NAMESPACE);
      const deps = makeDeps();
      expect(await readServedStamp(deps, NAMESPACE)).toBe(OLD_STAMP);
      expect(await readServedStamp(deps, null)).toBeNull();
    });

    it("mergeSnapshotPr mints a token and delegates to mergePullRequestFn", async () => {
      const mergePullRequestFn = vi.fn(async () => "merged" as const);
      const deps = makeDeps({ mergePullRequestFn: mergePullRequestFn as never });
      const result = await mergeSnapshotPr(deps, "TestOrg", "test-kg", 9, "sha123");
      expect(result).toBe("merged");
      expect(mergePullRequestFn).toHaveBeenCalledWith("tok", "TestOrg", "test-kg", 9, "sha123", "merge");
    });

    it("deleteSnapshotBranch is best-effort: a deleteBranchFn failure does not throw", async () => {
      const deleteBranchFn = vi.fn(async () => {
        throw new Error("branch already gone");
      });
      const deps = makeDeps({ deleteBranchFn: deleteBranchFn as never });
      await expect(deleteSnapshotBranch(deps, "TestOrg", "test-kg", "kg-refresh/x")).resolves.toBeUndefined();
    });

    it("closeSnapshotPr comments, closes, and deletes the branch", async () => {
      const postPrCommentFn = vi.fn(async () => {});
      const closePullRequestFn = vi.fn(async () => {});
      const deleteBranchFn = vi.fn(async () => {});
      const deps = makeDeps({ postPrCommentFn: postPrCommentFn as never, closePullRequestFn: closePullRequestFn as never, deleteBranchFn: deleteBranchFn as never });
      await closeSnapshotPr(deps, "TestOrg", "test-kg", 9, "canary", "kg-refresh/x");
      expect(postPrCommentFn).toHaveBeenCalledTimes(1);
      expect(closePullRequestFn).toHaveBeenCalledTimes(1);
      expect(deleteBranchFn).toHaveBeenCalledTimes(1);
    });

    it("postDryRunReport posts the sticky comment and sets the commit status on success", async () => {
      const postOrUpdateStickyCommentFn = vi.fn(async () => {});
      const setCommitStatusFn = vi.fn(async () => {});
      const deps = makeDeps({
        postOrUpdateStickyCommentFn: postOrUpdateStickyCommentFn as never,
        setCommitStatusFn: setCommitStatusFn as never,
      });
      const report: KgDryRunReportTarget = { repo: "TestOrg/test-kg", prNumber: 9, sha: "sha123" };
      const outcome: RefreshOutcome = { ok: true, at: 0, detail: "dry-run: guard passed: no shrink", stampBefore: null, stampAfter: null, dryRun: true };
      await postDryRunReport(deps, report, outcome);
      expect(postOrUpdateStickyCommentFn).toHaveBeenCalledTimes(1);
      expect(setCommitStatusFn).toHaveBeenCalledWith("tok", "TestOrg", "test-kg", "sha123", expect.objectContaining({ state: "success" }));
    });
  });
});
