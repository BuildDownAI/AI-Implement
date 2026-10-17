/**
 * Orchestrator-side sealing of the Fly model-auth bootstrap (AII-500).
 *
 * Produces exactly the `SealedModelAuthBootstrapV1` that `openSealedModelAuthBootstrap`
 * (model-auth-client.ts) opens in the runner: AES-256-GCM, a random 12-byte nonce, a
 * 16-byte tag and AAD `sealedBootstrapAad(dispatchId, "fly")`. The protection key is an
 * injected input. It is never read from the environment here and is never the hosted
 * session-state key (model-session-store.ts). Errors carry a category only: no grant,
 * bearer or key bytes.
 */

import { createCipheriv, randomBytes } from "node:crypto";
import {
  MODEL_AUTH_ENV,
  SEALED_BOOTSTRAP_ALGORITHM,
  parseModelAuthGrantBootstrap,
  parseSealedModelAuthBootstrap,
  sealedBootstrapAad,
  type SealedModelAuthBootstrapV1,
} from "./model-auth-contract.js";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type ModelAuthSealErrorCategory =
  | "seal_grant_malformed"
  | "seal_backend_unsupported"
  | "seal_key_missing"
  | "seal_key_invalid"
  | "seal_key_reference_unsafe"
  | "seal_output_invalid";

export class ModelAuthSealError extends Error {
  readonly category: ModelAuthSealErrorCategory;
  constructor(category: ModelAuthSealErrorCategory) {
    super(`model-auth seal error: ${category}`);
    this.name = "ModelAuthSealError";
    this.category = category;
  }
}

/** The runner reads the protection key from this one platform-secret name; no other reference is safe. */
export function isSafeProtectionKeyRef(ref: unknown): ref is typeof MODEL_AUTH_ENV.protectionKey {
  return ref === MODEL_AUTH_ENV.protectionKey;
}

export interface ProtectionKeyInput {
  /** Platform secret name the key was resolved from; must be the canonical bootstrap-key name. */
  readonly ref: string;
  readonly key: Uint8Array;
}

/** Seals a validated Fly bootstrap grant for one dispatch. */
export function sealModelAuthBootstrap(input: {
  grant: unknown;
  protectionKey: ProtectionKeyInput | undefined;
}): SealedModelAuthBootstrapV1 {
  const parsed = parseModelAuthGrantBootstrap(input.grant);
  if (!parsed.ok) throw new ModelAuthSealError("seal_grant_malformed");
  const grant = parsed.value;
  if (grant.backend !== "fly") throw new ModelAuthSealError("seal_backend_unsupported");

  const pk = input.protectionKey;
  if (!pk || !pk.key) throw new ModelAuthSealError("seal_key_missing");
  if (!isSafeProtectionKeyRef(pk.ref)) throw new ModelAuthSealError("seal_key_reference_unsafe");
  if (!(pk.key instanceof Uint8Array) || pk.key.byteLength !== KEY_BYTES) throw new ModelAuthSealError("seal_key_invalid");

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(SEALED_BOOTSTRAP_ALGORITHM, pk.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(sealedBootstrapAad(grant.dispatchId, grant.backend), "utf8"));
  const plaintext = Buffer.from(JSON.stringify(grant), "utf8");
  let ciphertext: Buffer;
  try {
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  } finally {
    plaintext.fill(0);
  }
  const sealed = parseSealedModelAuthBootstrap({
    version: 1,
    algorithm: SEALED_BOOTSTRAP_ALGORITHM,
    dispatchId: grant.dispatchId,
    backend: "fly",
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
  if (!sealed.ok) throw new ModelAuthSealError("seal_output_invalid");
  return sealed.value;
}
