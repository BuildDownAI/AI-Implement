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
