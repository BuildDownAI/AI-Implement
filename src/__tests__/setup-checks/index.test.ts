import { beforeEach, describe, expect, it } from "vitest";
import type * as DedupModule from "../../dedup.js";
import type * as SetupChecksModule from "../../setup-checks/index.js";
import type { SetupCheck, SetupCheckContext, SetupCheckResult } from "../../setup-checks/index.js";
import { makeAccessEntry, makeMapping } from "../helpers/builders.js";
import { makeSetupCheckContext } from "../helpers/fixtures/setup-checks.js";
import { testDb } from "../helpers/test-db.js";

let dedup: typeof DedupModule;
let checks: typeof SetupChecksModule;

beforeEach(async () => {
  ({ dedup, checks } = (await testDb({
    modules: { dedup: () => import("../../dedup.js"), checks: () => import("../../setup-checks/index.js") },
  })).modules);
});

function fakeCheck(overrides: Partial<SetupCheck> = {}): SetupCheck {
  return {
    id: "restate",
    title: "Fake check",
    group: "orchestrator",
    tier: "core",
    onAdminPath: false,
    run: () => [{ state: "pass" }],
    ...overrides,
  };
}

const SAVED_ROWS: Record<string, string> = { kg_base_repo: "Org/saved-repo", fly_process_level_secrets: "true" };
const SAVED_ENTRIES = [makeAccessEntry(), makeAccessEntry({ kind: "domain", value: "example.com", role: "user" })];

/** Contexts that between them reach every check's pass, warn, fail, cannot-verify and not-applicable branches. */
const CONTEXTS: Record<string, SetupCheckContext> = {
  "nothing configured": makeSetupCheckContext(),
  "configured": makeSetupCheckContext({
    env: {
      GITHUB_APP_ID: "123456",
      ADMIN_ACCESS_CODE: "a-real-code",
      RUNNER_MODE: "gha",
      POLL_INTERVAL_MS: "30000",
      DISPATCH_BREAKER_THRESHOLD: "5",
      RUNNER_CALLBACK_BASE_URL: "https://orchestrator.example.com",
      RUNNER_TOKEN_SECRET: "a-long-random-value",
      GOOGLE_OAUTH_CLIENT_ID: "gid",
      GOOGLE_OAUTH_CLIENT_SECRET: "gsecret",
      OAUTH_REDIRECT_BASE_URL: "https://orchestrator.example.com",
      OAUTH_ALLOWED_EMAILS: "admin@example.com",
      FLY_APP_NAME: "ai-implement-orchestrator",
    },
    mappings: () => ({ ENG: makeMapping({ executionMode: "fly-machines" }) }),
    runnerMode: () => ({ mode: "gha", source: "env" }),
    flySessions: () => ({ token: "fly-token", app: "ai-sessions", region: null, source: { app: "restate", region: null } }),
  }),
  "broken": makeSetupCheckContext({
    env: {
      GITHUB_APP_ID: "123456",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
      ADMIN_ACCESS_CODE: "your-secret-access-code",
      RUNNER_MODE: "flyy",
      POLL_INTERVAL_MS: "60s",
      DISPATCH_BREAKER_THRESHOLD: "",
      KG_BASE_REPO: "Org/env-repo",
      RUNNER_IMAGE_ALLOWED_PREFIXES: "ghcr.io",
      FLY_PROCESS_LEVEL_SECRETS: "false",
      GOOGLE_OAUTH_CLIENT_ID: "gid",
      MICROSOFT_OAUTH_CLIENT_ID: "mid",
      MICROSOFT_OAUTH_CLIENT_SECRET: "msecret",
      MICROSOFT_OAUTH_TENANT: "common",
      BUILDDOWN_OIDC_ISSUER: "http://cp.example.com",
      BUILDDOWN_OIDC_CLIENT_ID: "bid",
      BUILDDOWN_OIDC_CLIENT_SECRET: "bsecret",
      OAUTH_ALLOWED_DOMAINS: "example.com",
      FLY_APP_NAME: "ai-implement-orchestrator",
    },
    readSetting: (key) => SAVED_ROWS[key] ?? null,
    storedAccessEntries: () => SAVED_ENTRIES,
    effectiveAllowlist: () => ({ entries: SAVED_ENTRIES, source: "db" }),
    restateStatus: () => ({ sidecar: { state: "exited" }, registration: { state: "not-attempted" } }),
    databasePath: () => ({ path: "/tmp/ai-implement.sqlite", configured: "/data/dedup.sqlite", fellBack: true }),
    mappings: () => ({ ENG: makeMapping({ executionMode: "fly-machines" }) }),
  }),
  "database unreadable": makeSetupCheckContext({
    env: { GOOGLE_OAUTH_CLIENT_ID: "gid", GOOGLE_OAUTH_CLIENT_SECRET: "gsecret", KG_BASE_REPO: "Org/env-repo", RUNNER_MODE: "fly" },
    readSetting: () => { throw new Error("no such table: settings"); },
    storedAccessEntries: () => { throw new Error("no such table: access_entries"); },
    effectiveAllowlist: () => null,
    runnerMode: () => ({ mode: "fly", source: "env" }),
  }),
  "SSO with no admin in the list": makeSetupCheckContext({
    env: { GOOGLE_OAUTH_CLIENT_ID: "gid", GOOGLE_OAUTH_CLIENT_SECRET: "gsecret", OAUTH_ALLOWED_DOMAINS: "example.com" },
    effectiveAllowlist: () => ({ entries: [makeAccessEntry({ kind: "domain", value: "example.com", role: "user", addedAt: 0, addedBy: null })], source: "env" }),
    databasePath: () => ({ path: "/data/dedup.sqlite", configured: "/data/dedup.sqlite", fellBack: false }),
    onSeparateFilesystem: () => false,
  }),
};

async function resultsFor(ctx: SetupCheckContext): Promise<SetupCheckResult[]> {
  return (await checks.runSetupChecks(ctx)).results;
}

describe("SETUP_CHECKS", () => {
  it("registers exactly one check for each id in SETUP_CHECK_IDS", () => {
    const registered = checks.SETUP_CHECKS.map((check) => check.id).sort();
    expect(registered).toEqual([...checks.SETUP_CHECK_IDS].sort());
  });

  it("reaches every state across the shared contexts, so the rules below run over every branch kind", async () => {
    const states = new Set<string>();
    for (const ctx of Object.values(CONTEXTS)) for (const result of await resultsFor(ctx)) states.add(result.state);
    expect([...states].sort()).toEqual(["cannot-verify", "fail", "not-applicable", "pass", "warn"]);
  });

  it.each(Object.keys(CONTEXTS))("never names a docs/ file in a detail or fix (%s)", async (name) => {
    for (const result of await resultsFor(CONTEXTS[name])) {
      expect(result.detail ?? "", result.id).not.toContain("docs/");
      expect(result.fix ?? "", result.id).not.toContain("docs/");
    }
  });

  it("keeps every configured value out of id, title and state", async () => {
    // Each value carries a marker no id or title contains, so a match can only be a value shown.
    const ctx = makeSetupCheckContext({
      env: {
        GITHUB_APP_ID: "marked-app-id",
        RUNNER_MODE: "marked-mode",
        POLL_INTERVAL_MS: "marked-interval",
        DISPATCH_BREAKER_THRESHOLD: "marked-threshold",
        KG_BASE_REPO: "marked/kg-base-repo",
        LINEAR_PICKUP_LABEL: "marked-label",
        RUNNER_IMAGE_ALLOWED_PREFIXES: "marked-prefix",
        RUNNER_CALLBACK_BASE_URL: "https://marked.example.com",
        GOOGLE_OAUTH_CLIENT_ID: "marked-client-id",
        OAUTH_REDIRECT_BASE_URL: "https://marked-redirect.example.com",
        OAUTH_ALLOWED_EMAILS: "marked@example.com",
        FLY_APP_NAME: "marked-fly-app",
        FLY_SESSIONS_APP: "marked-sessions-app",
      },
      // Only the free-text rows: the others hold a value their admin route validated.
      readSetting: (key) => ({ kg_base_repo: "marked/saved-repo", linear_pickup_label: "marked-saved-label" } as Record<string, string>)[key] ?? null,
      databasePath: () => ({ path: "/marked/dedup.sqlite", configured: "/marked/dedup.sqlite", fellBack: false }),
      mappings: () => ({ MARKED: makeMapping({ executionMode: "fly-machines" }) }),
      flySessions: () => ({ token: null, app: "marked-sessions-app", region: null, source: { app: "env", region: null } }),
    });
    for (const result of await resultsFor(ctx)) {
      expect([result.id, result.title, result.state].join(" ").toLowerCase(), result.id).not.toContain("marked");
    }
  });

  it("never shows a secret's value in any field", async () => {
    const secrets = {
      GITHUB_APP_PRIVATE_KEY: "sentinel-app-key",
      ADMIN_ACCESS_CODE: "sentinel-access-code",
      RUNNER_TOKEN_SECRET: "sentinel-token-secret",
      FLY_SESSIONS_TOKEN: "sentinel-fly-sessions-token",
      GOOGLE_OAUTH_CLIENT_SECRET: "sentinel-google-secret",
      MICROSOFT_OAUTH_CLIENT_SECRET: "sentinel-microsoft-secret",
      BUILDDOWN_OIDC_CLIENT_SECRET: "sentinel-builddown-secret",
    };
    const ctx = makeSetupCheckContext({
      env: {
        ...secrets,
        GITHUB_APP_ID: "123456",
        RUNNER_CALLBACK_BASE_URL: "https://orchestrator.example.com",
        GOOGLE_OAUTH_CLIENT_ID: "gid",
        MICROSOFT_OAUTH_CLIENT_ID: "mid",
        MICROSOFT_OAUTH_TENANT: "tenant-id",
        BUILDDOWN_OIDC_ISSUER: "https://cp.example.com",
        BUILDDOWN_OIDC_CLIENT_ID: "bid",
        OAUTH_REDIRECT_BASE_URL: "https://orchestrator.example.com",
      },
      mappings: () => ({ ENG: makeMapping({ executionMode: "fly-machines" }) }),
      flySessions: () => ({ token: secrets.FLY_SESSIONS_TOKEN, app: null, region: null, source: { app: null, region: null } }),
    });
    const results = await resultsFor(ctx);
    expect(results.length).toBe(checks.SETUP_CHECKS.length);
    expect(JSON.stringify(results)).not.toContain("sentinel-");
  });
});

describe("runSetupChecks", () => {
  it("adds each check's identity to its outcomes and stamps the run with the clock", async () => {
    const check = fakeCheck({ id: "admin.path", title: "Admin sign-in", tier: "mode", onAdminPath: true, run: () => [{ state: "warn", detail: "d", fix: "f" }] });
    expect(await checks.runSetupChecks(makeSetupCheckContext(), [check], () => 1234)).toEqual({
      checkedAt: 1234,
      results: [{ id: "admin.path", title: "Admin sign-in", group: "orchestrator", tier: "mode", onAdminPath: true, state: "warn", detail: "d", fix: "f" }],
    });
  });

  it("reports one result per outcome, in check order, for a per-project check", async () => {
    const perProject = fakeCheck({ id: "env.poll-interval", run: async () => [{ state: "pass", project: "ENG" }, { state: "fail", project: "OPS" }] });
    const after = fakeCheck({ id: "restate" });
    const { results } = await checks.runSetupChecks(makeSetupCheckContext(), [perProject, after]);
    expect(results.map((r) => [r.id, r.project, r.state])).toEqual([
      ["env.poll-interval", "ENG", "pass"],
      ["env.poll-interval", "OPS", "fail"],
      ["restate", undefined, "pass"],
    ]);
  });

  it("reports a check that throws as cannot-verify with its error, and still runs the others", async () => {
    const throwsSync = fakeCheck({ id: "env.github-app", run: () => { throw new Error("reader broke"); } });
    const rejects = fakeCheck({ id: "restate", run: async () => { throw "not an Error"; } });
    const passes = fakeCheck({ id: "admin.path" });
    const { results } = await checks.runSetupChecks(makeSetupCheckContext(), [throwsSync, rejects, passes]);
    expect(results.map((r) => [r.id, r.state, r.detail])).toEqual([
      ["env.github-app", "cannot-verify", "reader broke"],
      ["restate", "cannot-verify", "not an Error"],
      ["admin.path", "pass", undefined],
    ]);
    expect(results[0].fix).toBe("The check itself could not run, its detail names the error.");
  });

  it("runs the registered list by default", async () => {
    const { results } = await checks.runSetupChecks(makeSetupCheckContext());
    expect(new Set(results.map((r) => r.id))).toEqual(new Set(checks.SETUP_CHECK_IDS));
  });
});

describe("createSetupCheckContext", () => {
  const restateStatus = () => ({ sidecar: { state: "ready" }, registration: { state: "registered" } });

  it("reads a raw settings row from the orchestrator's database, or null when there is none", () => {
    dedup.getDb().prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("runner_mode", "gha");
    const ctx = checks.createSetupCheckContext({ restateStatus });
    expect(ctx.readSetting("runner_mode")).toBe("gha");
    expect(ctx.readSetting("kg_base_repo")).toBeNull();
  });

  it("throws from readSetting when the database cannot answer, so the check reports cannot-verify", async () => {
    const { modules } = await testDb({ tables: "none", modules: { checks: () => import("../../setup-checks/index.js") } });
    const ctx = modules.checks.createSetupCheckContext({ restateStatus });
    expect(() => ctx.readSetting("runner_mode")).toThrow();
  });

  it("keeps the caller's overrides and the default readers for the rest", () => {
    const env = { RUNNER_MODE: "fly" };
    const ctx = checks.createSetupCheckContext({ env, restateStatus });
    expect(ctx.env).toBe(env);
    expect(ctx.restateStatus).toBe(restateStatus);
    expect(ctx.databasePath()).toEqual(dedup.getDatabasePath());
  });

  it("requires the caller to supply the Restate status reader", () => {
    // @ts-expect-error The reader depends on where the caller runs, so it has no default.
    const ctx = checks.createSetupCheckContext({});
    expect(ctx.restateStatus).toBeUndefined();
  });
});
