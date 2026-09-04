import { getDb } from "./dedup.js";

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      RUNNER_MODE?: string;
      RUNNER_CALLBACK_BASE_URL?: string;
      PORT?: string;
      FLY_PROCESS_LEVEL_SECRETS?: string;
    }
  }
}

export const VALID_RUNNER_MODES = ["default", "gha", "fly", "local", "shadow"] as const;
export type RunnerMode = typeof VALID_RUNNER_MODES[number];
export const DEFAULT_RUNNER_MODE: RunnerMode = "default";
const RUNNER_MODE_SETTING_KEY = "runner_mode";
const FLY_SECRETS_MIN_VERSION_SETTING_KEY = "fly_secrets_min_version";

/** Type guard for narrowing an arbitrary string to RunnerMode. */
export function isRunnerMode(value: string | undefined | null): value is RunnerMode {
  return value !== undefined && value !== null && (VALID_RUNNER_MODES as readonly string[]).includes(value);
}

export interface RunnerModeStatus {
  mode: RunnerMode;
  source: "env" | "db" | "default";
}

export function initSettingsTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

/**
 * Returns the effective runner mode.
 * Priority: RUNNER_MODE env var > DB setting > default ("default").
 * The env var acts as a break-glass override when the DB is unavailable.
 */
export function getRunnerMode(): RunnerModeStatus {
  const envMode = process.env.RUNNER_MODE;
  if (isRunnerMode(envMode)) {
    return { mode: envMode, source: "env" };
  }

  try {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(RUNNER_MODE_SETTING_KEY) as { value: string } | undefined;

    if (row && isRunnerMode(row.value)) {
      return { mode: row.value, source: "db" };
    }
  } catch {
    // DB unavailable — fall through to default
  }

  return { mode: DEFAULT_RUNNER_MODE, source: "default" };
}

/**
 * Returns the execution path for a single dispatch given the global runner mode
 * and the per-team execution mode. Pure — no I/O.
 *
 * "both" means shadow mode: dispatch GHA (primary) and Fly (secondary).
 */
export function resolveExecutionPath(
  runnerMode: RunnerMode,
  mappingMode: "github-actions" | "fly-machines",
): "github-actions" | "fly-machines" | "local-docker" | "both" {
  if (runnerMode === "shadow") return "both";
  if (runnerMode === "local") return "local-docker";
  if (runnerMode === "fly") return "fly-machines";
  if (runnerMode === "gha") return "github-actions";
  // "default": honour per-team setting
  return mappingMode;
}

export interface ForcedPathEligibility {
  eligible: boolean;
  reason: string | null;
}

/**
 * AII-306: when the global runner mode FORCES a path a mapping cannot run on,
 * the dispatch must be skipped (issue stays queued) instead of launching a run
 * that cannot work. Pure — no I/O. Only mode "fly" forces an incapable path
 * today: bedrock is GHA-only, and Fly machine creation needs a sessions app.
 * Non-forcing modes (and "gha"/"local", which every mapping can run) are
 * always eligible.
 */
export function checkForcedPathEligibility(
  runnerMode: RunnerMode,
  mapping: { executionMode: "github-actions" | "fly-machines"; provider?: string },
  hasFlySessionsApp: boolean,
): ForcedPathEligibility {
  if (runnerMode !== "fly") return { eligible: true, reason: null };
  if (mapping.provider === "bedrock") {
    return { eligible: false, reason: "provider=bedrock is GHA-only (no role-assumption on Fly)" };
  }
  if (!hasFlySessionsApp) {
    return { eligible: false, reason: "no Fly sessions app configured (FLY_SESSIONS_APP)" };
  }
  return { eligible: true, reason: null };
}

/**
 * Planning-specific execution path resolution. Identical to resolveExecutionPath
 * except shadow ("both") collapses to "github-actions": planning posts user-visible
 * Linear comments, so a shadow second backend would double-post.
 */
export function resolvePlanningExecutionPath(
  runnerMode: RunnerMode,
  mappingMode: "github-actions" | "fly-machines",
): "github-actions" | "fly-machines" | "local-docker" {
  const path = resolveExecutionPath(runnerMode, mappingMode);
  if (path === "both") return "github-actions";
  return path;
}

export interface RunnerCallbackBaseUrlResult {
  url: string | null;
  /** "env" = explicit RUNNER_CALLBACK_BASE_URL; "local-default" = derived for RUNNER_MODE=local. */
  source: "env" | "local-default" | "unset";
}

/**
 * Resolves the runner-callback base URL. An explicit RUNNER_CALLBACK_BASE_URL
 * always wins. When it's unset and RUNNER_MODE=local (the `npm run dev:local`
 * contract — env var only, never the DB setting, since host.docker.internal
 * is only known-correct for an orchestrator running on the Docker host), the
 * URL is derived from the orchestrator's own HTTP port: local containers are
 * started with `--add-host host.docker.internal:host-gateway`, so the callback
 * target is known a-priori. Without it, planning runs complete but can never
 * report results, so the orchestrator re-dispatches planning forever.
 */
export function resolveRunnerCallbackBaseUrl(
  env: Pick<NodeJS.ProcessEnv, "RUNNER_CALLBACK_BASE_URL" | "RUNNER_MODE" | "PORT">,
): RunnerCallbackBaseUrlResult {
  if (env.RUNNER_CALLBACK_BASE_URL) return { url: env.RUNNER_CALLBACK_BASE_URL, source: "env" };
  if (env.RUNNER_MODE === "local") {
    const port = parseInt(env.PORT || "8080", 10);
    return { url: `http://host.docker.internal:${port}`, source: "local-default" };
  }
  return { url: null, source: "unset" };
}

/** Persists the runner mode to the DB. Env var override is unaffected. */
export function setRunnerMode(mode: RunnerMode): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(RUNNER_MODE_SETTING_KEY, mode);
}

export function getFlySecretsMinVersion(): number | null {
  try {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(FLY_SECRETS_MIN_VERSION_SETTING_KEY) as { value: string } | undefined;

    if (!row) return null;
    const parsed = Number.parseInt(row.value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function setFlySecretsMinVersion(version: number): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(FLY_SECRETS_MIN_VERSION_SETTING_KEY, String(version));
}

export interface FlyProcessLevelSecretsStatus {
  enabled: boolean;
  source: "env" | "db" | "default";
}

const FLY_PROCESS_LEVEL_SECRETS_SETTING_KEY = "fly_process_level_secrets";

/**
 * Returns true/false for recognised values (true/1/yes or false/0/no, case-insensitive),
 * or undefined when the var is absent, empty, or whitespace-only (treat as unset).
 */
export function parseFlyProcessLevelSecretsEnv(val: string | undefined): boolean | undefined {
  if (!val || !val.trim()) return undefined;
  if (["true", "1", "yes"].includes(val.toLowerCase())) return true;
  if (["false", "0", "no"].includes(val.toLowerCase())) return false;
  return undefined;
}

/**
 * Returns the effective Fly process-level secrets setting.
 * Priority: FLY_PROCESS_LEVEL_SECRETS env var > DB setting > default (true).
 * An explicit false/0/no env value is treated as a set override, not a fall-through.
 */
export function getFlyProcessLevelSecrets(): FlyProcessLevelSecretsStatus {
  const envVal = parseFlyProcessLevelSecretsEnv(process.env.FLY_PROCESS_LEVEL_SECRETS);
  if (envVal !== undefined) {
    return { enabled: envVal, source: "env" };
  }

  try {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(FLY_PROCESS_LEVEL_SECRETS_SETTING_KEY) as { value: string } | undefined;

    if (row) {
      return { enabled: row.value === "true", source: "db" };
    }
  } catch {
    // DB unavailable — fall through to default
  }

  return { enabled: true, source: "default" };
}

/** Persists the Fly process-level secrets setting to the DB. Env var override is unaffected. */
export function setFlyProcessLevelSecrets(enabled: boolean): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(FLY_PROCESS_LEVEL_SECRETS_SETTING_KEY, String(enabled));
}
