// HTTP-route-level coverage for /runner/result and /trigger/gap-fill.
//
// The orchestrator's HTTP server in src/index.ts inlines all of its routing
// inside the main entry-point IIFE (it starts the polling loop and the HTTP
// server together), so we can't import a top-level `app` to exercise. Rather
// than refactor index.ts just to make a router unit-testable, this file
// re-implements the small slice of route-wrapper logic that lives ABOVE the
// inner handlers (501-when-not-configured, 400-on-invalid-JSON) and exercises
// it directly. The handler-level tests in runner-callback.test.ts and
// gap-fill-trigger.test.ts cover the post-parse logic in detail.
//
// If/when index.ts is refactored to expose a `createRouter`, replace these
// with real HTTP request tests against that router.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as RunnerCallbackModule from "../runner-callback.js";
import type * as GapFillModule from "../gap-fill-trigger.js";
import type * as RunnerTokensModule from "../runner-tokens.js";
import type { RepoMapping } from "../config.js";
import { FakeProvider } from "./providers/fake.js";
import type { TicketingProvider } from "../providers/types.js";

let dbPath: string;
let dedup: typeof DedupModule;
let runnerCallback: typeof RunnerCallbackModule;
let gapFill: typeof GapFillModule;
let runnerTokens: typeof RunnerTokensModule;

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(
    os.tmpdir(),
    `route-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  runnerCallback = await import("../runner-callback.js");
  gapFill = await import("../gap-fill-trigger.js");
  runnerTokens = await import("../runner-tokens.js");
  dedup.getDb();
});

afterEach(() => {
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

/**
 * Mirror of the /runner/result route wrapper in src/index.ts. Returns
 * { status, body } the same way the handler does.
 */
async function callRunnerResultRoute(opts: {
  runnerTokenSecret: string | null;
  authorization?: string;
  rawBody: string; // pre-stringified
  resolveProvider?: (key: string) => Promise<TicketingProvider | null>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!opts.runnerTokenSecret) {
    return { status: 501, body: { error: "Runner callback not configured" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.rawBody);
  } catch {
    return { status: 400, body: { error: "Invalid JSON" } };
  }
  return runnerCallback.handleRunnerResult({
    authorization: opts.authorization,
    body: parsed as never,
    secret: opts.runnerTokenSecret,
    resolveProvider: opts.resolveProvider ?? (async () => new FakeProvider()),
  });
}

/**
 * Mirror of the /trigger/gap-fill route wrapper. The 501-when-not-configured
 * path actually lives inside handleGapFillTrigger (not the route), so we
 * only need to model the JSON-parse step here.
 */
async function callGapFillRoute(opts: {
  triggerSecret: string | null;
  authorization?: string;
  rawBody: string;
  getMappings?: () => Record<string, RepoMapping>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.rawBody);
  } catch {
    return { status: 400, body: { error: "Invalid JSON" } };
  }
  return gapFill.handleGapFillTrigger({
    authorization: opts.authorization,
    body: parsed as never,
    triggerSecret: opts.triggerSecret,
    runnerCallbackBaseUrl: null,
    runnerTokenSecret: null,
    getMappings: opts.getMappings ?? (() => ({})),
    resolveProvider: async () => new FakeProvider(),
    getInstallationToken: async () => "gh-token",
    dispatchWorkflow: vi.fn(async () => ({ success: true, status: 204 })),
  });
}

/**
 * Mirror of the GET /runner/planning-context route wrapper in src/index.ts.
 */
async function callPlanningContextRoute(opts: {
  runnerTokenSecret: string | null;
  authorization?: string;
  resolveProvider?: (key: string) => Promise<TicketingProvider | null>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!opts.runnerTokenSecret) {
    return { status: 501, body: { error: "Runner callback not configured" } };
  }
  return runnerCallback.handleRunnerPlanningContext({
    authorization: opts.authorization,
    secret: opts.runnerTokenSecret,
    resolveProvider: opts.resolveProvider ?? (async () => new FakeProvider()),
  });
}

/**
 * Mirror of the POST /runner/kg-tracker-data route wrapper in src/index.ts:
 * 501 when unconfigured, 400 on invalid JSON, else parses cursor/teamKey and
 * delegates to handleKgTrackerDataRequest.
 */
async function callKgTrackerDataRoute(opts: {
  runnerTokenSecret: string | null;
  authorization?: string;
  rawBody: string;
  getMappings?: () => Record<string, unknown>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!opts.runnerTokenSecret) {
    return { status: 501, body: { error: "Runner callback not configured" } };
  }
  let cursor: string | null = null;
  let teamKey = "";
  try {
    if (opts.rawBody.trim()) {
      const parsed = JSON.parse(opts.rawBody) as { cursor?: unknown; teamKey?: unknown };
      if (typeof parsed.cursor === "string") cursor = parsed.cursor;
      if (typeof parsed.teamKey === "string") teamKey = parsed.teamKey;
    }
  } catch {
    return { status: 400, body: { error: "Invalid JSON" } };
  }
  return runnerCallback.handleKgTrackerDataRequest({
    authorization: opts.authorization,
    secret: opts.runnerTokenSecret,
    cursor,
    teamKey,
    getMappings: opts.getMappings ?? (() => ({})),
  });
}

describe("/runner/kg-tracker-data route wrapper", () => {
  it("returns 501 when RUNNER_TOKEN_SECRET is unset", async () => {
    const res = await callKgTrackerDataRoute({
      runnerTokenSecret: null,
      rawBody: JSON.stringify({ teamKey: "AII" }),
    });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe("Runner callback not configured");
  });

  it("returns 400 on invalid JSON body", async () => {
    const res = await callKgTrackerDataRoute({
      runnerTokenSecret: "secret",
      rawBody: "{not json",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid JSON");
  });

  it("returns 403 when bearer is missing (after parse) — unchanged after the fetchTrackerIssuesPage extraction", async () => {
    const res = await callKgTrackerDataRoute({
      runnerTokenSecret: "secret",
      rawBody: JSON.stringify({ teamKey: "AII" }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Unauthorized");
  });
});

/**
 * Mirror of the POST /runner/kg-scope route wrapper in src/index.ts:
 * 501 when unconfigured, else delegates straight to handleKgScopeRequest
 * (no request body is parsed for this route).
 */
async function callKgScopeRoute(opts: {
  runnerTokenSecret: string | null;
  authorization?: string;
  getMappings?: () => Record<string, { owner: string; repo: string; defaultBranch: string; ticketingProvider: string }>;
}): Promise<{ status: number; body: unknown }> {
  if (!opts.runnerTokenSecret) {
    return { status: 501, body: { error: "Runner callback not configured" } };
  }
  return runnerCallback.handleKgScopeRequest({
    authorization: opts.authorization,
    secret: opts.runnerTokenSecret,
    getMappings: opts.getMappings ?? (() => ({})),
  });
}

describe("/runner/kg-scope route wrapper", () => {
  it("returns 501 when RUNNER_TOKEN_SECRET is unset", async () => {
    const res = await callKgScopeRoute({ runnerTokenSecret: null });
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: "Runner callback not configured" });
  });

  it("returns 403 when the bearer is missing", async () => {
    const res = await callKgScopeRoute({ runnerTokenSecret: "secret" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 when the token's phase is not kg-refresh", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "AII",
      phase: "implementation",
      audience: "progress",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: "secret",
    });

    const res = await callKgScopeRoute({
      runnerTokenSecret: "secret",
      authorization: `Bearer ${token}`,
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("returns exactly {teamKey, repo, defaultBranch, ticketingProvider} per mapping on the happy path", async () => {
    const { token } = runnerTokens.mintRunToken({
      issueId: "i",
      mappingTeamKey: "AII",
      phase: "kg-refresh",
      audience: "progress",
      ttlSeconds: runnerTokens.IMPLEMENTATION_TTL_SECONDS,
      secret: "secret",
    });

    const res = await callKgScopeRoute({
      runnerTokenSecret: "secret",
      authorization: `Bearer ${token}`,
      getMappings: () => ({
        AII: { owner: "BuildDownAI", repo: "AI-Implement", defaultBranch: "main", ticketingProvider: "linear" },
        ENG: { owner: "acme", repo: "widgets", defaultBranch: "develop", ticketingProvider: "jira" },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { teamKey: "AII", repo: "BuildDownAI/AI-Implement", defaultBranch: "main", ticketingProvider: "linear" },
      { teamKey: "ENG", repo: "acme/widgets", defaultBranch: "develop", ticketingProvider: "jira" },
    ]);
  });
});

describe("/runner/planning-context route wrapper", () => {
  it("returns 501 when RUNNER_TOKEN_SECRET is unset", async () => {
    const res = await callPlanningContextRoute({ runnerTokenSecret: null });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe("Runner callback not configured");
  });

  it("returns 401 when bearer is missing", async () => {
    const res = await callPlanningContextRoute({ runnerTokenSecret: "secret" });
    expect(res.status).toBe(401);
  });
});

describe("/runner/result route wrapper", () => {
  it("returns 501 when RUNNER_TOKEN_SECRET is unset", async () => {
    const res = await callRunnerResultRoute({
      runnerTokenSecret: null,
      rawBody: "{}",
    });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe("Runner callback not configured");
  });

  it("returns 400 on invalid JSON body", async () => {
    const res = await callRunnerResultRoute({
      runnerTokenSecret: "secret",
      rawBody: "{not json",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid JSON");
  });

  it("returns 401 when bearer is missing (after parse)", async () => {
    const res = await callRunnerResultRoute({
      runnerTokenSecret: "secret",
      rawBody: JSON.stringify({ phase: "planning", outcome: "success", comments: [] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("/trigger/gap-fill route wrapper", () => {
  it("returns 501 when GAP_FILL_TRIGGER_SECRET is unset", async () => {
    const res = await callGapFillRoute({
      triggerSecret: null,
      rawBody: JSON.stringify({ issueKey: "X-1", prNumber: 1 }),
      authorization: "Bearer anything",
    });
    expect(res.status).toBe(501);
  });

  it("returns 400 on invalid JSON body", async () => {
    const res = await callGapFillRoute({
      triggerSecret: "trig",
      rawBody: "{not json",
      authorization: "Bearer trig",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid JSON");
  });

  it("returns 401 on bad bearer", async () => {
    const res = await callGapFillRoute({
      triggerSecret: "trig",
      rawBody: JSON.stringify({ issueKey: "X-1", prNumber: 1 }),
      authorization: "Bearer wrong",
    });
    expect(res.status).toBe(401);
  });
});
