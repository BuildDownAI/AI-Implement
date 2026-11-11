import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runSetupChecks, setupChecksHealthField, type SetupCheckRun } from "../../setup-checks/index.js";
import { ORCHESTRATOR_CONFIG_CHECKS } from "../../setup-checks/orchestrator-config.js";
import { makeSetupCheckContext } from "../helpers/fixtures/setup-checks.js";
import { testDb } from "../helpers/test-db.js";
import { fakeFetch } from "../helpers/fake-fetch.js";

describe("setupChecksHealthField", () => {
  it("has no time or count before a run, and names the failing admin-path ids while no admin path is configured", async () => {
    expect(await setupChecksHealthField(null, makeSetupCheckContext())).toEqual({
      checkedAt: null, failingCore: null, failingOnAdminPath: ["env.github-app", "admin.path"],
    });
  });

  it("uses only local checks with Restate down, refreshing ids but keeping the run's count", async () => {
    const fake = fakeFetch({}).install();
    const ctx = makeSetupCheckContext({
      env: { ADMIN_ACCESS_CODE: "your-secret-access-code", GOOGLE_OAUTH_CLIENT_ID: "partial", POLL_INTERVAL_MS: "bad" },
      restateStatus: () => ({ sidecar: { state: "exited" }, registration: { state: "unreachable" } }),
      databasePath: () => ({ path: "/tmp/db", configured: "/data/db", fellBack: true }),
    });
    const run = await runSetupChecks(ctx, ORCHESTRATOR_CONFIG_CHECKS, () => 123);
    expect(await setupChecksHealthField(run, ctx)).toEqual({
      checkedAt: 123, failingCore: 7,
      failingOnAdminPath: ["env.github-app", "env.admin-access-code", "volume.database", "restate", "admin.path"],
    });
    ctx.env = { GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret" };
    expect(await setupChecksHealthField(run, ctx)).toEqual({
      checkedAt: 123, failingCore: 7,
      failingOnAdminPath: ["env.github-app", "volume.database", "restate", "admin.redirect-url", "admin.allowlist"],
    });
    expect(fake.calls).toEqual([]);
  });

  it("counts only failing core rows in the run", async () => {
    const results: SetupCheckRun["results"] = [
      ["core", "fail"], ["core", "fail"], ["core", "pass"], ["core", "warn"],
      ["core", "cannot-verify"], ["core", "not-applicable"], ["mode", "fail"], ["feature", "fail"],
    ].map(([tier, state]) => ({
      id: "restate", title: "Stored diagnostic", group: "orchestrator", onAdminPath: true,
      tier: tier as SetupCheckRun["results"][number]["tier"],
      state: state as SetupCheckRun["results"][number]["state"],
    }));
    expect(await setupChecksHealthField({ checkedAt: 321, results }, makeSetupCheckContext())).toEqual({
      checkedAt: 321, failingCore: 2, failingOnAdminPath: ["env.github-app", "admin.path"],
    });
  });

  it("excludes cannot-verify local checks from bootstrap failures", async () => {
    const ctx = makeSetupCheckContext({
      databasePath: () => { throw new Error("sentinel-unreadable-database"); },
    });
    expect(await setupChecksHealthField(null, ctx)).toEqual({
      checkedAt: null, failingCore: null, failingOnAdminPath: ["env.github-app", "admin.path"],
    });
  });

  it("keeps an empty bootstrap list when no local check reports fail", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    let allowlistReads = 0;
    const ctx = makeSetupCheckContext({
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
    expect(await setupChecksHealthField(null, ctx)).toEqual({
      checkedAt: null, failingCore: null, failingOnAdminPath: [],
    });
    expect(allowlistReads).toBe(2);
  });

  it("serializes only allowed keys with diagnostic sentinels in live bootstrap results", async () => {
    const fake = fakeFetch({}).install();
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
    const field = await setupChecksHealthField(run, ctx);
    expect(Object.keys(field).sort()).toEqual(["checkedAt", "failingCore", "failingOnAdminPath"]);
    expect(JSON.parse(JSON.stringify(field))).toEqual({
      checkedAt: 777, failingCore: 4,
      failingOnAdminPath: ["env.github-app", "volume.database", "admin.redirect-url", "admin.allowlist"],
    });
    expect(JSON.stringify(field)).not.toContain("sentinel-");
    expect(fake.calls).toEqual([]);
  });

  it("exposes only counts and ids, and omits ids once configured or the allowlist is unreadable", async () => {
    const run: SetupCheckRun = { checkedAt: 999, results: [{ id: "admin.path", title: "PRIVATE TITLE", group: "orchestrator", tier: "core", state: "fail", onAdminPath: true, project: "PRIVATE PROJECT", detail: "PRIVATE DETAIL", fix: "PRIVATE FIX" }] };
    for (const ctx of [makeSetupCheckContext({ env: { ADMIN_ACCESS_CODE: "PRIVATE CODE" } }), makeSetupCheckContext({ effectiveAllowlist: () => null })]) {
      expect(await setupChecksHealthField(run, ctx)).toEqual({ checkedAt: 999, failingCore: 1 });
    }
  });

  it.each(["", "example.com"])("suppresses bootstrap ids after a cached allowlist refresh fails (domain %s)", async (domain) => {
    const { modules: { access, dedup, setup } } = await testDb({ modules: {
      access: () => import("../../access-entries.js"),
      dedup: () => import("../../dedup.js"),
      setup: () => import("../../setup-checks/index.js"),
    } });
    vi.stubEnv("OAUTH_ALLOWED_EMAILS", "");
    vi.stubEnv("OAUTH_ALLOWED_DOMAINS", domain);
    const fake = fakeFetch({}).install();
    // Keep the real production allowlist readers, including their cache and availability state.
    const field = () => setup.setupChecksHealthField(null, setup.createSetupCheckContext({
      env: {}, restateStatus: () => ({ sidecar: { state: "exited" }, registration: { state: "unreachable" } }),
    }));
    expect(await field()).toHaveProperty("failingOnAdminPath");
    const cached = access.getEffectiveAllowlist();
    expect(access.isAllowlistReadAvailable()).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dedup.getDb().exec("DROP TABLE access_entries");
    access.refreshEffectiveAllowlist();
    expect(access.getEffectiveAllowlist()).toBe(cached);
    expect(access.isAllowlistReadAvailable()).toBe(false);
    expect(await field()).toEqual({ checkedAt: null, failingCore: null });
    // A successful read restores bootstrap behavior without a process restart.
    access.initAccessEntriesTable();
    access.refreshEffectiveAllowlist();
    expect(access.isAllowlistReadAvailable()).toBe(true);
    expect(await field()).toHaveProperty("failingOnAdminPath");
    expect(fake.calls).toEqual([]);
    warn.mockRestore();
  });

  it("keeps the eight admin-path ids explicit", () => {
    expect(ORCHESTRATOR_CONFIG_CHECKS.filter((check) => check.onAdminPath).map((check) => check.id)).toEqual([
      "env.github-app", "env.admin-access-code", "volume.database", "restate", "admin.path", "admin.providers", "admin.redirect-url", "admin.allowlist",
    ]);
  });
});
