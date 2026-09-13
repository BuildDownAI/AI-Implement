// src/orchestrator-settings.ts
import { getDb } from "./dedup.js";

const FLY_SESSIONS_APP_KEY = "fly_sessions_app";
const FLY_SESSIONS_REGION_KEY = "fly_sessions_region";
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
