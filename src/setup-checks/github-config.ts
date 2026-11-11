/** Checks of the GitHub App and the repositories each project's runs read: the `github` group. */

import type { RepoMapping } from "../config.js";
import { appCredentialsProblem, appCredentialsRefused, CLOCK_SKEW_TOLERANCE_S, type AppIdentityRead } from "../github-app-auth.js";
import { GITHUB_APP_PERMISSIONS, permissionLevelCovers } from "../github-app-permissions.js";
import { GitHubApiError } from "../github-errors.js";
import { appInstallUrl } from "../github-install-state.js";
import type { RepositoryFacts, RepositoryFactsRequest } from "../github.js";
import { githubRepoParts } from "../reference-repos.js";
import { resolveExecutionPath } from "../runner-mode.js";
import { isWorkflowSyncInProgress } from "../workflow-sync-queue.js";
import { buildSyncBranchName } from "../workflow-sync.js";
import type { SetupCheck, SetupCheckContext, SetupCheckOutcome } from "./index.js";

/** The expression naming a workflow file on `branch`, or on GitHub's default branch when `branch` is null. */
export function workflowFileExpression(branch: string | null, file: string): string {
  return `${branch ?? "HEAD"}:.github/workflows/${file}`;
}

/** The workflow files a project's dispatches need: its implementation workflow, and its planning workflow while planning is on. */
export function workflowFiles(mapping: RepoMapping): string[] {
  return [mapping.workflowFile, ...(mapping.planningEnabled && mapping.planningWorkflowFile ? [mapping.planningWorkflowFile] : [])];
}

/**
 * Every repository on `owner` that some project's runs read, with what the checks look up in it.
 * Repository names are lowercased, as GitHub matches them, so a repository read by two projects is asked for once.
 */
export function ownerRepositoryRequests(mappings: Record<string, RepoMapping>, owner: string): RepositoryFactsRequest[] {
  const requests = new Map<string, { expressions: Set<string>; heads: Set<string> }>();
  const ask = (repoOwner: string, repo: string, expressions: string[], heads: string[]) => {
    if (repoOwner.toLowerCase() !== owner.toLowerCase()) return;
    const request = requests.get(repo.toLowerCase()) ?? { expressions: new Set<string>(), heads: new Set<string>() };
    for (const expression of expressions) request.expressions.add(expression);
    for (const head of heads) request.heads.add(head);
    requests.set(repo.toLowerCase(), request);
  };
  for (const mapping of Object.values(mappings)) {
    const files = workflowFiles(mapping).flatMap((file) => [workflowFileExpression(null, file), workflowFileExpression(mapping.defaultBranch, file)]);
    // The bare branch tells a missing branch from a branch that lacks the files.
    const expressions = [mapping.defaultBranch, ...files];
    ask(mapping.owner, mapping.repo, expressions, [buildSyncBranchName(mapping.branchPrefix)]);
    for (const reference of mapping.referenceRepos ?? []) {
      const parts = githubRepoParts(reference.repo);
      if (parts) ask(parts.owner, parts.repo, reference.ref ? [reference.ref] : [], []);
    }
    const skills = mapping.skillsRepo ? githubRepoParts(mapping.skillsRepo) : null;
    if (skills) ask(skills.owner, skills.repo, [], []);
  }
  return [...requests].map(([repo, { expressions, heads }]) => ({ repo, expressions: [...expressions], openPullRequestHeads: [...heads] }));
}

const NO_PROJECT: SetupCheckOutcome[] = [{ state: "not-applicable", detail: "No project is configured" }];

const unreachable = (err: unknown): SetupCheckOutcome => ({
  state: "cannot-verify",
  detail: `The orchestrator could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
  fix: "Check that the orchestrator can reach api.github.com.",
});

/** Why GitHub cannot be asked as the App, in env.github-app's own words, or null when it can. */
function credentialsGate(ctx: SetupCheckContext): SetupCheckOutcome | null {
  const problem = appCredentialsProblem(ctx.env);
  return problem ? { state: "cannot-verify", detail: `${problem}, so GitHub cannot be asked as the App`, fix: "Clear env.github-app first." } : null;
}

/** GitHub's answer to the App's credentials, or the outcome that says why it could not be asked. */
async function readApp(ctx: SetupCheckContext): Promise<{ app: AppIdentityRead } | { outcome: SetupCheckOutcome }> {
  const gate = credentialsGate(ctx);
  if (gate) return { outcome: gate };
  try {
    return { app: await ctx.githubSetupFacts().app() };
  } catch (err) {
    return { outcome: unreachable(err) };
  }
}

/** How far this host's clock runs from GitHub's, in seconds, positive when the host is ahead. Null without GitHub's `Date`. */
function clockSkewSeconds(app: AppIdentityRead): number | null {
  return app.githubTime === null ? null : Math.round((app.localTime - app.githubTime) / 1000);
}

function describeSkew(seconds: number): string {
  const size = Math.abs(seconds);
  return `${size} second${size === 1 ? "" : "s"} ${seconds >= 0 ? "ahead of" : "behind"} GitHub's`;
}

const CLOCK_FIX = "Resync the host clock with NTP (on WSL, run hwclock -s).";

/** What GitHub did when it neither accepted nor refused the App's credentials, a 5xx or a rate limit, so nothing about them is known. */
const unjudged = (app: AppIdentityRead) => `GitHub answered HTTP ${app.status} rather than accepting or refusing the App's credentials`;
const RETRY_FIX = "Run the checks again once GitHub answers normally.";

type AcceptedApp = AppIdentityRead & { slug: string };

/**
 * Judges every project once GitHub accepts the App's credentials, or says in one row why it cannot.
 * `subject` names what the check reads, for that row.
 */
async function judgeProjects(
  ctx: SetupCheckContext,
  subject: string,
  judge: (app: AcceptedApp, mapping: RepoMapping, key: string) => Promise<SetupCheckOutcome>,
): Promise<SetupCheckOutcome[]> {
  const projects = Object.entries(ctx.mappings());
  if (projects.length === 0) return NO_PROJECT;
  const read = await readApp(ctx);
  if ("outcome" in read) return [read.outcome];
  const { app } = read;
  if (app.slug === null) {
    if (!appCredentialsRefused(app)) return [{ state: "cannot-verify", detail: `${unjudged(app)}, so ${subject} cannot be read`, fix: RETRY_FIX }];
    return [{ state: "cannot-verify", detail: `GitHub refused the App's credentials, so ${subject} cannot be read`, fix: "Clear github.app-identity first." }];
  }
  const accepted = { ...app, slug: app.slug };
  return Promise.all(projects.map(async ([key, mapping]): Promise<SetupCheckOutcome> => ({
    ...(await judge(accepted, mapping, key).catch(unreachable)),
    project: key,
  })));
}

const levelLabel = (level: string) => (level === "write" ? "read and write" : "read-only");

/** Why a project's GitHub Actions checks do not apply, or null when its runs dispatch a workflow. */
function notOnGitHubActions(ctx: SetupCheckContext, { owner, repo, executionMode }: RepoMapping, needs: string): SetupCheckOutcome | null {
  const path = resolveExecutionPath(ctx.runnerMode().mode, executionMode);
  if (path === "github-actions" || path === "both") return null;
  return { state: "not-applicable", detail: `${owner}/${repo} runs on ${EXECUTION_PATH_LABEL[path] ?? path}, not GitHub Actions, so it needs no ${needs}` };
}

/** The project's own repository as the App's installation sees it, or the outcome that says why it cannot be read. */
async function projectRepository(ctx: SetupCheckContext, { owner, repo }: RepoMapping): Promise<{ facts: RepositoryFacts } | { outcome: SetupCheckOutcome }> {
  const github = ctx.githubSetupFacts();
  if (!(await github.installation(owner))) {
    return { outcome: { state: "cannot-verify", detail: `The App is not installed on ${owner}, so ${owner}/${repo} cannot be read`, fix: "Clear github.installation first." } };
  }
  let facts;
  try {
    facts = (await github.repositories(owner)).get(repo.toLowerCase());
  } catch (err) {
    if (err instanceof GitHubApiError) return { outcome: { state: "cannot-verify", detail: `GitHub refused to read ${owner}'s repositories for the App (HTTP ${err.status})`, fix: "Clear github.permissions first." } };
    throw err;
  }
  if (!facts?.visible) return { outcome: { state: "cannot-verify", detail: `The App's installation on ${owner} cannot see ${repo}`, fix: "Clear github.installation first." } };
  return { facts };
}

const fileList = (files: string[]) => files.join(" and ");

/** Whether a repository a run reads can be cloned as the run clones it, or a problem or an unread reason when it cannot be said. */
async function cloneable(ctx: SetupCheckContext, owner: string, repo: string, ref?: string): Promise<{ problem?: string; unread?: string }> {
  const github = ctx.githubSetupFacts();
  const name = `${owner}/${repo}`;
  const installation = await github.installation(owner);
  if (!installation) {
    // A run clones it without a token, as for any repository on an owner the App is not installed on.
    const read = await github.publicRepository(owner, repo, ref);
    if (read.status === 404) return { problem: `${name} is private or missing, and the App is not installed on ${owner}` };
    if (read.status !== 200) return { unread: `${name} could not be read (HTTP ${read.status})` };
    return read.refExists === false ? { problem: `${name} has no ref ${ref}` } : {};
  }
  const included = await github.installationRepositories(owner);
  if (included !== null && !included.has(repo.toLowerCase())) return { problem: `${name} is outside the App's installation on ${owner}` };
  const facts = (await github.repositories(owner)).get(repo.toLowerCase());
  if (!facts?.visible) return { problem: `${name} does not exist, or the App cannot see it` };
  return ref && !facts.exists[ref] ? { problem: `${name} has no ref ${ref}` } : {};
}

/** How an operator names each place a run can execute. */
const EXECUTION_PATH_LABEL: Record<string, string> = {
  "github-actions": "GitHub Actions",
  "fly-machines": "Fly Machines",
  "local-docker": "local Docker",
  both: "GitHub Actions and Fly Machines",
};

export const GITHUB_CONFIG_CHECKS: readonly SetupCheck[] = [
  {
    id: "github.app-identity",
    title: "GitHub App identity",
    group: "github",
    tier: "core",
    onAdminPath: false,
    run: async (ctx) => {
      const read = await readApp(ctx);
      if ("outcome" in read) return [read.outcome];
      const { app } = read;
      if (app.slug !== null) return [{ state: "pass", detail: `GitHub accepts the credentials of the App ${app.slug}` }];
      if (!appCredentialsRefused(app)) return [{ state: "cannot-verify", detail: unjudged(app), fix: RETRY_FIX }];
      const skew = clockSkewSeconds(app);
      if (skew !== null && Math.abs(skew) > CLOCK_SKEW_TOLERANCE_S) {
        return [{ state: "fail", detail: `GitHub refused the App's credentials (HTTP ${app.status}) because the host clock is ${describeSkew(skew)}`, fix: CLOCK_FIX }];
      }
      return [{
        state: "fail",
        detail: `GitHub refused the App's ID and private key (HTTP ${app.status}), so every GitHub call fails`,
        fix: "Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY to the App's ID and a private key from its settings on GitHub.",
      }];
    },
  },
  {
    id: "github.clock",
    title: "Host clock",
    group: "github",
    tier: "core",
    onAdminPath: false,
    run: async (ctx) => {
      const read = await readApp(ctx);
      if ("outcome" in read) return [read.outcome];
      const skew = clockSkewSeconds(read.app);
      if (skew === null) return [{ state: "cannot-verify", detail: "GitHub's response carried no Date header, so the host clock cannot be compared with it", fix: "Compare the host clock with an NTP server by hand." }];
      if (Math.abs(skew) > CLOCK_SKEW_TOLERANCE_S) {
        return [{
          state: "fail",
          detail: `The host clock is ${describeSkew(skew)}, more than the ${CLOCK_SKEW_TOLERANCE_S} seconds the App's credentials allow, so GitHub refuses them`,
          fix: CLOCK_FIX,
        }];
      }
      return [{ state: "pass", detail: `The host clock is ${describeSkew(skew)}, within the ${CLOCK_SKEW_TOLERANCE_S} seconds the App's credentials allow` }];
    },
  },
  {
    id: "github.installation",
    title: "GitHub App installation",
    group: "github",
    tier: "core",
    onAdminPath: false,
    run: (ctx) => judgeProjects(ctx, "the App's installations", async (app, { owner, repo }) => {
      const facts = ctx.githubSetupFacts();
      const installation = await facts.installation(owner);
      if (!installation) {
        return {
          state: "fail",
          detail: `The App is not installed on ${owner}, so the orchestrator cannot dispatch to or clone ${owner}/${repo}`,
          fix: `Install the App on ${owner}.`,
          fixUrl: appInstallUrl(app.slug),
        };
      }
      const included = await facts.installationRepositories(owner);
      if (included === null) return { state: "pass", detail: `The App is installed on ${owner} for all of its repositories` };
      if (!included.has(repo.toLowerCase())) {
        return {
          state: "fail",
          detail: `The App's installation on ${owner} does not include ${repo}, so the orchestrator cannot dispatch to or clone it`,
          fix: `Add ${repo} to the App's installation on ${owner}.`,
          fixUrl: appInstallUrl(app.slug),
        };
      }
      return { state: "pass", detail: `The App's installation on ${owner} includes ${repo}` };
    }),
  },
  {
    id: "github.permissions",
    title: "GitHub App permissions",
    group: "github",
    tier: "core",
    onAdminPath: false,
    // No fixUrl: GitHub documents the App's permissions page only as navigation, and only an owner or App manager can open it.
    run: (ctx) => judgeProjects(ctx, "the App's permissions", async (_app, { owner }) => {
      const installation = await ctx.githubSetupFacts().installation(owner);
      if (!installation) return { state: "cannot-verify", detail: `The App is not installed on ${owner}, so its permissions there cannot be read`, fix: "Clear github.installation first." };
      const gaps = GITHUB_APP_PERMISSIONS.filter((p) => !permissionLevelCovers(installation.permissions[p.name], p.level));
      const required = gaps.filter((p) => p.required);
      const shown = required.length > 0 ? required : gaps;
      if (shown.length === 0) return { state: "pass", detail: `The App's installation on ${owner} has every permission the orchestrator uses` };
      return {
        state: required.length > 0 ? "fail" : "warn",
        detail: `The App's installation on ${owner} lacks ${shown.map((p) => `${p.title} (${levelLabel(p.level)})`).join(", ")}. ${shown.map((p) => p.whenMissing).join(" ")}`,
        fix: `An organization owner or a GitHub App manager grants these in the settings of the account that owns the App: Developer settings -> GitHub Apps -> Edit -> Permissions & events. Then an owner of ${owner} approves the new permissions on its installation.`,
      };
    }),
  },
  {
    id: "github.target-secrets",
    title: "App secrets in GitHub Actions",
    group: "github",
    tier: "mode",
    onAdminPath: false,
    run: (ctx) => {
      const projects = Object.entries(ctx.mappings());
      if (projects.length === 0) return NO_PROJECT;
      return projects.map(([key, mapping]): SetupCheckOutcome => {
        const { owner, repo } = mapping;
        const off = notOnGitHubActions(ctx, mapping, "App secrets");
        if (off) return { ...off, project: key };
        return {
          state: "cannot-verify",
          detail: `${owner}/${repo}'s GitHub Actions runs need the AI_IMPLEMENT_APP_ID and AI_IMPLEMENT_PRIVATE_KEY secrets, which the orchestrator has no permission to read`,
          fix: `Check both secrets in ${owner}/${repo}'s Actions secrets, or its organization's, by hand.`,
          project: key,
        };
      });
    },
  },
  {
    id: "github.webhook-signature",
    title: "Webhook signatures",
    group: "github",
    tier: "feature",
    onAdminPath: false,
    run: async (ctx) => {
      if (!ctx.env.GITHUB_WEBHOOK_SECRET) return [{ state: "not-applicable", detail: "GITHUB_WEBHOOK_SECRET is not set, so there is no webhook signature to check" }];
      const gate = credentialsGate(ctx);
      if (gate) return [gate];
      let listed;
      try {
        listed = await ctx.githubSetupFacts().deliveries();
      } catch (err) {
        if (err instanceof GitHubApiError) {
          return [{ state: "cannot-verify", detail: `GitHub refused to list the App's webhook deliveries (HTTP ${err.status}), so their signatures cannot be read`, fix: "Clear github.app-identity first." }];
        }
        return [unreachable(err)];
      }
      const partly = listed.endedEarlyWith === null ? "" : ` (GitHub ended the list early with HTTP ${listed.endedEarlyWith})`;
      const total = listed.deliveries.length;
      if (total === 0) return [{ state: "pass", detail: `The App received no webhook deliveries in the last day${partly}` }];
      const refused = listed.deliveries.filter((d) => d.status_code === 401).length;
      if (refused > 0) {
        return [{
          state: "warn",
          detail: `${refused} of the App's ${total} webhook deliveries in the last day did not match GITHUB_WEBHOOK_SECRET (HTTP 401), so the orchestrator ignored those events${partly}`,
          fix: "Set the same secret as GITHUB_WEBHOOK_SECRET and in the App's webhook settings on GitHub.",
        }];
      }
      return [{ state: "pass", detail: `None of the App's ${total} webhook deliveries in the last day failed the GITHUB_WEBHOOK_SECRET check${partly}` }];
    },
  },
  {
    id: "github.kg-grants",
    title: "Knowledge graph refresh access",
    group: "github",
    tier: "feature",
    onAdminPath: false,
    run: async (ctx) => {
      if (!ctx.env.KG_SOURCE_REPO?.trim()) return [{ state: "not-applicable", detail: "KG_SOURCE_REPO is not set, so the App needs no knowledge graph access" }];
      if (!ctx.githubSetupFacts().kgSourceRepo()) {
        return [{ state: "fail", detail: "KG_SOURCE_REPO is not an owner/repo repository name, so the knowledge graph cannot be refreshed", fix: "Set KG_SOURCE_REPO to the knowledge graph repository as owner/repo." }];
      }
      const gate = credentialsGate(ctx);
      if (gate) return [gate];
      let preflight;
      try {
        preflight = await ctx.githubSetupFacts().kgPreflight();
      } catch (err) {
        return [unreachable(err)];
      }
      if (preflight === null) return [{ state: "not-applicable", detail: "KG_SOURCE_REPO is not set, so the App needs no knowledge graph access" }];
      const failing = preflight.results.filter((r) => !r.ok);
      if (failing.length === 0) {
        const repos = new Set(preflight.results.map((r) => r.repo)).size;
        return [{ state: "pass", detail: `The App has every access the knowledge graph refresh needs, across ${repos} repositories` }];
      }
      return [{
        state: "fail",
        detail: `The App lacks access the knowledge graph refresh needs, so a refresh is refused: ${failing.map((r) => `${r.repo} ${r.grant} (HTTP ${r.status})${r.hint ? `, ${r.hint}` : ""}`).join(", ")}`,
        fix: "Give the App the access each listed repository needs on GitHub, or remove the repository from sources.yml.",
      }];
    },
  },
  {
    id: "github.workflow-default-branch",
    title: "Workflow files on the default branch",
    group: "github",
    tier: "mode",
    onAdminPath: false,
    run: (ctx) => judgeProjects(ctx, "the projects' workflow files", async (_app, mapping, key) => {
      const { owner, repo } = mapping;
      const off = notOnGitHubActions(ctx, mapping, "workflow files");
      if (off) return off;
      const read = await projectRepository(ctx, mapping);
      if ("outcome" in read) return read.outcome;
      const { facts } = read;
      const branch = facts.defaultBranch ?? "its default branch";
      const files = workflowFiles(mapping);
      const missing = files.filter((file) => !facts.exists[workflowFileExpression(null, file)]);
      const pr = facts.openPullRequests[buildSyncBranchName(mapping.branchPrefix)] ?? null;
      if (missing.length === 0) {
        if (pr) {
          return {
            state: "warn",
            detail: `${owner}/${repo} has ${fileList(files)} on ${branch}, and workflow sync pull request #${pr.number} still carries changes to them`,
            fix: `Merge pull request #${pr.number}.`,
            fixUrl: pr.url,
          };
        }
        return { state: "pass", detail: `${owner}/${repo} has ${fileList(files)} on ${branch}, where GitHub dispatches them from` };
      }
      const lead = `${owner}/${repo} lacks ${fileList(missing)} on its default branch ${branch}, so GitHub refuses to dispatch ${missing.length === 1 ? "it" : "them"}`;
      if (facts.defaultBranch !== null && mapping.defaultBranch !== facts.defaultBranch && missing.every((file) => facts.exists[workflowFileExpression(mapping.defaultBranch, file)])) {
        return {
          state: "fail",
          detail: `${lead}. They are on the project's branch ${mapping.defaultBranch}, but GitHub dispatches only workflows on the default branch`,
          fix: `Merge the workflow files from ${mapping.defaultBranch} into ${branch}, or set the project's Default Branch at /admin#projects to ${branch}.`,
        };
      }
      const sync = ctx.githubSetupFacts().workflowSync(key);
      if (sync && isWorkflowSyncInProgress(sync)) {
        return { state: "fail", detail: `${lead}. A workflow sync for this project is in progress`, fix: "Wait for the sync to open its pull request, then merge it." };
      }
      if (sync?.status === "failed" && sync.error) {
        return { state: "fail", detail: `${lead}. The last workflow sync failed: ${sync.error.message}`, fix: "Correct what the failed sync names, then click Sync workflows on the project's row at /admin#projects." };
      }
      if (pr) return { state: "fail", detail: `${lead}. Workflow sync pull request #${pr.number} carries them`, fix: `Merge pull request #${pr.number}.`, fixUrl: pr.url };
      return { state: "fail", detail: `${lead}, and no workflow sync pull request is open`, fix: "Click Sync workflows on the project's row at /admin#projects, then merge the pull request it opens." };
    }),
  },
  {
    id: "github.workflow-mapping-branch",
    title: "Workflow files on the project's branch",
    group: "github",
    tier: "mode",
    onAdminPath: false,
    run: (ctx) => judgeProjects(ctx, "the projects' branches", async (_app, mapping) => {
      const { owner, repo, defaultBranch: branch } = mapping;
      const off = notOnGitHubActions(ctx, mapping, "workflow files");
      if (off) return off;
      const read = await projectRepository(ctx, mapping);
      if ("outcome" in read) return read.outcome;
      const { facts } = read;
      if (facts.defaultBranch === null || branch === facts.defaultBranch) {
        return { state: "not-applicable", detail: `${owner}/${repo}'s project branch is its default branch, which github.workflow-default-branch checks` };
      }
      if (!facts.exists[branch]) {
        return {
          state: "fail",
          detail: `The project's branch ${branch} does not exist in ${owner}/${repo}, so its dispatches and clones fail`,
          fix: `Set the project's Default Branch at /admin#projects to a branch that exists, such as ${facts.defaultBranch}.`,
        };
      }
      const missing = workflowFiles(mapping).filter((file) => !facts.exists[workflowFileExpression(branch, file)]);
      if (missing.length === 0) return { state: "pass", detail: `${owner}/${repo}'s project branch ${branch} differs from its default branch ${facts.defaultBranch} and has the workflow files dispatches run` };
      return {
        state: "fail",
        detail: `${owner}/${repo}'s project branch ${branch} differs from its default branch ${facts.defaultBranch} and lacks ${fileList(missing)}, so dispatches to it fail`,
        fix: `Merge the workflow files into ${branch}, or set the project's Default Branch at /admin#projects to ${facts.defaultBranch}.`,
      };
    }),
  },
  {
    id: "github.reference-repos",
    title: "Reference repositories",
    group: "github",
    tier: "feature",
    onAdminPath: false,
    run: (ctx) => judgeProjects(ctx, "the projects' reference repositories", async (_app, { owner, repo, referenceRepos }) => {
      const entries = (referenceRepos ?? []).map((entry) => ({ entry, parts: githubRepoParts(entry.repo) }));
      if (entries.length === 0) return { state: "not-applicable", detail: `${owner}/${repo} reads no reference repositories` };
      const results = await Promise.all(entries.map(({ entry, parts }) =>
        parts ? cloneable(ctx, parts.owner, parts.repo, entry.ref).catch((err) => ({ unread: `${entry.repo} could not be read: ${err instanceof Error ? err.message : String(err)}` }))
          : Promise.resolve({ problem: `${entry.repo} is not a GitHub repository` })));
      const problems = results.flatMap((r) => ("problem" in r && r.problem ? [r.problem] : []));
      const unread = results.flatMap((r) => ("unread" in r && r.unread ? [r.unread] : []));
      if (problems.length > 0) {
        return {
          state: "fail",
          detail: `Runs of ${owner}/${repo} cannot clone ${problems.length} of its ${entries.length} reference repositories: ${problems.join(", ")}`,
          fix: "Add each repository to the App's installation or make it public, and correct each ref named, under Reference Repositories at /admin#projects.",
        };
      }
      if (unread.length > 0) return { state: "cannot-verify", detail: `Some of ${owner}/${repo}'s reference repositories could not be read: ${unread.join(", ")}`, fix: "Check that the orchestrator can reach api.github.com." };
      return { state: "pass", detail: `Runs of ${owner}/${repo} can clone all ${entries.length} of its reference repositories` };
    }),
  },
  {
    id: "github.skills-repo",
    title: "Skills repository",
    group: "github",
    tier: "feature",
    onAdminPath: false,
    run: (ctx) => judgeProjects(ctx, "the projects' skills repositories", async (_app, { owner, repo, skillsRepo }) => {
      if (!skillsRepo) return { state: "not-applicable", detail: `${owner}/${repo} has no skills repository` };
      const parts = githubRepoParts(skillsRepo);
      if (!parts) return { state: "fail", detail: `${skillsRepo} is not a GitHub repository, so no skills install`, fix: "Correct the project's Skills Repo at /admin#projects." };
      const name = `${parts.owner}/${parts.repo}`;
      if (name.toLowerCase() === `${owner}/${repo}`.toLowerCase()) return { state: "pass", detail: `${owner}/${repo}'s skills come from its own repository, which every run can clone` };
      // A run clones the skills repository with a token for the project's own repository, which reads public repositories only besides it.
      const github = ctx.githubSetupFacts();
      let visibility: "public" | "private" | "missing" | { unread: number };
      if (await github.installation(parts.owner)) {
        const facts = (await github.repositories(parts.owner)).get(parts.repo.toLowerCase());
        visibility = !facts?.visible ? "missing" : facts.private ? "private" : "public";
      } else {
        const read = await github.publicRepository(parts.owner, parts.repo);
        visibility = read.status === 200 ? "public" : read.status === 404 ? "missing" : { unread: read.status };
      }
      if (visibility === "public") return { state: "pass", detail: `The skills repository ${name} is public, so every run can clone it` };
      if (visibility === "private") {
        return {
          state: "fail",
          detail: `The skills repository ${name} is private, and runs clone it with a token for ${owner}/${repo} alone, so its skills never install`,
          fix: `Make ${name} public, or keep the skills in ${owner}/${repo}.`,
        };
      }
      if (visibility === "missing") return { state: "fail", detail: `The skills repository ${name} does not exist, or is private, so its skills never install`, fix: "Correct the project's Skills Repo at /admin#projects, or make the repository public." };
      return { state: "cannot-verify", detail: `The skills repository ${name} could not be read (HTTP ${visibility.unread})`, fix: "Check that the orchestrator can reach api.github.com." };
    }),
  },
];
