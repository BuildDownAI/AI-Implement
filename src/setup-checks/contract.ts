/**
 * The setup checks' contract: what a check is written against. The check ids, a result and what a check reports,
 * the context a check reads, and the helpers the check modules share for writing an outcome.
 *
 * The check modules import from here, never from index.ts, which imports each of them at load to build the list,
 * so the dependency runs one way. Everything this module takes from elsewhere is a type.
 */

import type { getOrchestratorDefaults, getProjectStageConfig } from "../agent-config-store.js";
import type { AccessEntry, EffectiveAllowlist } from "../access-entries.js";
import type { RepoMapping } from "../config.js";
import type { DatabasePath } from "../dedup.js";
import type { AppIdentityRead, AppInstallation } from "../github-app-auth.js";
import type { PublicRepositoryRead, RepositoryFacts } from "../github.js";
import type { OrchestratorHealthRead } from "../health-body.js";
import type { PreflightCheckResult } from "../kg-refresh.js";
import type { FlySessionsConfig } from "../orchestrator-settings.js";
import type { TicketingProvider, TrackerSetupFacts } from "../providers/types.js";
import type { RunnerModeStatus } from "../runner-mode.js";
import type { RecentAppDeliveries } from "../webhook-redelivery.js";
import type { WorkflowSyncJob } from "../workflow-sync-queue.js";

export type SetupCheckState = "pass" | "warn" | "fail" | "cannot-verify" | "not-applicable";

/** The states of a row someone should look at. */
export const NEEDS_ATTENTION: readonly SetupCheckState[] = ["fail", "cannot-verify", "warn"];

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
  "kg.remote-store",
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
  "runner.project-backend",
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
  "github.webhook-events",
  "github.kg-grants",
  "github.workflow-default-branch",
  "github.workflow-mapping-branch",
  "github.reference-repos",
  "github.skills-repo",
  "github.review-process",
] as const;

export type SetupCheckId = (typeof SETUP_CHECK_IDS)[number];

/** The runtime failures that ask for a check to run again, each kept as the `cause` of the rows its recheck answers. */
export const SETUP_RECHECK_CAUSES = ["dispatch-404", "dispatch-refused", "launch-refused", "planning-refused", "token-step", "tracker-read", "tracker-write", "github-read", "workflow-sync", "runner-reported", "token-vending"] as const;

export type SetupRecheckCause = (typeof SETUP_RECHECK_CAUSES)[number];

export interface SetupCheckResult {
  id: SetupCheckId;        // stable, e.g. "admin.allowlist"; runtime failures and self-heal actions name checks by id
  title: string;           // a human name for the check
  group: "orchestrator" | "tracker" | "github" | "model";
  tier: SetupCheckTier;    // core: every deployment; mode: one execution mode; feature: optional
  onAdminPath: boolean;    // named on GET / while no admin path is configured
  verifiable?: false;      // set on a check that can only name what to confirm by hand, so it never passes; absent means it can
  project?: string;        // the mapping key, for a per-project check; absent for orchestrator-wide checks
  state: SetupCheckState;
  detail?: string;         // what was read; only on the Setup page and its route, never in a summary (ADR 047)
  fix?: string;            // set when state is warn, fail or cannot-verify; shown where detail is
  fixUrl?: string;         // a page that applies the fix; shown where detail is
  waitsOn?: SetupCheckId;  // the check this row cannot be read without, which its fix names (`waitOn`)
  checkedAt?: number;      // set by a run narrower than a full one; absent means the run's checkedAt
  cause?: SetupRecheckCause; // the runtime failure whose recheck answered this row
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
  workflowSync(project: string): WorkflowSyncJob | null;
}

/** What a check reports; the runner adds the check's own identity fields. */
export type SetupCheckOutcome = Pick<SetupCheckResult, "state" | "detail" | "fix" | "fixUrl" | "waitsOn" | "project">;

export interface SetupCheck {
  id: SetupCheckId;
  title: string;
  group: SetupCheckResult["group"];
  tier: SetupCheckTier;
  onAdminPath: boolean;
  /** Judges each project, so in a run for one project every row it answers is that project's. */
  perProject: boolean;
  /** False when nothing the orchestrator can read settles it, so it names what to confirm by hand and never passes. */
  verifiable: boolean;
  /** One outcome for an orchestrator-wide check, one per project for a per-project check. */
  run(ctx: SetupCheckContext): SetupCheckOutcome[] | Promise<SetupCheckOutcome[]>;
}

/** The fix of a row that cannot be read until check `id` is addressed, with that check as the row's `waitsOn`. */
export function waitOn(id: SetupCheckId): Required<Pick<SetupCheckResult, "fix" | "waitsOn">> {
  return { fix: `More information is needed. Address the ${id} check first.`, waitsOn: id };
}

/** `outcome` as each project's own row, so a fault every project shares shows on each of them. */
export function forEachProject(keys: string[], outcome: SetupCheckOutcome): SetupCheckOutcome[] {
  return keys.map((project) => ({ ...outcome, project }));
}
