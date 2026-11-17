/**
 * Orchestrator setup checks: read-only checks of an orchestrator's setup, each naming its fix.
 *
 * This module holds the list, the context every caller starts from and the runner, with a project's own run and the stored
 * run's merge. The contract a check is written against (the check ids, a result, the context a check reads) is contract.ts,
 * re-exported here. The checks sit beside it, one module per group, each named `<group>-config.ts`:
 * `orchestrator-config.ts` holds the orchestrator's own environment and settings checks.
 */

import { getOrchestratorDefaults, getProjectStageConfig } from "../agent-config-store.js";
import { statSync } from "node:fs";
import { isAllowlistReadAvailable, getEffectiveAllowlist, listAccessEntries } from "../access-entries.js";
import { getMappings, type RepoMapping } from "../config.js";
import { getDatabasePath, getDb } from "../dedup.js";
import { readKgSourceRepo } from "../deploy.js";
import { getAppInstallation, getScopedInstallationToken, listInstallationRepositoryNames, readAppIdentity } from "../github-app-auth.js";
import { readPublicRepository, readRepositoryFacts } from "../github.js";
import { ORCHESTRATOR_INSTANCE_ID, readOrchestratorHealth, type HealthSetupChecks } from "../health-body.js";
import { runKgRefreshPreflight } from "../kg-refresh.js";
import { getRunnerBackendSource, getFlySessionsConfig, getOrchestratorSettings } from "../orchestrator-settings.js";
import { providerConfigFromEnv, ProviderRegistry } from "../providers/index.js";
import type { TrackerSetupFacts } from "../providers/types.js";
import { getRunnerMode } from "../runner-mode.js";
import { listRecentAppDeliveries } from "../webhook-redelivery.js";
import { getWorkflowSyncByTeam } from "../workflow-sync-queue.js";
import type { GitHubSetupFacts, SetupCheck, SetupCheckContext, SetupCheckId, SetupCheckResult } from "./contract.js";
import { GITHUB_CONFIG_CHECKS, ownerRepositoryRequests } from "./github-config.js";
import { isAdminPathConfigured, ORCHESTRATOR_CONFIG_CHECKS } from "./orchestrator-config.js";
import { TRACKER_CONFIG_CHECKS } from "./tracker-config.js";

export * from "./contract.js";

/** How each group is named to an operator. The keys stay as they are, since stored runs and their readers use them. */
export const SETUP_CHECK_GROUP_LABELS: Record<SetupCheckResult["group"], string> = {
  orchestrator: "Orchestrator",
  tracker: "Ticketing system",
  github: "GitHub",
  model: "Models",
};

/** The setup command as an operator runs it against this orchestrator: over SSH on Fly, which sets FLY_APP_NAME, else from the checkout. */
export function setupCommandFor(env: NodeJS.ProcessEnv): string {
  return env.FLY_APP_NAME ? `fly ssh console -a ${env.FLY_APP_NAME} -C "node /app/dist/check-setup.js"` : "npm run check-setup";
}

export interface SetupCheckRun {
  startedAt?: number;      // when the run began; absent on a run an older orchestrator stored
  checkedAt: number;       // when its last check finished
  results: SetupCheckResult[];
}

/** A run as every allowlisted identity may see it on `get_tenant_health`: each row's identity and state, never its detail or fix (ADR 047). */
export interface SetupCheckSummary {
  checkedAt: number;
  failingCore: number;
  rows: Array<Pick<SetupCheckResult, "id" | "title" | "state" | "project">>;
}

/** The production reads behind `githubSetupFacts`, each memoized by its arguments. */
function createGitHubSetupFacts(ctx: SetupCheckContext): GitHubSetupFacts {
  const reads = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    let pending = reads.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = read();
      reads.set(key, pending);
    }
    return pending;
  };
  const app = () => {
    const appId = ctx.env.GITHUB_APP_ID;
    const privateKey = ctx.env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !privateKey) throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are not both set");
    return { appId, privateKey };
  };
  // Reads only, with the least the repository reads need.
  const ownerToken = (owner: string) => once(`token:${owner.toLowerCase()}`, async () => {
    const { appId, privateKey } = app();
    const minted = await getScopedInstallationToken(appId, privateKey, owner, { permissions: { contents: "read", pull_requests: "read", metadata: "read" } });
    return minted.token;
  });
  const facts: GitHubSetupFacts = {
    app: () => once("app", async () => {
      const { appId, privateKey } = app();
      return readAppIdentity(appId, privateKey);
    }),
    installation: (owner) => once(`installation:${owner.toLowerCase()}`, async () => {
      const { appId, privateKey } = app();
      return getAppInstallation(appId, privateKey, owner);
    }),
    installationRepositories: (owner) => once(`installation-repositories:${owner.toLowerCase()}`, async () => {
      const installation = await facts.installation(owner);
      if (!installation) throw new Error(`The GitHub App is not installed on ${owner}`);
      return installation.repository_selection === "all" ? null : listInstallationRepositoryNames(await ownerToken(owner));
    }),
    repositories: (owner) => once(`repositories:${owner.toLowerCase()}`, async () =>
      readRepositoryFacts(await ownerToken(owner), owner, ownerRepositoryRequests(ctx.mappings(), owner))),
    publicRepository: (owner, repo, ref) => once(`public:${owner.toLowerCase()}/${repo.toLowerCase()}@${ref ?? ""}`, () =>
      readPublicRepository(owner, repo, ref)),
    deliveries: () => once("deliveries", async () => listRecentAppDeliveries(app())),
    kgSourceRepo: () => readKgSourceRepo(ctx.env.KG_SOURCE_REPO, () => {}),
    kgPreflight: () => once("kg-preflight", async () => {
      const kgSourceRepo = facts.kgSourceRepo();
      if (!kgSourceRepo) return null;
      const { appId, privateKey } = app();
      return runKgRefreshPreflight({ githubAppId: appId, githubAppPrivateKey: privateKey, kgSourceRepo, kgBaseRepo: getOrchestratorSettings().kgBaseRepo });
    }),
    workflowSync: getWorkflowSyncByTeam,
  };
  return facts;
}

/**
 * The context every caller starts from. A caller overrides only what it reads differently: the
 * setup command runs in its own process, so the server's Fly sessions cache is not its own.
 * The Restate status has no default, since its reader depends on where the caller runs.
 */
export function createSetupCheckContext(
  overrides: Partial<SetupCheckContext> & Pick<SetupCheckContext, "restateStatus">,
): SetupCheckContext {
  const registry = new ProviderRegistry(providerConfigFromEnv(), () => ctx.mappings());
  const setupFacts = new Map<string, Promise<TrackerSetupFacts | null>>();
  let githubFacts: GitHubSetupFacts | undefined;
  let projects: Record<string, RepoMapping> | undefined;
  const ctx: SetupCheckContext = {
    env: process.env,
    // A database error throws, so the check reports cannot-verify instead of reading a missing row.
    readSetting: (key) =>
      (getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null,
    orchestratorDefaults: getOrchestratorDefaults,
    projectStageConfig: getProjectStageConfig,
    runnerMode: getRunnerMode,
    flySessions: getFlySessionsConfig,
    runnerBackendSource: getRunnerBackendSource,
    // Read once, so every check in a run judges the same projects even when one is saved mid-run.
    mappings: () => (projects ??= getMappings()),
    storedAccessEntries: listAccessEntries,
    effectiveAllowlist: getEffectiveAllowlist,
    allowlistReadAvailable: isAllowlistReadAvailable,
    databasePath: getDatabasePath,
    onSeparateFilesystem: (dir) => statSync(dir).dev !== statSync("/").dev,
    trackerProvider: async (providerId) => {
      const mapping = Object.values(ctx.mappings()).find((m) => m.ticketingProvider === providerId);
      if (!mapping) throw new Error(`No project uses the ${providerId} ticketing system`);
      return registry.forMapping(mapping);
    },
    // Every check that judges one provider's facts shares a single read per run.
    trackerSetupFacts: (providerId) => {
      let read = setupFacts.get(providerId);
      if (!read) {
        read = ctx.trackerProvider(providerId).then((provider) => {
          if (!provider.fetchSetupFacts) return null;
          const teams = Object.entries(ctx.mappings()).filter(([, m]) => m.ticketingProvider === providerId).map(([key]) => key);
          return provider.fetchSetupFacts(teams);
        });
        setupFacts.set(providerId, read);
      }
      return read;
    },
    githubSetupFacts: () => (githubFacts ??= createGitHubSetupFacts(ctx)),
    orchestratorHealthAt: (baseUrl) => readOrchestratorHealth(baseUrl),
    orchestratorInstanceId: () => ORCHESTRATOR_INSTANCE_ID,
    ...overrides,
  };
  return ctx;
}

export const SETUP_CHECKS: readonly SetupCheck[] = [...ORCHESTRATOR_CONFIG_CHECKS, ...TRACKER_CONFIG_CHECKS, ...GITHUB_CONFIG_CHECKS];

/**
 * Runs every check at once and answers them in list order. A check that throws reports `cannot-verify` with its error,
 * and the others still run. `onSettled` hears each check's rows the moment that check finishes.
 */
export async function runSetupChecks(
  ctx: SetupCheckContext,
  checks: readonly SetupCheck[] = SETUP_CHECKS,
  now: () => number = Date.now,
  onSettled: (id: SetupCheckId, rows: SetupCheckResult[]) => void = () => {},
): Promise<SetupCheckRun> {
  const startedAt = now();
  const rows = await Promise.all(checks.map(async (check) => {
    const identity = {
      id: check.id,
      title: check.title,
      group: check.group,
      tier: check.tier,
      onAdminPath: check.onAdminPath,
      ...(check.verifiable ? {} : { verifiable: false as const }),
    };
    let settled: SetupCheckResult[];
    try {
      settled = (await check.run(ctx)).map((outcome) => ({ ...identity, ...outcome }));
    } catch (error) {
      settled = [{
        ...identity,
        state: "cannot-verify",
        detail: error instanceof Error ? error.message : String(error),
        fix: "The check itself could not run, its detail names the error.",
      }];
    }
    onSettled(check.id, settled);
    return settled;
  }));
  return { startedAt, checkedAt: now(), results: rows.flat() };
}

/** The orchestrator-wide checks every project's rows depend on, run beside them. */
const PROJECT_RUN_DEPENDENCIES: readonly SetupCheckId[] = ["tracker.provider", "github.app-identity", "github.clock"];
/** The checks no project passes before its first workflow sync, which a run before the save leaves out. */
export const BEFORE_FIRST_SYNC: readonly SetupCheckId[] = ["github.workflow-default-branch", "github.workflow-mapping-branch"];
/** The credentials check of each ticketing system that has one. */
const CREDENTIALS_CHECK: Partial<Record<string, SetupCheckId>> = { linear: "tracker.linear.credentials", jira: "tracker.jira.credentials" };

/**
 * Runs one project's checks and the orchestrator-wide checks they depend on. `ctx.mappings()` must answer that project alone,
 * so every read is that project's. A per-project check that threw answers one row with no project, which here is the project's.
 */
export async function runProjectSetupChecks(
  ctx: SetupCheckContext,
  key: string,
  exclude: readonly SetupCheckId[] = [],
  now: () => number = Date.now,
): Promise<SetupCheckRun> {
  const projects = Object.keys(ctx.mappings());
  if (projects.length !== 1 || projects[0] !== key) throw new Error(`A run for ${key} needs a context holding that project alone`);
  const credentials = CREDENTIALS_CHECK[ctx.mappings()[key].ticketingProvider];
  const checks = SETUP_CHECKS.filter((check) => !exclude.includes(check.id)
    && (check.perProject || check.id === credentials || PROJECT_RUN_DEPENDENCIES.includes(check.id)));
  const run = await runSetupChecks(ctx, checks, now);
  return { ...run, results: run.results.map((row) => (row.project === undefined && checks.some((check) => check.id === row.id && check.perProject) ? { ...row, project: key } : row)) };
}

/**
 * Whether a project run found an orchestrator-wide check its rows depend on failing or unread. Such a fault reaches every project
 * that shares the check, whose stored rows a project run cannot correct, so the run is answered by a full run instead.
 */
export function projectRunNeedsFullRun(run: SetupCheckRun): boolean {
  return run.results.some((row) => row.project === undefined && (row.state === "fail" || row.state === "cannot-verify"));
}

/**
 * The stored run with one project's rows, and the orchestrator-wide rows the project run read afresh, replaced by the project run's,
 * each dated by that run. So a project row that points at a failed dependency points at that dependency's current row.
 * tracker.provider keeps its stored row: it names every project on a provider, and a project run's names one. With no stored run, the whole project run starts one.
 */
export function mergeProjectRun(stored: SetupCheckRun | null, key: string, run: SetupCheckRun): SetupCheckRun {
  const dated = (row: SetupCheckResult): SetupCheckResult => ({ ...row, checkedAt: run.checkedAt });
  if (stored === null) return { checkedAt: run.checkedAt, results: run.results.map(dated) };
  const rows = run.results.filter((row) => row.project === key || (row.project === undefined && row.id !== "tracker.provider")).map(dated);
  const refreshed = new Set(rows.filter((row) => row.project === undefined).map((row) => row.id));
  const kept = stored.results.filter((row) => row.project !== key && !(row.project === undefined && refreshed.has(row.id)));
  return { ...stored, results: [...kept, ...rows] };
}

/** The run in progress in this process, as the admin Setup page shows it while it runs. */
export interface SetupCheckProgress {
  startedAt: number;
  total: number;                // checks in the run
  finished: SetupCheckResult[]; // the rows of every check that has finished
  running: Array<Pick<SetupCheckResult, "id" | "title" | "group">>; // the checks still running, named as the page names them
}

let progress: SetupCheckProgress | null = null;

function newProgress(now: () => number): SetupCheckProgress {
  return { startedAt: now(), total: SETUP_CHECKS.length, finished: [], running: SETUP_CHECKS.map(({ id, title, group }) => ({ id, title, group })) };
}

/**
 * Claims the next run for a caller about to start one, by showing it as started before it is sent.
 * Answers the run already going, or null when the claim is the caller's. Two starts cannot both find no run going.
 */
export function claimSetupCheckRun(now: () => number = Date.now): SetupCheckProgress | null {
  if (progress !== null) return structuredClone(progress);
  progress = newProgress(now);
  return null;
}

/** Runs every check, recording each check's rows in this process as it finishes, until `endSetupCheckProgress`. */
export function runSetupChecksWithProgress(ctx: SetupCheckContext, now: () => number = Date.now): Promise<SetupCheckRun> {
  // A retried run starts its own record, so a superseded run's late checks never write into it.
  const current = newProgress(now);
  progress = current;
  return runSetupChecks(ctx, SETUP_CHECKS, now, (id, rows) => {
    current.finished.push(...rows);
    current.running = current.running.filter((running) => running.id !== id);
  });
}

export function getSetupCheckProgress(): SetupCheckProgress | null {
  return progress === null ? null : structuredClone(progress);
}

/** Called once the finished run is recorded, so a reader always sees the run or its progress, or when a claimed run was never sent. */
export function endSetupCheckProgress(): void {
  progress = null;
}

/** The core rows in state `fail`: what the setup command's exit code, its last line and every summary count. */
export function countFailingCore(run: SetupCheckRun): number {
  return run.results.filter((result) => result.tier === "core" && result.state === "fail").length;
}

/** The run as every allowlisted identity may see it, or null before the first run. */
export function summarizeSetupChecks(run: SetupCheckRun | null): SetupCheckSummary | null {
  if (!run) return null;
  return {
    checkedAt: run.checkedAt,
    failingCore: countFailingCore(run),
    rows: run.results.map(({ id, title, state, project }) => ({ id, title, state, ...(project === undefined ? {} : { project }) })),
  };
}

/**
 * The run as anyone may see it on `GET /`: the last run's time and failing core count, plus, while no admin path is
 * configured, the ids of the failing admin-path checks, run afresh on each call (ADR 047's bootstrap mode).
 */
export async function setupChecksHealthField(run: SetupCheckRun | null, ctx: SetupCheckContext): Promise<HealthSetupChecks> {
  const field: HealthSetupChecks = { checkedAt: run?.checkedAt ?? null, failingCore: run === null ? null : countFailingCore(run) };
  if (!isAdminPathConfigured(ctx)) {
    const live = await runSetupChecks(ctx, ORCHESTRATOR_CONFIG_CHECKS.filter((check) => check.onAdminPath));
    field.failingOnAdminPath = live.results.filter((row) => row.state === "fail").map((row) => row.id);
  }
  return field;
}

// Process-local health snapshot, independent of Restate availability.
let lastRun: SetupCheckRun | null = null;
export function recordSetupCheckRun(run: SetupCheckRun): void {
  lastRun = structuredClone(run);
}
export function getLastSetupCheckRun(): SetupCheckRun | null {
  return lastRun === null ? null : structuredClone(lastRun);
}
