// src/orchestrator-settings.ts
import { getDb } from "./dedup.js";
import { DEFAULT_RETRY_POLICY, normalizeRetryPolicy, type RetryPolicy } from "./pipeline/retry-backoff.js";

export { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./pipeline/retry-backoff.js";

const FLY_SESSIONS_APP_KEY = "fly_sessions_app";
const FLY_SESSIONS_REGION_KEY = "fly_sessions_region";
const RETRY_POLICY_KEY = "retry_policy";
const KG_REFRESH_REPORT_ISSUE_KEY = "kg_refresh_report_issue";
const KG_BASE_REPO_KEY = "kg_base_repo";

type SettingKey = "flySessionsApp" | "flySessionsRegion" | "kgRefreshReportIssue" | "kgBaseRepo";

const SETTING_KEYS: Record<SettingKey, string> = {
  flySessionsApp: FLY_SESSIONS_APP_KEY,
  flySessionsRegion: FLY_SESSIONS_REGION_KEY,
  kgRefreshReportIssue: KG_REFRESH_REPORT_ISSUE_KEY,
  kgBaseRepo: KG_BASE_REPO_KEY,
};

export interface OrchestratorSettings {
  flySessionsApp: string | null;
  flySessionsRegion: string | null;
  /** Linear issue identifier (e.g. "AII-496") to receive kg-refresh failure comments. */
  kgRefreshReportIssue: string | null;
  /** owner/repo of the base template repo the KG PR-triggered dry-run check watches (AII-633). Seeded once from KG_BASE_REPO. */
  kgBaseRepo: string | null;
}

export function getOrchestratorSettings(): OrchestratorSettings {
  try {
    const db = getDb();
    const get = (key: string): string | null => {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value ?? null;
    };
    return {
      flySessionsApp: get(FLY_SESSIONS_APP_KEY),
      flySessionsRegion: get(FLY_SESSIONS_REGION_KEY),
      kgRefreshReportIssue: get(KG_REFRESH_REPORT_ISSUE_KEY),
      kgBaseRepo: get(KG_BASE_REPO_KEY),
    };
  } catch {
    return { flySessionsApp: null, flySessionsRegion: null, kgRefreshReportIssue: null, kgBaseRepo: null };
  }
}

/**
 * Seeds `kgBaseRepo` from KG_BASE_REPO on first boot only (AII-633) — a no-op once the
 * DB already holds a value, so a later env removal or edit at /admin#settings is never
 * clobbered. Call once during startup.
 */
export function seedKgBaseRepoFromEnv(envValue: string | null | undefined): void {
  if (!envValue?.trim()) return;
  if (getOrchestratorSettings().kgBaseRepo !== null) return;
  setOrchestratorSetting("kgBaseRepo", envValue.trim());
}

export function setOrchestratorSetting(key: SettingKey, value: string | null): void {
  const dbKey = SETTING_KEYS[key];
  const db = getDb();
  if (value === null) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(dbKey);
  } else {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(dbKey, value);
  }
}

const RETRY_POLICY_KNOWN_KEYS = [
  "requestRetries",
  "stageRetries",
  "pushRetries",
  "backoffInitialMs",
  "backoffMaxMs",
  "backoffJitter",
  "reviewMaxTurns",
] as const;

/**
 * Effective retry policy: defaults merged with whatever partial object is stored
 * under `retry_policy`, validated field-by-field through `normalizeRetryPolicy`
 * (the same runner-side guard the envelope decode path uses) so a row that is
 * present but out-of-range — hand-edited, or written by an older/newer version —
 * can never reach the admin Settings form or a dispatch. Falls back to defaults
 * entirely on any DB error (missing table, corrupt JSON, etc.) so a bad row can
 * never take down dispatch or the runner.
 */
export function getRetryPolicy(): RetryPolicy {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(RETRY_POLICY_KEY) as
      | { value: string }
      | undefined;
    if (!row) return { ...DEFAULT_RETRY_POLICY };
    return normalizeRetryPolicy(JSON.parse(row.value));
  } catch (err) {
    console.warn("[orchestrator-settings] Failed to read retry policy, falling back to defaults:", err);
    return { ...DEFAULT_RETRY_POLICY };
  }
}

function assertIntInRange(value: unknown, name: string, min: number, max: number): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
}

function validateRetryPolicy(p: RetryPolicy): void {
  assertIntInRange(p.requestRetries, "requestRetries", 0, 10);
  assertIntInRange(p.stageRetries, "stageRetries", 0, 10);
  assertIntInRange(p.pushRetries, "pushRetries", 0, 10);
  assertIntInRange(p.reviewMaxTurns, "reviewMaxTurns", 5, 200);
  assertIntInRange(p.backoffInitialMs, "backoffInitialMs", 1_000, 600_000);
  assertIntInRange(p.backoffMaxMs, "backoffMaxMs", 1_000, 600_000);
  if (p.backoffMaxMs < p.backoffInitialMs) {
    throw new Error("backoffMaxMs must be an integer >= backoffInitialMs");
  }
  if (typeof p.backoffJitter !== "number" || Number.isNaN(p.backoffJitter) || p.backoffJitter < 0 || p.backoffJitter > 1) {
    throw new Error("backoffJitter must be a number between 0 and 1");
  }
}

/**
 * Merges `p` over `DEFAULT_RETRY_POLICY` (never over the currently-stored value) and
 * validates the result before writing, so an absent key always means "reset to
 * default" — a blank form field must not silently keep whatever was previously
 * stored. `null` deletes the row, resetting to defaults. Throws on validation
 * failure, including any key outside the seven known ones — the caller (admin POST
 * handler) is expected to turn that into a 400 and must not have written anything
 * else first.
 */
export function setRetryPolicy(p: Partial<RetryPolicy> | null): void {
  const db = getDb();
  if (p === null) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(RETRY_POLICY_KEY);
    return;
  }
  const unknownKeys = Object.keys(p).filter((k) => !(RETRY_POLICY_KNOWN_KEYS as readonly string[]).includes(k));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown retry policy key(s): ${unknownKeys.join(", ")}`);
  }
  const merged: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...p };
  validateRetryPolicy(merged);
  // Persist a projection of only the known keys, so nothing arbitrary rides the envelope.
  const toStore: RetryPolicy = {
    requestRetries: merged.requestRetries,
    stageRetries: merged.stageRetries,
    pushRetries: merged.pushRetries,
    backoffInitialMs: merged.backoffInitialMs,
    backoffMaxMs: merged.backoffMaxMs,
    backoffJitter: merged.backoffJitter,
    reviewMaxTurns: merged.reviewMaxTurns,
  };
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    RETRY_POLICY_KEY,
    JSON.stringify(toStore),
  );
}
