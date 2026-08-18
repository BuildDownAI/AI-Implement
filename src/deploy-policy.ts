import { getDb } from "./dedup.js";

const AUTO_DEPLOY_KEY = "deploy_auto";
const NOTIFY_AVAILABLE_KEY = "deploy_notify_available";
const LAST_ACTED_COMMIT_KEY = "deploy_last_acted_commit";

export type AvailabilityAction = "deploy" | "notify" | "none";

export interface DeployPolicy {
  /** Opt-in — deploy without being asked. Off unless explicitly enabled. */
  autoDeploy: boolean;
  /** Opt-out — announce an available deployment. On unless explicitly disabled. */
  notifyAvailable: boolean;
}

export interface AvailabilityDecisionInput {
  configured: boolean; // Whether this orchestrator can deploy itself at all — token, app and build stamps.
  available: boolean | null;
  headCommit: string | null;
  held: boolean;
  policy: DeployPolicy;
  lastActedCommit: string | null;
}

/**
 * What to do about the current availability. Pure — every input is passed in, so the
 * poll loop's only job is to gather them and carry out the verdict.
 */
export function decideAvailabilityAction(input: AvailabilityDecisionInput): AvailabilityAction {
  const { configured, available, headCommit, held, policy, lastActedCommit } = input;

  // Nothing is actionable on an orchestrator that cannot deploy itself
  if (!configured) return "none";

  // Only a confirmed new deployment is actionable. `null` is unknown, and acting on
  // unknown would deploy an orchestrator that may already be current.
  if (available !== true || !headCommit) return "none";

  // A deploy already holds. The starter would refuse it anyway, and announcing a
  // deployment that is already being built is noise rather than news.
  if (held) return "none";

  // One action per head commit, and deliberately shared by both branches: it bounds
  // the automatic attempt that a failing build must not repeat every cycle, and the
  // notice that must not repeat every poll. A new push is what re-arms either.
  if (headCommit === lastActedCommit) return "none";

  if (policy.autoDeploy) return "deploy";
  return policy.notifyAvailable ? "notify" : "none";
}

/**
 * The default is a parameter because the two flags default in opposite directions,
 * and it doubles as the answer when the database is unreachable. Both flags then
 * degrade to "behave as if unconfigured", which is the safe direction for each:
 * automatic deploying stays off, and notifications stay on rather than going quiet.
 */
function readFlag(key: string, whenAbsent: boolean): boolean {
  try {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? row.value === "1" : whenAbsent;
  } catch {
    return whenAbsent;
  }
}

export function getDeployPolicy(): DeployPolicy {
  return {
    autoDeploy: readFlag(AUTO_DEPLOY_KEY, false),
    notifyAvailable: readFlag(NOTIFY_AVAILABLE_KEY, true),
  };
}

/** The head commit this orchestrator last deployed or announced, across restarts. */
export function getLastActedCommit(): string | null {
  try {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(LAST_ACTED_COMMIT_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    // Unreadable reads as "not acted yet". The alternative — treating an error as
    // already-acted — would silently disable automatic deploying rather than repeat it.
    return null;
  }
}

/** Patch rather than replace, so toggling one flag cannot clobber the other. */
export function setDeployPolicy(patch: Partial<DeployPolicy>): void {
  const write = getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  if (patch.autoDeploy !== undefined) write.run(AUTO_DEPLOY_KEY, patch.autoDeploy ? "1" : "0");
  if (patch.notifyAvailable !== undefined) write.run(NOTIFY_AVAILABLE_KEY, patch.notifyAvailable ? "1" : "0");
}

export function setLastActedCommit(sha: string): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(LAST_ACTED_COMMIT_KEY, sha);
}
