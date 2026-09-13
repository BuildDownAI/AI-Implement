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

/** Listeners registered via onDeployHoldCleared(), fired when clearDeployHold() actually clears a held lock (AII-636). */
const deployHoldClearedListeners: Array<() => void> = [];

/**
 * Registers a listener fired every time clearDeployHold() transitions the hold from
 * held to clear. Used to wake work that was refused while the hold was set (e.g. a
 * kg-refresh dispatch queued behind a deploy-hold 409) without that work needing to
 * poll isDeployHeld() itself. Returns an unregister function.
 */
export function onDeployHoldCleared(cb: () => void): () => void {
  deployHoldClearedListeners.push(cb);
  return () => {
    const idx = deployHoldClearedListeners.indexOf(cb);
    if (idx !== -1) deployHoldClearedListeners.splice(idx, 1);
  };
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
  if (held) {
    for (const cb of [...deployHoldClearedListeners]) {
      try {
        cb();
      } catch (err) {
        console.error("[deploy-hold] onDeployHoldCleared listener failed:", err);
      }
    }
  }
  return held;
}
