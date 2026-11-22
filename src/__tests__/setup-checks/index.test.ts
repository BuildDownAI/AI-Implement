import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DedupModule from "../../dedup.js";
import type * as SetupChecksModule from "../../setup-checks/index.js";
import type { FilesystemSetupFacts, JiraSetupFacts } from "../../providers/types.js";
import type { SetupCheck, SetupCheckContext, SetupCheckId, SetupCheckResult, SetupCheckRun, SetupCheckScope } from "../../setup-checks/index.js";
import { waitOn } from "../../setup-checks/contract.js";
import { makeAccessEntry, makeAppPrivateKey, makeMapping, makeProvider } from "../helpers/builders.js";
import { makeGitHubSetupFacts, makeLinearSetupFacts, makeSentinelSetupCheckContext, makeSetupCheckContext } from "../helpers/fixtures/setup-checks.js";
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
    perProject: false,
    verifiable: true,
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
    // Every check answers but those that depend on a Jira or Filesystem project, which the context's one Linear project leaves out.
    const answering = checks.SETUP_CHECK_IDS.filter((id) => (!id.startsWith("tracker.jira.") || id === "tracker.jira.credentials") && id !== "tracker.filesystem.directory");
    expect(new Set(results.map((r) => r.id))).toEqual(new Set(answering));
    expect(JSON.stringify(results)).not.toContain("sentinel-");
  });

  it("declares perProject on exactly the checks that answer a row for a project", async () => {
    // GitHub accepts the App but it is installed nowhere, so each GitHub per-project check reaches its projects. The webhook secret lets the webhook checks run.
    const githubAccepting = makeSetupCheckContext({
      env: { GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: makeAppPrivateKey(), GITHUB_WEBHOOK_SECRET: "secret" },
      mappings: () => ({ ENG: makeMapping() }),
      githubSetupFacts: () => makeGitHubSetupFacts({
        app: async () => ({ status: 200, slug: "ai-implement", events: [], errorBody: "", githubTime: null, localTime: 0 }),
        installation: async () => null,
        publicRepository: async () => ({ status: 404, refExists: null }),
      }),
    });
    const answeredForAProject = new Set<string>();
    for (const ctx of [githubAccepting, CONTEXTS["Linear set up with faults"], CONTEXTS["Jira and Filesystem set up with faults"]]) {
      for (const row of await resultsFor(ctx)) if (row.project !== undefined) answeredForAProject.add(row.id);
    }
    expect([...answeredForAProject].sort()).toEqual(checks.SETUP_CHECKS.filter((check) => check.perProject).map((check) => check.id).sort());
  });

  it("declares a check unverifiable only when it never passes, fails or warns", async () => {
    const reviewedOutside = makeSetupCheckContext({ mappings: () => ({ ENG: makeMapping({ reviewProcess: "claude-code-review" }) }) });
    const unverifiable = checks.SETUP_CHECKS.filter((check) => !check.verifiable).map((check) => check.id);
    expect(unverifiable.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const ctx of [...Object.values(CONTEXTS), reviewedOutside]) {
      for (const row of await resultsFor(ctx)) {
        if (!unverifiable.includes(row.id)) continue;
        seen.add(row.id);
        expect(["cannot-verify", "not-applicable"], `${row.id} answered ${row.state}`).toContain(row.state);
      }
    }
    expect([...seen].sort()).toEqual([...unverifiable].sort());
  });

  // A surface groups a project's rows by the check they wait on, so a fix that names a check without saying so would be shown alone.
  it("gives every row whose fix waits on another check that check as its waitsOn, and only those rows", async () => {
    let waiting = 0;
    for (const ctx of Object.values(CONTEXTS)) {
      for (const row of await resultsFor(ctx)) {
        const named = row.fix?.match(/^More information is needed\. Address the (.+) check first\.$/)?.[1];
        expect(row.waitsOn, `${row.id}: ${row.fix}`).toBe(named);
        if (named) waiting++;
      }
    }
    expect(waiting).toBeGreaterThan(0);
  });

  it("words a waiting row's fix from the check it waits on", () => {
    expect(waitOn("tracker.provider")).toEqual({ fix: "More information is needed. Address the tracker.provider check first.", waitsOn: "tracker.provider" });
  });
});

describe("runSetupChecks", () => {
  it("adds each check's identity to its outcomes and stamps the run with when it began and finished", async () => {
    const ticks = [1000, 1234];
    const check = fakeCheck({ id: "admin.path", title: "Admin sign-in", tier: "mode", onAdminPath: true, run: () => [{ state: "warn", detail: "d", fix: "f" }] });
    expect(await checks.runSetupChecks(makeSetupCheckContext(), [check], () => ticks.shift()!)).toEqual({
      startedAt: 1000,
      checkedAt: 1234,
      results: [{ id: "admin.path", title: "Admin sign-in", group: "orchestrator", tier: "mode", onAdminPath: true, state: "warn", detail: "d", fix: "f" }],
    });
  });

  it("marks every row of an unverifiable check as such, a thrown one included, so a reader can leave them out of a verdict", async () => {
    const answers = fakeCheck({ id: "env.github-app", verifiable: false, run: () => [{ state: "cannot-verify", project: "ENG" }] });
    const throws = fakeCheck({ id: "restate", verifiable: false, run: () => { throw new Error("reader broke"); } });
    const { results } = await checks.runSetupChecks(makeSetupCheckContext(), [answers, throws]);
    expect(results.map((r) => [r.id, r.verifiable])).toEqual([["env.github-app", false], ["restate", false]]);
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
    // Settled checks, not rows: with no project configured, the checks that depend on one answer nothing.
    const settled: string[] = [];
    await checks.runSetupChecks(makeSetupCheckContext(), undefined, Date.now, (id) => settled.push(id));
    expect(new Set(settled)).toEqual(new Set(checks.SETUP_CHECK_IDS));
  });

  it("tells onSettled each check's rows the moment that check finishes, while the run still answers in list order", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow = fakeCheck({ id: "env.github-app", run: async () => { await held; return [{ state: "pass" }]; } });
    const fast = fakeCheck({ id: "restate", run: () => [{ state: "warn" }] });
    const throws = fakeCheck({ id: "admin.path", run: () => { throw new Error("reader broke"); } });
    const heard: Array<[string, string[]]> = [];
    const run = checks.runSetupChecks(makeSetupCheckContext(), [slow, fast, throws], Date.now, (id, rows) => heard.push([id, rows.map((row) => row.state)]));

    await vi.waitFor(() => expect(heard).toHaveLength(2));
    // The two quick checks settle in either order; the held one cannot have been heard yet.
    expect(heard).toEqual(expect.arrayContaining([["restate", ["warn"]], ["admin.path", ["cannot-verify"]]]));
    release();
    const { results } = await run;
    expect(heard[2]).toEqual(["env.github-app", ["pass"]]);
    expect(results.map((row) => row.id)).toEqual(["env.github-app", "restate", "admin.path"]);
  });
});

describe("a run for one project", () => {
  const JIRA_CONFIG = { kind: "jira" as const, jql: "project = OPS", repoFieldValue: "acme/ops", ...NO_FIELD_OVERRIDES };
  const FILESYSTEM_CONFIG = { kind: "filesystem" as const, directory: "/tickets" };
  // Linear accepts the app and every per-project read is answerable; GitHub has no App credentials, so its per-project checks fold.
  const linearProject = (key = "ENG") => makeSetupCheckContext({
    mappings: () => ({ [key]: makeMapping() }),
    trackerProvider: async () => makeProvider({ fetchSetupFacts: async () => makeLinearSetupFacts({ teams: { [key]: ["started", "completed"] } }) }),
    trackerSetupFacts: async () => makeLinearSetupFacts({ teams: { [key]: ["started", "completed"] } }),
  });
  const idsOf = (run: { results: SetupCheckResult[] }) => new Set(run.results.map((row) => row.id));

  it("refuses a context holding other projects, or holding none but another", async () => {
    const both = makeSetupCheckContext({ mappings: () => ({ ENG: makeMapping(), OPS: makeMapping() }) });
    await expect(checks.runProjectSetupChecks(both, "ENG")).rejects.toThrow("A run for ENG needs a context holding that project alone");
    await expect(checks.runProjectSetupChecks(linearProject("OPS"), "ENG")).rejects.toThrow("A run for ENG needs a context holding that project alone");
  });

  it("runs every per-project check and the rows they depend on, and no other orchestrator-wide check", async () => {
    const ids = idsOf(await checks.runProjectSetupChecks(linearProject(), "ENG"));
    for (const id of ["tracker.provider", "tracker.linear.credentials", "github.app-identity", "github.clock", "tracker.linear.team-access", "github.installation", "github.target-secrets"]) {
      expect(ids).toContain(id);
    }
    for (const id of ["tracker.jira.credentials", "restate", "env.github-app", "admin.path", "github.webhook-signature", "github.kg-grants", "model.credentials-adopted"]) {
      expect(ids).not.toContain(id);
    }
  });

  it("runs the credentials check of the project's own ticketing system alone", async () => {
    const jira = await checks.runProjectSetupChecks(makeSetupCheckContext({ mappings: () => ({ OPS: makeMapping({ ticketingProvider: "jira", ticketingConfig: JIRA_CONFIG }) }) }), "OPS");
    expect(idsOf(jira)).toContain("tracker.jira.credentials");
    expect(idsOf(jira)).not.toContain("tracker.linear.credentials");
    const filesystem = await checks.runProjectSetupChecks(makeSetupCheckContext({ mappings: () => ({ LOCAL: makeMapping({ ticketingProvider: "filesystem", ticketingConfig: FILESYSTEM_CONFIG }) }) }), "LOCAL");
    expect(idsOf(filesystem)).not.toContain("tracker.linear.credentials");
    expect(idsOf(filesystem)).not.toContain("tracker.jira.credentials");
  });

  it("gives the project's key to the row of a per-project check that threw, and none to an orchestrator-wide row", async () => {
    // github.target-secrets reads the runner mode, so an unreadable one makes it throw, and the run answers its one row.
    const ctx = makeSetupCheckContext({ ...linearProject(), runnerMode: () => { throw new Error("runner mode unreadable"); } });
    const { results } = await checks.runProjectSetupChecks(ctx, "ENG");
    expect(results.filter((row) => row.id === "github.target-secrets")).toEqual([expect.objectContaining({ state: "cannot-verify", detail: "runner mode unreadable", project: "ENG" })]);
    expect(results.find((row) => row.id === "github.app-identity")?.project).toBeUndefined();
    expect(results.find((row) => row.id === "tracker.provider")?.project).toBeUndefined();
  });

  it("leaves out the checks it is told to", async () => {
    const ids = idsOf(await checks.runProjectSetupChecks(linearProject(), "ENG", ["github.workflow-default-branch", "github.workflow-mapping-branch"]));
    expect(ids).not.toContain("github.workflow-default-branch");
    expect(ids).not.toContain("github.workflow-mapping-branch");
    expect(ids).toContain("github.installation");
  });

  it("names its scope: every check it ran but tracker.provider, for its project alone", async () => {
    const run = await checks.runProjectSetupChecks(linearProject(), "ENG", ["github.workflow-default-branch"]);
    const ran = [...idsOf(run)].filter((id) => id !== "tracker.provider");
    expect(run.scope?.projects).toEqual(["ENG"]);
    expect(run.scope?.checks).not.toContain("tracker.provider");
    expect(run.scope?.checks).not.toContain("github.workflow-default-branch");
    // Every check it ran is in scope, including one that answered no row, so the merge can clear that check's stored row.
    expect(run.scope?.checks).toEqual(expect.arrayContaining(ran));
    expect(ran).not.toContain("tracker.filesystem.directory");
    expect(run.scope?.checks).toContain("tracker.filesystem.directory");
  });

  it("stamps the run with when it began and finished, as a full run is", async () => {
    const ticks = [100, 200];
    const run = await checks.runProjectSetupChecks(linearProject(), "ENG", [], () => ticks.shift()!);
    expect([run.startedAt, run.checkedAt]).toEqual([100, 200]);
  });
});

describe("a fault every project on a dependency shares", () => {
  const JIRA_CONFIG = { kind: "jira" as const, jql: "project = OPS", repoFieldValue: "acme/ops", ...NO_FIELD_OVERRIDES };
  const broken = makeSetupCheckContext({
    mappings: () => ({ ENG: makeMapping(), APP: makeMapping(), OPS: makeMapping({ ticketingProvider: "jira", ticketingConfig: JIRA_CONFIG }) }),
    trackerProvider: async (id) => { if (id === "linear") throw new Error("LINEAR_CLIENT_ID is not set"); return makeProvider(); },
  });

  // A project's marker counts only its own rows, so a full run gives each project on the broken provider its rows.
  it("is in the rows of each project that depends on it, in a full run, and in no other project's", async () => {
    const { results } = await checks.runSetupChecks(broken, checks.SETUP_CHECKS);
    const linearRows = results.filter((row) => row.id.startsWith("tracker.linear.") && row.id !== "tracker.linear.credentials");
    expect(new Set(linearRows.map((row) => row.project))).toEqual(new Set(["ENG", "APP"]));
    expect(linearRows.every((row) => row.state === "cannot-verify")).toBe(true);
    expect(results.find((row) => row.id === "tracker.provider" && row.state === "fail")?.project).toBeUndefined();
  });

  it("makes a project run answer with a full run, while a fault of the project's own does not", () => {
    const run = (results: SetupCheckResult[]) => ({ checkedAt: 1, results });
    const shared = (state: SetupCheckResult["state"]) => ({ id: "tracker.provider" as const, title: "", group: "tracker" as const, tier: "core" as const, onAdminPath: false, state, detail: "" });
    expect(checks.projectRunNeedsFullRun(run([shared("fail")]), null)).toBe(true);
    expect(checks.projectRunNeedsFullRun(run([shared("cannot-verify")]), null)).toBe(true);
    expect(checks.projectRunNeedsFullRun(run([shared("pass"), shared("warn"), shared("not-applicable")]), null)).toBe(false);
    expect(checks.projectRunNeedsFullRun(run([{ ...shared("fail"), id: "tracker.linear.team-access", project: "ENG" }]), null)).toBe(false);
  });

  // Once a full run has stored the fault on every project, another full run would only repeat its reads against the failing system.
  it("lets a project run merge as it is once the stored run already shows the shared fault, and escalates for one it does not", () => {
    const run = (results: SetupCheckResult[]) => ({ checkedAt: 1, results });
    const shared = (state: SetupCheckResult["state"]) => ({ id: "tracker.provider" as const, title: "", group: "tracker" as const, tier: "core" as const, onAdminPath: false, state, detail: "" });
    expect(checks.projectRunNeedsFullRun(run([shared("fail")]), run([shared("fail")]))).toBe(false);
    expect(checks.projectRunNeedsFullRun(run([shared("fail")]), run([shared("pass")]))).toBe(true);
    expect(checks.projectRunNeedsFullRun(run([shared("fail")]), run([shared("cannot-verify")]))).toBe(true);
    expect(checks.projectRunNeedsFullRun(run([shared("fail")]), run([{ ...shared("fail"), project: "ENG" }]))).toBe(true);
  });
});

describe("merging a partial run into the stored run", () => {
  const row = (overrides: Partial<SetupCheckResult>): SetupCheckResult => ({
    id: "tracker.linear.team-access", title: "Linear team access", group: "tracker", tier: "core", onAdminPath: false, state: "pass", ...overrides,
  });
  const MAPPED = ["ENG", "OPS"];
  // Built per test, so a merge that changed its input could not hide behind an earlier test's change.
  const storedRun = () => ({
    startedAt: 10,
    checkedAt: 20,
    results: [
      row({ id: "restate", group: "orchestrator", onAdminPath: true }),
      row({ id: "tracker.provider", detail: "The linear provider is ready for ENG, OPS" }),
      row({ id: "github.app-identity", group: "github" }),
      row({ project: "ENG", state: "fail" }),
      row({ id: "github.reference-repos", group: "github", project: "ENG", state: "warn" }),
      row({ id: "github.workflow-default-branch", group: "github", project: "ENG", state: "fail" }),
      row({ project: "OPS", state: "fail" }),
    ],
  });
  // A project run that read github.reference-repos, which answered nothing for ENG this time, and left out the workflow-file checks.
  const projectRun = (): SetupCheckRun => ({
    startedAt: 90,
    checkedAt: 99,
    results: [
      row({ id: "tracker.provider", detail: "The linear provider is ready for ENG" }),
      row({ id: "github.app-identity", group: "github", state: "fail" }),
      row({ project: "ENG" }),
    ],
    scope: { checks: ["github.app-identity", "tracker.linear.team-access", "github.reference-repos"], projects: ["ENG"] },
  });

  it("replaces the rows the run answers for, each dated by the run, and leaves every other row as it was", () => {
    const stored = storedRun();
    expect(checks.mergeSetupCheckRun(stored, projectRun(), MAPPED)).toEqual({
      startedAt: 10,
      checkedAt: 20,
      results: [
        stored.results[0],
        stored.results[1],
        stored.results[5],
        stored.results[6],
        row({ id: "github.app-identity", group: "github", state: "fail", checkedAt: 99 }),
        row({ project: "ENG", checkedAt: 99 }),
      ],
    });
  });

  it("leaves no row for a check in its scope that answered nothing, and keeps the project's rows of checks outside it", () => {
    const merged = checks.mergeSetupCheckRun(storedRun(), projectRun(), MAPPED);
    expect(merged.results.some((r) => r.id === "github.reference-repos")).toBe(false);
    expect(merged.results.filter((r) => r.id === "github.workflow-default-branch")).toEqual([storedRun().results[5]]);
  });

  // Its row names every project on the provider, and a project run's names only the one project.
  it("keeps the stored tracker.provider row, which a project run leaves out of its scope", () => {
    const merged = checks.mergeSetupCheckRun(storedRun(), projectRun(), MAPPED);
    expect(merged.results.filter((r) => r.id === "tracker.provider")).toEqual([storedRun().results[1]]);
  });

  // A per-project check that threw in a full run answers one row with no project, which belongs to every project.
  it("keeps a full run's row with no project of a per-project check when its scope names projects, and replaces it when it names none", () => {
    const thrown = row({ id: "github.installation", group: "github", state: "cannot-verify" });
    const stored = { ...storedRun(), results: [...storedRun().results, thrown] };
    const forEng = { ...projectRun(), scope: { checks: ["github.installation" as const], projects: ["ENG"] }, results: [row({ id: "github.installation", group: "github", project: "ENG" })] };
    expect(checks.mergeSetupCheckRun(stored, forEng, MAPPED).results).toContainEqual(thrown);
    const everywhere = { ...forEng, scope: { checks: ["github.installation" as const] } };
    expect(checks.mergeSetupCheckRun(stored, everywhere, MAPPED).results).not.toContainEqual(thrown);
  });

  it("drops the rows of a project no longer mapped, and keeps every row with no project", () => {
    const merged = checks.mergeSetupCheckRun(storedRun(), projectRun(), ["ENG"]);
    expect(merged.results.some((r) => r.project === "OPS")).toBe(false);
    expect(merged.results.filter((r) => r.project === undefined).map((r) => r.id)).toEqual(["restate", "tracker.provider", "github.app-identity"]);
  });

  it("replaces only the orchestrator-wide rows for an orchestrator-wide run", async () => {
    const run = await checks.runOrchestratorWideSetupChecks(makeSetupCheckContext(), () => 99);
    const merged = checks.mergeSetupCheckRun(storedRun(), run, MAPPED);
    expect(merged.results.filter((r) => r.project !== undefined)).toEqual(storedRun().results.filter((r) => r.project !== undefined));
    expect(merged.results.find((r) => r.id === "restate")?.checkedAt).toBe(99);
  });

  it("answers a full run whole, since it carries no scope", () => {
    const full = { checkedAt: 99, results: [row({ project: "ENG" })] };
    expect(checks.mergeSetupCheckRun(storedRun(), full, MAPPED)).toBe(full);
  });

  // With no stored provider row to keep, the run's own is the only one saying whether the provider can be built.
  it("starts the stored run from the whole partial run when none is stored, its tracker.provider row included", () => {
    expect(checks.mergeSetupCheckRun(null, projectRun(), MAPPED)).toStrictEqual({
      checkedAt: 99,
      results: projectRun().results.map((r) => ({ ...r, checkedAt: 99 })),
    });
  });

  it("changes neither run it is given", () => {
    const stored = storedRun();
    const run = projectRun();
    checks.mergeSetupCheckRun(stored, run, MAPPED);
    expect({ stored, run }).toEqual({ stored: storedRun(), run: projectRun() });
  });
});

describe("an orchestrator-wide run", () => {
  it("runs every check that is not per project, and names them as its scope", async () => {
    const run = await checks.runOrchestratorWideSetupChecks(makeSetupCheckContext({ mappings: () => ({ ENG: makeMapping() }) }));
    const wide = checks.SETUP_CHECKS.filter((check) => !check.perProject).map((check) => check.id);
    expect(run.scope).toEqual({ checks: wide });
    expect(run.results.every((row) => wide.includes(row.id))).toBe(true);
    expect(run.results.some((row) => row.project !== undefined && row.id !== "tracker.provider")).toBe(false);
  });

  // Its rows are the credentials checks' alone, which judge only whether the app is accepted.
  it("reads each ticketing system's setup facts for no project, once", async () => {
    const fetchSetupFacts = vi.fn(async () => makeLinearSetupFacts({ teams: {} }));
    const ctx = makeSetupCheckContext({
      mappings: () => ({ ENG: makeMapping(), APP: makeMapping() }),
      trackerProvider: async () => makeProvider({ fetchSetupFacts }),
      trackerSetupFacts: async () => { throw new Error("the shared read reads every project"); },
    });
    const run = await checks.runOrchestratorWideSetupChecks(ctx);
    expect(fetchSetupFacts.mock.calls).toEqual([[[]]]);
    expect(run.results.find((row) => row.id === "tracker.linear.credentials")?.state).toBe("pass");
  });
});

describe("the run before Restate serves", () => {
  it("runs the orchestrator's own checks, less the two that read what only Restate fills", async () => {
    const run = await checks.runSetupChecksBeforeRestate(makeSetupCheckContext());
    const own = checks.SETUP_CHECKS.filter((check) => check.group === "orchestrator").map((check) => check.id).filter((id) => id !== "restate" && id !== "runner.fly-sessions");
    expect(new Set(run.results.map((row) => row.id))).toEqual(new Set(own));
  });
});

describe("setup-check log lines", () => {
  const row = (overrides: Partial<SetupCheckResult>): SetupCheckResult => ({ id: "env.github-app", title: "", group: "orchestrator", tier: "core", onAdminPath: false, state: "fail", ...overrides });

  it("writes one line for each row that needs attention, and none for a row that passes or does not apply", () => {
    const lines = checks.setupCheckLogLines([
      row({ state: "fail", detail: "GITHUB_APP_ID is not set", fix: "Set GITHUB_APP_ID." }),
      row({ id: "callback.reachable", state: "cannot-verify" }),
      row({ id: "env.poll-interval", state: "warn" }),
      row({ id: "restate", state: "pass" }),
      row({ id: "admin.path", state: "not-applicable" }),
    ]);
    expect(lines.map((line) => line.split(" ")[1])).toEqual(["env.github-app", "callback.reachable", "env.poll-interval"]);
  });

  it("names the check, its project, its state, what was found and the fix", () => {
    const [line] = checks.setupCheckLogLines([row({ id: "github.installation", project: "ENG", detail: "The App is not installed on acme", fix: "Install the App." })]);
    expect(line).toMatch(/^\[setup-checks\] github\.installation \(ENG\) fail:/);
    expect(line).toContain("The App is not installed on acme.");
    expect(line).toContain("Install the App.");
  });

  it("carries no secret's value, from any check boot runs", async () => {
    const ctx = makeSentinelSetupCheckContext();
    const runs = [await checks.runSetupChecksBeforeRestate(ctx), await checks.runOrchestratorWideSetupChecks(ctx)];
    expect(runs.flatMap((run) => checks.setupCheckLogLines(run.results)).join("\n")).not.toContain("sentinel-");
  });
});

describe("boot's setup-check runs", () => {
  const row = (id: SetupCheckResult["id"], state: SetupCheckResult["state"] = "fail"): SetupCheckResult => ({ id, title: "", group: "orchestrator", tier: "core", onAdminPath: false, state });
  const runOf = (...results: SetupCheckResult[]): SetupCheckRun => ({ checkedAt: 1, results });
  function boot(deps: Partial<Parameters<typeof checks.createBootSetupChecks>[0]> = {}) {
    const lines: string[] = [];
    const runs = checks.createBootSetupChecks({
      runBeforeRestate: async () => runOf(row("env.github-app")),
      storeOrchestratorWide: async () => runOf(),
      log: (line) => { lines.push(line); },
      ...deps,
    });
    return { runs, lines };
  }

  it("logs the rows of the run before Restate serves", async () => {
    const { runs, lines } = boot();
    await runs.beforeRestate();
    expect(lines).toEqual([expect.stringContaining("env.github-app fail")]);
  });

  // The stored run holds every row; the first log covered the orchestrator's own checks but the two that need Restate.
  it("logs only the stored rows the first log could not, once Restate serves", async () => {
    const stored = runOf(row("env.github-app"), row("restate"), row("runner.fly-sessions"), row("tracker.linear.credentials"), { ...row("tracker.linear.team-access"), project: "ENG" });
    const { runs, lines } = boot({ storeOrchestratorWide: async () => stored });
    await runs.afterServing();
    expect(lines.map((line) => line.split(" ")[1])).toEqual(["restate", "runner.fly-sessions", "tracker.linear.credentials"]);
  });

  it("logs nothing once Restate serves when the run could not be stored, which the ingress already logged", async () => {
    const { runs, lines } = boot({ storeOrchestratorWide: async () => null });
    await runs.afterServing();
    expect(lines).toEqual([]);
  });

  it.each([
    ["before Restate serves", "beforeRestate", { runBeforeRestate: async () => { throw new Error("the database is locked"); } }],
    ["once Restate serves", "afterServing", { storeOrchestratorWide: async () => { throw new Error("the ingress is gone"); } }],
  ] as const)("logs one line, and never throws, when the run %s cannot run", async (when, phase, deps) => {
    const { runs, lines } = boot(deps);
    await expect(runs[phase]()).resolves.toBeUndefined();
    expect(lines).toEqual([expect.stringMatching(new RegExp(`^\\[setup-checks\\] the checks ${when} could not run: `))]);
  });
});

describe("a recheck", () => {
  const HOUR = 60 * 60_000;
  const stored = (state: SetupCheckResult["state"], checkedAt: number, project?: string): SetupCheckRun => ({
    checkedAt: 0,
    results: [{ id: "tracker.linear.team-access", title: "", group: "tracker", tier: "core", onAdminPath: false, state, checkedAt, ...(project ? { project } : {}) }],
  });

  it("is scoped to one project's rows of a per-project check, every row of a check given none, and an orchestrator-wide check's rows whatever project is given", () => {
    expect(checks.recheckScope("tracker.linear.team-access", "ENG")).toEqual({ checks: ["tracker.linear.team-access"], projects: ["ENG"] });
    expect(checks.recheckScope("tracker.linear.team-access")).toEqual({ checks: ["tracker.linear.team-access"] });
    expect(checks.recheckScope("github.app-identity", "ENG")).toEqual({ checks: ["github.app-identity"] });
    expect(checks.recheckScope("no.such-check")).toBeNull();
  });

  it.each([
    ["a recheck of them ran within the hour", null, HOUR - 1, true],
    ["the last recheck of them was an hour ago", null, 0, false],
    ["every stored row fails and was checked within the hour", stored("fail", 1, "ENG"), undefined, true],
    ["every stored row warns or cannot be verified, within the hour", stored("cannot-verify", 1, "ENG"), undefined, true],
    ["the stored row passes", stored("pass", 1, "ENG"), undefined, false],
    ["the failing stored row was checked an hour ago", stored("fail", 0, "ENG"), undefined, false],
    ["no stored row answers for the project", stored("fail", 1, "OPS"), undefined, false],
    ["nothing is stored", null, undefined, false],
  ] as const)("is held when %s: %s", (_case, run, lastRecheckAt, held) => {
    expect(checks.recheckHeld(run, { checks: ["tracker.linear.team-access"], projects: ["ENG"] }, lastRecheckAt, HOUR)).toBe(held);
  });

  describe("of the checks a rechecked run's rows wait on", () => {
    const waiting = (id: SetupCheckId, waitsOn?: SetupCheckId): SetupCheckResult =>
      ({ id, title: "", group: "tracker", tier: "core", onAdminPath: false, state: "cannot-verify", ...(waitsOn ? { waitsOn } : {}) });
    const runOf = (...results: SetupCheckResult[]): SetupCheckRun => ({ checkedAt: 0, results });
    // Answers each check's canned run with no hold, so only the chain's own guard can end it. Throws rather than loop without end.
    function rerunning(answers: Partial<Record<SetupCheckId, SetupCheckRun | null>>) {
      const asked: Array<[SetupCheckId, string | undefined]> = [];
      const rerun = async (dependency: SetupCheckScope, waited: SetupCheckId) => {
        if (asked.length > 10) throw new Error("the chain did not end");
        asked.push([waited, dependency.projects?.[0]]);
        expect(dependency.checks).toEqual([waited]);
        return answers[waited] ?? null;
      };
      return { asked, rerun };
    }
    const pickupLabel: SetupCheckScope = { checks: ["tracker.linear.pickup-label"], projects: ["ENG"] };

    it("rechecks each check the answered rows wait on in turn, for the project when the check is per-project", async () => {
      const { asked, rerun } = rerunning({
        "tracker.linear.team-access": runOf(waiting("tracker.linear.team-access", "tracker.linear.credentials")),
        "tracker.linear.credentials": runOf(waiting("tracker.linear.credentials", "tracker.provider")),
        "tracker.provider": null,
      });
      await checks.recheckWaitedOn(pickupLabel, runOf(waiting("tracker.linear.pickup-label", "tracker.linear.team-access")), rerun);
      expect(asked).toEqual([["tracker.linear.team-access", "ENG"], ["tracker.linear.credentials", undefined], ["tracker.provider", undefined]]);
    });

    // A flapping read, or a waitsOn added later, could lead the chain back to a check it already ran.
    it("runs each scope once, so a chain that leads back to one it ran ends", async () => {
      const { asked, rerun } = rerunning({
        "tracker.linear.team-access": runOf(waiting("tracker.linear.team-access", "tracker.linear.pickup-label"), waiting("tracker.linear.team-access", "tracker.linear.credentials")),
        "tracker.linear.credentials": runOf(waiting("tracker.linear.credentials", "tracker.linear.team-access")),
      });
      const run = runOf(waiting("tracker.linear.pickup-label", "tracker.linear.team-access"), waiting("tracker.linear.pickup-label", "tracker.linear.team-access"));
      await checks.recheckWaitedOn(pickupLabel, run, rerun);
      expect(asked).toEqual([["tracker.linear.team-access", "ENG"], ["tracker.linear.credentials", undefined]]);
    });

    it("runs nothing when no row waits on another check", async () => {
      const { asked, rerun } = rerunning({});
      await checks.recheckWaitedOn(pickupLabel, runOf(waiting("tracker.linear.pickup-label")), rerun);
      expect(asked).toEqual([]);
    });
  });

  // A check that throws answers one row with no project, which in a run for one project is that project's.
  it("runs only the checks its scope names, and gives one project the row of a per-project check that threw", async () => {
    const ctx = makeSetupCheckContext({ mappings: () => { throw new Error("the database is locked"); } });
    const run = await checks.runSetupChecksInScope(ctx, { checks: ["tracker.linear.team-access"], projects: ["ENG"] });
    expect(run.scope).toEqual({ checks: ["tracker.linear.team-access"], projects: ["ENG"] });
    expect(run.results.map((answered) => [answered.id, answered.state, answered.project])).toEqual([["tracker.linear.team-access", "cannot-verify", "ENG"]]);
  });
});

describe("the run in progress", () => {
  // callback.reachable reads the callback address's health, so holding that read holds exactly one check.
  function heldContext() {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ctx = makeSetupCheckContext({
      env: { RUNNER_CALLBACK_BASE_URL: "https://o.example.com" },
      orchestratorHealthAt: async () => { await held; return { outcome: "no-response", timedOut: true, error: "timeout" }; },
    });
    return { ctx, release };
  }

  it("is null before any run", () => {
    expect(checks.getSetupCheckProgress()).toBeNull();
  });

  const runningIds = () => checks.getSetupCheckProgress()?.running.map((check) => check.id);

  it("records every check as running, then each finished check's rows, until the run is ended", async () => {
    const { ctx, release } = heldContext();
    const run = checks.runSetupChecksWithProgress(ctx, () => 50);

    await vi.waitFor(() => expect(runningIds()).toEqual(["callback.reachable"]));
    const during = checks.getSetupCheckProgress()!;
    // Named as the Setup page shows it, since a page module cannot import the check list.
    const reachable = checks.SETUP_CHECKS.find((check) => check.id === "callback.reachable")!;
    expect(during.running).toEqual([{ id: reachable.id, title: reachable.title, group: reachable.group }]);
    expect(during.startedAt).toBe(50);
    expect(during.total).toBe(checks.SETUP_CHECKS.length);
    expect(during.finished.map((row) => row.id)).not.toContain("callback.reachable");
    release();
    const finished = await run;

    // The record stays until the caller has stored the run, so a reader always sees one or the other.
    expect(checks.getSetupCheckProgress()).toEqual({ startedAt: 50, total: checks.SETUP_CHECKS.length, finished: expect.any(Array), running: [] });
    expect(new Set(checks.getSetupCheckProgress()!.finished)).toEqual(new Set(finished.results));
    checks.endSetupCheckProgress();
    expect(checks.getSetupCheckProgress()).toBeNull();
  });

  it("answers a copy, so a reader cannot change the record", async () => {
    const { ctx, release } = heldContext();
    const run = checks.runSetupChecksWithProgress(ctx);
    await vi.waitFor(() => expect(runningIds()).toEqual(["callback.reachable"]));
    checks.getSetupCheckProgress()!.running.length = 0;
    expect(runningIds()).toEqual(["callback.reachable"]);
    release();
    await run;
  });

  it("never lets a superseded run's late checks write into a newer run's record", async () => {
    const first = heldContext();
    const firstRun = checks.runSetupChecksWithProgress(first.ctx, () => 1);
    await vi.waitFor(() => expect(runningIds()).toEqual(["callback.reachable"]));
    const second = heldContext();
    const secondRun = checks.runSetupChecksWithProgress(second.ctx, () => 2);
    await vi.waitFor(() => expect(runningIds()).toEqual(["callback.reachable"]));

    first.release();
    await firstRun;
    expect(checks.getSetupCheckProgress()).toMatchObject({ startedAt: 2, running: [{ id: "callback.reachable" }] });
    second.release();
    await secondRun;
  });
});

describe("setupCommandFor", () => {
  it("names the SSH command for the app on Fly, and the npm script off it", () => {
    expect(checks.setupCommandFor({ FLY_APP_NAME: "acme-orchestrator" })).toBe('fly ssh console -a acme-orchestrator -C "node /app/dist/check-setup.js"');
    expect(checks.setupCommandFor({})).toBe("npm run check-setup");
  });
});

describe("the recorded run", () => {
  it("keeps its own copy, so neither the run it was given nor one read back can change it", () => {
    const row: SetupCheckResult = { id: "restate", title: "Restate engine", group: "orchestrator", tier: "core", onAdminPath: true, state: "pass" };
    const run = { checkedAt: 1, results: [row] };
    checks.cacheSetupCheckRun(run);

    run.checkedAt = 2;
    row.state = "fail";
    const readBack = checks.getCachedSetupCheckRun();
    if (readBack) readBack.results[0].state = "warn";

    expect(checks.getCachedSetupCheckRun()).toEqual({ checkedAt: 1, results: [{ ...row, state: "pass" }] });
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
    await expect(unconfigured.trackerProvider("jira")).rejects.toThrow("No project uses the jira ticketing system");
    await expect(unconfigured.trackerProvider("linear")).rejects.toThrow(/linearClientId/);

    linearAuth.configureLinearAuth("client-id", "client-secret");
    const configured = checks.createSetupCheckContext({ restateStatus, mappings });
    expect((await configured.trackerProvider("linear")).id).toBe("linear");
  });

  describe("githubSetupFacts", () => {
    const env = { GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: makeAppPrivateKey() };
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

    it("only reads from GitHub across a whole run: a GET, a token mint, or the GraphQL read query", async () => {
      const api = fakeFetch({
        "GET /app": { json: { slug: "app" } },
        "GET /orgs/o/installation": installed(1),
        "GET /orgs/other/installation": githubError(404, "Not Found"),
        "GET /users/other/installation": githubError(404, "Not Found"),
        "POST /app/installations/1/access_tokens": { status: 201, json: { token: "ghs_read", expires_at: new Date(Date.now() + 3600_000).toISOString() } },
        "POST /graphql": { json: { data: { r0: { defaultBranchRef: { name: "main" }, isPrivate: false, e0: null, e1: null, e2: null, p0: { nodes: [] } } } } },
        "GET /app/hook/deliveries": { json: [] },
        "GET /repos/other/docs": { json: { private: false } },
        "GET /repos/other/skills": { json: { private: false } },
      }).install();
      const ctx = checks.createSetupCheckContext({
        env: { ...env, GITHUB_WEBHOOK_SECRET: "s" },
        restateStatus,
        mappings: () => ({
          ENG: makeMapping({ owner: "o", repo: "app", referenceRepos: [{ repo: "https://github.com/other/docs", path: "docs" }], skillsRepo: "https://github.com/other/skills" }),
        }),
        // The ticketing system's reads are its own checks' subject, not GitHub's.
        trackerProvider: async () => makeProvider(),
        trackerSetupFacts: async () => null,
      });

      await checks.runSetupChecks(ctx);

      const kinds = api.calls.map((call) => {
        if (call.method === "GET") return "get";
        if (call.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(call.path)) return "mint";
        if (call.method === "POST" && call.path === "/graphql" && /^\s*query\b/.test(JSON.parse(call.body).query)) return "query";
        return `${call.method} ${call.path}`;
      });
      expect(new Set(kinds)).toEqual(new Set(["get", "mint", "query"]));
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
        row({ id: "tracker.linear.team-access", title: "Linear team access", group: "tracker", onAdminPath: false, project: "ENG", detail: "The app can see team ENG", checkedAt: 5 }),
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
