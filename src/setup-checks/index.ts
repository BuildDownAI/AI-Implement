/**
 * Orchestrator setup checks: read-only checks of an orchestrator's setup, each naming its fix.
 *
 * This module holds the result contract, the check ids, the context a check reads, the list and
 * the runner. The checks sit beside it, one module per group, each named `<group>-config.ts`:
 * `orchestrator-config.ts` holds the orchestrator's own environment and settings checks.
 */

import { getOrchestratorDefaults, getProjectStageConfig } from "../agent-config-store.js";
import { statSync } from "node:fs";
import { isAllowlistReadAvailable, getEffectiveAllowlist, listAccessEntries, type AccessEntry, type EffectiveAllowlist } from "../access-entries.js";
import { getMappings, type RepoMapping } from "../config.js";
import { getDatabasePath, getDb, type DatabasePath } from "../dedup.js";
import { readKgSourceRepo } from "../deploy.js";
import { getAppInstallation, getScopedInstallationToken, listInstallationRepositoryNames, readAppIdentity, type AppIdentityRead, type AppInstallation } from "../github-app-auth.js";
import { readPublicRepository, readRepositoryFacts, type PublicRepositoryRead, type RepositoryFacts } from "../github.js";
import { ORCHESTRATOR_INSTANCE_ID, readOrchestratorHealth, type HealthSetupChecks, type OrchestratorHealthRead } from "../health-body.js";
import { runKgRefreshPreflight, type PreflightCheckResult } from "../kg-refresh.js";
import { getRunnerBackendSource, getFlySessionsConfig, getOrchestratorSettings, type FlySessionsConfig } from "../orchestrator-settings.js";
import { providerConfigFromEnv, ProviderRegistry } from "../providers/index.js";
import type { TicketingProvider, TrackerSetupFacts } from "../providers/types.js";
import { getRunnerMode, type RunnerModeStatus } from "../runner-mode.js";
import { listRecentAppDeliveries, type RecentAppDeliveries } from "../webhook-redelivery.js";
import { getWorkflowSyncByTeam, type WorkflowSyncJob } from "../workflow-sync-queue.js";
import { GITHUB_CONFIG_CHECKS, ownerRepositoryRequests } from "./github-config.js";
import { isAdminPathConfigured, ORCHESTRATOR_CONFIG_CHECKS } from "./orchestrator-config.js";
import { TRACKER_CONFIG_CHECKS } from "./tracker-config.js";

export type SetupCheckState = "pass" | "warn" | "fail" | "cannot-verify" | "not-applicable";
export type SetupCheckTier = "core" | "mode" | "feature";

/**
 * Every check's id, declared once. Stored runs, runtime failures and self-heal actions name checks
 * by id, so an id is never renamed; a check module adds its ids here when it registers its checks.
 */
export const SETUP_CHECK_IDS = [
  // orchestrator-config.ts
  "env.github-app",
  "env.admin-access-code",
  "env.runner-mode",
  "env.poll-interval",
  "env.breaker-threshold",
  "model.credentials-adopted",
  "settings.seeded",
  "settings.env-override",
  "settings.allowlist-env",
  "volume.database",
  "restate",
  "callback.config",
  "callback.reachable",
  "runner.fly-sessions",
  "admin.path",
  "admin.providers",
  "admin.redirect-url",
  "admin.allowlist",
  // tracker-config.ts
  "tracker.provider",
  "tracker.linear.credentials",
  "tracker.linear.team-access",
  "tracker.linear.pickup-label",
  "tracker.linear.lifecycle-labels",
  "tracker.linear.workflow-states",
  "tracker.jira.credentials",
  "tracker.jira.fields",
  "tracker.jira.field-cache",
  "tracker.jira.status-options",
  "tracker.jira.repo-option",
  "tracker.jira.jql",
  "tracker.filesystem.directory",
  // github-config.ts
  "github.app-identity",
  "github.clock",
  "github.installation",
  "github.permissions",
  "github.target-secrets",
  "github.webhook-signature",
  "github.kg-grants",
  "github.workflow-default-branch",
  "github.workflow-mapping-branch",
  "github.reference-repos",
  "github.skills-repo",
] as const;

export type SetupCheckId = (typeof SETUP_CHECK_IDS)[number];

export interface SetupCheckResult {
  id: SetupCheckId;        // stable, e.g. "admin.allowlist"; runtime failures and self-heal actions name checks by id
  title: string;           // a human name for the check
  group: "orchestrator" | "tracker" | "github" | "model";
  tier: SetupCheckTier;    // core: every deployment; mode: one execution mode; feature: optional
  onAdminPath: boolean;    // named on GET / while no admin path is configured
  project?: string;        // the mapping key, for a per-project check; absent for orchestrator-wide checks
  state: SetupCheckState;
  detail?: string;         // what was read; only on the Setup page and its route, never in a summary (ADR 047)
  fix?: string;            // set when state is warn, fail or cannot-verify; shown where detail is
  fixUrl?: string;         // a page that applies the fix; shown where detail is
}

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

/**
 * The part of `RestateStatus` (`src/restate/status.ts`) the `restate` check reads. Declared here
 * because only door adapters may import from `src/restate/` (`restate-boundary.test.ts`).
 */
export interface SetupCheckRestateStatus {
  sidecar: { state: string };
  registration: { state: string };
}

/** Everything a check reads, as functions, so a reader that throws fails only the checks that call it. */
export interface SetupCheckContext {
  env: Readonly<Record<string, string | undefined>>;
  /** A raw `settings` row, or null when none exists. */
  readSetting(key: string): string | null;
  orchestratorDefaults(): ReturnType<typeof getOrchestratorDefaults>;
  projectStageConfig(key: string): ReturnType<typeof getProjectStageConfig>;
  runnerMode(): RunnerModeStatus;
  flySessions(): FlySessionsConfig;
  runnerBackendSource(): "restate" | "not-loaded";
  mappings(): Record<string, RepoMapping>;
  storedAccessEntries(): AccessEntry[];
  effectiveAllowlist(): EffectiveAllowlist | null;
  /** Availability of the latest read, even when effectiveAllowlist serves cached entries. */
  allowlistReadAvailable(): boolean;
  restateStatus(): SetupCheckRestateStatus;
  databasePath(): DatabasePath;
  /** True when `dir` is on a different filesystem from `/`, which on Fly means a mounted volume. */
  onSeparateFilesystem(dir: string): boolean;
  /** The provider for a ticketing provider id, built as the poll builds it. Throws when it cannot be built. */
  trackerProvider(providerId: string): Promise<TicketingProvider>;
  /** One provider's setup facts for its projects' teams, read once per context, or null when it reads none. */
  trackerSetupFacts(providerId: string): Promise<TrackerSetupFacts | null>;
  /** The GitHub reads the `github` checks share, one set per context. */
  githubSetupFacts(): GitHubSetupFacts;
  /** The orchestrator's health endpoint at a base URL, read from this host the way a run reaches the orchestrator. */
  orchestratorHealthAt(baseUrl: string): Promise<OrchestratorHealthRead>;
  /** The identifier this orchestrator's own health body carries. */
  orchestratorInstanceId(): string;
}

/** GitHub's side of the setup, read lazily: each read runs at its first call and is shared for the rest of the run. */
export interface GitHubSetupFacts {
  /** `GET /app` with the App's JWT. Throws when the App's ID or key is missing or cannot sign one. */
  app(): Promise<AppIdentityRead>;
  /** The App's installation on an owner, or null when it has none. */
  installation(owner: string): Promise<AppInstallation | null>;
  /** The lowercased names a selected-repositories installation includes, or null when it includes them all. Throws when the owner has no installation. */
  installationRepositories(owner: string): Promise<Set<string> | null>;
  /** What the installation's token sees of every repository projects read on an owner, keyed by lowercased name. */
  repositories(owner: string): Promise<Map<string, RepositoryFacts>>;
  /** An unauthenticated read of a repository, and of `ref` in it, for an owner the App is not installed on. */
  publicRepository(owner: string, repo: string, ref?: string): Promise<PublicRepositoryRead>;
  /** The App's webhook deliveries from the last day. */
  deliveries(): Promise<RecentAppDeliveries>;
  /** `KG_SOURCE_REPO` as self-deploy and the refresh read it, or null when it is unset or not an owner/repo name. */
  kgSourceRepo(): string | null;
  /** The knowledge-graph refresh preflight, or null when `kgSourceRepo()` is. */
  kgPreflight(): Promise<PreflightCheckResult | null>;
  /** A project's workflow sync row, or null when none was ever queued. */
  workflowSync(teamKey: string): WorkflowSyncJob | null;
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

/** What a check reports; the runner adds the check's own identity fields. */
export type SetupCheckOutcome = Pick<SetupCheckResult, "state" | "detail" | "fix" | "fixUrl" | "project">;

export interface SetupCheck {
  id: SetupCheckId;
  title: string;
  group: SetupCheckResult["group"];
  tier: SetupCheckTier;
  onAdminPath: boolean;
  /** One outcome for an orchestrator-wide check, one per project for a per-project check. */
  run(ctx: SetupCheckContext): SetupCheckOutcome[] | Promise<SetupCheckOutcome[]>;
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
    const identity = { id: check.id, title: check.title, group: check.group, tier: check.tier, onAdminPath: check.onAdminPath };
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
