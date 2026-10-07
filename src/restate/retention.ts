import { getDb } from "../dedup.js";

export const RESTATE_RETENTION_DAYS_DEFAULT = 14;
export const RESTATE_RETENTION_DAYS_MIN = 1;
export const RESTATE_RETENTION_DAYS_MAX = 60;

const RESTATE_RETENTION_DAYS_KEY = "restate_retention_days";
const VOLUME_SNAPSHOT_RETENTION_DAYS_KEY = "volume_snapshot_retention_days";

const DAY_MS = 24 * 60 * 60 * 1000;

function inRange(days: number): boolean {
  return Number.isInteger(days) && days >= RESTATE_RETENTION_DAYS_MIN && days <= RESTATE_RETENTION_DAYS_MAX;
}

/** An absent, unparseable, or out-of-range row answers the default and warns once per read. */
function readDaysSetting(key: string): number {
  let raw: string | undefined;
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    raw = row?.value;
  } catch (err) {
    console.warn(`[restate] could not read ${key}, using ${RESTATE_RETENTION_DAYS_DEFAULT} days: ${String(err)}`);
    return RESTATE_RETENTION_DAYS_DEFAULT;
  }
  if (raw === undefined) return RESTATE_RETENTION_DAYS_DEFAULT;
  const trimmed = raw.trim();
  const days = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!inRange(days)) {
    console.warn(
      `[restate] ignoring invalid ${key} setting ${JSON.stringify(raw)} (want an integer ${RESTATE_RETENTION_DAYS_MIN}-${RESTATE_RETENTION_DAYS_MAX}); using ${RESTATE_RETENTION_DAYS_DEFAULT} days`,
    );
    return RESTATE_RETENTION_DAYS_DEFAULT;
  }
  return days;
}

function writeDaysSetting(key: string, days: number): void {
  if (!inRange(days)) {
    throw new Error(
      `${key} must be an integer from ${RESTATE_RETENTION_DAYS_MIN} to ${RESTATE_RETENTION_DAYS_MAX}, got ${String(days)}`,
    );
  }
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(days));
}

/** Read once at boot when the workflows are built; a change applies at the next deploy or restart. */
export function getRestateRetentionDays(): number {
  return readDaysSetting(RESTATE_RETENTION_DAYS_KEY);
}

export function setRestateRetentionDays(days: number): void {
  writeDaysSetting(RESTATE_RETENTION_DAYS_KEY, days);
}

export function restateRetentionMs(): number {
  return getRestateRetentionDays() * DAY_MS;
}

export function getVolumeSnapshotRetentionDays(): number {
  return readDaysSetting(VOLUME_SNAPSHOT_RETENTION_DAYS_KEY);
}

export function setVolumeSnapshotRetentionDays(days: number): void {
  writeDaysSetting(VOLUME_SNAPSHOT_RETENTION_DAYS_KEY, days);
}
