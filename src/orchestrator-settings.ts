// src/orchestrator-settings.ts
import * as restateClients from "@restatedev/restate-sdk-clients";
import { getDb } from "./dedup.js";
import { RESTATE_INGRESS_BASE_URL } from "./restate/server.js";
import type { RunnerBackendDefinition } from "./restate/runner-backend.js";
import { DEFAULT_RETRY_POLICY, normalizeRetryPolicy, type RetryPolicy } from "./pipeline/retry-backoff.js";

export { DEFAULT_RETRY_POLICY, type RetryPolicy } from "./pipeline/retry-backoff.js";

const FLY_SESSIONS_APP_KEY = "fly_sessions_app";
const FLY_SESSIONS_REGION_KEY = "fly_sessions_region";
const RETRY_POLICY_KEY = "retry_policy";
const KG_REFRESH_REPORT_ISSUE_KEY = "kg_refresh_report_issue";
export const KG_BASE_REPO_KEY = "kg_base_repo";
export const LINEAR_PICKUP_LABEL_KEY = "linear_pickup_label";
export const RUNNER_IMAGE_ALLOWED_PREFIXES_KEY = "runner_image_allowed_prefixes";

/** Default Linear pickup label when no `linear_pickup_label` row exists (AII-694). */
export const DEFAULT_LINEAR_PICKUP_LABEL = "AI-Implement";

type SettingKey = "flySessionsApp" | "flySessionsRegion" | "kgRefreshReportIssue" | "kgBaseRepo" | "linearPickupLabel" | "runnerImageAllowedPrefixes";

const SETTING_KEYS: Record<SettingKey, string> = {
  flySessionsApp: FLY_SESSIONS_APP_KEY,
  flySessionsRegion: FLY_SESSIONS_REGION_KEY,
  kgRefreshReportIssue: KG_REFRESH_REPORT_ISSUE_KEY,
  kgBaseRepo: KG_BASE_REPO_KEY,
  linearPickupLabel: LINEAR_PICKUP_LABEL_KEY,
  runnerImageAllowedPrefixes: RUNNER_IMAGE_ALLOWED_PREFIXES_KEY,
};

export interface OrchestratorSettings {
  flySessionsApp: string | null;
  flySessionsRegion: string | null;
  /** Linear issue identifier (e.g. "AII-496") to receive kg-refresh failure comments. */
  kgRefreshReportIssue: string | null;
  /** owner/repo of the base template repo the KG PR-triggered dry-run check watches (AII-633). Seeded once from KG_BASE_REPO. */
  kgBaseRepo: string | null;
  /** Linear label the provider polls for pickup (AII-694). Seeded once from LINEAR_PICKUP_LABEL. */
  linearPickupLabel: string | null;
  /** Comma-separated extra trusted runner-image prefixes (AII-1321). Seeded once from RUNNER_IMAGE_ALLOWED_PREFIXES. */
  runnerImageAllowedPrefixes: string | null;
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
      linearPickupLabel: get(LINEAR_PICKUP_LABEL_KEY),
      runnerImageAllowedPrefixes: get(RUNNER_IMAGE_ALLOWED_PREFIXES_KEY),
    };
  } catch {
    return {
      flySessionsApp: null,
      flySessionsRegion: null,
      kgRefreshReportIssue: null,
      kgBaseRepo: null,
      linearPickupLabel: null,
      runnerImageAllowedPrefixes: null,
    };
  }
}

export interface FlySessionsConfig {
  /** FLY_SESSIONS_TOKEN only; never stored in the settings table or in Restate. */
  token: string | null;
  app: string | null;
  region: string | null;
  source: { app: "restate" | "env" | "settings" | null; region: "restate" | "env" | "settings" | null };
}

/** The last `RunnerBackend/fly-machines` state read from Restate (AII-1243); `loaded` is false until the first read. */
const flyBackendCache: { loaded: boolean; app: string | null; region: string | null } = { loaded: false, app: null, region: null };
let runnerBackendOutageLogged = false;

/**
 * The Fly sessions token, app, and region. The token comes from env only. App and region come from
 * the `RunnerBackend/fly-machines` cache once one read has succeeded; before that, from the env
 * var, else the settings row, else null (so a boot with Restate down still dispatches). Stays
 * synchronous: `refreshRunnerBackendCache()` fills the cache at boot and once per poll cycle.
 */
export function getFlySessionsConfig(): FlySessionsConfig {
  const token = process.env.FLY_SESSIONS_TOKEN || null;
  if (flyBackendCache.loaded) {
    return {
      token,
      app: flyBackendCache.app,
      region: flyBackendCache.region,
      source: { app: flyBackendCache.app ? "restate" : null, region: flyBackendCache.region ? "restate" : null },
    };
  }
  const envApp = process.env.FLY_SESSIONS_APP || null;
  const envRegion = process.env.FLY_SESSIONS_REGION || null;
  const rows = envApp && envRegion ? null : getOrchestratorSettings();
  const pick = (env: string | null, row: string | null | undefined) => {
    if (env) return { value: env, source: "env" as const };
    if (row) return { value: row, source: "settings" as const };
    return { value: null, source: null };
  };
  const app = pick(envApp, rows?.flySessionsApp);
  const region = pick(envRegion, rows?.flySessionsRegion);
  return {
    token,
    app: app.value,
    region: region.value,
    source: { app: app.source, region: region.source },
  };
}

/** Where `getFlySessionsConfig()` app and region come from right now: the Restate object, or the env-then-row fallback. */
export function getRunnerBackendSource(): "restate" | "fallback" {
  return flyBackendCache.loaded ? "restate" : "fallback";
}

/** Test seam: forgets the cached read and the outage latch. */
export function resetRunnerBackendCache(): void {
  flyBackendCache.loaded = false;
  flyBackendCache.app = null;
  flyBackendCache.region = null;
  runnerBackendOutageLogged = false;
}

/** Bounds the per-poll read so a down Restate cannot eat the poll cycle's budget. */
const RUNNER_BACKEND_READ_TIMEOUT_MS = 3_000;

export interface RunnerBackendCacheDeps {
  /** Reads `RunnerBackend/fly-machines`; null when the object holds nothing. Throws when Restate is unreachable. */
  readFlyMachines?: () => Promise<{ app?: string | null; region?: string | null } | null>;
}

async function readFlyMachinesViaIngress(): Promise<{ app?: string | null; region?: string | null } | null> {
  const ingress = restateClients.connect({ url: RESTATE_INGRESS_BASE_URL });
  const read = ingress.objectClient<RunnerBackendDefinition>({ name: "RunnerBackend" }, "fly-machines")
    .get(restateClients.rpc.opts<unknown, Record<string, unknown> | null>({ timeout: RUNNER_BACKEND_READ_TIMEOUT_MS }));
  return (await read) as { app?: string | null; region?: string | null } | null;
}

/**
 * Replaces the Fly app/region cache from `RunnerBackend/fly-machines`. On failure it keeps the last
 * value and logs once per outage; the latch re-arms after the next success. An empty object (the seed
 * has not landed) is "no value yet" and leaves the fallback in place. Never throws.
 */
export async function refreshRunnerBackendCache(deps: RunnerBackendCacheDeps = {}): Promise<void> {
  try {
    const state = await (deps.readFlyMachines ?? readFlyMachinesViaIngress)();
    runnerBackendOutageLogged = false;
    if (!state) return;
    flyBackendCache.app = state.app ?? null;
    flyBackendCache.region = state.region ?? null;
    flyBackendCache.loaded = true;
  } catch (err) {
    if (runnerBackendOutageLogged) return;
    runnerBackendOutageLogged = true;
    const serving = flyBackendCache.loaded
      ? `app=${flyBackendCache.app ?? "none"} region=${flyBackendCache.region ?? "none"}`
      : "the env-then-settings fallback";
    console.warn(`[runner-backend] Restate unreachable; serving last value (${serving}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface RunnerBackendSeedDeps {
  /** Sends `seed` for one backend key; resolves once the ingress accepted it. */
  sendSeed?: (backend: "fly-machines" | "github-actions", state: Record<string, unknown>, idempotencyKey: string) => Promise<void>;
}

/**
 * Boot seed (ADR 022 seed-once): copies FLY_SESSIONS_APP / FLY_SESSIONS_REGION, else the settings rows,
 * into `RunnerBackend/fly-machines`, and `{}` into `github-actions`. `seed` writes only when the object
 * is empty, so after the first boot the env vars and rows are inert. With nothing configured the
 * fly-machines seed is skipped, leaving the object empty so a later env var still applies via the
 * fallback. A failed send logs and returns; the next boot retries.
 */
export async function seedRunnerBackends(deps: RunnerBackendSeedDeps = {}): Promise<void> {
  const sendSeed = deps.sendSeed ?? (async (backend, state, key) => {
    const ingress = restateClients.connect({ url: RESTATE_INGRESS_BASE_URL });
    await ingress.objectSendClient<RunnerBackendDefinition>({ name: "RunnerBackend" }, backend)
      .seed(state, restateClients.rpc.sendOpts({ idempotencyKey: key }));
  });
  const rows = getOrchestratorSettings();
  const app = process.env.FLY_SESSIONS_APP || rows.flySessionsApp || null;
  const region = process.env.FLY_SESSIONS_REGION || rows.flySessionsRegion || null;
  try {
    if (app !== null || region !== null) await sendSeed("fly-machines", { app, region }, "seed:runner-backend:fly-machines");
    await sendSeed("github-actions", {}, "seed:runner-backend:github-actions");
  } catch (err) {
    console.error(`[runner-backend] could not seed RunnerBackend; the env vars and settings rows keep serving: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Effective Linear pickup label: the trimmed stored value when present and non-empty,
 * else DEFAULT_LINEAR_PICKUP_LABEL. Falls back to the default on any DB error (missing
 * table, etc.) so pickup never stops because the settings table is unreadable.
 */
export function getLinearPickupLabel(): string {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(LINEAR_PICKUP_LABEL_KEY) as
      | { value: string }
      | undefined;
    const value = row?.value?.trim();
    return value ? value : DEFAULT_LINEAR_PICKUP_LABEL;
  } catch {
    return DEFAULT_LINEAR_PICKUP_LABEL;
  }
}

/**
 * Extra trusted runner-image prefixes (AII-1321): the stored comma-separated value, split,
 * trimmed, empties dropped. Returns [] with no row and on any DB error, so an unreadable
 * table never widens the allowlist.
 */
export function getRunnerImageAllowedPrefixes(): string[] {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(RUNNER_IMAGE_ALLOWED_PREFIXES_KEY) as
      | { value: string }
      | undefined;
    return (row?.value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  } catch {
    return [];
  }
}

/**
 * Validates a runner-image prefix list (AII-1397) for both the settings API and the env seed;
 * returns the string to store (null = delete) or an error.
 */
export function validateRunnerImagePrefixes(raw: unknown): { value: string | null } | { error: string } {
  if (raw !== null && typeof raw !== "string") {
    return { error: "runnerImageAllowedPrefixes must be a string or null" };
  }
  if (raw === null || raw.trim() === "") return { value: null };
  if (raw.length > 1000) return { error: "runnerImageAllowedPrefixes must be 1000 characters or fewer" };
  const entries = raw.split(",").map((e) => e.trim()).filter((e) => e !== "");
  for (const entry of entries) {
    if (!/^[A-Za-z0-9._:/@-]+$/.test(entry)) {
      return { error: "each prefix may contain only letters, digits and . _ : / @ -" };
    }
    if (!entry.endsWith("/")) return { error: 'each prefix must end with "/"' };
    if (!entry.slice(0, -1).includes("/")) {
      return { error: "each prefix must include a path after the registry host" };
    }
    if (entry.startsWith("/") || entry.includes("//")) {
      return { error: "each prefix must not contain empty path segments" };
    }
  }
  return { value: entries.length > 0 ? entries.join(",") : null };
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
