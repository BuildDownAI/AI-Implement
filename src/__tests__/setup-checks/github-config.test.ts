import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { RepoMapping } from "../../config.js";
import type { AppIdentityRead, AppInstallation } from "../../github-app-auth.js";
import type { RepositoryFacts } from "../../github.js";
import type { WorkflowSyncJob } from "../../workflow-sync-queue.js";
import { GitHubApiError } from "../../github-errors.js";
import type { PreflightCheckResult } from "../../kg-refresh.js";
import { GITHUB_CONFIG_CHECKS, ownerRepositoryRequests, workflowFileExpression, workflowFiles } from "../../setup-checks/github-config.js";
import type { GitHubSetupFacts, SetupCheckContext, SetupCheckOutcome } from "../../setup-checks/index.js";
import type { AppDelivery } from "../../webhook-redelivery.js";
import { makeMapping } from "../helpers/builders.js";
import { makeGitHubSetupFacts, makeSetupCheckContext } from "../helpers/fixtures/setup-checks.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const APP_ENV = { GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: privateKey };
const NOW = Date.parse("2026-11-10T02:42:14Z");

/** GitHub's answer to the App's JWT: accepted as `slug`, or refused when `slug` is null, with the host `skewSeconds` ahead. */
const appRead = ({ slug = "ai-implement" as string | null, status = 200, skewSeconds = 0 } = {}): AppIdentityRead => ({
  status: slug === null && status === 200 ? 401 : status,
  slug,
  errorBody: slug === null ? '{"message":"A JSON web token could not be decoded"}' : "",
  githubTime: NOW,
  localTime: NOW + skewSeconds * 1000,
});

/** An installation as GitHub returns one, with every permission the orchestrator declares unless `permissions` says otherwise. */
const installation = (overrides: Partial<AppInstallation> = {}): AppInstallation => ({
  id: 1,
  repository_selection: "all",
  permissions: { contents: "write", pull_requests: "write", workflows: "write", actions: "write", issues: "write", metadata: "read", checks: "read", statuses: "write" },
  ...overrides,
});

function context(github: Partial<GitHubSetupFacts>, overrides: Partial<SetupCheckContext> = {}): SetupCheckContext {
  const facts = makeGitHubSetupFacts({ app: async () => appRead(), installation: async () => installation(), installationRepositories: async () => null, kgSourceRepo: () => "acme/kg", ...github });
  return makeSetupCheckContext({
    env: APP_ENV,
    mappings: () => ({ ENG: makeMapping({ owner: "acme", repo: "app" }) }),
    githubSetupFacts: () => facts,
    ...overrides,
  });
}

async function run(id: string, ctx: SetupCheckContext): Promise<SetupCheckOutcome[]> {
  const check = GITHUB_CONFIG_CHECKS.find((c) => c.id === id);
  if (!check) throw new Error(`No check ${id}`);
  return check.run(ctx);
}

describe("workflowFileExpression", () => {
  it("names a workflow file on GitHub's default branch, or on a named branch", () => {
    expect(workflowFileExpression(null, "claude-implement.yml")).toBe("HEAD:.github/workflows/claude-implement.yml");
    expect(workflowFileExpression("develop", "claude-plan.yml")).toBe("develop:.github/workflows/claude-plan.yml");
  });
});

describe("workflowFiles", () => {
  it("is the implementation workflow, plus the planning workflow while planning is on", () => {
    expect(workflowFiles(makeMapping({ workflowFile: "impl.yml", planningEnabled: true, planningWorkflowFile: "plan.yml" }))).toEqual(["impl.yml", "plan.yml"]);
    expect(workflowFiles(makeMapping({ workflowFile: "impl.yml", planningEnabled: false, planningWorkflowFile: "plan.yml" }))).toEqual(["impl.yml"]);
  });
});

describe("ownerRepositoryRequests", () => {
  it("asks for each workflow file on both branches, and for the project's sync branch", () => {
    const mappings = { ENG: makeMapping({ owner: "o", repo: "App", defaultBranch: "develop", workflowFile: "impl.yml", planningEnabled: true, planningWorkflowFile: "plan.yml", branchPrefix: "bot" }) };

    expect(ownerRepositoryRequests(mappings, "o")).toEqual([{
      repo: "app",
      expressions: ["develop", "HEAD:.github/workflows/impl.yml", "develop:.github/workflows/impl.yml", "HEAD:.github/workflows/plan.yml", "develop:.github/workflows/plan.yml"],
      openPullRequestHeads: ["bot/sync/ai-implement"],
    }]);
  });

  it("adds the reference and skills repositories on the owner, a pinned ref as its own expression", () => {
    const mappings = {
      ENG: makeMapping({
        owner: "o", repo: "app", planningEnabled: false,
        referenceRepos: [
          { repo: "https://github.com/o/docs", path: "docs", ref: "v2" },
          { repo: "https://github.com/elsewhere/lib", path: "lib" },
        ],
        skillsRepo: "https://github.com/O/skills.git",
      }),
    };

    const requests = ownerRepositoryRequests(mappings, "O");
    expect(requests.map((r) => r.repo)).toEqual(["app", "docs", "skills"]);
    expect(requests[1]).toEqual({ repo: "docs", expressions: ["v2"], openPullRequestHeads: [] });
    expect(requests[2]).toEqual({ repo: "skills", expressions: [], openPullRequestHeads: [] });
    expect(ownerRepositoryRequests(mappings, "elsewhere")).toEqual([{ repo: "lib", expressions: [], openPullRequestHeads: [] }]);
  });

  it("asks once for a repository two projects read, with both projects' lookups", () => {
    const mappings = {
      ENG: makeMapping({ owner: "o", repo: "app", workflowFile: "impl.yml", planningEnabled: false, defaultBranch: "main" }),
      OPS: makeMapping({ owner: "o", repo: "APP", workflowFile: "ops.yml", planningEnabled: false, defaultBranch: "main" }),
    };

    const [request, ...rest] = ownerRepositoryRequests(mappings, "o");
    expect(rest).toEqual([]);
    expect(request.expressions).toEqual(["main", "HEAD:.github/workflows/impl.yml", "main:.github/workflows/impl.yml", "HEAD:.github/workflows/ops.yml", "main:.github/workflows/ops.yml"]);
    expect(request.openPullRequestHeads).toEqual(["sync/ai-implement"]);
  });

  it("asks for nothing on an owner no project reads", () => {
    expect(ownerRepositoryRequests({ ENG: makeMapping({ owner: "o" }) }, "other")).toEqual([]);
  });
});

describe("the App's credentials, before any GitHub read", () => {
  it.each(["github.app-identity", "github.clock", "github.installation", "github.webhook-signature", "github.kg-grants"])("%s names env.github-app when the key is missing or unreadable", async (id) => {
    const env = { GITHUB_WEBHOOK_SECRET: "s", KG_SOURCE_REPO: "acme/kg" };
    for (const appEnv of [{ GITHUB_APP_ID: "123456" }, { GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: "not a key" }]) {
      const rows = await run(id, context({}, { env: { ...env, ...appEnv } }));
      expect(rows).toEqual([expect.objectContaining({ state: "cannot-verify", fix: "Clear env.github-app first." })]);
    }
  });
});

describe("github.app-identity", () => {
  it("passes when GitHub accepts the credentials, naming the App", async () => {
    expect(await run("github.app-identity", context({}))).toEqual([{ state: "pass", detail: "GitHub accepts the credentials of the App ai-implement" }]);
  });

  it("names the clock, not the key, when the clock explains the refusal", async () => {
    const [row] = await run("github.app-identity", context({ app: async () => appRead({ slug: null, skewSeconds: 400 }) }));
    expect(row).toMatchObject({ state: "fail", detail: "GitHub refused the App's credentials (HTTP 401) because the host clock is 400 seconds ahead of GitHub's" });
    expect(row.fix).toContain("NTP");
  });

  it("names the ID and key when the clock is inside the tolerance", async () => {
    const [row] = await run("github.app-identity", context({ app: async () => appRead({ slug: null, skewSeconds: 300 }) }));
    expect(row).toMatchObject({ state: "fail", detail: "GitHub refused the App's ID and private key (HTTP 401), so every GitHub call fails" });
    expect(row.fix).toContain("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY");
  });

  it("names the ID and key when GitHub knows no such App (HTTP 404, its answer to a wrong App ID)", async () => {
    const [row] = await run("github.app-identity", context({ app: async () => appRead({ slug: null, status: 404 }) }));
    expect(row).toMatchObject({ state: "fail", detail: "GitHub refused the App's ID and private key (HTTP 404), so every GitHub call fails" });
  });

  it.each([503, 429])("cannot verify, blaming neither key nor clock, when GitHub answers HTTP %i", async (status) => {
    const [row] = await run("github.app-identity", context({ app: async () => appRead({ slug: null, status, skewSeconds: 400 }) }));
    expect(row).toEqual({
      state: "cannot-verify",
      detail: `GitHub answered HTTP ${status} rather than accepting or refusing the App's credentials`,
      fix: "Run the checks again once GitHub answers normally.",
    });
  });

  it("cannot verify when GitHub cannot be reached", async () => {
    const [row] = await run("github.app-identity", context({ app: async () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); } }));
    expect(row).toMatchObject({ state: "cannot-verify", detail: "The orchestrator could not reach GitHub: getaddrinfo ENOTFOUND api.github.com" });
  });
});

describe("github.clock", () => {
  it.each([
    [0, "pass", "The host clock is 0 seconds ahead of GitHub's, within the 300 seconds the App's credentials allow"],
    [1, "pass", "The host clock is 1 second ahead of GitHub's, within the 300 seconds the App's credentials allow"],
    [300, "pass", "The host clock is 300 seconds ahead of GitHub's, within the 300 seconds the App's credentials allow"],
    [400, "fail", "The host clock is 400 seconds ahead of GitHub's, more than the 300 seconds the App's credentials allow, so GitHub refuses them"],
    [-301, "fail", "The host clock is 301 seconds behind GitHub's, more than the 300 seconds the App's credentials allow, so GitHub refuses them"],
  ])("a host %s seconds ahead reads %s", async (skewSeconds, state, detail) => {
    expect(await run("github.clock", context({ app: async () => appRead({ skewSeconds }) }))).toEqual([expect.objectContaining({ state, detail })]);
  });

  it("measures the clock even when GitHub refuses the credentials", async () => {
    const rows = await run("github.clock", context({ app: async () => appRead({ slug: null, skewSeconds: 400 }) }));
    expect(rows).toEqual([expect.objectContaining({ state: "fail" })]);
  });

  it("cannot verify without GitHub's Date header", async () => {
    const rows = await run("github.clock", context({ app: async () => ({ ...appRead(), githubTime: null }) }));
    expect(rows).toEqual([expect.objectContaining({ state: "cannot-verify", detail: "GitHub's response carried no Date header, so the host clock cannot be compared with it" })]);
  });
});

describe("github.installation", () => {
  it("is not applicable with no project", async () => {
    expect(await run("github.installation", context({}, { mappings: () => ({}) }))).toEqual([{ state: "not-applicable", detail: "No project is configured" }]);
  });

  it("waits on github.app-identity when GitHub refuses the credentials", async () => {
    const rows = await run("github.installation", context({ app: async () => appRead({ slug: null }) }));
    expect(rows).toEqual([expect.objectContaining({ state: "cannot-verify", fix: "Clear github.app-identity first." })]);
  });

  it("cannot verify, without blaming the credentials, when GitHub answers HTTP 503", async () => {
    const rows = await run("github.installation", context({ app: async () => appRead({ slug: null, status: 503 }) }));
    expect(rows).toEqual([{
      state: "cannot-verify",
      detail: "GitHub answered HTTP 503 rather than accepting or refusing the App's credentials, so the App's installations cannot be read",
      fix: "Run the checks again once GitHub answers normally.",
    }]);
  });

  it("fails a project whose owner has no installation, linking the install page", async () => {
    const [row] = await run("github.installation", context({ installation: async () => null }));
    expect(row).toEqual({
      state: "fail",
      project: "ENG",
      detail: "The App is not installed on acme, so the orchestrator cannot dispatch to or clone acme/app",
      fix: "Install the App on acme.",
      fixUrl: "https://github.com/apps/ai-implement/installations/new",
    });
  });

  it("fails a repository a selected-repositories installation leaves out, and passes one it includes in any case", async () => {
    const left = await run("github.installation", context({ installation: async () => installation({ repository_selection: "selected" }), installationRepositories: async () => new Set(["other"]) }));
    expect(left).toEqual([expect.objectContaining({ state: "fail", project: "ENG", detail: "The App's installation on acme does not include app, so the orchestrator cannot dispatch to or clone it", fixUrl: "https://github.com/apps/ai-implement/installations/new" })]);

    const kept = await run("github.installation", context({ installationRepositories: async () => new Set(["app"]) }, { mappings: () => ({ ENG: makeMapping({ owner: "acme", repo: "App" }) }) }));
    expect(kept).toEqual([expect.objectContaining({ state: "pass", detail: "The App's installation on acme includes App" })]);
  });

  it("passes an installation with every repository", async () => {
    expect(await run("github.installation", context({}))).toEqual([{ state: "pass", project: "ENG", detail: "The App is installed on acme for all of its repositories" }]);
  });

  it("cannot verify one project whose installation cannot be read, and still judges the rest", async () => {
    const ctx = context({ installation: async (owner) => { if (owner === "acme") throw new GitHubApiError({ status: 502 }); return installation(); } }, {
      mappings: () => ({ ENG: makeMapping({ owner: "acme", repo: "app" }), OPS: makeMapping({ owner: "beta", repo: "ops" }) }),
    });
    const rows = await run("github.installation", ctx);
    expect(rows.map((r) => [r.project, r.state])).toEqual([["ENG", "cannot-verify"], ["OPS", "pass"]]);
  });
});

describe("github.permissions", () => {
  it("passes an installation holding every declared permission", async () => {
    expect(await run("github.permissions", context({}))).toEqual([{ state: "pass", project: "ENG", detail: "The App's installation on acme has every permission the orchestrator uses" }]);
  });

  it("fails on a missing or too-low required permission, naming each and what breaks", async () => {
    const permissions = { ...installation().permissions, contents: "read" } as Record<string, string>;
    delete permissions.workflows;
    const [row] = await run("github.permissions", context({ installation: async () => installation({ permissions }) }));
    expect(row.state).toBe("fail");
    expect(row.detail).toBe("The App's installation on acme lacks Contents (read and write), Workflows (read and write). Runs cannot clone the repository or push their branch. Workflow sync, and runs that change a workflow file, cannot push.");
    // Directions, not a link: GitHub gives the page no documented URL, and only an owner or App manager can open it.
    expect(row.fix).toBe(
      "An organization owner or a GitHub App manager grants these in the settings of the account that owns the App: Developer settings -> GitHub Apps -> Edit -> Permissions & events. Then an owner of acme approves the new permissions on its installation.",
    );
    expect(row).not.toHaveProperty("fixUrl");
  });

  it("warns when only an optional permission is missing", async () => {
    const permissions = { ...installation().permissions } as Record<string, string>;
    delete permissions.checks;
    const [row] = await run("github.permissions", context({ installation: async () => installation({ permissions }) }));
    expect(row).toMatchObject({ state: "warn", detail: expect.stringContaining("lacks Checks (read-only).") });
  });

  it("waits on github.installation for an owner without the App", async () => {
    const [row] = await run("github.permissions", context({ installation: async () => null }));
    expect(row).toMatchObject({ state: "cannot-verify", fix: "Clear github.installation first." });
  });
});

describe("github.target-secrets", () => {
  it.each([
    ["github-actions", "default", "cannot-verify"],
    ["fly-machines", "default", "not-applicable"],
    ["fly-machines", "gha", "cannot-verify"],
    ["github-actions", "local", "not-applicable"],
    ["fly-machines", "shadow", "cannot-verify"],
  ] as const)("a %s project under runner mode %s reads %s", async (executionMode, mode, state) => {
    const ctx = context({}, { mappings: () => ({ ENG: makeMapping({ owner: "acme", repo: "app", executionMode }) }), runnerMode: () => ({ mode, source: "default" }) });
    expect(await run("github.target-secrets", ctx)).toEqual([expect.objectContaining({ state, project: "ENG" })]);
  });

  it("reads nothing from GitHub", async () => {
    const ctx = context({ app: async () => { throw new Error("no GitHub read expected"); } }, { env: {} });
    expect(await run("github.target-secrets", ctx)).toEqual([expect.objectContaining({ state: "cannot-verify", detail: expect.stringContaining("AI_IMPLEMENT_APP_ID and AI_IMPLEMENT_PRIVATE_KEY") })]);
  });
});

describe("github.webhook-signature", () => {
  const delivery = (status_code: number, n: number): AppDelivery => ({ id: n, guid: `g${n}`, delivered_at: new Date(NOW).toISOString(), status: status_code === 200 ? "OK" : `Invalid HTTP Response: ${status_code}`, status_code, event: "issue_comment" });
  const withSecret = (github: Partial<GitHubSetupFacts>) => context(github, { env: { ...APP_ENV, GITHUB_WEBHOOK_SECRET: "s" } });

  it("is not applicable without a webhook secret", async () => {
    expect(await run("github.webhook-signature", context({}))).toEqual([{ state: "not-applicable", detail: "GITHUB_WEBHOOK_SECRET is not set, so there is no webhook signature to check" }]);
  });

  it("warns when deliveries in the last day were refused for their signature, counting them", async () => {
    const rows = await run("github.webhook-signature", withSecret({ deliveries: async () => ({ deliveries: [delivery(401, 1), delivery(200, 2), delivery(401, 3), delivery(503, 4)], endedEarlyWith: null }) }));
    expect(rows).toEqual([expect.objectContaining({ state: "warn", detail: "2 of the App's 4 webhook deliveries in the last day did not match GITHUB_WEBHOOK_SECRET (HTTP 401), so the orchestrator ignored those events" })]);
  });

  it("passes with no refused delivery, saying when the list ended early", async () => {
    const rows = await run("github.webhook-signature", withSecret({ deliveries: async () => ({ deliveries: [delivery(200, 1), delivery(503, 2)], endedEarlyWith: 502 }) }));
    expect(rows).toEqual([{ state: "pass", detail: "None of the App's 2 webhook deliveries in the last day failed the GITHUB_WEBHOOK_SECRET check (GitHub ended the list early with HTTP 502)" }]);
  });

  it("passes with no delivery in the last day, saying so", async () => {
    const rows = await run("github.webhook-signature", withSecret({ deliveries: async () => ({ deliveries: [], endedEarlyWith: null }) }));
    expect(rows).toEqual([{ state: "pass", detail: "The App received no webhook deliveries in the last day" }]);
  });

  it("waits on github.app-identity when GitHub refuses to list deliveries", async () => {
    const rows = await run("github.webhook-signature", withSecret({ deliveries: async () => { throw new GitHubApiError({ status: 401 }); } }));
    expect(rows).toEqual([expect.objectContaining({ state: "cannot-verify", fix: "Clear github.app-identity first." })]);
  });
});

describe("github.kg-grants", () => {
  const preflight = (results: PreflightCheckResult["results"]): PreflightCheckResult => ({ ok: results.every((r) => r.ok), checkedAt: NOW, results });
  const withKg = (github: Partial<GitHubSetupFacts>) => context(github, { env: { ...APP_ENV, KG_SOURCE_REPO: "acme/kg" } });

  it("is not applicable without KG_SOURCE_REPO", async () => {
    expect(await run("github.kg-grants", context({}))).toEqual([{ state: "not-applicable", detail: "KG_SOURCE_REPO is not set, so the App needs no knowledge graph access" }]);
  });

  it("fails a KG_SOURCE_REPO that is not an owner/repo name, before any GitHub read", async () => {
    const ctx = context({ kgSourceRepo: () => null, kgPreflight: async () => { throw new Error("no GitHub read expected"); } }, { env: { ...APP_ENV, KG_SOURCE_REPO: "https://github.com/acme/kg" } });
    expect(await run("github.kg-grants", ctx)).toEqual([expect.objectContaining({ state: "fail", fix: "Set KG_SOURCE_REPO to the knowledge graph repository as owner/repo." })]);
  });

  it("passes when every grant passes, counting the repositories", async () => {
    const rows = await run("github.kg-grants", withKg({ kgPreflight: async () => preflight([
      { repo: "acme/kg", grant: "contents:write", ok: true, status: 200 },
      { repo: "acme/app", grant: "contents:read", ok: true, status: 200 },
      { repo: "acme/app", grant: "pull_requests:read", ok: true, status: 200 },
    ]) }));
    expect(rows).toEqual([{ state: "pass", detail: "The App has every access the knowledge graph refresh needs, across 2 repositories" }]);
  });

  it("fails naming each failing grant, its status and hint", async () => {
    const rows = await run("github.kg-grants", withKg({ kgPreflight: async () => preflight([
      { repo: "acme/kg", grant: "contents:write", ok: true, status: 200 },
      { repo: "acme/lib", grant: "contents:read", ok: false, status: 404 },
      { repo: "acme/kg", grant: "workflow:envelope", ok: false, status: 404, hint: "sync the workflow" },
    ]) }));
    expect(rows).toEqual([expect.objectContaining({ state: "fail", detail: "The App lacks access the knowledge graph refresh needs, so a refresh is refused: acme/lib contents:read (HTTP 404), acme/kg workflow:envelope (HTTP 404), sync the workflow" })]);
  });

  it("cannot verify when the preflight cannot run", async () => {
    const rows = await run("github.kg-grants", withKg({ kgPreflight: async () => { throw new Error("socket hang up"); } }));
    expect(rows).toEqual([expect.objectContaining({ state: "cannot-verify", detail: "The orchestrator could not reach GitHub: socket hang up" })]);
  });
});

/** What the installation's token sees of a repository, as `readRepositoryFacts` reports it. */
const repoFacts = (overrides: Partial<RepositoryFacts> = {}): RepositoryFacts => ({ visible: true, private: false, defaultBranch: "main", exists: {}, openPullRequests: {}, ...overrides });
const IMPL = "HEAD:.github/workflows/claude-implement.yml";
const PLAN = "HEAD:.github/workflows/claude-plan.yml";
const syncJob = (status: WorkflowSyncJob["status"], updatedAt = Date.now(), error: WorkflowSyncJob["error"] = null): WorkflowSyncJob =>
  ({ id: 1, teamKey: "ENG", status, result: null, error, createdAt: updatedAt, updatedAt });

describe("github.workflow-default-branch", () => {
  const gha = (facts: RepositoryFacts, github: Partial<GitHubSetupFacts> = {}, mapping = {}) => context(
    { repositories: async () => new Map([["app", facts]]), ...github },
    { mappings: () => ({ ENG: makeMapping({ owner: "acme", repo: "app", executionMode: "github-actions", defaultBranch: "main", workflowFile: "claude-implement.yml", planningEnabled: true, planningWorkflowFile: "claude-plan.yml", branchPrefix: null, ...mapping }) }) },
  );
  const both = { [IMPL]: true, [PLAN]: true };

  it("is not applicable to a project that does not run on GitHub Actions", async () => {
    const rows = await run("github.workflow-default-branch", context({}, { mappings: () => ({ ENG: makeMapping({ owner: "acme", repo: "app", executionMode: "fly-machines" }) }) }));
    expect(rows).toEqual([{ state: "not-applicable", project: "ENG", detail: "acme/app runs on Fly Machines, not GitHub Actions, so it needs no workflow files" }]);
  });

  it("passes when every workflow file is on the default branch", async () => {
    expect(await run("github.workflow-default-branch", gha(repoFacts({ exists: both })))).toEqual([{
      state: "pass", project: "ENG", detail: "acme/app has claude-implement.yml and claude-plan.yml on main, where GitHub dispatches them from",
    }]);
  });

  it("warns when the files are there but a sync pull request still carries changes to them", async () => {
    const pr = { number: 9, url: "https://github.com/acme/app/pull/9" };
    const [row] = await run("github.workflow-default-branch", gha(repoFacts({ exists: both, openPullRequests: { "sync/ai-implement": pr } })));
    expect(row).toMatchObject({ state: "warn", fix: "Merge pull request #9.", fixUrl: pr.url });
  });

  it("names the files on the project's branch when only the default branch lacks them", async () => {
    const facts = repoFacts({ exists: { "develop:.github/workflows/claude-implement.yml": true, "develop:.github/workflows/claude-plan.yml": true } });
    const [row] = await run("github.workflow-default-branch", gha(facts, {}, { defaultBranch: "develop" }));
    expect(row.detail).toBe("acme/app lacks claude-implement.yml and claude-plan.yml on its default branch main, so GitHub refuses to dispatch them. They are on the project's branch develop, but GitHub dispatches only workflows on the default branch");
  });

  it("says a sync is in progress before anything else, then a failed sync's error, then the open pull request", async () => {
    const pr = { number: 9, url: "https://github.com/acme/app/pull/9" };
    const facts = repoFacts({ exists: { [PLAN]: true }, openPullRequests: { "sync/ai-implement": pr } });
    const rowWith = async (job: WorkflowSyncJob | null) => (await run("github.workflow-default-branch", gha(facts, { workflowSync: () => job })))[0];

    expect(await rowWith(syncJob("running"))).toMatchObject({ state: "fail", detail: expect.stringContaining("A workflow sync for this project is in progress"), fix: "Wait for the sync to open its pull request, then merge it." });
    expect(await rowWith(syncJob("failed", Date.now(), { category: "permission-denied", message: "GitHub refused the push" }))).toMatchObject({ detail: expect.stringContaining("The last workflow sync failed: GitHub refused the push") });
    expect(await rowWith(syncJob("running", Date.now() - 6 * 60_000))).toMatchObject({ detail: expect.stringContaining("Workflow sync pull request #9 carries them"), fixUrl: pr.url });
    expect(await rowWith(null)).toMatchObject({ detail: "acme/app lacks claude-implement.yml on its default branch main, so GitHub refuses to dispatch it. Workflow sync pull request #9 carries them" });
  });

  it("names the Sync workflows action when nothing is on its way", async () => {
    const [row] = await run("github.workflow-default-branch", gha(repoFacts()));
    expect(row).toMatchObject({ state: "fail", detail: expect.stringMatching(/, and no workflow sync pull request is open$/), fix: expect.stringContaining("Sync workflows") });
  });

  it("waits on github.installation and github.permissions when the repository cannot be read", async () => {
    const hidden = await run("github.workflow-default-branch", gha(repoFacts({ visible: false })));
    expect(hidden).toEqual([expect.objectContaining({ state: "cannot-verify", fix: "Clear github.installation first." })]);
    const refused = await run("github.workflow-default-branch", gha(repoFacts(), { repositories: async () => { throw new GitHubApiError({ status: 422 }); } }));
    expect(refused).toEqual([expect.objectContaining({ state: "cannot-verify", fix: "Clear github.permissions first." })]);
  });
});

describe("github.workflow-mapping-branch", () => {
  const onBranch = (facts: RepositoryFacts, defaultBranch = "develop") => context(
    { repositories: async () => new Map([["app", facts]]) },
    { mappings: () => ({ ENG: makeMapping({ owner: "acme", repo: "app", executionMode: "github-actions", defaultBranch, planningEnabled: false, workflowFile: "claude-implement.yml" }) }) },
  );

  it("is not applicable when the project's branch is the repository's default", async () => {
    expect(await run("github.workflow-mapping-branch", onBranch(repoFacts(), "main"))).toEqual([expect.objectContaining({ state: "not-applicable" })]);
  });

  it("fails a project branch that does not exist", async () => {
    expect(await run("github.workflow-mapping-branch", onBranch(repoFacts()))).toEqual([expect.objectContaining({ state: "fail", detail: "The project's branch develop does not exist in acme/app, so its dispatches and clones fail" })]);
  });

  it("passes a project branch with the files, and fails one without them", async () => {
    const withFiles = repoFacts({ exists: { develop: true, "develop:.github/workflows/claude-implement.yml": true } });
    expect(await run("github.workflow-mapping-branch", onBranch(withFiles))).toEqual([expect.objectContaining({ state: "pass" })]);
    const without = repoFacts({ exists: { develop: true } });
    expect(await run("github.workflow-mapping-branch", onBranch(without))).toEqual([expect.objectContaining({ state: "fail", detail: "acme/app's project branch develop differs from its default branch main and lacks claude-implement.yml, so dispatches to it fail" })]);
  });
});

describe("github.reference-repos", () => {
  const withRefs = (referenceRepos: RepoMapping["referenceRepos"], github: Partial<GitHubSetupFacts>) => context(github, { mappings: () => ({ ENG: makeMapping({ owner: "acme", repo: "app", referenceRepos }) }) });

  it("is not applicable to a project with none", async () => {
    expect(await run("github.reference-repos", withRefs(null, {}))).toEqual([{ state: "not-applicable", project: "ENG", detail: "acme/app reads no reference repositories" }]);
  });

  it("reads a repository on an owner without the App as a run does, without a token", async () => {
    const publicRepository = vi.fn(async (_o: string, repo: string) => ({ status: repo === "open" ? 200 : 404, refExists: repo === "open" ? true : null }));
    const rows = await run("github.reference-repos", withRefs(
      [{ repo: "https://github.com/other/open", path: "a", ref: "v1" }, { repo: "https://github.com/other/closed", path: "b" }],
      { installation: async (owner) => (owner === "other" ? null : installation()), publicRepository },
    ));
    expect(rows).toEqual([expect.objectContaining({ state: "fail", detail: "Runs of acme/app cannot clone 1 of its 2 reference repositories: other/closed is private or missing, and the App is not installed on other" })]);
    expect(publicRepository).toHaveBeenCalledWith("other", "open", "v1");
  });

  it("fails a repository outside a selected installation, an unseen one and a missing ref", async () => {
    const rows = await run("github.reference-repos", withRefs(
      [{ repo: "https://github.com/acme/outside", path: "a" }, { repo: "https://github.com/acme/docs", path: "b", ref: "v9" }, { repo: "https://github.com/acme/gone", path: "c" }],
      {
        installation: async () => installation({ repository_selection: "selected" }),
        installationRepositories: async () => new Set(["docs", "gone"]),
        repositories: async () => new Map([["docs", repoFacts({ exists: { v1: true } })], ["gone", repoFacts({ visible: false })]]),
      },
    ));
    expect(rows[0].detail).toBe("Runs of acme/app cannot clone 3 of its 3 reference repositories: acme/outside is outside the App's installation on acme, acme/docs has no ref v9, acme/gone does not exist, or the App cannot see it");
  });

  it("passes when every repository can be cloned, and cannot verify one it cannot read", async () => {
    const ok = await run("github.reference-repos", withRefs([{ repo: "https://github.com/acme/docs", path: "b", ref: "v1" }], { repositories: async () => new Map([["docs", repoFacts({ exists: { v1: true } })]]) }));
    expect(ok).toEqual([expect.objectContaining({ state: "pass", detail: "Runs of acme/app can clone all 1 of its reference repositories" })]);
    const limited = await run("github.reference-repos", withRefs([{ repo: "https://github.com/other/x", path: "a" }], { installation: async () => null, publicRepository: async () => ({ status: 403, refExists: null }) }));
    expect(limited).toEqual([expect.objectContaining({ state: "cannot-verify", detail: "Some of acme/app's reference repositories could not be read: other/x could not be read (HTTP 403)" })]);
  });
});

describe("github.skills-repo", () => {
  const withSkills = (skillsRepo: string | null, github: Partial<GitHubSetupFacts> = {}) => context(github, { mappings: () => ({ ENG: makeMapping({ owner: "acme", repo: "app", skillsRepo }) }) });

  it("is not applicable without a skills repository, and passes the project's own", async () => {
    expect(await run("github.skills-repo", withSkills(null))).toEqual([expect.objectContaining({ state: "not-applicable" })]);
    expect(await run("github.skills-repo", withSkills("https://github.com/Acme/App"))).toEqual([expect.objectContaining({ state: "pass" })]);
  });

  it("reads visibility through the installation where the App is installed, and fails a private one", async () => {
    const publicRepository = vi.fn();
    const rows = await run("github.skills-repo", withSkills("https://github.com/acme/skills", { repositories: async () => new Map([["skills", repoFacts({ private: true })]]), publicRepository }));
    expect(rows).toEqual([expect.objectContaining({ state: "fail", fix: "Make acme/skills public, or keep the skills in acme/app." })]);
    expect(publicRepository).not.toHaveBeenCalled();
  });

  it("passes a public one, and reads one on an owner without the App without a token", async () => {
    expect(await run("github.skills-repo", withSkills("https://github.com/acme/skills", { repositories: async () => new Map([["skills", repoFacts()]]) }))).toEqual([expect.objectContaining({ state: "pass" })]);
    const missing = await run("github.skills-repo", withSkills("https://github.com/other/skills", { installation: async () => null, publicRepository: async () => ({ status: 404, refExists: null }) }));
    expect(missing).toEqual([expect.objectContaining({ state: "fail", detail: "The skills repository other/skills does not exist, or is private, so its skills never install" })]);
    const limited = await run("github.skills-repo", withSkills("https://github.com/other/skills", { installation: async () => null, publicRepository: async () => ({ status: 403, refExists: null }) }));
    expect(limited).toEqual([expect.objectContaining({ state: "cannot-verify" })]);
  });
});
