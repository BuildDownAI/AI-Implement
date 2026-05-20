import { getDb } from "./dedup.js";

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
