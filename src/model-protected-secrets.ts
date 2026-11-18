/**
 * Encrypted storage for API-key and Bedrock credentials (AII-1411), over `model_protected_secrets` (dedup.ts).
 *
 * AES-256-GCM under a key HKDF-derived from `RUNNER_TOKEN_SECRET` (model-session-keys.ts). The AAD binds the
 * ciphertext to the exact `model-account:` reference, so a row copied to another reference fails authentication.
 * Rotating `RUNNER_TOKEN_SECRET` orphans every row: the operator re-imports.
 *
 * The resolver is synchronous (ProtectedSecretResolver) and returns null for every failure; it never throws and
 * never falls back to an ambient variable. Results carry a fixed failure code, never a value or crypto error text.
 * Nothing is logged. Import/delete operator commands live elsewhere (AII-1422).
 */
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "./dedup.js";
import { parseModelAuthCheckoutResponse } from "./model-auth-contract.js";
import { MODEL_ACCOUNT_REF_PATTERN, type ProtectedSecretResolver, type ProtectedSecretValue } from "./model-credentials.js";
import { deriveModelProtectedSecretKey } from "./model-session-keys.js";

export const PROTECTED_SECRET_KEY_ID = "mps-v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type ProtectedSecretFailure =
  | "invalid_ref"
  | "invalid_value"
  | "key_unavailable"
  | "row_missing"
  | "decrypt_failed"
  | "write_failed";

export type ProtectedSecretOpenResult =
  | { readonly ok: true; readonly value: ProtectedSecretValue }
  | { readonly ok: false; readonly code: ProtectedSecretFailure };

export type ProtectedSecretWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ProtectedSecretFailure };

export interface ModelProtectedSecrets {
  /** Validates, encrypts, and upserts. */
  write(ref: string, value: ProtectedSecretValue): ProtectedSecretWriteResult;
  /** Idempotent; needs no key. */
  delete(ref: string): ProtectedSecretWriteResult;
  /** Like `resolve`, with the fixed failure category. */
  open(ref: string): ProtectedSecretOpenResult;
  /** Null for every failure; never throws. */
  resolve: ProtectedSecretResolver;
}

interface Row {
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  encryption_key_id: string;
}

function aad(ref: string): Buffer {
  return Buffer.from(JSON.stringify(["model-protected-secret", 1, ref]), "utf8");
}

function validRef(ref: unknown): ref is string {
  return typeof ref === "string" && MODEL_ACCOUNT_REF_PATTERN.test(ref);
}

/** Same validator the reader applies, so a stored value is always one the reader accepts. */
function validateValue(value: unknown): ProtectedSecretValue | null {
  if (typeof value === "string") {
    const parsed = parseModelAuthCheckoutResponse({
      version: 1, ok: true, profileId: "p", authMode: "anthropic-api-key",
      secret: { kind: "api-key", apiKey: value },
    });
    return parsed.ok && parsed.value.secret.kind === "api-key" ? parsed.value.secret.apiKey : null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = parseModelAuthCheckoutResponse({
    version: 1, ok: true, profileId: "p", authMode: "bedrock",
    secret: { kind: "aws-bedrock", ...(value as Record<string, unknown>) },
  });
  if (!parsed.ok || parsed.value.secret.kind !== "aws-bedrock") return null;
  const { region, accessKeyId, secretAccessKey, sessionToken } = parsed.value.secret;
  return sessionToken === undefined
    ? { region, accessKeyId, secretAccessKey }
    : { region, accessKeyId, secretAccessKey, sessionToken };
}

function encode(value: ProtectedSecretValue): string {
  return JSON.stringify(typeof value === "string" ? { t: "api-key", v: value } : { t: "bedrock", v: value });
}

function decode(text: string): ProtectedSecretValue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { t, v } = parsed as { t?: unknown; v?: unknown };
  if (t === "api-key" && typeof v === "string") return validateValue(v);
  if (t === "bedrock") return validateValue(v);
  return null;
}

export function createModelProtectedSecrets(
  options: { env?: NodeJS.ProcessEnv; db?: () => Database.Database; now?: () => number } = {},
): ModelProtectedSecrets {
  const database = options.db ?? getDb;
  const now = options.now ?? Date.now;

  // Re-derived per call so the store follows the live environment.
  function key(): Buffer | undefined {
    try {
      return deriveModelProtectedSecretKey(options.env ?? process.env);
    } catch {
      return undefined;
    }
  }

  function open(ref: string): ProtectedSecretOpenResult {
    if (!validRef(ref)) return { ok: false, code: "invalid_ref" };
    const k = key();
    if (!k) return { ok: false, code: "key_unavailable" };
    try {
      const row = database()
        .prepare("SELECT ciphertext, nonce, auth_tag, encryption_key_id FROM model_protected_secrets WHERE secret_ref = ?")
        .get(ref) as Row | undefined;
      if (!row) return { ok: false, code: "row_missing" };
      if (
        row.encryption_key_id !== PROTECTED_SECRET_KEY_ID ||
        !Buffer.isBuffer(row.ciphertext) || !Buffer.isBuffer(row.nonce) || row.nonce.length !== NONCE_BYTES ||
        !Buffer.isBuffer(row.auth_tag) || row.auth_tag.length !== TAG_BYTES
      ) {
        return { ok: false, code: "decrypt_failed" };
      }
      const decipher = crypto.createDecipheriv("aes-256-gcm", k, row.nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(ref));
      decipher.setAuthTag(row.auth_tag);
      const plain = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      const value = decode(plain.toString("utf8"));
      plain.fill(0);
      return value === null ? { ok: false, code: "invalid_value" } : { ok: true, value };
    } catch {
      return { ok: false, code: "decrypt_failed" }; // never echo the underlying error
    } finally {
      k.fill(0);
    }
  }

  return {
    write(ref, value) {
      if (!validRef(ref)) return { ok: false, code: "invalid_ref" };
      const valid = validateValue(value);
      if (valid === null) return { ok: false, code: "invalid_value" };
      const k = key();
      if (!k) return { ok: false, code: "key_unavailable" };
      try {
        const nonce = crypto.randomBytes(NONCE_BYTES);
        const cipher = crypto.createCipheriv("aes-256-gcm", k, nonce, { authTagLength: TAG_BYTES });
        cipher.setAAD(aad(ref));
        const plain = Buffer.from(encode(valid), "utf8");
        const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
        plain.fill(0);
        database()
          .prepare(
            `INSERT INTO model_protected_secrets (secret_ref, ciphertext, nonce, auth_tag, encryption_key_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(secret_ref) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
               auth_tag = excluded.auth_tag, encryption_key_id = excluded.encryption_key_id, updated_at = excluded.updated_at`,
          )
          .run(ref, ciphertext, nonce, cipher.getAuthTag(), PROTECTED_SECRET_KEY_ID, now());
        return { ok: true };
      } catch {
        return { ok: false, code: "write_failed" };
      } finally {
        k.fill(0);
      }
    },
    delete(ref) {
      if (!validRef(ref)) return { ok: false, code: "invalid_ref" };
      try {
        database().prepare("DELETE FROM model_protected_secrets WHERE secret_ref = ?").run(ref);
        return { ok: true };
      } catch {
        return { ok: false, code: "write_failed" };
      }
    },
    open,
    resolve(ref) {
      const r = open(ref);
      return r.ok ? r.value : null;
    },
  };
}
