/**
 * Settings an environment variable writes once, when no row exists. From then on the row is the
 * authority and the variable is inert (ADR 022); `main()` seeds from this list and the setup checks
 * read it, so a new seed is both seeded and checked.
 *
 * Its own module because it reads keys from both `orchestrator-settings.ts` and `runner-mode.ts`,
 * which many tests mock in part; neither of those modules loads the other.
 */

import { getDb } from "./dedup.js";
import {
  KG_BASE_REPO_KEY,
  LINEAR_PICKUP_LABEL_KEY,
  RUNNER_IMAGE_ALLOWED_PREFIXES_KEY,
  validateRunnerImagePrefixes,
} from "./orchestrator-settings.js";
import {
  KG_EXECUTION_MODE_SETTING_KEY,
  KG_MATERIALIZE_DIRECT_SETTING_KEY,
  parseKgExecutionModeEnv,
  parseKgMaterializeDirectEnv,
} from "./runner-mode.js";

export interface SeedOnceSetting {
  variable: string;
  key: string;
  /** The admin page that changes the setting after the first boot. */
  page: string;
  /** What the seed writes for this value: the row, nothing (`null`), or nothing with an error to log. */
  seedValue(raw: string | undefined): string | null | { error: string };
}

const trimmed = (raw: string | undefined): string | null => raw?.trim() || null;

/** In the order `main()` seeds them. */
export const SEED_ONCE_SETTINGS: readonly SeedOnceSetting[] = [
  { variable: "KG_BASE_REPO", key: KG_BASE_REPO_KEY, page: "/admin#settings", seedValue: trimmed },
  {
    variable: "KG_MATERIALIZE_DIRECT",
    key: KG_MATERIALIZE_DIRECT_SETTING_KEY,
    page: "/admin#kg-pipelines",
    seedValue: (raw) => {
      const enabled = parseKgMaterializeDirectEnv(raw);
      return enabled === undefined ? null : String(enabled);
    },
  },
  {
    variable: "KG_EXECUTION_MODE",
    key: KG_EXECUTION_MODE_SETTING_KEY,
    page: "/admin#kg-pipelines",
    seedValue: (raw) => parseKgExecutionModeEnv(raw) ?? null,
  },
  { variable: "LINEAR_PICKUP_LABEL", key: LINEAR_PICKUP_LABEL_KEY, page: "/admin#settings", seedValue: trimmed },
  {
    variable: "RUNNER_IMAGE_ALLOWED_PREFIXES",
    key: RUNNER_IMAGE_ALLOWED_PREFIXES_KEY,
    page: "/admin#settings",
    seedValue: (raw) => {
      const parsed = validateRunnerImagePrefixes(raw ?? null);
      return "error" in parsed ? parsed : parsed.value;
    },
  },
];

/** Writes each `SEED_ONCE_SETTINGS` row from `env` where none exists yet. Call once at boot, after `initSettingsTable()`. */
export function seedSettingsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): void {
  const db = getDb();
  for (const setting of SEED_ONCE_SETTINGS) {
    const seed = setting.seedValue(env[setting.variable]);
    if (seed === null) continue;
    if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(setting.key)) continue;
    if (typeof seed === "string") {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(setting.key, seed);
    } else {
      console.warn(`[settings] ${setting.variable} is invalid (${seed.error}), so it was not seeded`);
    }
  }
}
