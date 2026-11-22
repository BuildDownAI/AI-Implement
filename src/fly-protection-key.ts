/**
 * Protection key delivery for protected Fly machines (AII-1388, ADR 009). The orchestrator derives the key
 * from `RUNNER_TOKEN_SECRET`, writes it once to the sessions app as a Fly secret, and remembers the
 * secrets version so machine configs can pin `min_secrets_version`. The key value never leaves this module
 * except as the secret value; logs, errors and the settings row hold only a fingerprint and a version.
 */
import crypto from "node:crypto";
import { getDb } from "./dedup.js";
import { MODEL_AUTH_ENV, type ModelAuthGrantBootstrapV1 } from "./model-auth-contract.js";
import { sealModelAuthBootstrap } from "./model-auth-seal.js";
import { deriveModelAuthProtectionKey } from "./model-session-keys.js";
import { putAppSecretsVersioned, type ProtectedBootstrapSecretMetadata, type ProtectedModelBootstrapInput } from "./fly-machines.js";
import { initSettingsTable } from "./runner-mode.js";
import type { RunConfigV1 } from "./run-config.js";

const SETTING_KEY = "fly_protection_key_secret";
const FINGERPRINT_LABEL = "ai-implement/model-auth-protection-key-fingerprint/v1";

export class ProtectionKeyError extends Error {
  readonly category: "protection_key_unavailable";
  constructor(category: "protection_key_unavailable") {
    super(`protection key error: ${category}`);
    this.name = "ProtectionKeyError";
    this.category = category;
  }
}

function fingerprintOf(key: Buffer): string {
  return crypto.createHmac("sha256", key).update(FINGERPRINT_LABEL).digest("hex").slice(0, 16);
}

function readStored(): { fingerprint: string; version: number } | undefined {
  try {
    initSettingsTable();
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(SETTING_KEY) as { value: string } | undefined;
    if (!row) return undefined;
    const parsed = JSON.parse(row.value) as { fingerprint?: unknown; version?: unknown };
    if (typeof parsed.fingerprint === "string" && typeof parsed.version === "number" && Number.isInteger(parsed.version) && parsed.version >= 1) {
      return { fingerprint: parsed.fingerprint, version: parsed.version };
    }
  } catch {
    // Unreadable row: treat as absent and write again (idempotent).
  }
  return undefined;
}

/** Writes the derived key once, remembers {fingerprint, version} in the settings table. */
export async function ensureProtectionKeySecret(input: {
  token: string;
  app: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProtectedBootstrapSecretMetadata> {
  const key = deriveModelAuthProtectionKey(input.env ?? process.env);
  if (!key) throw new ProtectionKeyError("protection_key_unavailable");
  const fingerprint = fingerprintOf(key);
  const stored = readStored();
  if (stored && stored.fingerprint === fingerprint) {
    return { name: MODEL_AUTH_ENV.protectionKey, available: true, version: stored.version };
  }
  const version = await putAppSecretsVersioned(input.token, input.app, {
    [MODEL_AUTH_ENV.protectionKey]: key.toString("base64url"),
  });
  initSettingsTable();
  // One JSON value so a crash cannot leave a matching fingerprint beside a stale version.
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(SETTING_KEY, JSON.stringify({ fingerprint, version }));
  console.log(`protection key secret written (version ${version})`);
  return { name: MODEL_AUTH_ENV.protectionKey, available: true, version };
}

/** Seals the bootstrap and returns the builder input. Throws value-free errors only. */
export async function buildProtectedFlyBootstrap(input: {
  token: string;
  app: string;
  bootstrap: ModelAuthGrantBootstrapV1;
  projectKey: string;
  runConfig: RunConfigV1;
  modelAuthUrl: string;
}): Promise<ProtectedModelBootstrapInput> {
  const secret = await ensureProtectionKeySecret({ token: input.token, app: input.app });
  const key = deriveModelAuthProtectionKey();
  if (!key) throw new ProtectionKeyError("protection_key_unavailable");
  const sealed = sealModelAuthBootstrap({
    grant: input.bootstrap,
    protectionKey: { ref: MODEL_AUTH_ENV.protectionKey, key },
  });
  return { sealed, projectKey: input.projectKey, modelAuthUrl: input.modelAuthUrl, runConfig: input.runConfig, secret };
}
