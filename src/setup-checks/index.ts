/**
 * Orchestrator setup checks: read-only checks of an orchestrator's setup, each naming its fix.
 *
 * This module holds the result contract, the check ids, the context a check reads, the list and
 * the runner. The checks sit beside it, one module per group, each named `<group>-config.ts`:
 * `orchestrator-config.ts` holds the orchestrator's own environment and settings checks.
 */

import { statSync } from "node:fs";
import { getEffectiveAllowlist, listAccessEntries, type AccessEntry, type EffectiveAllowlist } from "../access-entries.js";
import { getMappings, type RepoMapping } from "../config.js";
import { getDatabasePath, getDb, type DatabasePath } from "../dedup.js";
import { getFlySessionsConfig, type FlySessionsConfig } from "../orchestrator-settings.js";
import { getRunnerMode, type RunnerModeStatus } from "../runner-mode.js";
import { ORCHESTRATOR_CONFIG_CHECKS } from "./orchestrator-config.js";

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
  "settings.seeded",
  "settings.env-override",
  "settings.allowlist-env",
  "volume.database",
  "restate",
  "callback.config",
  "runner.fly-sessions",
  "admin.path",
  "admin.providers",
  "admin.redirect-url",
  "admin.allowlist",
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
  detail?: string;         // what was read; shown to admins only
  fix?: string;            // set when state is warn, fail or cannot-verify
  fixUrl?: string;         // a page that applies the fix; admin-only, like fix
}

export interface SetupCheckRun {
  checkedAt: number;
  results: SetupCheckResult[];
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
  runnerMode(): RunnerModeStatus;
  flySessions(): FlySessionsConfig;
  mappings(): Record<string, RepoMapping>;
  storedAccessEntries(): AccessEntry[];
  effectiveAllowlist(): EffectiveAllowlist | null;
  restateStatus(): SetupCheckRestateStatus;
  databasePath(): DatabasePath;
  /** True when `dir` is on a different filesystem from `/`, which on Fly means a mounted volume. */
  onSeparateFilesystem(dir: string): boolean;
}

/**
 * The context every caller starts from. A caller overrides only what it reads differently: the
 * setup command runs in its own process, so the server's Fly sessions cache is not its own.
 * The Restate status has no default, since its reader depends on where the caller runs.
 */
export function createSetupCheckContext(
  overrides: Partial<SetupCheckContext> & Pick<SetupCheckContext, "restateStatus">,
): SetupCheckContext {
  return {
    env: process.env,
    // A database error throws, so the check reports cannot-verify instead of reading a missing row.
    readSetting: (key) =>
      (getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null,
    runnerMode: getRunnerMode,
    flySessions: getFlySessionsConfig,
    mappings: getMappings,
    storedAccessEntries: listAccessEntries,
    effectiveAllowlist: getEffectiveAllowlist,
    databasePath: getDatabasePath,
    onSeparateFilesystem: (dir) => statSync(dir).dev !== statSync("/").dev,
    ...overrides,
  };
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

export const SETUP_CHECKS: readonly SetupCheck[] = [...ORCHESTRATOR_CONFIG_CHECKS];

/** Runs every check. A check that throws reports `cannot-verify` with its error, and the others still run. */
export async function runSetupChecks(
  ctx: SetupCheckContext,
  checks: readonly SetupCheck[] = SETUP_CHECKS,
  now: () => number = Date.now,
): Promise<SetupCheckRun> {
  // The async wrapper turns a check's synchronous throw into a rejection that allSettled records.
  const settled = await Promise.allSettled(checks.map(async (check) => check.run(ctx)));
  const results = settled.flatMap((result, i) => {
    const check = checks[i];
    const identity = { id: check.id, title: check.title, group: check.group, tier: check.tier, onAdminPath: check.onAdminPath };
    if (result.status === "fulfilled") return result.value.map((outcome) => ({ ...identity, ...outcome }));
    return [{
      ...identity,
      state: "cannot-verify" as const,
      detail: result.reason instanceof Error ? result.reason.message : String(result.reason),
      fix: "The check itself could not run, its detail names the error.",
    }];
  });
  return { checkedAt: now(), results };
}
