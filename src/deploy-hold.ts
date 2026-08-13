import { getDb } from "./dedup.js";

const DEPLOY_HOLD_KEY = "deploy_hold";

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

export function setDeployHold(): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')")
    .run(DEPLOY_HOLD_KEY);
}

/**
 * Clears the hold. Returns whether one was set — at boot that means the previous
 * process died mid-deploy, which is the only place the distinction is observable.
 */
export function clearDeployHold(): boolean {
  const held = isDeployHeld();
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(DEPLOY_HOLD_KEY);
  return held;
}
