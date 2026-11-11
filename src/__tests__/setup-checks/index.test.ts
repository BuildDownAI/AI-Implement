import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type * as DedupModule from "../../dedup.js";
import type * as SetupChecksModule from "../../setup-checks/index.js";
import type { FilesystemSetupFacts, JiraSetupFacts } from "../../providers/types.js";
import type { SetupCheck, SetupCheckContext, SetupCheckResult } from "../../setup-checks/index.js";
import { makeAccessEntry, makeMapping, makeProvider } from "../helpers/builders.js";
import { makeLinearSetupFacts, makeSentinelSetupCheckContext, makeSetupCheckContext } from "../helpers/fixtures/setup-checks.js";
import { testDb } from "../helpers/test-db.js";
import { fakeFetch } from "../helpers/fake-fetch.js";
import { githubError } from "../helpers/replies/github.js";

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

const FAULTY_LINEAR = makeLinearSetupFacts({ teams: { ENG: ["started"] }, found: [{ name: "ai-implement", teamKey: "ENG" }, { name: "ai-working", teamKey: "ENG" }] });
const REFUSED_LINEAR = { kind: "linear", token: "refused", status: 401, error: "Linear token mint failed (401): invalid_client" } as const;
// One Jira project whose status field is missing, one whose reads each fail or warn, and a Filesystem
// directory the orchestrator cannot write: between them, every Jira and Filesystem fault branch.
const FAULTY_JIRA: JiraSetupFacts = {
  kind: "jira",
  credentials: "accepted",
  oauth: true,
  projects: {
    OPS: { fields: "unresolved", field: "AI-Implement Status", fault: "missing" },
    WEB: {
      fields: "resolved",
      ids: { statusFieldId: "customfield_1", repoFieldId: "customfield_2", profilesFieldId: null, baseBranchFieldId: null },
      cachedIds: { statusFieldId: "customfield_9", repoFieldId: "customfield_2", profilesFieldId: null, baseBranchFieldId: null },
      ambiguousOptional: ["AI-Implement Profiles"],
      statusOptions: { read: "options", values: ["Ready"] },
      repoOptions: { read: "failed", failure: { status: 403, error: "forbidden" } },
      jql: { accepted: false, failure: { status: 400, error: "Error in the JQL Query" } },
    },
  },
};
// A Jira config as the store reads one back with no field overrides.
const NO_FIELD_OVERRIDES = { statusFieldOverride: null, repoFieldOverride: null, profilesFieldOverride: null, baseBranchFieldOverride: null };
const FAULTY_FILESYSTEM: FilesystemSetupFacts = { kind: "filesystem", directories: { LOCAL: { directory: "/tickets", fault: "not-writable" } } };

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
  "Linear set up with faults": makeSetupCheckContext({
    mappings: () => ({ ENG: makeMapping(), OPS: makeMapping({ ticketingProvider: "jira" }) }),
    trackerProvider: async (id) => makeProvider(id === "linear" ? { fetchSetupFacts: async () => FAULTY_LINEAR } : { id }),
    trackerSetupFacts: async (id) => (id === "linear" ? FAULTY_LINEAR : null),
  }),
  "Jira and Filesystem set up with faults": makeSetupCheckContext({
    mappings: () => ({
      OPS: makeMapping({ ticketingProvider: "jira", ticketingConfig: { kind: "jira", jql: "project = OPS", repoFieldValue: "acme/ops", ...NO_FIELD_OVERRIDES } }),
      WEB: makeMapping({ ticketingProvider: "jira", ticketingConfig: { kind: "jira", jql: "project = WEB", repoFieldValue: "acme/web", ...NO_FIELD_OVERRIDES } }),
      LOCAL: makeMapping({ ticketingProvider: "filesystem", ticketingConfig: { kind: "filesystem", directory: "/tickets" } }),
    }),
    trackerProvider: async (id) => makeProvider({ id, fetchSetupFacts: async () => (id === "jira" ? FAULTY_JIRA : FAULTY_FILESYSTEM) }),
    trackerSetupFacts: async (id) => (id === "jira" ? FAULTY_JIRA : id === "filesystem" ? FAULTY_FILESYSTEM : null),
  }),
  "Linear refusing the app": makeSetupCheckContext({
    mappings: () => ({ ENG: makeMapping() }),
    trackerProvider: async () => makeProvider({ fetchSetupFacts: async () => REFUSED_LINEAR }),
    trackerSetupFacts: async () => REFUSED_LINEAR,
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
    const MARKED_LINEAR = makeLinearSetupFacts({ pickupLabel: "marked-pickup", teams: { MARKED: [] }, found: [{ name: "Marked-Pickup", teamKey: "MARKED" }] });
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
      trackerProvider: async () => makeProvider({ fetchSetupFacts: async () => MARKED_LINEAR }),
      trackerSetupFacts: async () => MARKED_LINEAR,
    });
    for (const result of await resultsFor(ctx)) {
      expect([result.id, result.title, result.state].join(" ").toLowerCase(), result.id).not.toContain("marked");
    }
  });

  it("never shows a secret's value in any field", async () => {
    const results = await resultsFor(makeSentinelSetupCheckContext());
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

describe("the recorded run", () => {
  it("keeps its own copy, so neither the run it was given nor one read back can change it", () => {
    const row: SetupCheckResult = { id: "restate", title: "Restate engine", group: "orchestrator", tier: "core", onAdminPath: true, state: "pass" };
    const run = { checkedAt: 1, results: [row] };
    checks.recordSetupCheckRun(run);

    run.checkedAt = 2;
    row.state = "fail";
    const readBack = checks.getLastSetupCheckRun();
    if (readBack) readBack.results[0].state = "warn";

    expect(checks.getLastSetupCheckRun()).toEqual({ checkedAt: 1, results: [{ ...row, state: "pass" }] });
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

  it("reads the health endpoint at the address given, and this process's own identifier, the one its health body carries", async () => {
    const fake = fakeFetch({ "GET /": { json: { restate: restateStatus(), instanceId: "an-instance" } } }).install();
    const ctx = checks.createSetupCheckContext({ restateStatus });
    // Imported after testDb's module reset, so it is the copy the context's module loaded.
    const { ORCHESTRATOR_INSTANCE_ID } = await import("../../health-body.js");

    expect(await ctx.orchestratorHealthAt("https://o.example.com")).toMatchObject({ outcome: "health-body", instanceId: "an-instance" });
    expect(fake.calls.map((c) => `${c.method} ${c.url.href}`)).toEqual(["GET https://o.example.com/"]);
    expect(ctx.orchestratorInstanceId()).toBe(ORCHESTRATOR_INSTANCE_ID);
  });

  it("reads the projects once per context, so a save during a run cannot split what the run judges", async () => {
    const { upsertMapping } = await import("../../config.js");
    upsertMapping("ENG", makeMapping({ owner: "acme", repo: "app" }));
    const ctx = checks.createSetupCheckContext({ restateStatus });
    const first = ctx.mappings();

    upsertMapping("OPS", makeMapping({ owner: "acme", repo: "ops" }));

    expect(ctx.mappings()).toEqual(first);
    expect(Object.keys(ctx.mappings())).toEqual(["ENG"]);
    expect(Object.keys(checks.createSetupCheckContext({ restateStatus }).mappings()).sort()).toEqual(["ENG", "OPS"]);
  });

  it("keeps the caller's overrides and the default readers for the rest", () => {
    const env = { RUNNER_MODE: "fly" };
    const ctx = checks.createSetupCheckContext({ env, restateStatus });
    expect(ctx.env).toBe(env);
    expect(ctx.restateStatus).toBe(restateStatus);
    expect(ctx.databasePath()).toEqual(dedup.getDatabasePath());
  });

  it("reads one provider's setup facts once per context, for the teams that provider serves", async () => {
    const fetchSetupFacts = vi.fn(async () => makeLinearSetupFacts());
    const ctx = checks.createSetupCheckContext({
      restateStatus,
      mappings: () => ({ ENG: makeMapping(), OPS: makeMapping(), SUP: makeMapping({ ticketingProvider: "jira" }) }),
      trackerProvider: async () => makeProvider({ fetchSetupFacts }),
    });

    const [first, second] = await Promise.all([ctx.trackerSetupFacts("linear"), ctx.trackerSetupFacts("linear")]);
    const later = await ctx.trackerSetupFacts("linear");

    expect(fetchSetupFacts).toHaveBeenCalledTimes(1);
    expect(fetchSetupFacts).toHaveBeenCalledWith(["ENG", "OPS"]);
    expect([second, later]).toEqual([first, first]);
  });

  it("reads no facts from a provider without setup facts", async () => {
    const ctx = checks.createSetupCheckContext({
      restateStatus,
      mappings: () => ({ SUP: makeMapping({ ticketingProvider: "jira" }) }),
      trackerProvider: async () => makeProvider({ id: "jira" }),
    });
    expect(await ctx.trackerSetupFacts("jira")).toBeNull();
  });

  it("builds a project's provider as the poll does, and refuses a tracker no project uses", async () => {
    // The module instance the context's registry reached, since testDb reset the registry before importing it.
    const linearAuth = await import("../../linear-app-auth.js");
    const mappings = () => ({ ENG: makeMapping() });

    const unconfigured = checks.createSetupCheckContext({ restateStatus, mappings });
    await expect(unconfigured.trackerProvider("jira")).rejects.toThrow("No project uses the jira tracker");
    await expect(unconfigured.trackerProvider("linear")).rejects.toThrow(/linearClientId/);

    linearAuth.configureLinearAuth("client-id", "client-secret");
    const configured = checks.createSetupCheckContext({ restateStatus, mappings });
    expect((await configured.trackerProvider("linear")).id).toBe("linear");
  });

  describe("githubSetupFacts", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const env = { GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: privateKey };
    const installed = (id: number, selection: "all" | "selected" = "all") =>
      ({ json: { id, repository_selection: selection, permissions: { contents: "write", pull_requests: "write", metadata: "read" } } });

    it("is one set per context, and shares each read, a concurrent one included", async () => {
      const api = fakeFetch({ "GET /app": { json: { slug: "app" } } }).install();
      const ctx = checks.createSetupCheckContext({ env, restateStatus });

      expect(ctx.githubSetupFacts()).toBe(ctx.githubSetupFacts());
      const [first, second] = await Promise.all([ctx.githubSetupFacts().app(), ctx.githubSetupFacts().app()]);
      await ctx.githubSetupFacts().app();
      expect(first).toBe(second);
      expect(api.calls).toHaveLength(1);
    });

    it("shares a failed read for the rest of the run instead of retrying it", async () => {
      const api = fakeFetch({ "GET /orgs/o/installation": [githubError(500, "Server Error"), installed(1)] }).install();
      const facts = checks.createSetupCheckContext({ env, restateStatus }).githubSetupFacts();

      await expect(facts.installation("o")).rejects.toMatchObject({ status: 500 });
      await expect(facts.installation("O")).rejects.toMatchObject({ status: 500 });
      expect(api.calls).toHaveLength(1);
    });

    it("refuses every App read without both App credentials, and reads nothing", async () => {
      const api = fakeFetch({}).install();
      const facts = checks.createSetupCheckContext({ env: { GITHUB_APP_ID: "123456" }, restateStatus }).githubSetupFacts();

      await expect(facts.app()).rejects.toThrow("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are not both set");
      await expect(facts.deliveries()).rejects.toThrow("not both set");
      expect(api.calls).toHaveLength(0);
    });

    it("reads an all-repositories installation's list as null, and refuses an owner without the App", async () => {
      const api = fakeFetch({
        "GET /orgs/o/installation": installed(1),
        "GET /orgs/nobody/installation": githubError(404, "Not Found"),
        "GET /users/nobody/installation": githubError(404, "Not Found"),
      }).install();
      const facts = checks.createSetupCheckContext({ env, restateStatus }).githubSetupFacts();

      await expect(facts.installationRepositories("o")).resolves.toBeNull();
      await expect(facts.installationRepositories("nobody")).rejects.toThrow("The GitHub App is not installed on nobody");
      expect(api.calls.some((c) => c.path.includes("/installation/repositories"))).toBe(false);
    });

    it("lists a selected installation's repositories with a read-only owner token", async () => {
      const api = fakeFetch({
        "GET /orgs/o/installation": installed(1, "selected"),
        "POST /app/installations/1/access_tokens": { status: 201, json: { token: "ghs_read", expires_at: new Date(Date.now() + 3600_000).toISOString() } },
        "GET /installation/repositories": { json: { total_count: 1, repositories: [{ name: "App" }] } },
      }).install();
      const facts = checks.createSetupCheckContext({ env, restateStatus }).githubSetupFacts();

      expect(await facts.installationRepositories("o")).toEqual(new Set(["app"]));
      const mint = api.calls.find((c) => c.method === "POST");
      expect(JSON.parse(mint!.body)).toEqual({ permissions: { contents: "read", pull_requests: "read", metadata: "read" } });
      expect(api.calls.find((c) => c.path === "/installation/repositories")?.headers.get("authorization")).toBe("Bearer ghs_read");
    });

    it("reads each owner's repositories in one query, built from the projects' requests, shared by every later read", async () => {
      const api = fakeFetch({
        "POST /app/installations/1/access_tokens": { status: 201, json: { token: "ghs_read", expires_at: new Date(Date.now() + 3600_000).toISOString() } },
        "GET /orgs/o/installation": installed(1),
        "POST /graphql": { json: { data: { r0: { defaultBranchRef: { name: "main" }, e0: null, e1: null, p0: { nodes: [] } } } } },
      }).install();
      const mappings = () => ({ ENG: makeMapping({ owner: "o", repo: "app", planningEnabled: false }) });
      const facts = checks.createSetupCheckContext({ env, restateStatus, mappings }).githubSetupFacts();

      // A run's checks read one owner concurrently and again later, and must all judge the same answer.
      const [read, concurrent] = await Promise.all([facts.repositories("o"), facts.repositories("O")]);
      const later = await facts.repositories("o");
      expect([...read.keys()]).toEqual(["app"]);
      expect(concurrent).toBe(read);
      expect(later).toBe(read);
      const query = api.calls.filter((c) => c.path === "/graphql");
      expect(query).toHaveLength(1);
      expect(JSON.parse(query[0].body).variables.r0).toBe("app");
    });

    it("has no preflight without KG_SOURCE_REPO, and reads a project's sync row", async () => {
      const api = fakeFetch({}).install();
      const facts = checks.createSetupCheckContext({ env, restateStatus }).githubSetupFacts();
      const queue = await import("../../workflow-sync-queue.js");

      expect(await facts.kgPreflight()).toBeNull();
      expect(facts.workflowSync("ENG")).toBeNull();
      queue.enqueueWorkflowSync("ENG");
      expect(facts.workflowSync("ENG")).toMatchObject({ teamKey: "ENG", status: "pending" });
      expect(api.calls).toHaveLength(0);
    });
  });

  it("requires the caller to supply the Restate status reader", () => {
    // @ts-expect-error The reader depends on where the caller runs, so it has no default.
    const ctx = checks.createSetupCheckContext({});
    expect(ctx.restateStatus).toBeUndefined();
  });
});

describe("the summary every allowlisted identity sees", () => {
  const row = (overrides: Partial<SetupCheckResult>): SetupCheckResult => ({
    id: "restate", title: "Restate engine", group: "orchestrator", tier: "core", onAdminPath: true, state: "pass", ...overrides,
  });

  it("counts only the core rows in state fail", () => {
    const run = {
      checkedAt: 1,
      results: [
        row({ state: "fail" }),
        row({ id: "tracker.linear.team-access", project: "ENG", state: "fail" }),
        row({ id: "runner.fly-sessions", tier: "mode", state: "fail" }),
        row({ id: "admin.redirect-url", state: "warn" }),
        row({ id: "env.github-app", state: "cannot-verify" }),
      ],
    };
    expect(checks.countFailingCore(run)).toBe(2);
  });

  it("is null before the first run", () => {
    expect(checks.summarizeSetupChecks(null)).toBeNull();
  });

  it("keeps each row's id, title, state and project, and drops every other field", () => {
    const run = {
      checkedAt: 99,
      results: [
        row({ state: "fail", detail: "The sidecar is exited", fix: "Read the [restate] lines", fixUrl: "/admin#settings" }),
        row({ id: "tracker.linear.team-access", title: "Linear team access", group: "tracker", onAdminPath: false, project: "ENG", detail: "The app can see team ENG" }),
      ],
    };
    expect(checks.summarizeSetupChecks(run)).toStrictEqual({
      checkedAt: 99,
      failingCore: 1,
      rows: [
        { id: "restate", title: "Restate engine", state: "fail" },
        { id: "tracker.linear.team-access", title: "Linear team access", state: "pass", project: "ENG" },
      ],
    });
  });
});
