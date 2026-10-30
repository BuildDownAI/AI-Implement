import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SeedOnceSettingsModule from "../../seed-once-settings.js";
import type * as SetupChecksModule from "../../setup-checks/index.js";
import type { SetupCheckContext, SetupCheckId, SetupCheckOutcome } from "../../setup-checks/index.js";
import { ORCHESTRATOR_CONFIG_CHECKS } from "../../setup-checks/orchestrator-config.js";
import { makeAccessEntry, makeMapping } from "../helpers/builders.js";
import { makeSetupCheckContext } from "../helpers/fixtures/setup-checks.js";
import { testDb } from "../helpers/test-db.js";

const { privateKey: pkcs1Key } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

async function run(id: SetupCheckId, overrides: Partial<SetupCheckContext> = {}): Promise<SetupCheckOutcome[]> {
  const check = ORCHESTRATOR_CONFIG_CHECKS.find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check.run(makeSetupCheckContext(overrides));
}

const rows = (values: Record<string, string>) => (key: string) => values[key] ?? null;

const GOOGLE = { GOOGLE_OAUTH_CLIENT_ID: "gid", GOOGLE_OAUTH_CLIENT_SECRET: "gsecret" };

describe("the .env.example this issue started from", () => {
  // Its values as `npm run dev` loads them (blank assignments load as empty strings).
  const ENV_EXAMPLE = {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
    RUNNER_MODE: "fly",
    FLY_SESSIONS_APP: "",
    FLY_SESSIONS_REGION: "iad",
    FLY_SESSIONS_TOKEN: "",
    FLY_PROCESS_LEVEL_SECRETS: "",
    RUNNER_CALLBACK_BASE_URL: "",
    RUNNER_TOKEN_SECRET: "",
    ADMIN_ACCESS_CODE: "your-secret-access-code",
    OAUTH_REDIRECT_BASE_URL: "",
    OAUTH_ALLOWED_DOMAINS: "your-company.com",
    OAUTH_ALLOWED_EMAILS: "you@your-company.com",
    POLL_INTERVAL_MS: "60000",
    DEDUP_DB_PATH: "./dedup.sqlite",
    DISPATCH_BREAKER_THRESHOLD: "3",
  };

  it("names the placeholder App key, the placeholder access code and the RUNNER_MODE override", async () => {
    // An operator who saved a runner mode on /admin#runners, as the override then hides.
    const ctx = { env: ENV_EXAMPLE, readSetting: rows({ runner_mode: "default" }) };
    expect(await run("env.github-app", ctx)).toMatchObject([{ state: "fail", detail: "GITHUB_APP_PRIVATE_KEY does not parse as a private key" }]);
    expect(await run("env.admin-access-code", ctx)).toMatchObject([{ state: "fail" }]);
    expect(await run("settings.env-override", ctx)).toMatchObject([{ state: "warn", detail: expect.stringContaining("RUNNER_MODE=fly overrides") }]);
  });
});

describe("env.github-app", () => {
  it.each([
    [{}, "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY not set"],
    [{ GITHUB_APP_ID: "123456" }, "GITHUB_APP_PRIVATE_KEY not set"],
    [{ GITHUB_APP_PRIVATE_KEY: pkcs1Key }, "GITHUB_APP_ID not set"],
  ])("fails naming each unset variable (%j)", async (env, detail) => {
    expect(await run("env.github-app", { env })).toMatchObject([{ state: "fail", detail }]);
  });

  it("fails when the key does not parse", async () => {
    expect(await run("env.github-app", { env: { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "not a key" } })).toMatchObject([
      { state: "fail", detail: "GITHUB_APP_PRIVATE_KEY does not parse as a private key" },
    ]);
  });

  it("passes a PKCS#1 key written on one line with escaped newlines, as the mint reads it", async () => {
    const oneLine = pkcs1Key.replace(/\n/g, "\\n");
    expect(await run("env.github-app", { env: { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: oneLine } })).toMatchObject([{ state: "pass" }]);
  });
});

describe("env.admin-access-code", () => {
  it.each([{}, { ADMIN_ACCESS_CODE: "" }])("does not apply when the code is unset (%j)", async (env) => {
    expect(await run("env.admin-access-code", { env })).toMatchObject([{ state: "not-applicable" }]);
  });

  it("fails on the published placeholder", async () => {
    expect(await run("env.admin-access-code", { env: { ADMIN_ACCESS_CODE: "your-secret-access-code" } })).toMatchObject([
      { state: "fail", fix: "Set a real access code, or unset ADMIN_ACCESS_CODE and sign in with SSO." },
    ]);
  });

  it("passes any other code", async () => {
    expect(await run("env.admin-access-code", { env: { ADMIN_ACCESS_CODE: "a-real-code" } })).toMatchObject([{ state: "pass" }]);
  });
});

describe("env.runner-mode", () => {
  it.each([{}, { RUNNER_MODE: "fly" }, { RUNNER_MODE: "default" }])("passes when unset or a runner mode (%j)", async (env) => {
    expect(await run("env.runner-mode", { env })).toMatchObject([{ state: "pass" }]);
  });

  it.each(["Fly", "github", " fly"])("warns that %j is ignored, naming the valid modes", async (mode) => {
    expect(await run("env.runner-mode", { env: { RUNNER_MODE: mode } })).toMatchObject([
      { state: "warn", fix: "Set RUNNER_MODE to one of default, gha, fly, local, shadow, or unset it." },
    ]);
  });
});

describe("env.poll-interval", () => {
  it.each([
    [{}, "POLL_INTERVAL_MS not set, so the poll runs every 60000 ms"],
    [{ POLL_INTERVAL_MS: "" }, "POLL_INTERVAL_MS not set, so the poll runs every 60000 ms"],
    [{ POLL_INTERVAL_MS: "30000" }, "The poll runs every 30000 ms"],
    [{ POLL_INTERVAL_MS: "2147483647" }, "The poll runs every 2147483647 ms"],
  ])("passes %j", async (env, detail) => {
    expect(await run("env.poll-interval", { env })).toMatchObject([{ state: "pass", detail }]);
  });

  it.each([
    ["60s", "POLL_INTERVAL_MS=60s is read as 60, so the poll runs every 60 ms"],
    ["1e5", "POLL_INTERVAL_MS=1e5 is read as 1, so the poll runs every 1 ms"],
    ["abc", "POLL_INTERVAL_MS=abc is read as NaN, so the poll runs every millisecond"],
    ["0", "POLL_INTERVAL_MS=0 is read as 0, so the poll runs every millisecond"],
    ["-5", "POLL_INTERVAL_MS=-5 is read as -5, so the poll runs every millisecond"],
    ["3000000000", "POLL_INTERVAL_MS=3000000000 is read as 3000000000, so the poll runs every millisecond"],
  ])("fails %j", async (raw, detail) => {
    expect(await run("env.poll-interval", { env: { POLL_INTERVAL_MS: raw } })).toMatchObject([{ state: "fail", detail }]);
  });
});

describe("env.breaker-threshold", () => {
  it.each([
    [{}, "DISPATCH_BREAKER_THRESHOLD not set, so an issue parks after 3 failures"],
    [{ DISPATCH_BREAKER_THRESHOLD: "5" }, "So an issue parks after 5 failures"],
    [{ DISPATCH_BREAKER_THRESHOLD: "3.5" }, "So an issue parks after 4 failures"],
  ])("passes %j", async (env, detail) => {
    expect(await run("env.breaker-threshold", { env })).toMatchObject([{ state: "pass", detail }]);
  });

  it.each([
    ["", "0"],
    ["0", "0"],
    ["-1", "-1"],
    ["abc", "NaN"],
  ])("fails %j, which reads as %s and turns the breaker off", async (raw, read) => {
    expect(await run("env.breaker-threshold", { env: { DISPATCH_BREAKER_THRESHOLD: raw } })).toMatchObject([
      { state: "fail", detail: `DISPATCH_BREAKER_THRESHOLD=${raw} is read as ${read}, which turns the breaker off` },
    ]);
  });
});

describe("settings.seeded", () => {
  it("passes with no seed-once variable set, or one the seed would skip", async () => {
    expect(await run("settings.seeded")).toMatchObject([{ state: "pass" }]);
    expect(await run("settings.seeded", { env: { KG_EXECUTION_MODE: "bogus", LINEAR_PICKUP_LABEL: "  " } })).toMatchObject([{ state: "pass" }]);
  });

  it("passes when the saved value matches the variable as the seed stores it", async () => {
    const outcomes = await run("settings.seeded", {
      env: { KG_BASE_REPO: "  Org/repo  ", KG_MATERIALIZE_DIRECT: "yes" },
      readSetting: rows({ kg_base_repo: "Org/repo", kg_materialize_direct: "false" }),
    });
    expect(outcomes).toMatchObject([{ state: "pass" }]);
  });

  it("warns when a variable differs from its saved value, naming the page that changes it", async () => {
    const outcomes = await run("settings.seeded", {
      env: { LINEAR_PICKUP_LABEL: "AI-Implement", KG_EXECUTION_MODE: "fly-machines" },
      readSetting: rows({ linear_pickup_label: "AI Implement - New", kg_execution_mode: "github-actions" }),
    });
    expect(outcomes).toMatchObject([{
      state: "warn",
      detail: "KG_EXECUTION_MODE differs from the value saved on /admin#kg-pipelines, so it has no effect. LINEAR_PICKUP_LABEL differs from the value saved on /admin#settings, so it has no effect.",
      fix: "Change each setting on its admin page, then remove the variable from the environment.",
    }]);
  });

  it("warns when a variable has no saved value, so the next boot seeds it again", async () => {
    expect(await run("settings.seeded", { env: { KG_BASE_REPO: "Org/repo" } })).toMatchObject([
      { state: "warn", detail: "KG_BASE_REPO has no saved value, so the next boot saves it again." },
    ]);
  });

  it("warns when a variable is one the seed refuses", async () => {
    expect(await run("settings.seeded", { env: { RUNNER_IMAGE_ALLOWED_PREFIXES: "ghcr.io" } })).toMatchObject([
      { state: "warn", detail: expect.stringMatching(/^RUNNER_IMAGE_ALLOWED_PREFIXES is invalid \(.+\), so it has no effect\.$/) },
    ]);
  });

  describe("against the rows boot itself seeds", () => {
    let seeds: typeof SeedOnceSettingsModule;
    let checks: typeof SetupChecksModule;

    beforeEach(async () => {
      ({ seeds, checks } = (await testDb({
        modules: { seeds: () => import("../../seed-once-settings.js"), checks: () => import("../../setup-checks/index.js") },
      })).modules);
    });

    it("passes for every variable right after boot seeds it", async () => {
      const env = {
        KG_BASE_REPO: " Org/repo ",
        KG_MATERIALIZE_DIRECT: "true",
        KG_EXECUTION_MODE: " fly-machines ",
        LINEAR_PICKUP_LABEL: " Pick me ",
        RUNNER_IMAGE_ALLOWED_PREFIXES: " ghcr.io/acme/ , ghcr.io/b/ ",
      };
      seeds.seedSettingsFromEnv(env);
      const ctx = checks.createSetupCheckContext({ env, restateStatus: () => ({ sidecar: { state: "ready" }, registration: { state: "registered" } }) });
      const check = checks.SETUP_CHECKS.find((c) => c.id === "settings.seeded")!;
      expect(await check.run(ctx)).toMatchObject([{ state: "pass" }]);
    });
  });
});

describe("settings.env-override", () => {
  it.each([
    ["no variable", {}, { runner_mode: "gha", fly_process_level_secrets: "false" }],
    ["a variable that matches its row", { RUNNER_MODE: "fly", FLY_PROCESS_LEVEL_SECRETS: "yes" }, { runner_mode: "fly", fly_process_level_secrets: "true" }],
    ["a variable with no row to override", { RUNNER_MODE: "fly", FLY_PROCESS_LEVEL_SECRETS: "false" }, {}],
    ["a variable that is not a recognized value", { RUNNER_MODE: "Fly", FLY_PROCESS_LEVEL_SECRETS: "off" }, { runner_mode: "gha", fly_process_level_secrets: "true" }],
  ])("passes with %s", async (_name, env, saved) => {
    expect(await run("settings.env-override", { env, readSetting: rows(saved) })).toMatchObject([{ state: "pass" }]);
  });

  it("warns for each variable that overrides a different saved setting", async () => {
    const outcomes = await run("settings.env-override", {
      env: { RUNNER_MODE: "fly", FLY_PROCESS_LEVEL_SECRETS: "0" },
      readSetting: rows({ runner_mode: "default", fly_process_level_secrets: "true" }),
    });
    expect(outcomes).toMatchObject([{
      state: "warn",
      detail: "RUNNER_MODE=fly overrides the runner mode saved on /admin#runners (default). FLY_PROCESS_LEVEL_SECRETS overrides the setting saved on /admin#runners (on).",
      fix: "Unset the variable and restart, so the saved setting applies.",
    }]);
  });
});

describe("settings.allowlist-env", () => {
  it("passes when the variables admit nobody", async () => {
    expect(await run("settings.allowlist-env", { env: { OAUTH_ALLOWED_DOMAINS: " , " } })).toMatchObject([{ state: "pass" }]);
  });

  it("passes while no list is saved, since the variables are in force", async () => {
    expect(await run("settings.allowlist-env", { env: { OAUTH_ALLOWED_EMAILS: "admin@example.com" } })).toMatchObject([
      { state: "pass", detail: expect.stringContaining("in force") },
    ]);
  });

  it("warns when a saved list makes the variables inert", async () => {
    expect(await run("settings.allowlist-env", {
      env: { OAUTH_ALLOWED_DOMAINS: "example.com" },
      storedAccessEntries: () => [makeAccessEntry()],
    })).toMatchObject([{ state: "warn", fix: "Remove OAUTH_ALLOWED_DOMAINS and OAUTH_ALLOWED_EMAILS from the environment." }]);
  });
});

describe("volume.database", () => {
  it("fails when the database fell back to /tmp", async () => {
    const outcomes = await run("volume.database", {
      databasePath: () => ({ path: "/tmp/ai-implement.sqlite", configured: "/data/dedup.sqlite", fellBack: true }),
    });
    expect(outcomes).toMatchObject([{ state: "fail", detail: "The directory of /data/dedup.sqlite could not be created, so the database fell back to /tmp/ai-implement.sqlite" }]);
  });

  it("passes off Fly without looking for a volume", async () => {
    const onSeparateFilesystem = vi.fn(() => false);
    expect(await run("volume.database", { onSeparateFilesystem })).toMatchObject([{ state: "pass", detail: "The database is /data/dedup.sqlite" }]);
    expect(onSeparateFilesystem).not.toHaveBeenCalled();
  });

  it("on Fly, passes when the database directory is a mounted volume", async () => {
    const onSeparateFilesystem = vi.fn(() => true);
    expect(await run("volume.database", { env: { FLY_APP_NAME: "orchestrator" }, onSeparateFilesystem })).toMatchObject([
      { state: "pass", detail: "The database is /data/dedup.sqlite, on a mounted volume" },
    ]);
    expect(onSeparateFilesystem).toHaveBeenCalledWith("/data");
  });

  it("on Fly, fails when the database directory is on the root filesystem", async () => {
    expect(await run("volume.database", { env: { FLY_APP_NAME: "orchestrator" }, onSeparateFilesystem: () => false })).toMatchObject([
      { state: "fail", fix: expect.stringContaining("fly.toml") },
    ]);
  });
});

describe("restate", () => {
  it("passes when the sidecar is ready and the endpoint registered", async () => {
    expect(await run("restate")).toMatchObject([{ state: "pass", detail: "The sidecar is ready and the endpoint registration is registered" }]);
  });

  it.each([
    ["starting", "not-attempted"],
    ["exited", "not-attempted"],
    ["missing-binary", "not-attempted"],
    ["ready", "declined-conflict"],
    ["ready", "unreachable"],
  ])("fails with the sidecar %s and the registration %s, naming both", async (sidecar, registration) => {
    expect(await run("restate", { restateStatus: () => ({ sidecar: { state: sidecar }, registration: { state: registration } }) })).toMatchObject([{
      state: "fail",
      detail: `The sidecar is ${sidecar} and the endpoint registration is ${registration}`,
      fix: "Read the [restate] lines in the orchestrator log, which name the cause.",
    }]);
  });
});

describe("callback.config", () => {
  it("passes with an explicit address and the token secret", async () => {
    expect(await run("callback.config", { env: { RUNNER_CALLBACK_BASE_URL: "https://o.example.com", RUNNER_TOKEN_SECRET: "s" } })).toMatchObject([
      { state: "pass", detail: "Runs report to https://o.example.com" },
    ]);
  });

  it("passes with the address derived for RUNNER_MODE=local, and says so", async () => {
    expect(await run("callback.config", { env: { RUNNER_MODE: "local", PORT: "9090", RUNNER_TOKEN_SECRET: "s" } })).toMatchObject([
      { state: "pass", detail: "Runs report to http://host.docker.internal:9090, derived for RUNNER_MODE=local" },
    ]);
  });

  it.each([
    [{ RUNNER_CALLBACK_BASE_URL: "https://o.example.com" }, "RUNNER_TOKEN_SECRET not set"],
    [{ RUNNER_TOKEN_SECRET: "s" }, "RUNNER_CALLBACK_BASE_URL not set"],
    [{}, "RUNNER_CALLBACK_BASE_URL and RUNNER_TOKEN_SECRET not set"],
  ])("fails naming what is unset (%j)", async (env, missing) => {
    expect(await run("callback.config", { env })).toMatchObject([
      { state: "fail", detail: `${missing}, so runs cannot report back and planning is refused` },
    ]);
  });
});

describe("runner.fly-sessions", () => {
  const configured = () => ({ token: "fly-token", app: "ai-sessions", region: null, source: { app: "restate" as const, region: null } });
  const unconfigured = () => ({ token: null, app: null, region: null, source: { app: null, region: null } });
  const onGha = () => ({ ENG: makeMapping({ executionMode: "github-actions" }) });
  const onFly = () => ({ ENG: makeMapping({ executionMode: "fly-machines" }), OPS: makeMapping({ executionMode: "github-actions" }) });

  it.each([
    ["no projects", "default", () => ({})],
    ["only GitHub Actions projects", "default", onGha],
    ["a Fly project under runner mode gha", "gha", onFly],
    ["a Fly project under runner mode local", "local", onFly],
  ] as const)("does not apply with %s", async (_name, mode, mappings) => {
    expect(await run("runner.fly-sessions", { mappings, runnerMode: () => ({ mode, source: "db" }), flySessions: unconfigured })).toMatchObject([
      { state: "not-applicable" },
    ]);
  });

  it("passes when the token and the sessions app are set, listing the projects on Fly", async () => {
    expect(await run("runner.fly-sessions", { mappings: onFly, flySessions: configured })).toMatchObject([
      { state: "pass", detail: "Projects on Fly Machines: ENG. The token and the sessions app are set." },
    ]);
  });

  it.each([
    ["fly", "ENG, OPS"],
    ["shadow", "ENG, OPS"],
    ["default", "ENG"],
  ] as const)("under runner mode %s, fails naming what is unset and the projects it strands (%s)", async (mode, projects) => {
    expect(await run("runner.fly-sessions", { mappings: onFly, runnerMode: () => ({ mode, source: "db" }), flySessions: unconfigured })).toMatchObject([{
      state: "fail",
      detail: `FLY_SESSIONS_TOKEN and the sessions app not set, so these projects cannot dispatch on Fly Machines: ${projects}`,
    }]);
  });

  it("names only what is unset", async () => {
    const tokenOnly = () => ({ token: "fly-token", app: null, region: null, source: { app: null, region: null } });
    expect(await run("runner.fly-sessions", { mappings: onFly, flySessions: tokenOnly })).toMatchObject([
      { state: "fail", detail: expect.stringMatching(/^the sessions app not set/) },
    ]);
  });
});

describe("admin.path", () => {
  it.each([
    ["nothing", {}],
    ["only the refused placeholder code", { ADMIN_ACCESS_CODE: "your-secret-access-code" }],
    ["only a provider boot drops", { MICROSOFT_OAUTH_CLIENT_ID: "m", MICROSOFT_OAUTH_CLIENT_SECRET: "s", MICROSOFT_OAUTH_TENANT: "common" }],
  ])("fails with %s configured", async (_name, env) => {
    expect(await run("admin.path", { env })).toMatchObject([
      { state: "fail", fix: "Configure a sign-in provider (preferred), or set ADMIN_ACCESS_CODE." },
    ]);
  });

  it.each([
    [{ ADMIN_ACCESS_CODE: "a-real-code" }, "Admins sign in with the access code"],
    [GOOGLE, "Admins sign in with SSO (google)"],
    [{ ...GOOGLE, ADMIN_ACCESS_CODE: "a-real-code" }, "Admins sign in with SSO (google) and the access code"],
  ])("passes, naming each admin path (%j)", async (env, detail) => {
    expect(await run("admin.path", { env })).toMatchObject([{ state: "pass", detail }]);
  });
});

describe("admin.providers", () => {
  it("passes when every provider is complete or absent", async () => {
    expect(await run("admin.providers", { env: GOOGLE })).toMatchObject([{ state: "pass" }]);
  });

  it("warns for each provider boot drops, with its reason", async () => {
    expect(await run("admin.providers", { env: { GOOGLE_OAUTH_CLIENT_ID: "g", BUILDDOWN_OIDC_ISSUER: "http://cp.example.com", BUILDDOWN_OIDC_CLIENT_ID: "b", BUILDDOWN_OIDC_CLIENT_SECRET: "s" } })).toMatchObject([{
      state: "warn",
      detail: "builddown is disabled: BUILDDOWN_OIDC_ISSUER does not start with https://. google is disabled: GOOGLE_OAUTH_CLIENT_SECRET not set.",
    }]);
  });
});

describe("admin.redirect-url", () => {
  it("does not apply without a sign-in provider", async () => {
    expect(await run("admin.redirect-url", { env: { OAUTH_REDIRECT_BASE_URL: "https://o.example.com" } })).toMatchObject([{ state: "not-applicable" }]);
  });

  it("passes with a provider and the return address", async () => {
    expect(await run("admin.redirect-url", { env: { ...GOOGLE, OAUTH_REDIRECT_BASE_URL: "https://o.example.com" } })).toMatchObject([
      { state: "pass", detail: "Sign-in returns to https://o.example.com" },
    ]);
  });

  it("fails with a provider and no return address", async () => {
    expect(await run("admin.redirect-url", { env: GOOGLE })).toMatchObject([
      { state: "fail", fix: "Set OAUTH_REDIRECT_BASE_URL to the orchestrator's public address." },
    ]);
  });
});

describe("admin.allowlist", () => {
  // A domain read from OAUTH_ALLOWED_DOMAINS, as allowlistFromEnv builds it: no save time, no saver.
  const domainOnly = () => ({ entries: [makeAccessEntry({ kind: "domain", value: "example.com", role: "user", addedAt: 0, addedBy: null })], source: "env" as const });

  it("does not apply without a sign-in provider", async () => {
    expect(await run("admin.allowlist", { effectiveAllowlist: domainOnly })).toMatchObject([{ state: "not-applicable" }]);
  });

  it("passes with BuildDown configured, naming the claim path, whatever the list holds", async () => {
    const env = { BUILDDOWN_OIDC_ISSUER: "https://cp.example.com", BUILDDOWN_OIDC_CLIENT_ID: "b", BUILDDOWN_OIDC_CLIENT_SECRET: "s" };
    expect(await run("admin.allowlist", { env, effectiveAllowlist: domainOnly })).toMatchObject([
      { state: "pass", detail: expect.stringContaining("role claim, which /admin#access neither lists nor overrides") },
    ]);
  });

  it("cannot verify an allowlist that has never loaded", async () => {
    expect(await run("admin.allowlist", { env: GOOGLE, effectiveAllowlist: () => null })).toMatchObject([
      { state: "cannot-verify", fix: "Read the [access] lines in the orchestrator log." },
    ]);
  });

  it("passes when the list names an admin address", async () => {
    expect(await run("admin.allowlist", { env: GOOGLE, effectiveAllowlist: () => ({ entries: [makeAccessEntry()], source: "db" }) })).toMatchObject([
      { state: "pass", detail: "The sign-in allowlist names an admin address" },
    ]);
  });

  it("passes when the access code still reaches admin", async () => {
    expect(await run("admin.allowlist", { env: { ...GOOGLE, ADMIN_ACCESS_CODE: "a-real-code" }, effectiveAllowlist: domainOnly })).toMatchObject([
      { state: "pass" },
    ]);
  });

  it.each([
    ["is empty", () => ({ entries: [], source: "env" as const }), "The sign-in allowlist is empty, so sign-in admits nobody"],
    ["admits a domain only", domainOnly, "The sign-in allowlist names no admin address, so nobody can administer this orchestrator"],
  ])("fails when SSO is the only admin path and the list %s", async (_name, effectiveAllowlist, detail) => {
    expect(await run("admin.allowlist", { env: { ...GOOGLE, ADMIN_ACCESS_CODE: "your-secret-access-code" }, effectiveAllowlist })).toMatchObject([
      { state: "fail", detail, fix: "Add an admin address to OAUTH_ALLOWED_EMAILS. A domain admits its addresses as user only." },
    ]);
  });
});
