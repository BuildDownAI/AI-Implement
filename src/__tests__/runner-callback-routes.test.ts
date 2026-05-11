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
import type { RepoMapping } from "../config.js";
import { FakeProvider } from "./providers/fake.js";
import type { TicketingProvider } from "../providers/types.js";

let dbPath: string;
let dedup: typeof DedupModule;
let runnerCallback: typeof RunnerCallbackModule;
let gapFill: typeof GapFillModule;

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
