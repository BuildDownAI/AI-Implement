import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { ModelAuthSealError, isSafeProtectionKeyRef, sealModelAuthBootstrap } from "../model-auth-seal.js";
import { ModelAuthClientError, openSealedModelAuthBootstrap, type ExpectedBootstrapContext } from "../model-auth-client.js";
import {
  MODEL_AUTH_ENV,
  SEALED_NONCE_LENGTH,
  SEALED_TAG_LENGTH,
  parseSealedModelAuthBootstrap,
  type ModelAuthGrantBootstrapV1,
} from "../model-auth-contract.js";

// Synthetic sentinels only. No real credential, no network.
const S_BEARER = "SENTINELbearer0123456789abcdefghijklmnop";
const NOW = 1_700_000_000_000;
const ctx: ExpectedBootstrapContext = { dispatchId: "disp-1", projectKey: "proj", snapshotId: "snap-1", backend: "fly" };

function grant(overrides: Partial<ModelAuthGrantBootstrapV1> = {}): ModelAuthGrantBootstrapV1 {
  return {
    version: 1,
    audience: "model-auth",
    grantId: "grant-1",
    dispatchId: "disp-1",
    projectKey: "proj",
    snapshotId: "snap-1",
    backend: "fly",
    expiresAt: NOW + 60_000,
    bearer: S_BEARER,
    bindings: [{ stage: "implementation", profileId: "sub", profileRevision: 1, authMode: "codex-subscription", ownerGeneration: 3 }],
    ...overrides,
  };
}

const key = randomBytes(32);
const pk = (k: Uint8Array = key, ref: string = MODEL_AUTH_ENV.protectionKey) => ({ ref, key: k });
const open = (sealed: unknown, k: Uint8Array = key, expected = ctx) =>
  openSealedModelAuthBootstrap({ sealed, protectionKey: k, expected, now: () => NOW });
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as ModelAuthClientError).category;
  }
  return undefined;
};
const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);

describe("sealModelAuthBootstrap", () => {
  it("round-trips through the real runner open function", () => {
    const sealed = sealModelAuthBootstrap({ grant: grant(), protectionKey: pk() });
    expect(parseSealedModelAuthBootstrap(sealed).ok).toBe(true);
    expect(sealed.nonce).toHaveLength(SEALED_NONCE_LENGTH);
    expect(sealed.tag).toHaveLength(SEALED_TAG_LENGTH);
    expect(sealed.backend).toBe("fly");
    expect(sealed.dispatchId).toBe("disp-1");
    expect(open(sealed)).toEqual(grant());
  });

  it("emits only the sealed envelope fields and no plaintext grant data", () => {
    const sealed = sealModelAuthBootstrap({ grant: grant(), protectionKey: pk() });
    expect(Object.keys(sealed).sort()).toEqual(["algorithm", "backend", "ciphertext", "dispatchId", "nonce", "tag", "version"]);
    expect(JSON.stringify(sealed)).not.toContain(S_BEARER);
  });

  it("uses a fresh nonce and ciphertext each time", () => {
    const sealed = Array.from({ length: 20 }, () => sealModelAuthBootstrap({ grant: grant(), protectionKey: pk() }));
    expect(new Set(sealed.map((s) => s.nonce)).size).toBe(20);
    expect(new Set(sealed.map((s) => s.ciphertext)).size).toBe(20);
  });

  it("fails to open with the wrong key", () => {
    const sealed = sealModelAuthBootstrap({ grant: grant(), protectionKey: pk() });
    expect(codeOf(() => open(sealed, randomBytes(32)))).toBe("bootstrap_authentication_failed");
  });

  it("fails to open when the dispatch binding is changed", () => {
    const sealed = sealModelAuthBootstrap({ grant: grant(), protectionKey: pk() });
    expect(codeOf(() => open({ ...sealed, dispatchId: "disp-2" }))).toBe("bootstrap_authentication_failed");
    expect(codeOf(() => open(sealed, key, { ...ctx, dispatchId: "disp-2" }))).toBe("bootstrap_context_mismatch");
  });

  it("fails to open when the nonce, ciphertext or tag is altered", () => {
    const sealed = sealModelAuthBootstrap({ grant: grant(), protectionKey: pk() });
    for (const field of ["nonce", "ciphertext", "tag"] as const) {
      expect(codeOf(() => open({ ...sealed, [field]: flip(sealed[field]) }))).toBe("bootstrap_authentication_failed");
    }
  });

  it("rejects an envelope sealed under a different backend", () => {
    const sealed = sealModelAuthBootstrap({ grant: grant(), protectionKey: pk() });
    expect(codeOf(() => open({ ...sealed, backend: "bedrock" }))).toBe("bootstrap_malformed");
  });

  it("rejects a non-fly or malformed grant without echoing it", () => {
    const run = (g: unknown) => {
      try {
        sealModelAuthBootstrap({ grant: g, protectionKey: pk() });
      } catch (e) {
        return e as ModelAuthSealError;
      }
      throw new Error("expected throw");
    };
    expect(run(grant({ backend: "github-actions" as never })).category).toMatch(/seal_(backend_unsupported|grant_malformed)/);
    const bad = run({ ...grant(), extra: "x" });
    expect(bad).toBeInstanceOf(ModelAuthSealError);
    expect(bad.category).toBe("seal_grant_malformed");
    expect(bad.message).not.toContain(S_BEARER);
    expect(run(null).category).toBe("seal_grant_malformed");
  });

  it("rejects a missing, short, long or unsafely-referenced key with value-free errors", () => {
    const category = (k: Parameters<typeof sealModelAuthBootstrap>[0]["protectionKey"]) => {
      try {
        sealModelAuthBootstrap({ grant: grant(), protectionKey: k });
      } catch (e) {
        const err = e as ModelAuthSealError;
        expect(err.message).not.toContain(S_BEARER);
        expect(err.message).not.toContain(Buffer.from(key).toString("base64url"));
        return err.category;
      }
      return undefined;
    };
    expect(category(undefined)).toBe("seal_key_missing");
    expect(category(pk(randomBytes(31)))).toBe("seal_key_invalid");
    expect(category(pk(randomBytes(33)))).toBe("seal_key_invalid");
    expect(category(pk(key, "SESSION_STATE_KEY"))).toBe("seal_key_reference_unsafe");
    expect(category(pk(key, ""))).toBe("seal_key_reference_unsafe");
  });

  it("accepts only the canonical protection-key reference", () => {
    expect(isSafeProtectionKeyRef(MODEL_AUTH_ENV.protectionKey)).toBe(true);
    expect(isSafeProtectionKeyRef("ENG_AI_IMPLEMENT_MODEL_AUTH_PROTECTION_KEY")).toBe(false);
    expect(isSafeProtectionKeyRef(undefined)).toBe(false);
  });
});
