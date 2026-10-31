import { getDb } from "./dedup.js";
import { notifyDeploy, type DeployNotification } from "./notify.js";
import { sidecarHealthFields } from "./kg-provider.js";

export interface BootStateInput {
  currentImageRef: string;
  prevImageRef: string | null;
  lastShutdownAt: number | null;
  now: number;
}

export interface BootDecision {
  kind: "deployed" | "restarted";
  downtimeMs: number | null;
}

export interface DeployNotifyConfig {
  notifyType: string;
  notifyWebhookUrl: string | null;
  kgSidecarUrl: string | null;
}

/** The terminal SelfDeploy record, as far as this module reads it. Structural so this file never imports src/restate/. */
export interface DeployRecordLike {
  deployId: string;
  phase: string;
  target: { commit: string };
  finishedAt: number | null;
  reason: string | null;
}

export interface DeployOutcome {
  kind: "deployed-ok" | "deployed-not-serving" | "build-failed" | "deploy-failed" | "deploy-cancelled";
  /** null when the image was not stamped with AI_IMPLEMENT_SOURCE_COMMIT at build time */
  commit: string | null;
  timestamp: number;
  detail?: string;
}

const LAST_IMAGE_REF_KEY = "deploy_last_image_ref";
const LAST_SHUTDOWN_AT_KEY = "deploy_last_shutdown_at";
const DEPLOY_OUTCOME_KEY = "deploy_last_outcome";

function readSetting(key: string): string | null {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string | null): void {
  const db = getDb();
  if (value === null) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  } else {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }
}

export function decideBootNotification(input: BootStateInput): BootDecision | null {
  const { currentImageRef, prevImageRef, lastShutdownAt, now } = input;

  // best-effort, a clean shutdown records a timestamp while a hard kill does not
  const downtimeMs = lastShutdownAt != null ? Math.max(0, now - lastShutdownAt) : null;

  // Nothing remembered — first boot on a fresh volume. announcing a "deploy" here would fire on every new client app's first start.
  if (prevImageRef === null) return null;

  if (prevImageRef !== currentImageRef) return { kind: "deployed", downtimeMs };

  // Same version. Only speak if a shutdown notice went out, so the notification pair stays matched;
  // otherwise this is a boot nobody was told about.
  return lastShutdownAt != null ? { kind: "restarted", downtimeMs } : null;
}

/** Maps a terminal SelfDeploy record to the stored outcome; `detail` carries the reason code. */
export function outcomeFromDeployRecord(record: DeployRecordLike): DeployOutcome {
  const base = { commit: record.target.commit, timestamp: record.finishedAt ?? Date.now() };
  if (record.phase === "succeeded") return { kind: "deployed-ok", ...base };
  if (record.phase === "cancelled") return { kind: "deploy-cancelled", ...base };
  return { kind: "deploy-failed", ...base, ...(record.reason ? { detail: record.reason } : {}) };
}

/** Present only inside a Fly Machine, so it doubles as the "this is a real deployment" gate. */
function flyImageRef(): string | null {
  return process.env.FLY_IMAGE_REF || null;
}

export function isKgDegraded(): boolean {
  return process.env.KG_EMBEDDINGS_DEGRADED === "1";
}

function describe(kind: DeployNotification["kind"], imageRef: string, downtimeMs: number | null): DeployNotification {
  return {
    kind,
    appName: process.env.FLY_APP_NAME || "orchestrator",
    region: process.env.FLY_REGION || null,
    imageRef,
    downtimeMs,
    kgDegraded: isKgDegraded(),
    kgUnavailable: sidecarHealthFields().kgUnavailable,
    sidecarError: sidecarHealthFields().sidecar.lastError,
  };
}

export function getDeployOutcome(): DeployOutcome | null {
  const raw = readSetting(DEPLOY_OUTCOME_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DeployOutcome;
  } catch {
    return null;
  }
}

export function recordDeployOutcome(outcome: DeployOutcome): void {
  try {
    writeSetting(DEPLOY_OUTCOME_KEY, JSON.stringify(outcome));
  } catch (err) {
    console.error("[deploy-notify] failed to record deploy outcome:", err);
  }
}

/** Records the stop so the next boot can measure downtime. Must run before closeDb(). */
export function recordShutdown(): void {
  if (!flyImageRef()) return;
  try {
    writeSetting(LAST_SHUTDOWN_AT_KEY, String(Date.now()));
  } catch (err) {
    console.error("[deploy-notify] failed to record shutdown:", err);
  }
}

export async function postShutdownNotice(config: DeployNotifyConfig): Promise<void> {
  const imageRef = flyImageRef();
  if (!imageRef || !config.notifyWebhookUrl) return;
  try {
    await notifyDeploy(config.notifyType, config.notifyWebhookUrl, describe("shutdown", imageRef, null));
  } catch (err) {
    console.error("[deploy-notify] shutdown notice failed:", err);
  }
}

export async function postBootNotice(
  config: DeployNotifyConfig,
): Promise<void> {
  const imageRef = flyImageRef();
  if (!imageRef) return;

  const prevImageRef = readSetting(LAST_IMAGE_REF_KEY);

  const decision = decideBootNotification({
    currentImageRef: imageRef,
    prevImageRef,
    lastShutdownAt: Number(readSetting(LAST_SHUTDOWN_AT_KEY)) || null,
    now: Date.now(),
  });

  // State advances even when nothing is posted, and even when the webhook is unset — otherwise
  // a run with notifications disabled would leave a stale ref and mis-classify the next boot.
  // Every write here stays above this function's first await: it is called fire-and-forget,
  // so anything below one is lost whenever the webhook hangs.
  try {
    writeSetting(LAST_IMAGE_REF_KEY, imageRef);
    writeSetting(LAST_SHUTDOWN_AT_KEY, null);
  } catch (err) {
    console.error("[deploy-notify] failed to persist deploy state:", err);
  }

  if (!decision || !config.notifyWebhookUrl) return;
  try {
    await notifyDeploy(config.notifyType, config.notifyWebhookUrl, describe(decision.kind, imageRef, decision.downtimeMs));
  } catch (err) {
    console.error("[deploy-notify] boot notice failed:", err);
  }
}

/**
 * Announces a deployment the operator has to decide about. Unlike the boot and
 * shutdown notices this does not gate on FLY_IMAGE_REF: those describe this machine's
 * own lifecycle and would fire on every local Ctrl-C, while availability is a fact
 * about the repository against the running commit and is meaningful on any host.
 */
export async function postAvailableNotice(config: DeployNotifyConfig, commit: string): Promise<void> {
  if (!config.notifyWebhookUrl) return;
  try {
    await notifyDeploy(config.notifyType, config.notifyWebhookUrl, {
      kind: "available",
      appName: process.env.FLY_APP_NAME || "orchestrator",
      region: process.env.FLY_REGION || null,
      imageRef: null,
      commit,
    });
  } catch (err) {
    console.error("[deploy-notify] availability notice failed:", err);
  }
}

/**
 * The SelfDeploy object's `onOutcome`: stores the outcome and announces an unsuccessful end. Runs in
 * whichever process finishes the deploy (the new one, after a successful verify), so it reads only
 * SQLite and env. It never throws — the object retries a throwing effect, which would repeat the notice.
 */
export async function onSelfDeployOutcome(config: DeployNotifyConfig, record: DeployRecordLike): Promise<void> {
  const outcome = outcomeFromDeployRecord(record);
  recordDeployOutcome(outcome);
  console.log(`[self-deploy] ${record.deployId} outcome ${outcome.kind}${outcome.detail ? ` ${outcome.detail}` : ""}`);
  if (record.phase === "succeeded" || !config.notifyWebhookUrl) return;
  try {
    await notifyDeploy(config.notifyType, config.notifyWebhookUrl, {
      kind: outcome.kind === "deploy-cancelled" ? "deploy-cancelled" : "deploy-failed",
      appName: process.env.FLY_APP_NAME || "orchestrator",
      region: process.env.FLY_REGION || null,
      imageRef: null,
      commit: record.target.commit,
      detail: outcome.detail ?? null,
    });
  } catch (err) {
    console.error("[deploy-notify] deploy outcome notice failed:", err);
  }
}
