/**
 * Contract: kg-refresh envelope runnerCallbackUrl is the bare base URL.
 * Every runner-side client appends its own path segment.
 *
 * Served routes (src/index.ts):
 *   POST /runner/result
 *   POST /api/runner/kg-tracker-data
 *   POST /api/runner/dependency-token
 *   GET  /runner/planning-context
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { postRunnerResult } from "../runner-result.js";
import { kgTrackerDataStep } from "../pipeline/steps/kg-tracker-data.js";

const BASE = "http://orchestrator.test";

// Routes served by src/index.ts — every resolved kg-refresh callback path must be in this set.
const SERVED_ROUTES = new Set([
  "POST /runner/result",
  "POST /api/runner/kg-tracker-data",
  "POST /api/runner/dependency-token",
  "GET /runner/planning-context",
]);

describe("kg-refresh callback-URL contract", () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "kgroot-"));
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
    vi.clearAllMocks();
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
    expect(c.repoStatus).not.toHaveBeenCalled();
    expect(c.report).toHaveBeenCalledWith(
      dispatchId,
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
  });

  it("answers 409 no-refresh-in-flight when the workflow has no such key", async () => {
    const { token } = mint();
    const c = client({ report: vi.fn(async () => ({ status: "not-found" })) });
    expect(await run(token, c)).toEqual({ status: 409, body: { error: "no-refresh-in-flight" } });
  });

  it("answers 503 when the client or source repo is not configured", async () => {
    const { token } = mint();
    const out = await callback.handleRunnerResult({
      authorization: `Bearer ${token}`, body: resultBody, secret: SECRET, resolveProvider: async () => null,
    });
    expect(out.status).toBe(503);
  });

  it("progress calls progress(dispatchId) and maps not-found, conflict and unavailable", async () => {
    const { token, dispatchId } = mint("progress");
    const c = client();
    const out = await callback.handleRunnerProgress({
      authorization: `Bearer ${token}`, body: {}, secret: SECRET, kgRefreshClient: c as never, kgSourceRepo: SLUG,
    });
    expect(out).toEqual({ status: 200, body: { acknowledged: true } });
    expect(c.progress).toHaveBeenCalledWith(dispatchId);
    expect(c.repoStatus).not.toHaveBeenCalled();

    const statusFor = async (status: string) => (await callback.handleRunnerProgress({
      authorization: `Bearer ${token}`, body: {}, secret: SECRET, kgSourceRepo: SLUG,
      kgRefreshClient: client({ progress: vi.fn(async () => ({ status })) }) as never,
    })).status;
    expect(await statusFor("not-found")).toBe(409);
    expect(await statusFor("conflict")).toBe(409);
    expect(await statusFor("unavailable")).toBe(503);
  });

  // ADR 034 rule 4 producer proofs: start at the real sender, end at the real receiver.
  it("contract: KgRefresh.report — a real postRunnerResult is accepted by handleRunnerResult and reports to the workflow", async () => {
    const { token, dispatchId } = mint();
    const c = client();
    const seen: Array<{ url: string; status: number }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const out = await callback.handleRunnerResult({
        authorization: headers.Authorization,
        body: JSON.parse(String(init.body)),
        secret: SECRET,
        resolveProvider: async () => null,
        kgRefreshClient: c as never,
        kgSourceRepo: SLUG,
      });
      seen.push({ url, status: out.status });
      return new Response(JSON.stringify(out.body), { status: out.status });
    });
    const workspaceDir = mkdtempSync(join(tmpdir(), "kgreport-"));
    const savedToken = process.env.RUN_TOKEN;
    process.env.RUN_TOKEN = token;
    try {
      await postRunnerResult({
        phase: "kg-refresh",
        workspaceDir,
        outcome: "success",
        snapshotPr: 7,
        snapshotCommit: "abc",
        callbackUrl: "http://orch.test",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    } finally {
      if (savedToken === undefined) delete process.env.RUN_TOKEN;
      else process.env.RUN_TOKEN = savedToken;
      rmSync(workspaceDir, { recursive: true, force: true });
    }
    expect(seen).toEqual([{ url: "http://orch.test/runner/result", status: 200 }]);
    expect(c.report).toHaveBeenCalledTimes(1);
    expect(c.report).toHaveBeenCalledWith(
      dispatchId,
      expect.objectContaining({ ok: true, snapshotPr: 7, snapshotCommit: "abc" }),
      { idempotencyKey: dispatchId },
    );
  });

  it("contract: KgRefresh.cancel — the real admin cancel dep cancels the clicked row's dispatchId and answers 200", async () => {
    const idx = await import("../index.js");
    const ingress = { repoStatus: vi.fn(), cancel: vi.fn().mockResolvedValue({ status: "accepted" }) };
    const deps = idx.makeKgRefreshAdminDeps(SLUG, ingress as never, vi.fn() as never, () => false);
    expect(await deps.cancel({ jobId: 1, dispatchId: "t-clicked", reason: "operator_cancelled" })).toEqual({
      status: 200,
      body: { cancelled: true },
    });
    expect(ingress.cancel).toHaveBeenCalledTimes(1);
    expect(ingress.cancel).toHaveBeenCalledWith("t-clicked", "operator_cancelled");

    ingress.cancel.mockClear();
    expect(await deps.cancel({ jobId: 2, dispatchId: null, reason: "operator_cancelled" })).toEqual({
      status: 409,
      body: { error: "no-refresh-in-flight" },
    });
    expect(ingress.cancel).not.toHaveBeenCalled();
  });
});
