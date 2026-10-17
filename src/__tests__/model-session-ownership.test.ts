/**
 * Behavioral tests for `src/model-session-ownership.ts` (AII-949) against a temp SQLite
 * file with the real session store. Synthetic keys and session data only; no network.
 * `npm run typecheck` excludes `src/__tests__`, so type-check this file explicitly with
 * a throwaway tsconfig.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type * as DedupModule from "../dedup.js";
import type * as OwnershipModule from "../model-session-ownership.js";
import type * as StoreModule from "../model-session-store.js";

const SENTINEL = "SYNTH-SESSION-TOKEN-xyz789";
const KEY = crypto.createHash("sha256").update("synthetic-ownership-key").digest();
const OPERATOR = { synthetic: "operator" };

let dbPath: string;
let dedup: typeof DedupModule;
let own: typeof OwnershipModule;
let storeMod: typeof StoreModule;
let store: StoreModule.ModelSessionStore;
let probeResult: () => OwnershipModule.TerminationProbeResult | Promise<OwnershipModule.TerminationProbeResult>;
let clock: number;

const sub = (profileId: string): OwnershipModule.ProfileRequest => ({ profileId, authMode: "subscription" });

function build(): OwnershipModule.ModelSessionOwnership {
  store = storeMod.createModelSessionStore({
    keys: { current: () => ({ keyId: "k1", key: KEY }), get: (id) => (id === "k1" ? KEY : undefined) },
    verifyOwner: own.sessionOwnerVerifier,
    authorizeOperator: (op) => op === OPERATOR,
  });
  return own.createModelSessionOwnership({ store, probe: () => probeResult(), now: () => clock });
}

async function boot(): Promise<OwnershipModule.ModelSessionOwnership> {
  vi.resetModules();
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  own = await import("../model-session-ownership.js");
  storeMod = await import("../model-session-store.js");
  dedup.getDb();
  return build();
}

let o: OwnershipModule.ModelSessionOwnership;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `model-session-ownership-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  probeResult = () => "terminated";
  clock = 1_000;
  o = await boot();
});

afterEach(() => {
  dedup.closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
});

function reserve1(dispatchId: string, profileId = "p1"): ref {
  const r = o.reserve({ dispatchId, profiles: [sub(profileId)] });
  if (r.status !== "reserved") throw new Error(`expected reserved, got ${r.status}`);
  return { dispatchId, profileId, generation: r.reservations[0]!.generation };
}
type ref = OwnershipModule.OwnerRef;

function importFor(r: ref) {
  const res = store.importSession({ profileId: r.profileId, ownerGeneration: r.generation, sessionData: `${SENTINEL}-0`, operator: OPERATOR });
  expect(res.ok).toBe(true);
}

/** Reserved -> running with a checkpoint written by this generation. */
function runAndCheckpoint(r: ref, seq: number) {
  expect(o.markRunning(r).status).toBe("ok");
  const c = store.checkpoint({ profileId: r.profileId, ownerGeneration: r.generation, stateSequence: seq, sessionData: `${SENTINEL}-${seq}` });
  expect(c.ok).toBe(true);
  expect(o.markCheckpointed(r)).toMatchObject({ status: "ok", state: "checkpointed" });
}

function dbRows(profileId = "p1") {
  return dedup.getDb().prepare("SELECT * FROM model_profile_reservations WHERE profile_id = ? ORDER BY owner_generation").all(profileId) as Array<Record<string, unknown>>;
}

describe("reservation", () => {
  it("authorizes one owner per profile and queues competitors", () => {
    const a = o.reserve({ dispatchId: "d1", profiles: [sub("p1")] });
    const b = o.reserve({ dispatchId: "d2", profiles: [sub("p1")] });
    expect(a).toMatchObject({ status: "reserved", reservations: [{ profileId: "p1", generation: 1 }] });
    expect(b).toEqual({ status: "queued", busyProfiles: ["p1"] });
    expect(dbRows()).toHaveLength(1);
  });

  it("is idempotent for the same dispatch and skips API-key profiles", () => {
    const first = o.reserve({ dispatchId: "d1", profiles: [sub("p1"), { profileId: "k", authMode: "api_key" }] });
    const again = o.reserve({ dispatchId: "d1", profiles: [sub("p1"), { profileId: "k", authMode: "api_key" }] });
    expect(again).toEqual(first);
    expect(first).toMatchObject({ skipped: ["k"] });
    expect(dbRows()).toHaveLength(1);
    expect(dbRows("k")).toHaveLength(0);
  });

  it("never leaves a partial reservation and ignores request order", () => {
    reserve1("d1", "pb");
    const ab = o.reserve({ dispatchId: "d2", profiles: [sub("pa"), sub("pb")] });
    const ba = o.reserve({ dispatchId: "d2", profiles: [sub("pb"), sub("pa")] });
    expect(ab).toEqual({ status: "queued", busyProfiles: ["pb"] });
    expect(ba).toEqual(ab);
    expect(dbRows("pa")).toHaveLength(0);
  });

  it("reserves several profiles atomically in stable order", () => {
    const r = o.reserve({ dispatchId: "d1", profiles: [sub("pb"), sub("pa")] });
    expect(r).toMatchObject({ status: "reserved", reservations: [{ profileId: "pa" }, { profileId: "pb" }] });
  });

  it("rejects bad input and reuse of a released dispatch id", () => {
    expect(o.reserve({ dispatchId: "", profiles: [sub("p1")] })).toEqual({ status: "rejected", reason: "invalid_input" });
    const r = reserve1("d1");
    expect(o.releaseLaunchRejected(r).status).toBe("ok");
    expect(o.reserve({ dispatchId: "d1", profiles: [sub("p1")] })).toEqual({ status: "rejected", reason: "dispatch_released" });
  });

  it("next generation exceeds prior reservations and imported session rows", () => {
    const r1 = reserve1("d1");
    importFor(r1);
    runAndCheckpoint(r1, 1);
    // An operator import under a generation beyond the reservations (simulated row).
    dedup.getDb().prepare(
      `INSERT INTO model_session_generations (profile_id, owner_generation, checkpoint_sequence, encrypted_session_state,
         encryption_key_id, nonce, auth_tag, checkpointed_at, state_status)
       VALUES ('p1', 7, 0, x'00', 'k#x', x'00', x'00', 1, 'held')`,
    ).run();
    o.beginStop(r1);
    // release r1 directly (store state is now unusable for r1 so use launch-free path)
    dedup.getDb().prepare("UPDATE model_profile_reservations SET recovery_status='released', released_at=1 WHERE profile_id='p1'").run();
    const r2 = reserve1("d2");
    expect(r2.generation).toBe(8);
  });
});

describe("state transitions", () => {
  it("running and checkpointed are idempotent and survive restart", async () => {
    const r = reserve1("d1");
    importFor(r);
    expect(o.markRunning(r)).toEqual({ status: "ok", state: "running", idempotent: false });
    expect(o.markRunning(r)).toEqual({ status: "ok", state: "running", idempotent: true });
    expect(o.markCheckpointed(r)).toEqual({ status: "rejected", reason: "checkpoint_missing" }); // an import is not a runner checkpoint
    expect(store.checkpoint({ profileId: r.profileId, ownerGeneration: r.generation, stateSequence: 1, sessionData: `${SENTINEL}-1` }).ok).toBe(true);
    expect(o.markCheckpointed(r)).toMatchObject({ status: "ok", state: "checkpointed", idempotent: false });
    expect(o.markCheckpointed(r)).toEqual({ status: "ok", state: "checkpointed", idempotent: true });
    expect(o.beginStop(r).status).toBe("ok");
    expect(o.beginStop(r)).toEqual({ status: "ok", state: "stopping", idempotent: true });

    dedup.closeDb();
    o = await boot();
    expect(o.snapshot("p1")).toMatchObject({ state: "stopping", generation: r.generation });
    expect(o.reserve({ dispatchId: "d2", profiles: [sub("p1")] }).status).toBe("queued");
  });

  it("markCheckpointed requires a valid checkpoint by the current generation", () => {
    const r = reserve1("d1");
    o.markRunning(r);
    expect(o.markCheckpointed(r)).toEqual({ status: "rejected", reason: "checkpoint_missing" });
    expect(o.snapshot("p1")?.state).toBe("running");
  });

  it("rejects transitions from the wrong state", () => {
    const r = reserve1("d1");
    expect(o.markCheckpointed(r)).toEqual({ status: "rejected", reason: "invalid_state" });
    o.beginStop(r);
    expect(o.markRunning(r)).toEqual({ status: "rejected", reason: "invalid_state" });
    expect(o.releaseLaunchRejected(r)).toEqual({ status: "rejected", reason: "invalid_state" });
  });

  it("heartbeat updates liveness only; an expired heartbeat retains ownership", () => {
    const r = reserve1("d1");
    clock = 5_000;
    expect(o.heartbeat(r).status).toBe("ok");
    expect(o.snapshot("p1")).toMatchObject({ heartbeatAt: 5_000, state: "reserved" });
    clock = 10_000_000;
    expect(o.reserve({ dispatchId: "d2", profiles: [sub("p1")] }).status).toBe("queued");
  });

  it("unrecognised durable state reads as recovery required", () => {
    const r = reserve1("d1");
    dedup.getDb().prepare("UPDATE model_profile_reservations SET release_reason='mystery' WHERE profile_id='p1'").run();
    expect(o.snapshot("p1")?.state).toBe("recovery_required");
    expect(o.reserve({ dispatchId: "d2", profiles: [sub("p1")] }).status).toBe("queued");
    expect(o.markRunning(r)).toEqual({ status: "rejected", reason: "invalid_state" });
  });
});

describe("launch rejection", () => {
  it("releases the exact generation without a checkpoint, idempotently", () => {
    const r = reserve1("d1");
    expect(o.releaseLaunchRejected(r)).toEqual({ status: "ok", state: "released", idempotent: false });
    expect(o.releaseLaunchRejected(r)).toEqual({ status: "ok", state: "released", idempotent: true });
    expect(o.reserve({ dispatchId: "d2", profiles: [sub("p1")] })).toMatchObject({ status: "reserved" });
  });

  it("an ambiguous launch (recovery required or running) does not release", () => {
    const r = reserve1("d1");
    expect(o.markRecoveryRequired(r)).toMatchObject({ status: "ok", state: "recovery_required" });
    expect(o.releaseLaunchRejected(r)).toEqual({ status: "rejected", reason: "invalid_state" });
    expect(o.reserve({ dispatchId: "d2", profiles: [sub("p1")] }).status).toBe("queued");
  });
});

describe("release after termination", () => {
  function stopped() {
    const r = reserve1("d1");
    importFor(r);
    runAndCheckpoint(r, 1);
    o.beginStop(r);
    return r;
  }

  it("releases on confirmed termination with a current-owner checkpoint", async () => {
    const r = stopped();
    expect(await o.releaseAfterTermination(r)).toEqual({ status: "released", idempotent: false });
    expect(await o.releaseAfterTermination(r)).toEqual({ status: "released", idempotent: true });
    expect(o.reserve({ dispatchId: "d2", profiles: [sub("p1")] })).toMatchObject({ status: "reserved" });
  });

  it("requires beginStop first", async () => {
    const r = reserve1("d1");
    expect(await o.releaseAfterTermination(r)).toEqual({ status: "rejected", reason: "invalid_state" });
  });

  it("not_terminated stays stopping; unknown and probe errors hold", async () => {
    const r = stopped();
    probeResult = () => "not_terminated";
    expect(await o.releaseAfterTermination(r)).toEqual({ status: "pending", state: "stopping" });
    probeResult = () => "unknown";
    expect(await o.releaseAfterTermination(r)).toEqual({ status: "held", cause: "termination_unknown" });
    probeResult = () => { throw new Error(`boom ${SENTINEL}`); };
    const res = await o.releaseAfterTermination(r);
    expect(res).toEqual({ status: "held", cause: "termination_unknown" });
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
    probeResult = () => Promise.reject(new Error("async boom"));
    expect((await o.releaseAfterTermination(r)).status).toBe("held");
    expect(o.snapshot("p1")?.state).toBe("recovery_required");
    expect(o.reserve({ dispatchId: "d2", profiles: [sub("p1")] }).status).toBe("queued");
  });

  it("a held owner can be reconciled once termination is confirmed", async () => {
    const r = stopped();
    probeResult = () => "unknown";
    await o.releaseAfterTermination(r);
    probeResult = () => "terminated";
    expect(await o.releaseAfterTermination(r)).toEqual({ status: "released", idempotent: false });
  });

  it("confirmed termination with only an older imported session stays held", async () => {
    const r1 = reserve1("d1");
    importFor(r1);
    expect(o.releaseLaunchRejected(r1).status).toBe("ok");
    const r2 = reserve1("d2");
    expect(r2.generation).toBe(2);
    // The store can still read the gen-1 state for the new owner, but it is not current.
    expect(store.read("p1", 2)).toMatchObject({ ok: true, ownerGeneration: 1 });
    o.markRunning(r2);
    o.beginStop(r2);
    expect(await o.releaseAfterTermination(r2)).toEqual({ status: "held", cause: "checkpoint_missing" });
    expect(o.snapshot("p1")?.state).toBe("recovery_required");
    expect(o.reserve({ dispatchId: "d3", profiles: [sub("p1")] }).status).toBe("queued");
  });

  it("import-only state at the current generation is not a checkpoint", async () => {
    const r = reserve1("d1");
    importFor(r);
    o.markRunning(r);
    expect(o.markCheckpointed(r)).toEqual({ status: "rejected", reason: "checkpoint_missing" });
    o.beginStop(r);
    expect(await o.releaseAfterTermination(r)).toEqual({ status: "held", cause: "checkpoint_missing" });
    expect(o.snapshot("p1")?.state).toBe("recovery_required");
    expect(o.reserve({ dispatchId: "d2", profiles: [sub("p1")] }).status).toBe("queued");
  });

  it("an unusable key requires reauthentication, not release", async () => {
    const r = stopped();
    const other = storeMod.createModelSessionStore({
      keys: { current: () => undefined, get: () => undefined },
      verifyOwner: own.sessionOwnerVerifier,
      authorizeOperator: () => false,
    });
    const o2 = own.createModelSessionOwnership({ store: other, probe: () => "terminated", now: () => clock });
    expect(await o2.releaseAfterTermination(r)).toEqual({ status: "held", cause: "reauthentication_required" });
  });

  it("a throwing owner verifier or store never releases", async () => {
    const r = stopped();
    const broken = { read: () => { throw new Error("store down"); } } as unknown as StoreModule.ModelSessionStore;
    const o2 = own.createModelSessionOwnership({ store: broken, probe: () => "terminated", now: () => clock });
    expect((await o2.releaseAfterTermination(r)).status).toBe("rejected");
    expect(o.snapshot("p1")?.state).toBe("stopping");
  });
});

describe("stale owners", () => {
  it("late calls from a replaced generation cannot change the next owner", async () => {
    const r1 = reserve1("d1");
    expect(o.releaseLaunchRejected(r1).status).toBe("ok");
    const r2 = reserve1("d2");
    importFor(r2);
    o.markRunning(r2);
    const before = dbRows();

    expect(o.markRunning(r1)).toEqual({ status: "rejected", reason: "stale_owner" });
    expect(o.markCheckpointed(r1)).toEqual({ status: "rejected", reason: "stale_owner" });
    expect(o.beginStop(r1)).toEqual({ status: "rejected", reason: "stale_owner" });
    expect(o.heartbeat(r1)).toEqual({ status: "rejected", reason: "stale_owner" });
    expect(o.markRecoveryRequired(r1)).toEqual({ status: "rejected", reason: "stale_owner" });
    expect(o.releaseLaunchRejected(r1)).toMatchObject({ status: "ok", idempotent: true }); // its own release, repeated
    expect(await o.releaseAfterTermination(r1)).toEqual({ status: "rejected", reason: "invalid_state" });
    // wrong generation for the live dispatch
    expect(o.beginStop({ ...r2, generation: r2.generation + 1 })).toEqual({ status: "rejected", reason: "stale_owner" });
    expect(o.releaseLaunchRejected({ ...r2, generation: 1 })).toEqual({ status: "rejected", reason: "stale_owner" });
    expect(dbRows()).toEqual(before);
  });

  it("the session store rejects writes and reads from a released or superseded generation", () => {
    const r1 = reserve1("d1");
    importFor(r1);
    o.releaseLaunchRejected(r1);
    expect(store.checkpoint({ profileId: "p1", ownerGeneration: 1, stateSequence: 1, sessionData: SENTINEL })).toMatchObject({ ok: false, reason: "owner_rejected" });
    expect(store.read("p1", 1)).toMatchObject({ ok: false, reason: "owner_rejected" });
    const r2 = reserve1("d2");
    expect(store.read("p1", r2.generation).ok).toBe(true);
    expect(store.read("p1", 99)).toMatchObject({ ok: false, reason: "owner_rejected" });
  });

  it("the verifier accepts held and stopping owners so a final checkpoint can land", () => {
    const r = reserve1("d1");
    importFor(r);
    o.markRecoveryRequired(r);
    expect(store.checkpoint({ profileId: "p1", ownerGeneration: r.generation, stateSequence: 1, sessionData: SENTINEL }).ok).toBe(true);
  });

  describe("immutable reservation set per dispatch", () => {
    const api = (profileId: string): OwnershipModule.ProfileRequest => ({ profileId, authMode: "api_key" });
    const allRows = () => dedup.getDb().prepare("SELECT profile_id, owner_generation, released_at FROM model_profile_reservations ORDER BY profile_id").all();
    const changed = { status: "rejected", reason: "reservation_set_changed" };

    it("rejects expansion and reduction without writes", () => {
      expect(o.reserve({ dispatchId: "d1", profiles: [sub("pa")] }).status).toBe("reserved");
      const before = allRows();
      expect(o.reserve({ dispatchId: "d1", profiles: [sub("pa"), sub("pb")] })).toEqual(changed);
      expect(allRows()).toEqual(before);
      expect(o.reserve({ dispatchId: "d2", profiles: [sub("pc"), sub("pd")] }).status).toBe("reserved");
      const before2 = allRows();
      expect(o.reserve({ dispatchId: "d2", profiles: [sub("pc")] })).toEqual(changed);
      expect(allRows()).toEqual(before2);
    });

    it("retries the same set idempotently in any order, also after restart", async () => {
      const first = o.reserve({ dispatchId: "d1", profiles: [sub("pa"), sub("pb")] });
      const before = allRows();
      expect(o.reserve({ dispatchId: "d1", profiles: [sub("pb"), sub("pa"), sub("pa")] })).toEqual(first);
      expect(allRows()).toEqual(before);
      dedup.closeDb();
      o = await boot();
      expect(o.reserve({ dispatchId: "d1", profiles: [sub("pb"), sub("pa")] })).toEqual(first);
      expect(o.reserve({ dispatchId: "d1", profiles: [sub("pa")] })).toEqual(changed);
      expect(allRows()).toEqual(before);
    });

    it("mixed mode cannot hide an owned subscription profile", () => {
      o.reserve({ dispatchId: "d1", profiles: [sub("pa")] });
      expect(o.reserve({ dispatchId: "d1", profiles: [api("pa")] })).toEqual(changed);
      expect(o.reserve({ dispatchId: "d1", profiles: [sub("pa"), api("pb")] })).toMatchObject({
        status: "reserved",
        skipped: ["pb"],
      });
      expect(allRows()).toHaveLength(1);
    });

    it("released history cannot be bypassed by changing the set", () => {
      const r = reserve1("d1");
      o.releaseLaunchRejected(r);
      const before = allRows();
      expect(o.reserve({ dispatchId: "d1", profiles: [sub("p1")] })).toEqual({ status: "rejected", reason: "dispatch_released" });
      expect(o.reserve({ dispatchId: "d1", profiles: [sub("p1"), sub("p2")] })).toEqual(changed);
      expect(o.reserve({ dispatchId: "d1", profiles: [api("p1")] })).toEqual(changed);
      expect(allRows()).toEqual(before);
    });

    it("a queued zero-write attempt has no established set; api-key-only needs no rows", () => {
      const d0 = reserve1("d0");
      expect(o.reserve({ dispatchId: "d1", profiles: [sub("p1")] }).status).toBe("queued");
      expect(o.releaseLaunchRejected(d0).status).toBe("ok");
      expect(o.reserve({ dispatchId: "d1", profiles: [sub("p1"), sub("p2")] }).status).toBe("reserved");
      expect(o.reserve({ dispatchId: "d3", profiles: [api("px")] })).toEqual({ status: "reserved", reservations: [], skipped: ["px"] });
      expect(dbRows("px")).toHaveLength(0);
    });
  });
});
