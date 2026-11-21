/**
 * Orchestrator setup checks: read-only checks of an orchestrator's setup, each naming its fix.
 *
 * This module holds the list, the context every caller starts from and the runner, with a project's own run and the stored
 * run's merge, the scoped runs a recheck makes, and boot's runs. The contract a check is written against (the check ids, a result,
 * the context a check reads) is contract.ts, re-exported here. The change detector, which sends runs after a saved change, is
 * change-detector.ts. How a runtime failure names its checks and asks for a recheck is recheck.ts, which reads no check, so any
 * runtime path imports it without this module's imports. The checks sit beside this module, one module per group, each named `<group>-config.ts`:
 * `orchestrator-config.ts` holds the orchestrator's own environment and settings checks.
 */

import { getOrchestratorDefaults, getProjectStageConfig } from "../agent-config-store.js";
import { createHash } from "node:crypto";
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
import { NEEDS_ATTENTION, type GitHubSetupFacts, type GitHubSetupReader, type SetupCheck, type SetupCheckContext, type SetupCheckId, type SetupCheckReader, type SetupCheckResult } from "./contract.js";
import { RECHECK_HOLD_MS, recheckKey } from "./recheck.js";
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
  scope?: SetupCheckScope; // set by a run narrower than a full one: the stored rows it answers for
  checkListFingerprint?: string; // the check list's fingerprint in the process that ran it; the stored run keeps its full run's; absent on a run an older orchestrator stored
}

/**
 * The stored rows a partial run answers for: its checks' rows, limited to the given projects when it names some.
 * A row with no project, of a check every project shares, is answered by any run of that check.
 */
export interface SetupCheckScope {
  checks: readonly SetupCheckId[];
  projects?: readonly string[];
}

/** A run the SetupChecks object takes: every check, the orchestrator-wide checks, or one project's checks. */
export type SetupCheckRunKind = { kind: "full" } | { kind: "orchestrator-wide" } | { kind: "project"; project: string };

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
 * A hash of what every check on a check list declares, in list order, which changes when a check is added, removed or declared differently.
 * Each check's `run` is left out, as `JSON.stringify` leaves out every function, so a change to how a check judges does not change it.
 */
export function fingerprintCheckList(checks: readonly SetupCheck[]): string {
  return createHash("sha256").update(JSON.stringify(checks)).digest("hex").slice(0, 16);
}

const CHECK_LIST_FINGERPRINT = fingerprintCheckList(SETUP_CHECKS);

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
  return { startedAt, checkedAt: now(), results: rows.flat(), checkListFingerprint: CHECK_LIST_FINGERPRINT };
}

/** The checks whose rows no one project owns, in list order. */
const ORCHESTRATOR_WIDE_CHECK_IDS: ReadonlySet<SetupCheckId> = new Set(SETUP_CHECKS.filter((check) => !check.perProject).map((check) => check.id));
/** The orchestrator-wide checks per-project checks' rows can wait on, so a change to one reaches every project that shares it. */
const SHARED_DEPENDENCIES: ReadonlySet<SetupCheckId> = new Set(SETUP_CHECKS.filter((check) => check.perProject)
  .flatMap((check) => check.waitsOnChecks ?? [])
  .filter((id) => ORCHESTRATOR_WIDE_CHECK_IDS.has(id)));
/** The checks no project passes before its first workflow sync, which a run before the save leaves out. */
export const BEFORE_FIRST_SYNC: readonly SetupCheckId[] = ["github.workflow-default-branch", "github.workflow-mapping-branch"];
/** The credentials check of each ticketing system that has one. */
const CREDENTIALS_CHECK: Partial<Record<string, SetupCheckId>> = { linear: "tracker.linear.credentials", jira: "tracker.jira.credentials" };
/** Orchestrator-wide checks a project's run adds though no row waits on them: the host clock explains an App identity failure. */
const PROJECT_RUN_DIAGNOSTICS: readonly SetupCheckId[] = ["github.clock"];

/** The orchestrator-wide checks a project's run refreshes: those its per-project checks wait on, for its own ticketing system, and the diagnostics. */
function projectRunDependencies(provider: string): ReadonlySet<SetupCheckId> {
  const othersCredentials = Object.entries(CREDENTIALS_CHECK).filter(([id]) => id !== provider).map(([, check]) => check);
  return new Set([...[...SHARED_DEPENDENCIES].filter((id) => !othersCredentials.includes(id)), ...PROJECT_RUN_DIAGNOSTICS]);
}

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
  const dependencies = projectRunDependencies(ctx.mappings()[key].ticketingProvider);
  const checks = SETUP_CHECKS.filter((check) => !exclude.includes(check.id) && (check.perProject || dependencies.has(check.id))).map((check) => check.id);
  const run = await runSetupChecksInScope(ctx, { checks, projects: [key] }, now);
  // tracker.provider runs only so a failing provider escalates: its stored row names every project on the provider, and this run's names one.
  return { ...run, scope: { checks: checks.filter((id) => id !== "tracker.provider"), projects: [key] } };
}

/**
 * Runs every check whose rows no one project owns: the orchestrator's own, each ticketing system's credentials, the App's.
 * The credentials checks judge only whether a ticketing system accepts the app, which a read for no project answers, so no project's setup is read.
 */
export async function runOrchestratorWideSetupChecks(ctx: SetupCheckContext, now: () => number = Date.now): Promise<SetupCheckRun> {
  // Only each ticketing system's own credentials check reads its facts here, so there is no read to share.
  const credentialsOnly: SetupCheckContext["trackerSetupFacts"] = (providerId) =>
    ctx.trackerProvider(providerId).then((provider) => provider.fetchSetupFacts?.([]) ?? null);
  return runSetupChecksInScope({ ...ctx, trackerSetupFacts: credentialsOnly }, { checks: [...ORCHESTRATOR_WIDE_CHECK_IDS] }, now);
}

/**
 * Runs the checks a scope names and answers them as a partial run with that scope. A scope naming projects needs a context whose
 * `ctx.mappings()` answers those projects alone, and with one project, a per-project row with no project, from a check that threw, is that project's.
 */
export async function runSetupChecksInScope(ctx: SetupCheckContext, scope: SetupCheckScope, now: () => number = Date.now): Promise<SetupCheckRun> {
  const checks = SETUP_CHECKS.filter((check) => scope.checks.includes(check.id));
  const run = await runSetupChecks(ctx, checks, now);
  const only = scope.projects?.length === 1 ? scope.projects[0] : undefined;
  const results = only === undefined ? run.results
    : run.results.map((row) => (row.project === undefined && !ORCHESTRATOR_WIDE_CHECK_IDS.has(row.id) ? { ...row, project: only } : row));
  return { ...run, results, scope };
}

/** The scope of a recheck: one project's rows of a per-project check given one, else every row of the check. Null for a check not on the list. */
export function recheckScope(id: string, project?: string): SetupCheckScope | null {
  const check = SETUP_CHECKS.find((candidate) => candidate.id === id);
  if (!check) return null;
  return check.perProject && project !== undefined ? { checks: [check.id], projects: [project] } : { checks: [check.id] };
}


/**
 * Whether a recheck does nothing, so a failure path that fires on every poll runs its check at most once an hour: a recheck of the same rows
 * ran within the hour (`lastRecheckAt`), or every stored row of them already needs attention and was checked within the hour.
 */
export function recheckHeld(stored: SetupCheckRun | null, scope: SetupCheckScope, lastRecheckAt: number | undefined, now: number): boolean {
  if (lastRecheckAt !== undefined && now - lastRecheckAt < RECHECK_HOLD_MS) return true;
  if (stored === null) return false;
  const rows = stored.results.filter((row) => inScope(row, scope));
  return rows.length > 0 && rows.every((row) => NEEDS_ATTENTION.includes(row.state) && now - (row.checkedAt ?? stored.checkedAt) < RECHECK_HOLD_MS);
}

/** The checks a run's rows wait on, in the order the rows name them. */
const checksWaitedOn = (run: SetupCheckRun): SetupCheckId[] => run.results.flatMap((row) => (row.waitsOnCheck ? [row.waitsOnCheck] : []));

/**
 * Rechecks each check a rechecked run's rows wait on, and each check those rows wait on in turn, since a dependency's read can find what
 * the first read did not. `rerun` answers a dependency's run, or null when it did not run. Each scope runs at most once, so the chain ends
 * whatever the hold or the checks' `waitsOnCheck` become.
 */
export async function recheckChecksWaitedOn(
  scope: SetupCheckScope,
  run: SetupCheckRun,
  rerun: (dependency: SetupCheckScope, waited: SetupCheckId) => Promise<SetupCheckRun | null>,
): Promise<void> {
  const rechecked = new Set([recheckKey(scope)]);
  const toRecheck = checksWaitedOn(run);
  for (let waited = toRecheck.shift(); waited !== undefined; waited = toRecheck.shift()) {
    const dependency = recheckScope(waited, scope.projects?.[0])!;
    if (rechecked.has(recheckKey(dependency))) continue;
    rechecked.add(recheckKey(dependency));
    const answered = await rerun(dependency, waited);
    if (answered !== null) toRecheck.push(...checksWaitedOn(answered));
  }
}

type BeforeRestateReader = "readable" | { leftOut: string };

/**
 * Whether boot's run before Restate serves can call each reader, and why not where it cannot. A check that calls one it cannot
 * is left out of that run and logged once the orchestrator-wide run stores it. A reader added to the context does not compile until it is placed here.
 */
const BEFORE_RESTATE_READERS: { [K in SetupCheckReader]: BeforeRestateReader } & { githubSetupFacts: Record<GitHubSetupReader, BeforeRestateReader> } = {
  env: "readable",
  readSetting: "readable",
  orchestratorDefaults: "readable",
  projectStageConfig: "readable",
  runnerMode: "readable",
  flySessions: { leftOut: "The sessions app comes from the RunnerBackend object, read once Restate serves." },
  runnerBackendSource: { leftOut: "Answers whether the RunnerBackend object has been read, which happens once Restate serves." },
  mappings: "readable",
  storedAccessEntries: "readable",
  effectiveAllowlist: "readable",
  allowlistReadAvailable: "readable",
  restateStatus: { leftOut: "Restate's own status, which reads as not serving until it does." },
  databasePath: "readable",
  onSeparateFilesystem: "readable",
  trackerProvider: "readable",
  trackerSetupFacts: "readable",
  orchestratorHealthAt: { leftOut: "Reads through the public address, which a deploy's proxy may not route to this machine yet." },
  orchestratorInstanceId: "readable",
  githubSetupFacts: {
    app: "readable",
    installation: "readable",
    installationRepositories: "readable",
    repositories: "readable",
    publicRepository: "readable",
    deliveries: "readable",
    kgSourceRepo: "readable",
    kgPreflight: "readable",
    workflowSync: "readable",
  },
};

/** The orchestrator's own checks that call only readers boot's run before Restate serves can call. */
const BEFORE_RESTATE_CHECKS = ORCHESTRATOR_CONFIG_CHECKS.filter((check) =>
  check.contextReaders.every((reader) => BEFORE_RESTATE_READERS[reader] === "readable")
  && (check.githubReaders ?? []).every((reader) => BEFORE_RESTATE_READERS.githubSetupFacts[reader] === "readable"));

/** Runs the orchestrator's own checks that can read what they need before Restate serves, for boot to log while Restate starts. */
export function runSetupChecksBeforeRestate(ctx: SetupCheckContext, now: () => number = Date.now): Promise<SetupCheckRun> {
  return runSetupChecks(ctx, BEFORE_RESTATE_CHECKS, now);
}

const end = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/** One log line per row that needs attention: the check and its project, the state, what was found and the fix. */
export function setupCheckLogLines(rows: readonly SetupCheckResult[]): string[] {
  return rows.filter((row) => NEEDS_ATTENTION.includes(row.state)).map((row) => {
    const subject = row.project === undefined ? row.id : `${row.id} (${row.project})`;
    return `[setup-checks] ${subject} ${row.state}:${row.detail ? ` ${end(row.detail)}` : ""}${row.fix ? ` Fix: ${row.fix}` : ""}`;
  });
}

/**
 * Boot's two runs, which boot never waits for. Before Restate serves, the orchestrator's own checks that can read what they need then run in this process and are only logged,
 * since a recorded run would keep hydration from reading the stored one. Once Restate serves, every orchestrator-wide check runs through the
 * SetupChecks object, which stores it, and the rows the first run did not log are logged.
 */
export function createBootSetupChecks(deps: {
  runBeforeRestate: () => Promise<SetupCheckRun>;
  /** The stored run the orchestrator-wide run was merged into, or null when Restate did not answer. */
  storeOrchestratorWide: () => Promise<SetupCheckRun | null>;
  log: (line: string) => void;
}): { beforeRestate: () => Promise<void>; afterServing: () => Promise<void> } {
  const logged = new Set(BEFORE_RESTATE_CHECKS.map((check) => check.id));
  const failed = (when: string, err: unknown) => deps.log(`[setup-checks] the checks ${when} could not run: ${err instanceof Error ? err.message : String(err)}`);
  return {
    beforeRestate: async () => {
      try {
        for (const line of setupCheckLogLines((await deps.runBeforeRestate()).results)) deps.log(line);
      } catch (err) {
        failed("before Restate serves", err);
      }
    },
    afterServing: async () => {
      try {
        const stored = await deps.storeOrchestratorWide();
        if (stored === null) return;
        const unlogged = stored.results.filter((row) => !logged.has(row.id) && ORCHESTRATOR_WIDE_CHECK_IDS.has(row.id));
        for (const line of setupCheckLogLines(unlogged)) deps.log(line);
      } catch (err) {
        failed("once Restate serves", err);
      }
    },
  };
}

/**
 * Whether a partial run is answered by a full run instead: nothing is stored, so it would stand for every check; the stored run came from
 * a check list declared otherwise, so a check it lacks has no rows and one declared differently keeps rows that copy the old declaration;
 * or it found a check every project's rows wait on in a state the stored run does not show, failing or recovered. Such a change reaches
 * every project that shares the check, whose stored rows a partial run cannot correct; once a full run has stored it, later partial runs merge as they are.
 */
export function partialRunNeedsFullRun(run: SetupCheckRun, stored: SetupCheckRun | null): boolean {
  if (run.scope === undefined) return false;
  if (stored === null || stored.checkListFingerprint !== run.checkListFingerprint) return true;
  return run.results.some((row) => row.project === undefined && SHARED_DEPENDENCIES.has(row.id)
    && !stored.results.some((kept) => kept.id === row.id && kept.project === undefined && kept.state === row.state));
}

function inScope(row: SetupCheckResult, scope: SetupCheckScope): boolean {
  if (!scope.checks.includes(row.id)) return false;
  if (scope.projects === undefined) return true;
  return row.project === undefined ? ORCHESTRATOR_WIDE_CHECK_IDS.has(row.id) : scope.projects.includes(row.project);
}

/**
 * The stored run with every row a partial run answers for replaced by the partial run's, each dated by that run,
 * so a check in scope that now answers nothing leaves no row. Rows of projects no longer mapped are dropped.
 * A full run replaces the stored run, and with no stored run the whole partial run starts one, its rows outside the scope included.
 */
export function mergeSetupCheckRun(stored: SetupCheckRun | null, run: SetupCheckRun, mapped: readonly string[]): SetupCheckRun {
  const { scope } = run;
  if (scope === undefined) return run;
  const dated = (row: SetupCheckResult): SetupCheckResult => ({ ...row, checkedAt: run.checkedAt });
  if (stored === null) return { checkedAt: run.checkedAt, results: run.results.map(dated) };
  const kept = stored.results.filter((row) => !inScope(row, scope) && (row.project === undefined || mapped.includes(row.project)));
  return { ...stored, results: [...kept, ...run.results.filter((row) => inScope(row, scope)).map(dated)] };
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

// This process's cache of the stored run, which GET / reads even while Restate cannot answer.
let cachedRun: SetupCheckRun | null = null;
export function cacheSetupCheckRun(run: SetupCheckRun): void {
  cachedRun = structuredClone(run);
}
export function getCachedSetupCheckRun(): SetupCheckRun | null {
  return cachedRun === null ? null : structuredClone(cachedRun);
}
