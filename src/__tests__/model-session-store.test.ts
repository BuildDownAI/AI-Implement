import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type * as DedupModule from "../dedup.js";
import type * as StoreModule from "../model-session-store.js";

const SENTINEL = "SYNTH-SESSION-TOKEN-abc123";
const KEY_A = crypto.createHash("sha256").update("synthetic-key-a").digest();
const KEY_B = crypto.createHash("sha256").update("synthetic-key-b").digest();
const OPERATOR = { synthetic: "operator" };

let dbPath: string;
let dedup: typeof DedupModule;
let mod: typeof StoreModule;
let owners: Map<string, number>;
let keys: Map<string, Buffer>;
let currentKeyId: string | undefined;

function provider(): StoreModule.SessionKeyProvider {
  return {
    current: () => (currentKeyId && keys.has(currentKeyId) ? { keyId: currentKeyId, key: keys.get(currentKeyId)! } : undefined),
    get: (id) => keys.get(id),
  };
}

function makeStore(extra: Partial<StoreModule.ModelSessionStoreOptions> = {}) {
  return mod.createModelSessionStore({
    keys: provider(),
    verifyOwner: (_db, profileId, gen) => owners.get(profileId) === gen,
    authorizeOperator: (op) => op === OPERATOR,
    ...extra,
  });
}

function session(n = 0) {
  return `${SENTINEL}-${n}`;
}

async function boot() {
  vi.resetModules();
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  mod = await import("../model-session-store.js");
  dedup.getDb();
}

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `model-session-store-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  owners = new Map([["p1", 1], ["p2", 1]]);
  keys = new Map([["k1", KEY_A]]);
  currentKeyId = "k1";
  await boot();
});

afterEach(() => {
  dedup.closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
});

function imported() {
  const store = makeStore();
  const r = store.importSession({ profileId: "p1", ownerGeneration: 1, sessionData: session(0), operator: OPERATOR });
  expect(r.ok).toBe(true);
  return store;
}

function rowCount(profile = "p1"): number {
  return (dedup.getDb().prepare("SELECT COUNT(*) AS n FROM model_session_generations WHERE profile_id = ?").get(profile) as { n: number }).n;
}

describe("model session store", () => {
  it("survives restart and decrypts for its profile", async () => {
    const store = imported();
    expect(store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: session(1) }).ok).toBe(true);
    dedup.closeDb();
    await boot();
    const read = makeStore().read("p1", 1);
    expect(read).toMatchObject({ ok: true, stateSequence: 1, sessionData: session(1), ownerGeneration: 1 });
  });

  it("keeps the plaintext sentinel out of the database file and columns", () => {
    const store = imported();
    store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: session(1) });
    const rows = dedup.getDb().prepare("SELECT * FROM model_session_generations").all() as Record<string, unknown>[];
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
    for (const r of rows) expect(Buffer.from(r.encrypted_session_state as Buffer).includes(Buffer.from(SENTINEL))).toBe(false);
    dedup.getDb().pragma("wal_checkpoint(TRUNCATE)");
    for (const suffix of ["", "-wal"]) {
      if (fs.existsSync(dbPath + suffix)) expect(fs.readFileSync(dbPath + suffix).includes(Buffer.from(SENTINEL))).toBe(false);
    }
  });

  it("binds ciphertext to profile, generation and sequence", () => {
    const store = imported();
    const db = dedup.getDb();
    owners.set("p2", 1);
    // Move the row to another profile.
    db.prepare("UPDATE model_session_generations SET profile_id = 'p2'").run();
    expect(store.read("p2", 1)).toMatchObject({ ok: false, category: "recovery_required", reason: "state_corrupt" });
    db.prepare("UPDATE model_session_generations SET profile_id = 'p1', owner_generation = 2").run();
    owners.set("p1", 2);
    expect(store.read("p1", 2)).toMatchObject({ ok: false, category: "recovery_required" });
    db.prepare("UPDATE model_session_generations SET owner_generation = 1, checkpoint_sequence = 5").run();
    owners.set("p1", 1);
    expect(store.read("p1", 1)).toMatchObject({ ok: false, category: "recovery_required" });
  });

  it.each(["encrypted_session_state", "nonce", "auth_tag"])("detects a flipped byte in %s", (col) => {
    const store = imported();
    const db = dedup.getDb();
    const row = db.prepare(`SELECT ${col} AS v FROM model_session_generations`).get() as { v: Buffer };
    const copy = Buffer.from(row.v);
    copy[0] ^= 1;
    db.prepare(`UPDATE model_session_generations SET ${col} = ?`).run(copy);
    expect(store.read("p1", 1)).toMatchObject({ ok: false, category: "recovery_required" });
    expect(store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: session(1) }))
      .toMatchObject({ ok: false, category: "recovery_required" });
    expect(rowCount()).toBe(1);
  });

  it("reports missing and wrong keys as authentication_required without leaking values", () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const store = imported();
    keys.delete("k1");
    const missing = store.read("p1", 1);
    keys.set("k1", KEY_B);
    const wrong = store.read("p1", 1);
    expect(missing).toMatchObject({ ok: false, category: "authentication_required", reason: "key_unavailable" });
    expect(wrong).toMatchObject({ ok: false, category: "authentication_required", reason: "key_mismatch" });
    const serialized = JSON.stringify([missing, wrong]);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain(KEY_A.toString("hex"));
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it("reads rotated-out keys by id and writes with the current key", () => {
    const store = imported();
    keys.set("k2", KEY_B);
    currentKeyId = "k2";
    expect(store.read("p1", 1)).toMatchObject({ ok: true, sessionData: session(0) });
    expect(store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: session(1) }).ok).toBe(true);
    expect(store.read("p1", 1)).toMatchObject({ ok: true, sessionData: session(1) });
  });

  it("fails with no key for writes", () => {
    currentKeyId = undefined;
    const r = makeStore().importSession({ profileId: "p1", ownerGeneration: 1, sessionData: session(), operator: OPERATOR });
    expect(r).toMatchObject({ ok: false, category: "authentication_required" });
    expect(rowCount()).toBe(0);
  });

  describe("checkpoint compare-and-set", () => {
    it("commits the next sequence", () => {
      const store = imported();
      expect(store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: session(1) }))
        .toMatchObject({ ok: true, idempotent: false });
      expect(rowCount()).toBe(2);
    });

    it("acknowledges a duplicate with the same payload without a new row, despite random nonces", () => {
      const store = imported();
      store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: session(1) });
      const before = rowCount();
      expect(store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: session(1) }))
        .toMatchObject({ ok: true, idempotent: true });
      expect(rowCount()).toBe(before);
    });

    it("rejects conflicting payload, stale sequence, gap, unknown and stale owners", () => {
      const store = imported();
      store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: session(1) });
      const cp = (p: Partial<StoreModule.CheckpointInput>) =>
        store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: session(1), ...p });
      expect(cp({ sessionData: "different" })).toMatchObject({ ok: false, reason: "conflicting_payload" });
      expect(cp({ stateSequence: 0 })).toMatchObject({ ok: false, reason: "stale_sequence" });
      expect(cp({ stateSequence: 3 })).toMatchObject({ ok: false, reason: "sequence_gap" });
      expect(cp({ profileId: "unknown" })).toMatchObject({ ok: false, category: "stale_owner", reason: "owner_rejected" });
      owners.set("p1", 2); // the reservation moved on; generation 1 is no longer owner
      expect(cp({ stateSequence: 2 })).toMatchObject({ ok: false, category: "stale_owner", reason: "owner_rejected" });
      expect(rowCount()).toBe(2);
    });

    it("rejects a lower generation than the stored state even if the seam says it owns", () => {
      const store = imported();
      dedup.getDb().prepare("UPDATE model_session_generations SET owner_generation = 3").run();
      // Re-encrypting is not possible by UPDATE; use a fresh profile state at generation 3 instead.
      dedup.getDb().prepare("DELETE FROM model_session_generations").run();
      owners.set("p1", 3);
      expect(store.importSession({ profileId: "p1", ownerGeneration: 3, sessionData: session(), operator: OPERATOR }).ok).toBe(true);
      owners.set("p1", 1);
      expect(store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: session(1) }))
        .toMatchObject({ ok: false, reason: "stale_generation" });
    });

    it("continues the sequence under a newer owner generation", () => {
      const store = imported();
      owners.set("p1", 2);
      expect(store.read("p1", 2)).toMatchObject({ ok: true, ownerGeneration: 1, stateSequence: 0 });
      expect(store.checkpoint({ profileId: "p1", ownerGeneration: 2, stateSequence: 1, sessionData: session(1) }).ok).toBe(true);
      expect(store.read("p1", 2)).toMatchObject({ ok: true, ownerGeneration: 2, stateSequence: 1 });
    });

    it("writes distinct nonces for identical payloads", () => {
      const store = imported();
      store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: session(0) });
      const rows = dedup.getDb().prepare("SELECT nonce FROM model_session_generations").all() as { nonce: Buffer }[];
      expect(new Set(rows.map((r) => r.nonce.toString("hex"))).size).toBe(rows.length);
    });

    it("rejects oversized and empty data", () => {
      const store = imported();
      const big = "x".repeat(65537);
      expect(store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: big }).ok).toBe(false);
      expect(store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: "" }).ok).toBe(false);
      expect(rowCount()).toBe(1);
    });

    it("rejects a checkpoint with no prior state", () => {
      expect(makeStore().checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 0, sessionData: session() }))
        .toMatchObject({ ok: false, category: "recovery_required", reason: "no_state" });
    });
  });

  describe("failed writes", () => {
    it("reports persistence_failed and persists nothing when the INSERT fails", () => {
      const store = imported();
      dedup.getDb().exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON model_session_generations
        BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
      const r = store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: session(1) });
      expect(r).toEqual({ ok: false, category: "persistence_failed", reason: "write_failed" });
      expect(JSON.stringify(r)).not.toContain("synthetic failure");
      expect(rowCount()).toBe(1);
    });

    it("reports persistence_failed when the database handle throws", () => {
      const store = makeStore({ db: () => { throw new Error(SENTINEL); } });
      const r = store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: session(1) });
      expect(r).toMatchObject({ ok: false, category: "persistence_failed" });
      expect(JSON.stringify(r)).not.toContain(SENTINEL);
    });
  });

  describe("no fallback to older state", () => {
    function withNewerRow(mutate: (db: ReturnType<typeof dedup.getDb>) => void) {
      const store = imported();
      store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: session(1) });
      mutate(dedup.getDb());
      return store;
    }
    const sql = (s: string) => (db: ReturnType<typeof dedup.getDb>) =>
      db.prepare(`UPDATE model_session_generations SET ${s} WHERE checkpoint_sequence = 1`).run();

    it.each([
      ["held", sql("state_status = 'held'")],
      ["revoked", sql("state_status = 'revoked'")],
      ["expired status", sql("state_status = 'expired'")],
      ["past valid_until_at", sql("valid_until_at = 1")],
      ["corrupt", sql("auth_tag = zeroblob(16)")],
    ])("fails closed when the newest row is %s", (_name, mutate) => {
      const store = withNewerRow(mutate);
      expect(store.read("p1", 1)).toMatchObject({ ok: false, category: "recovery_required" });
      expect(store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 2, sessionData: session(2) }))
        .toMatchObject({ ok: false, category: "recovery_required" });
    });

    it("uses the injected clock for expiry", () => {
      let t = 1_000;
      const store = makeStore({ now: () => t });
      store.importSession({ profileId: "p1", ownerGeneration: 1, sessionData: session(), operator: OPERATOR });
      dedup.getDb().prepare("UPDATE model_session_generations SET valid_until_at = 2000").run();
      expect(store.read("p1", 1).ok).toBe(true);
      t = 2_000;
      expect(store.read("p1", 1)).toMatchObject({ ok: false, category: "recovery_required" });
    });
  });

  describe("import", () => {
    it("requires operator authority", () => {
      const store = makeStore();
      for (const operator of [undefined, null, { synthetic: "other" }]) {
        expect(store.importSession({ profileId: "p1", ownerGeneration: 1, sessionData: session(), operator }))
          .toMatchObject({ ok: false, category: "unauthorized" });
      }
      expect(rowCount()).toBe(0);
    });

    it("needs a fresh generation to replace existing state and recovers an unusable profile", () => {
      const store = imported();
      expect(store.importSession({ profileId: "p1", ownerGeneration: 1, sessionData: session(9), operator: OPERATOR }))
        .toMatchObject({ ok: false, reason: "state_exists" });
      dedup.getDb().prepare("UPDATE model_session_generations SET state_status = 'held'").run();
      owners.set("p1", 2);
      expect(store.importSession({ profileId: "p1", ownerGeneration: 2, sessionData: session(9), operator: OPERATOR }))
        .toMatchObject({ ok: true, stateSequence: 0 });
      expect(store.read("p1", 2)).toMatchObject({ ok: true, sessionData: session(9), ownerGeneration: 2 });
    });

    it("rejects import for an unowned generation", () => {
      expect(makeStore().importSession({ profileId: "p1", ownerGeneration: 5, sessionData: session(), operator: OPERATOR }))
        .toMatchObject({ ok: false, category: "stale_owner" });
    });

    it("does not make a copied row usable as another profile", () => {
      const store = imported();
      const db = dedup.getDb();
      const row = db.prepare("SELECT * FROM model_session_generations").get() as Record<string, unknown>;
      db.prepare(`INSERT INTO model_session_generations
        (profile_id, owner_generation, checkpoint_sequence, encrypted_session_state, encryption_key_id, nonce, auth_tag, checkpointed_at, valid_until_at, state_status)
        VALUES ('p2', 1, 0, ?, ?, ?, ?, ?, NULL, 'checkpointed')`)
        .run(row.encrypted_session_state, row.encryption_key_id, row.nonce, row.auth_tag, row.checkpointed_at);
      expect(store.read("p2", 1)).toMatchObject({ ok: false, category: "recovery_required" });
    });
  });

  it("does not throw or leak through a throwing owner seam", () => {
    const store = makeStore({ verifyOwner: () => { throw new Error(SENTINEL); } });
    const r = store.read("p1", 1);
    expect(r).toMatchObject({ ok: false, category: "stale_owner" });
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });
});
