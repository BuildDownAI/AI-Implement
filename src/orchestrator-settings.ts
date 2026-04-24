// src/orchestrator-settings.ts
import { getDb } from "./dedup.js";

const FLY_SESSIONS_APP_KEY = "fly_sessions_app";
const FLY_SESSIONS_REGION_KEY = "fly_sessions_region";

const SETTING_KEYS: Record<"flySessionsApp" | "flySessionsRegion", string> = {
  flySessionsApp: FLY_SESSIONS_APP_KEY,
  flySessionsRegion: FLY_SESSIONS_REGION_KEY,
};

export interface OrchestratorSettings {
  flySessionsApp: string | null;
  flySessionsRegion: string | null;
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
    };
  } catch {
    return { flySessionsApp: null, flySessionsRegion: null };
  }
}

export function setOrchestratorSetting(key: "flySessionsApp" | "flySessionsRegion", value: string | null): void {
  const dbKey = SETTING_KEYS[key];
  const db = getDb();
  if (value === null) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(dbKey);
  } else {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(dbKey, value);
  }
}
