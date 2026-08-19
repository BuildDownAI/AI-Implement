import { getDb } from "./dedup.js";

const DEPLOY_HOLD_KEY = "deploy_hold";
const DEPLOY_STARTED_AT_KEY = "deploy_started_at";

/** True while a deploy is holding new work back. */
export function isDeployHeld(): boolean {
  try {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(DEPLOY_HOLD_KEY) as { value: string } | undefined;
    return row?.value === "1";
  } catch {
    return false;
  }
}

/** When the current deploy claimed the hold, or null when nothing is held. */
export function getDeployStartedAt(): number | null {
  try {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(DEPLOY_STARTED_AT_KEY) as { value: string } | undefined;
    const ms = row ? Number(row.value) : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

export function setDeployHold(): void {
  const db = getDb();
  const alreadyHeld = isDeployHeld();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(DEPLOY_HOLD_KEY);

  // One deploy claims the hold twice — atomically at the trigger, then again inside
  // runDeploy. Only the first claim starts the clock, so elapsed covers the whole deploy.
  if (!alreadyHeld) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run(DEPLOY_STARTED_AT_KEY, String(Date.now()));
  }
}

/**
 * Clears the hold. Returns whether one was set — at boot that means the previous
 * process died mid-deploy, which is the only place the distinction is observable.
 */
export function clearDeployHold(): boolean {
  const held = isDeployHeld();
  getDb()
    .prepare("DELETE FROM settings WHERE key IN (?, ?)")
    .run(DEPLOY_HOLD_KEY, DEPLOY_STARTED_AT_KEY);
  return held;
}
