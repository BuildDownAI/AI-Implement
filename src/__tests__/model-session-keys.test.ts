import { describe, it, expect, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createModelSessionKeyProvider, deriveModelAuthProtectionKey, MODEL_SESSION_KEY_ID } from "../model-session-keys.js";

const SECRET = "SENTINEL-RUNNER-TOKEN-SECRET-abc123";

function derive(secret: string, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", secret, "ai-implement", info, 32));
}

describe("createModelSessionKeyProvider", () => {
  it("derives a stable 32-byte key under id rts-v1", () => {
    const a = createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: SECRET });
    const b = createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: SECRET });
    const cur = a.current()!;
    expect(cur.keyId).toBe("rts-v1");
    expect(MODEL_SESSION_KEY_ID).toBe("rts-v1");
    expect(cur.key).toHaveLength(32);
    expect(cur.key.equals(a.current()!.key)).toBe(true);
    expect(cur.key.equals(b.current()!.key)).toBe(true);
    expect(a.get("rts-v1")!.equals(cur.key)).toBe(true);
    expect(cur.key.equals(derive(SECRET, "ai-implement/model-session-key/v1"))).toBe(true);
  });

  it("gives a different key for a different secret", () => {
    const a = createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: SECRET }).current()!.key;
    const b = createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: `${SECRET}-2` }).current()!.key;
    expect(a.equals(b)).toBe(false);
  });

  it("is independent of the secret, its HMAC use, and other HKDF labels", () => {
    const key = createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: SECRET }).current()!.key;
    expect(key.equals(crypto.createHash("sha256").update(SECRET).digest())).toBe(false);
    for (const payload of ["", "payload", "ai-implement/model-session-key/v1"]) {
      expect(key.equals(crypto.createHmac("sha256", SECRET).update(payload).digest())).toBe(false);
    }
    expect(key.equals(derive(SECRET, "ai-implement/other/v1"))).toBe(false);
  });

  it("returns undefined for an unknown key id", () => {
    expect(createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: SECRET }).get("rts-v2")).toBeUndefined();
  });

  it("returns undefined from both methods when the secret is unset or empty", () => {
    for (const env of [{}, { RUNNER_TOKEN_SECRET: "" }]) {
      const p = createModelSessionKeyProvider(env);
      expect(p.current()).toBeUndefined();
      expect(p.get("rts-v1")).toBeUndefined();
    }
  });

  it("follows the live environment on each call", () => {
    const env: NodeJS.ProcessEnv = {};
    const p = createModelSessionKeyProvider(env);
    expect(p.current()).toBeUndefined();
    env.RUNNER_TOKEN_SECRET = SECRET;
    const first = p.current()!.key;
    env.RUNNER_TOKEN_SECRET = "other-secret";
    expect(p.current()!.key.equals(first)).toBe(false);
  });

  it("defaults to process.env and never writes to it", () => {
    const before = JSON.stringify(process.env);
    vi.stubEnv("RUNNER_TOKEN_SECRET", SECRET);
    const snapshot = JSON.stringify(process.env);
    const p = createModelSessionKeyProvider();
    expect(p.current()!.key.equals(derive(SECRET, "ai-implement/model-session-key/v1"))).toBe(true);
    expect(JSON.stringify(process.env)).toBe(snapshot);
    vi.unstubAllEnvs();
    expect(JSON.stringify(process.env)).toBe(before);
    expect(p.current()).toBeUndefined();
  });
});

describe("store integration", () => {
  const dbPath = path.join(os.tmpdir(), `model-session-keys-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  it("fails key_unavailable without a secret and key_mismatch under another secret", async () => {
    vi.resetModules();
    process.env.DEDUP_DB_PATH = dbPath;
    const dedup = await import("../dedup.js");
    const { createModelSessionStore } = await import("../model-session-store.js");
    const env: NodeJS.ProcessEnv = {};
    const store = createModelSessionStore({
      keys: createModelSessionKeyProvider(env),
      verifyOwner: () => false,
      authorizeOperator: () => false,
    });
    const write = () => store.writePlanRecord({ profileId: "acct", expectedSequence: null, sessionData: '{"a":1}' });
    expect(write()).toMatchObject({ ok: false, reason: "key_unavailable" });
    env.RUNNER_TOKEN_SECRET = SECRET;
    expect(write().ok).toBe(true);
    expect(store.readPlanRecord("acct").ok).toBe(true);
    env.RUNNER_TOKEN_SECRET = "rotated-secret";
    expect(store.readPlanRecord("acct")).toMatchObject({ ok: false, reason: "key_mismatch" });
    dedup.closeDb();
  });
});

describe("deriveModelAuthProtectionKey", () => {
  it("is a stable 32-byte key from its own HKDF label", () => {
    const k = deriveModelAuthProtectionKey({ RUNNER_TOKEN_SECRET: SECRET })!;
    expect(k).toHaveLength(32);
    expect(k.equals(deriveModelAuthProtectionKey({ RUNNER_TOKEN_SECRET: SECRET })!)).toBe(true);
    expect(k.equals(derive(SECRET, "ai-implement/model-auth-protection-key/v1"))).toBe(true);
  });

  it("differs from the session key for the same secret", () => {
    const env = { RUNNER_TOKEN_SECRET: SECRET };
    expect(deriveModelAuthProtectionKey(env)!.equals(createModelSessionKeyProvider(env).current()!.key)).toBe(false);
  });

  it("is undefined without a secret", () => {
    expect(deriveModelAuthProtectionKey({})).toBeUndefined();
    expect(deriveModelAuthProtectionKey({ RUNNER_TOKEN_SECRET: "" })).toBeUndefined();
  });
});
