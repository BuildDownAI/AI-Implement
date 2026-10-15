/**
 * Hosted session key provider (AII-1355). Derives the 32-byte key that encrypts `model_session_generations`
 * from `RUNNER_TOKEN_SECRET`, which every hosted deployment already sets, so no new secret exists.
 *
 * The fixed HKDF info label keeps this key independent of the HMAC use of the same secret (runner callback
 * tokens). Rotating `RUNNER_TOKEN_SECRET` makes stored records unreadable (`key_mismatch`): sign in again.
 *
 * The secret is read on every call, so the provider follows the live environment. Nothing is written to
 * `process.env`, logged, or thrown; the key leaves only through `current()` and `get()`.
 */
import crypto from "node:crypto";
import type { SessionKeyProvider } from "./model-session-store.js";

export const MODEL_SESSION_KEY_ID = "rts-v1";
const HKDF_SALT = "ai-implement";
const HKDF_INFO = "ai-implement/model-session-key/v1";
const PROTECTION_HKDF_INFO = "ai-implement/model-auth-protection-key/v1";
const KEY_BYTES = 32;

export function createModelSessionKeyProvider(env: NodeJS.ProcessEnv = process.env): SessionKeyProvider {
  function derive(): Buffer | undefined {
    const secret = env.RUNNER_TOKEN_SECRET;
    if (!secret) return undefined;
    return Buffer.from(crypto.hkdfSync("sha256", secret, HKDF_SALT, HKDF_INFO, KEY_BYTES));
  }
  return {
    current() {
      const key = derive();
      return key ? { keyId: MODEL_SESSION_KEY_ID, key } : undefined;
    },
    get(keyId) {
      return keyId === MODEL_SESSION_KEY_ID ? derive() : undefined;
    },
  };
}

/**
 * Fly protection key (ADR 009): derived from `RUNNER_TOKEN_SECRET` with its own HKDF label, so it differs from the
 * hosted session key. Returns raw bytes; the consumer base64url-encodes it for the wire. `undefined` when the secret
 * is unset or empty.
 */
export function deriveModelAuthProtectionKey(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  const secret = env.RUNNER_TOKEN_SECRET;
  if (!secret) return undefined;
  return Buffer.from(crypto.hkdfSync("sha256", secret, HKDF_SALT, PROTECTION_HKDF_INFO, KEY_BYTES));
}
