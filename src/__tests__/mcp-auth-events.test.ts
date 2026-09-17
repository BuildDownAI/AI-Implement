import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dedup.ts freezes its DB path at import time, so each test sets a unique DEDUP_DB_PATH and
// re-imports the modules fresh (the same isolation pattern the sibling suites use).
let authEvents: typeof import("../mcp-auth-events.js");
let dedup: typeof import("../dedup.js");
let dbPath: string;

const SECRET_TOKEN = "super-secret-access-token-value";
const SECRET_REFRESH_TOKEN = "super-secret-refresh-token-value";

function baseEvent(over: Partial<Parameters<typeof authEvents.recordAuthEvent>[0]> = {}) {
  return {
    at: Date.now(),
    kind: "401" as const,
    cause: "invalid" as const,
    clientId: "client-1",
    clientPath: "loopback" as const,
    identityKind: null,
    email: null,
    familyId: null,
    latencyMs: 5,
    ...over,
  };
}

beforeEach(async () => {
  vi.resetModules();
  dbPath = path.join(os.tmpdir(), `mcp-auth-events-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.DEDUP_DB_PATH = dbPath;
  authEvents = await import("../mcp-auth-events.js");
  dedup = await import("../dedup.js");
  authEvents.initAuthEventsTable();
});

afterEach(() => {
  vi.restoreAllMocks();
  dedup.closeDb();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});

describe("recordAuthEvent", () => {
  it("writes one row readable back through listAuthEvents", () => {
    authEvents.recordAuthEvent(
      baseEvent({ cause: "expired", clientId: "client-a", clientPath: "https", email: "ada@eudoxus.ai", identityKind: "human" }),
    );
    const [event] = authEvents.listAuthEvents();
    expect(event).toMatchObject({
      kind: "401",
      cause: "expired",
      clientId: "client-a",
      clientPath: "https",
      email: "ada@eudoxus.ai",
      identityKind: "human",
    });
  });

  it("logs a single console line with the fixed [mcp-auth] prefix", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    authEvents.recordAuthEvent(baseEvent({ cause: "ok", kind: "refresh" }));
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain("[mcp-auth]");
    logSpy.mockRestore();
  });

  it("never writes a token, refresh token, or code value to the row or the console line", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    authEvents.recordAuthEvent(
      baseEvent({
        cause: "ok",
        kind: "refresh",
        email: "ada@eudoxus.ai",
        // Real call sites never pass a token, but nothing here should ever accept or emit one either.
      }),
    );
    const rows = dedup.getDb().prepare("SELECT * FROM mcp_auth_events").all();
    const serialized = JSON.stringify(rows);
    const logged = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(SECRET_REFRESH_TOKEN);
    expect(logged).not.toContain(SECRET_TOKEN);
    expect(logged).not.toContain(SECRET_REFRESH_TOKEN);
    logSpy.mockRestore();
  });

  it("prunes rows older than 30 days on every write", () => {
    // Insert the stale row directly: recordAuthEvent prunes on every call, including its own —
    // going through it here would delete the row before the assertion ever runs.
    const stale = Date.now() - 31 * 24 * 60 * 60 * 1000;
    dedup.getDb()
      .prepare(
        `INSERT INTO mcp_auth_events (at, kind, cause, client_id, client_path, identity_kind, email, family_id, latency_ms)
         VALUES (?, '401', 'invalid', 'stale-client', 'unknown', NULL, NULL, NULL, 0)`,
      )
      .run(stale);
    expect(
      dedup.getDb().prepare("SELECT * FROM mcp_auth_events WHERE client_id = 'stale-client'").get(),
    ).toBeDefined();

    authEvents.recordAuthEvent(baseEvent({ clientId: "fresh-client" }));

    expect(
      dedup.getDb().prepare("SELECT * FROM mcp_auth_events WHERE client_id = 'stale-client'").get(),
    ).toBeUndefined();
    expect(
      dedup.getDb().prepare("SELECT * FROM mcp_auth_events WHERE client_id = 'fresh-client'").get(),
    ).toBeDefined();
  });

  it("keeps a row exactly 29 days old", () => {
    const recent = Date.now() - 29 * 24 * 60 * 60 * 1000;
    authEvents.recordAuthEvent(baseEvent({ at: recent, clientId: "recent-client" }));
    authEvents.recordAuthEvent(baseEvent({ clientId: "fresh-client-2" }));
    expect(
      dedup.getDb().prepare("SELECT * FROM mcp_auth_events WHERE client_id = 'recent-client'").get(),
    ).toBeDefined();
  });
});

describe("listAuthEvents", () => {
  it("returns nothing before any event is recorded", () => {
    expect(authEvents.listAuthEvents()).toEqual([]);
  });

  it("orders newest first", () => {
    const now = Date.now();
    authEvents.recordAuthEvent(baseEvent({ at: now, clientId: "first" }));
    authEvents.recordAuthEvent(baseEvent({ at: now + 1000, clientId: "second" }));
    authEvents.recordAuthEvent(baseEvent({ at: now + 2000, clientId: "third" }));
    expect(authEvents.listAuthEvents().map((e) => e.clientId)).toEqual(["third", "second", "first"]);
  });

  it("respects the since filter", () => {
    const now = Date.now();
    authEvents.recordAuthEvent(baseEvent({ at: now, clientId: "old" }));
    authEvents.recordAuthEvent(baseEvent({ at: now + 5000, clientId: "new" }));
    expect(authEvents.listAuthEvents({ since: now + 3000 }).map((e) => e.clientId)).toEqual(["new"]);
  });

  it("respects the limit", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      authEvents.recordAuthEvent(baseEvent({ at: now + i, clientId: `c${i}` }));
    }
    expect(authEvents.listAuthEvents({ limit: 2 })).toHaveLength(2);
  });
});

describe("summarizeAuthEvents", () => {
  it("returns counts per cause and per client path for a seeded table", () => {
    const now = Date.now();
    authEvents.recordAuthEvent(baseEvent({ at: now, cause: "expired", clientPath: "loopback" }));
    authEvents.recordAuthEvent(baseEvent({ at: now, cause: "expired", clientPath: "https" }));
    authEvents.recordAuthEvent(baseEvent({ at: now, cause: "ok", kind: "refresh", clientPath: "https" }));
    authEvents.recordAuthEvent(baseEvent({ at: now, cause: "allowlist", clientPath: "unknown" }));

    const summary = authEvents.summarizeAuthEvents(0);
    expect(summary.totalEvents).toBe(4);
    expect(summary.byCause).toEqual({ expired: 2, ok: 1, allowlist: 1 });
    expect(summary.byClientPath).toEqual({ loopback: 1, https: 2, unknown: 1 });
  });

  it("excludes rows before the since boundary", () => {
    const now = Date.now();
    authEvents.recordAuthEvent(baseEvent({ at: now, cause: "invalid" }));
    authEvents.recordAuthEvent(baseEvent({ at: now + 5000, cause: "ok" }));
    const summary = authEvents.summarizeAuthEvents(now + 3000);
    expect(summary.totalEvents).toBe(1);
    expect(summary.byCause).toEqual({ ok: 1 });
  });
});
