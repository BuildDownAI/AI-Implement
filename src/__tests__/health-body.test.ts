import type http from "node:http";
import { withRequestErrorBoundary } from "../http-server.js";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildHealthBody, type HealthBodyReaders } from "../health-body.js";
import { getLastSetupCheckRun, recordSetupCheckRun, runSetupChecks, type SetupCheckRun } from "../setup-checks/index.js";
import { ORCHESTRATOR_CONFIG_CHECKS } from "../setup-checks/orchestrator-config.js";
import { makeSetupCheckContext } from "./helpers/fixtures/setup-checks.js";
import { testDb } from "./helpers/test-db.js";
import { fakeFetch } from "./helpers/fake-fetch.js";

function readers(): HealthBodyReaders {
  return {
    sourceCommit: () => "abc123",
    pollStats: () => ({ pollCount: 42, lastPollStartedAt: new Date(1000), lastPollFinishedAt: new Date(2000) }),
    kgDegraded: () => true,
    sidecarHealthFields: () => ({ kgUnavailable: true, sidecar: { reachable: false, toolsListed: false, lastError: "probe failed", checkedAt: 123 } }),
    restateStatus: () => ({ sidecar: { state: "exited", code: 1, signal: null }, registration: { state: "unreachable" } }),
    deployHealth: () => ({ held: true, startedAt: 456 }),
    lastSetupCheckRun: () => null,
    setupCheckContext: () => makeSetupCheckContext(),
  };
}

describe("public health body", () => {
  it("lets the request boundary finish a failed health build without sending 200", async () => {
    const read = readers();
    read.setupCheckContext = () => { throw new Error("context unavailable"); };
    const res = {
      headersSent: false, writeHead: vi.fn(), end: vi.fn(), destroy: vi.fn(),
    } as unknown as http.ServerResponse;
    const log = vi.fn();
    const listener = withRequestErrorBoundary((_req, response) => {
      return buildHealthBody(read).then((body) => {
        const json = JSON.stringify(body);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(json);
      });
    }, log);

    listener({} as http.IncomingMessage, res);
    expect(res.writeHead).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(res.end).toHaveBeenCalledOnce());
    expect(res.writeHead).toHaveBeenCalledExactlyOnceWith(500, { "Content-Type": "application/json" });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Internal server error" }));
    expect(res.destroy).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });

  it("preserves every legacy field and adds the unknown-run summary", async () => {
    expect(await buildHealthBody(readers())).toEqual({
      status: "ok", sourceCommit: "abc123", polls: 42, kgDegraded: true,
      kgUnavailable: true, sidecar: { reachable: false, toolsListed: false, lastError: "probe failed", checkedAt: 123 },
      restate: { sidecar: { state: "exited", code: 1, signal: null }, registration: { state: "unreachable" } },
      deploy: { held: true, startedAt: 456 }, lastPollStartedAt: new Date(1000).toISOString(), lastPollFinishedAt: new Date(2000).toISOString(),
      setupChecks: { checkedAt: null, failingCore: null, failingOnAdminPath: ["env.github-app", "admin.path"] },
    });
    const read = readers();
    read.sourceCommit = () => null;
    read.pollStats = () => ({ pollCount: 0, lastPollStartedAt: null, lastPollFinishedAt: null });
    read.sidecarHealthFields = () => ({});
    expect(await buildHealthBody(read)).toMatchObject({ sourceCommit: null, polls: 0, lastPollStartedAt: null, lastPollFinishedAt: null });
    expect(await buildHealthBody(read)).not.toHaveProperty("sidecar");
  });

  it("uses only local checks with Restate down, refreshing ids but keeping the cached count", async () => {
    const fake = fakeFetch({}).install();
    const read = readers();
    const ctx = makeSetupCheckContext({
      env: { ADMIN_ACCESS_CODE: "your-secret-access-code", GOOGLE_OAUTH_CLIENT_ID: "partial", POLL_INTERVAL_MS: "bad" },
      restateStatus: () => ({ sidecar: { state: "exited" }, registration: { state: "unreachable" } }),
      databasePath: () => ({ path: "/tmp/db", configured: "/data/db", fellBack: true }),
    });
    const run = await runSetupChecks(ctx, ORCHESTRATOR_CONFIG_CHECKS, () => 123);
    recordSetupCheckRun(run);
    read.lastSetupCheckRun = getLastSetupCheckRun;
    read.setupCheckContext = () => ctx;
    expect((await buildHealthBody(read)).setupChecks).toEqual({
      checkedAt: 123, failingCore: 7,
      failingOnAdminPath: ["env.github-app", "env.admin-access-code", "volume.database", "restate", "admin.path"],
    });
    ctx.env = { GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret" };
    expect((await buildHealthBody(read)).setupChecks).toEqual({
      checkedAt: 123, failingCore: 7,
      failingOnAdminPath: ["env.github-app", "volume.database", "restate", "admin.redirect-url", "admin.allowlist"],
    });
    expect(fake.calls).toEqual([]);
  });

  it("counts only failing core rows in the recorded run", async () => {
    const read = readers();
    const results: SetupCheckRun["results"] = [
      ["core", "fail"], ["core", "fail"], ["core", "pass"], ["core", "warn"],
      ["core", "cannot-verify"], ["core", "not-applicable"], ["mode", "fail"], ["feature", "fail"],
    ].map(([tier, state]) => ({
      id: "restate", title: "Stored diagnostic", group: "orchestrator", onAdminPath: true,
      tier: tier as SetupCheckRun["results"][number]["tier"],
      state: state as SetupCheckRun["results"][number]["state"],
    }));
    recordSetupCheckRun({ checkedAt: 321, results });
    read.lastSetupCheckRun = getLastSetupCheckRun;
    expect((await buildHealthBody(read)).setupChecks).toEqual({
      checkedAt: 321, failingCore: 2, failingOnAdminPath: ["env.github-app", "admin.path"],
    });
  });

  it("excludes cannot-verify local checks from bootstrap failures", async () => {
    const read = readers();
    read.setupCheckContext = () => makeSetupCheckContext({
      databasePath: () => { throw new Error("sentinel-unreadable-database"); },
    });
    expect((await buildHealthBody(read)).setupChecks).toEqual({
      checkedAt: null, failingCore: null, failingOnAdminPath: ["env.github-app", "admin.path"],
    });
  });

  it("keeps an empty bootstrap list when no local check reports fail", async () => {
    const read = readers();
    const { privateKey } = generateKeyPairSync("ed25519");
    let allowlistReads = 0;
    read.setupCheckContext = () => makeSetupCheckContext({
      env: {
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        GOOGLE_OAUTH_CLIENT_ID: "client", GOOGLE_OAUTH_CLIENT_SECRET: "secret",
        OAUTH_REDIRECT_BASE_URL: "https://example.com",
      },
      // The configuration read sees no admin. A subsequent local read fails rather than
      // reporting a failing allowlist, so there are no failing ids to disclose.
      effectiveAllowlist: () => {
        if (++allowlistReads > 1) throw new Error("sentinel-allowlist-outage");
        return { entries: [], source: "env" };
      },
    });
    expect((await buildHealthBody(read)).setupChecks).toEqual({
      checkedAt: null, failingCore: null, failingOnAdminPath: [],
    });
    expect(allowlistReads).toBe(2);
  });

  it("serializes only allowed keys with diagnostic sentinels in live bootstrap results", async () => {
    const fake = fakeFetch({}).install();
    const read = readers();
    const ctx = makeSetupCheckContext({
      env: { GITHUB_APP_ID: "sentinel-app-id", GITHUB_APP_PRIVATE_KEY: "sentinel-private-key",
        GOOGLE_OAUTH_CLIENT_ID: "sentinel-client-id", GOOGLE_OAUTH_CLIENT_SECRET: "sentinel-client-secret" },
      databasePath: () => ({ path: "sentinel-db-path", configured: "sentinel-db-configured", fellBack: true }),
      restateStatus: () => { throw new Error("sentinel-restate-error"); },
    });
    const live = await runSetupChecks(ctx, ORCHESTRATOR_CONFIG_CHECKS.filter((check) => check.onAdminPath), () => 777);
    expect(JSON.stringify(live)).toContain("sentinel-db-configured");
    expect(JSON.stringify(live)).toContain("sentinel-restate-error");
    const run: SetupCheckRun = { checkedAt: 777, results: live.results.map((row) => ({
      ...row, title: "sentinel-title", detail: "sentinel-detail", fix: "sentinel-fix",
      fixUrl: "sentinel-fix-url", project: "sentinel-project",
    })) };
    read.lastSetupCheckRun = () => run;
    read.setupCheckContext = () => ctx;
    const summary = (await buildHealthBody(read)).setupChecks;
    expect(Object.keys(summary).sort()).toEqual(["checkedAt", "failingCore", "failingOnAdminPath"]);
    expect(JSON.parse(JSON.stringify(summary))).toEqual({
      checkedAt: 777, failingCore: 4,
      failingOnAdminPath: ["env.github-app", "volume.database", "admin.redirect-url", "admin.allowlist"],
    });
    expect(JSON.stringify(summary)).not.toContain("sentinel-");
    expect(fake.calls).toEqual([]);
  });

  it("exposes only counts and ids, and omits ids once configured or the allowlist is unreadable", async () => {
    const read = readers();
    const run: SetupCheckRun = { checkedAt: 999, results: [{ id: "admin.path", title: "PRIVATE TITLE", group: "orchestrator", tier: "core", state: "fail", onAdminPath: true, project: "PRIVATE PROJECT", detail: "PRIVATE DETAIL", fix: "PRIVATE FIX" }] };
    read.lastSetupCheckRun = () => run;
    for (const ctx of [makeSetupCheckContext({ env: { ADMIN_ACCESS_CODE: "PRIVATE CODE" } }), makeSetupCheckContext({ effectiveAllowlist: () => null })]) {
      read.setupCheckContext = () => ctx;
      expect((await buildHealthBody(read)).setupChecks).toEqual({ checkedAt: 999, failingCore: 1 });
    }
  });

  it.each(["", "example.com"])("suppresses bootstrap ids after a cached allowlist refresh fails (domain %s)", async (domain) => {
    const { modules: { access, dedup, setup, health } } = await testDb({ modules: {
      access: () => import("../access-entries.js"),
      dedup: () => import("../dedup.js"),
      setup: () => import("../setup-checks/index.js"),
      health: () => import("../health-body.js"),
    } });
    vi.stubEnv("OAUTH_ALLOWED_EMAILS", "");
    vi.stubEnv("OAUTH_ALLOWED_DOMAINS", domain);
    const fake = fakeFetch({}).install();
    const read = readers();
    // Keep the real production allowlist readers, including their cache and availability state.
    read.setupCheckContext = () => setup.createSetupCheckContext({
      env: {}, restateStatus: () => ({ sidecar: { state: "exited" }, registration: { state: "unreachable" } }),
    });
    expect((await health.buildHealthBody(read)).setupChecks).toHaveProperty("failingOnAdminPath");
    const cached = access.getEffectiveAllowlist();
    expect(access.isAllowlistReadAvailable()).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dedup.getDb().exec("DROP TABLE access_entries");
    access.refreshEffectiveAllowlist();
    expect(access.getEffectiveAllowlist()).toBe(cached);
    expect(access.isAllowlistReadAvailable()).toBe(false);
    expect((await health.buildHealthBody(read)).setupChecks).toEqual({ checkedAt: null, failingCore: null });
    // A successful read restores bootstrap behavior without a process restart.
    access.initAccessEntriesTable();
    access.refreshEffectiveAllowlist();
    expect(access.isAllowlistReadAvailable()).toBe(true);
    expect((await health.buildHealthBody(read)).setupChecks).toHaveProperty("failingOnAdminPath");
    expect(fake.calls).toEqual([]);
    warn.mockRestore();
  });

  it("keeps the eight admin-path ids explicit", () => {
    expect(ORCHESTRATOR_CONFIG_CHECKS.filter((check) => check.onAdminPath).map((check) => check.id)).toEqual([
      "env.github-app", "env.admin-access-code", "volume.database", "restate", "admin.path", "admin.providers", "admin.redirect-url", "admin.allowlist",
    ]);
  });
});
