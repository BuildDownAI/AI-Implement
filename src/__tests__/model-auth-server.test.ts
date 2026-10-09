/**
 * Behavioral tests for `src/model-auth-server.ts` (AII-955) against a temp SQLite file
 * with the real session store and ownership module. Synthetic credentials only; no
 * network and no model calls. `npm run typecheck` excludes `src/__tests__`, so
 * type-check this file explicitly with a throwaway tsconfig.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type * as DedupModule from "../dedup.js";
import type * as OwnershipModule from "../model-session-ownership.js";
import type * as StoreModule from "../model-session-store.js";
import type * as ServerModule from "../model-auth-server.js";
import type { ModelAuthGrantBinding } from "../model-auth-contract.js";

const BEARER = "SYNTH_BEARER_" + "a".repeat(40);
const API_KEY = "SYNTH-API-KEY-sk-12345";
const SESSION = "SYNTH-SESSION-DATA-777";
const STORE_ERROR = "SYNTH-STORE-ERROR-disk-exploded";
const SENTINELS = [BEARER, API_KEY, SESSION, STORE_ERROR];
const KEY = crypto.createHash("sha256").update("synthetic-server-key").digest();
const OPERATOR = { synthetic: "operator" };
const NOW = 1_000_000;

let dbPath: string;
let dedup: typeof DedupModule;
let own: typeof OwnershipModule;
let storeMod: typeof StoreModule;
let server: typeof ServerModule;
let store: StoreModule.ModelSessionStore;
let ownership: OwnershipModule.ModelSessionOwnership;
let generation: number;
let logs: unknown[];
let bindings: ModelAuthGrantBinding[];
let grantOverrides: Partial<ServerModule.PersistedModelAuthGrant>;
let dispatchOverrides: Partial<ServerModule.PersistedDispatchContext>;
let selections: Record<string, ServerModule.SnapshotProfileSelection | undefined>;
let profileOverrides: Record<string, Partial<{ status: "active" | "disabled" | "archived"; allowedProjectKeys: string[]; revision: number }>>;
let trusted: boolean;
let nowValue: number;
let grantMissing: boolean;
let secretValue: unknown;
let handlers: ServerModule.ModelAuthHandlers;
let storeWrap: Partial<StoreModule.ModelSessionStore>;
let resolveSpy: Mock<(...args: any[]) => any>;
let revisionSpy: Mock<(...args: any[]) => any>;
let readSpy: Mock<(...args: any[]) => any>;
let checkpointSpy: Mock<(...args: any[]) => any>;
let lookupSpy: Mock<(...args: any[]) => any>;
let transportSpy: Mock<(...args: any[]) => any>;

const SUB: ModelAuthGrantBinding = { stage: "implementation", profileId: "sub1", profileRevision: 3, authMode: "claude-subscription", ownerGeneration: 1 };
const KEYB: ModelAuthGrantBinding = { stage: "review", profileId: "key1", profileRevision: 2, authMode: "openai-api-key" };

function build(): ServerModule.ModelAuthHandlers {
  return server.createModelAuthHandlers(depsFrom());
}

function depsFrom(): ServerModule.ModelAuthHandlerDeps {
  const realStore = storeMod.createModelSessionStore({
    keys: { current: () => ({ keyId: "k1", key: KEY }), get: (id) => (id === "k1" ? KEY : undefined) },
    verifyOwner: own.sessionOwnerVerifier,
    authorizeOperator: (op) => op === OPERATOR,
  });
  store = realStore;
  ownership = own.createModelSessionOwnership({ store: realStore, probe: () => "unknown", now: () => NOW });
  const sessionStore: StoreModule.ModelSessionStore = {
    read: (...a) => { readSpy(...a); return (storeWrap.read ?? realStore.read)(...a); },
    checkpoint: (...a) => { checkpointSpy(...a); return (storeWrap.checkpoint ?? realStore.checkpoint)(...a); },
    importSession: (...a) => realStore.importSession(...a),
  };
  const profile = (id: string, b: ModelAuthGrantBinding) => ({
    profileId: id,
    identity: "id",
    revision: b.profileRevision,
    agent: "codex" as const,
    provider: "openai" as const,
    authMode: b.authMode,
    allowedProjectKeys: ["proj"],
    status: "active" as const,
    ...profileOverrides[id],
  });
  const all = [SUB, KEYB];
  return {
    isTrustedTransport: () => { transportSpy(); return trusted; },
    lookupGrant: (hash) => {
      lookupSpy(hash);
      return !grantMissing && hash === server.hashModelAuthBearer(BEARER)
        ? {
            version: 1,
            audience: "model-auth",
            grantId: "g1",
            dispatchId: "d1",
            snapshotId: "s1",
            projectKey: "proj",
            backend: "fly",
            expiresAt: NOW + 60_000,
            bindings,
            bearerHash: hash,
            revokedAt: null,
            ...grantOverrides,
          }
        : undefined;
    },
    loadDispatchContext: () => ({ dispatchId: "d1", snapshotId: "s1", projectKey: "proj", backend: "fly", ...dispatchOverrides }),
    getSnapshotSelection: (_s, profileId) =>
      profileId in selections
        ? selections[profileId]
        : { provider: "openai", revision: all.find((b) => b.profileId === profileId)?.profileRevision ?? 1, authMode: all.find((b) => b.profileId === profileId)?.authMode ?? "openai-api-key" },
    credentials: {
      sessionStore,
      resolveProtectedSecret: () => { resolveSpy(); return secretValue as never; },
      getProfileRevision: (id) => {
        revisionSpy(id);
        const b = all.find((x) => x.profileId === id);
        return b ? profile(id, b) : null;
      },
      lookupReference: () => "model-account:key1",
    },
    sessionStore,
    ownership,
    now: () => nowValue,
    log: (d) => logs.push(d),
    bodyDeadlineMs: 50,
    maxSmallBodyBytes: 512,
    maxCheckpointBodyBytes: 4096,
  };
}

async function* chunks(...parts: string[]) {
  for (const p of parts) yield p;
}

function req(route: string, body: unknown, over: Partial<ServerModule.ModelAuthRequest> = {}): ServerModule.ModelAuthRequest {
  return {
    method: "POST",
    path: `/runner/model-auth/${route}`,
    authorization: `Bearer ${BEARER}`,
    body: chunks(typeof body === "string" ? body : JSON.stringify(body)),
    ...over,
  };
}

const checkout = (profileId: string, over?: Partial<ServerModule.ModelAuthRequest>) =>
  handlers.handle(req("checkout", { version: 1, profileId }, over));
const checkpoint = (seq: number, data = `${SESSION}-${seq}`, gen = 1, profileId = "sub1") =>
  handlers.handle(req("checkpoint", { version: 1, profileId, ownerGeneration: gen, stateSequence: seq, sessionData: data }));

function expectNoLeak(res: ServerModule.ModelAuthResponse, allowed: string[] = []) {
  const text = JSON.stringify(res) + JSON.stringify(logs);
  for (const s of SENTINELS.filter((x) => !allowed.includes(x))) expect(text).not.toContain(s);
  expect(JSON.stringify(logs)).not.toContain(SESSION);
  expect(JSON.stringify(logs)).not.toContain(API_KEY);
}

async function boot() {
  vi.resetModules();
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  own = await import("../model-session-ownership.js");
  storeMod = await import("../model-session-store.js");
  server = await import("../model-auth-server.js");
  dedup.getDb();
}

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `model-auth-server-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  logs = [];
  bindings = [SUB, KEYB];
  grantOverrides = {};
  dispatchOverrides = {};
  selections = {};
  profileOverrides = {};
  trusted = true;
  nowValue = NOW;
  grantMissing = false;
  secretValue = API_KEY;
  storeWrap = {};
  resolveSpy = vi.fn();
  revisionSpy = vi.fn();
  readSpy = vi.fn();
  checkpointSpy = vi.fn();
  lookupSpy = vi.fn();
  transportSpy = vi.fn();
  await boot();
  handlers = build();
  const r = ownership.reserve({ dispatchId: "d1", profiles: [{ profileId: "sub1", authMode: "subscription" }] });
  if (r.status !== "reserved") throw new Error("reserve failed");
  generation = r.reservations[0]!.generation;
  expect(generation).toBe(1);
  expect(store.importSession({ profileId: "sub1", ownerGeneration: 1, sessionData: `${SESSION}-0`, operator: OPERATOR }).ok).toBe(true);
  expect(ownership.markRunning({ dispatchId: "d1", profileId: "sub1", generation: 1 }).status).toBe("ok");
  for (const spy of [resolveSpy, revisionSpy, readSpy, checkpointSpy, lookupSpy, transportSpy]) spy.mockClear();
});

afterEach(() => {
  dedup.closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
});

describe("checkout", () => {
  it("returns the selected API key with no-store", async () => {
    const res = await checkout("key1");
    expect(res.status).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.body).toMatchObject({ ok: true, profileId: "key1", authMode: "openai-api-key", secret: { kind: "api-key", apiKey: API_KEY } });
    expect(server.hashModelAuthBearer(BEARER)).not.toContain(BEARER);
    expectNoLeak(res, [API_KEY]);
  });

  it("returns session state with the verified generation and the real sequence", async () => {
    const res = await checkout("sub1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, authMode: "claude-subscription", ownerGeneration: 1, secret: { kind: "session", sessionData: `${SESSION}-0`, stateSequence: 0 } });
    expectNoLeak(res, [SESSION]);
  });

  it("rebinds an earlier-generation session to the current generation", async () => {
    // Move ownership to generation 2 while the stored state is still generation 1.
    const ref = { dispatchId: "d1", profileId: "sub1", generation: 1 };
    ownership.markCheckpointed(ref);
    const db = dedup.getDb();
    db.prepare("UPDATE model_profile_reservations SET released_at = 1, recovery_status = 'released' WHERE profile_id = 'sub1'").run();
    const r2 = ownership.reserve({ dispatchId: "d2", profiles: [{ profileId: "sub1", authMode: "subscription" }] });
    expect(r2.status).toBe("reserved");
    bindings = [{ ...SUB, ownerGeneration: 2 }];
    grantOverrides = { dispatchId: "d2" };
    dispatchOverrides = { dispatchId: "d2" };
    handlers = build();
    const res = await checkout("sub1");
    expect(res.body).toMatchObject({ ok: true, ownerGeneration: 2, secret: { sessionData: `${SESSION}-0`, stateSequence: 0 } });
  });

  it("derives revision and provider from the grant and snapshot, never the body", async () => {
    const res = await handlers.handle(req("checkout", { version: 1, profileId: "key1", revision: 9, provider: "anthropic" }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ version: 1, ok: false, category: "unauthorized" });
  });

  it.each<[string, () => void, boolean?]>([
    ["wrong audience", () => { grantOverrides = { audience: "runner" as never }; }],
    ["expired", () => { grantOverrides = { expiresAt: NOW }; }],
    ["revoked", () => { grantOverrides = { revokedAt: NOW - 1 }; }],
    ["revocation state missing", () => { grantOverrides = { revokedAt: undefined as never }; }],
    ["wrong dispatch", () => { dispatchOverrides = { dispatchId: "other" }; }],
    ["wrong snapshot", () => { dispatchOverrides = { snapshotId: "other" }; }],
    ["wrong project", () => { dispatchOverrides = { projectKey: "other" }; }],
    ["wrong backend", () => { dispatchOverrides = { backend: "gha" }; }],
    ["revision differs from snapshot", () => { selections = { key1: { provider: "openai", revision: 7, authMode: "openai-api-key" } }; }],
    ["auth mode differs from snapshot", () => { selections = { key1: { provider: "openai", revision: 2, authMode: "anthropic-api-key" } }; }],
    ["no snapshot selection", () => { selections = { key1: undefined }; }],
    ["profile not permitted for project", () => { profileOverrides = { key1: { allowedProjectKeys: ["else"] } }; }, true],
    ["profile disabled", () => { profileOverrides = { key1: { status: "disabled" } }; }, true],
  ])("rejects %s without reaching the resolver or store", async (_name, setup, profileChecked = false) => {
    setup();
    handlers = build();
    const res = await checkout("key1");
    expect(res.body).toEqual({ version: 1, ok: false, category: "unauthorized" });
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expectNoLeak(res);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(checkpointSpy).not.toHaveBeenCalled();
    if (!profileChecked) expect(revisionSpy).not.toHaveBeenCalled();
  });

  it("rejects a body that asserts revision or provider before any resolver or store call", async () => {
    const res = await handlers.handle(req("checkout", { version: 1, profileId: "key1", revision: 2, provider: "openai" }));
    expect(res.status).toBe(400);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(revisionSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("rejects a profile outside the grant bindings", async () => {
    const res = await checkout("other");
    expect(res.body).toMatchObject({ ok: false, category: "unauthorized" });
  });

  it("rejects unknown, malformed, and missing bearers with 401", async () => {
    for (const authorization of [undefined, "Bearer", "Basic abc", `Bearer ${"b".repeat(40)}`, "Bearer short"]) {
      const res = await checkout("key1", { authorization });
      expect(res.status).toBe(401);
      expect(res.headers["Cache-Control"]).toBe("no-store");
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
    }
  });

  it("rejects an untrusted transport before reading anything", async () => {
    trusted = false;
    handlers = build();
    const res = await checkout("key1");
    expect(res.status).toBe(403);
    expect(transportSpy).toHaveBeenCalled();
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("fails closed for released, other-dispatch, older-generation, and missing owners", async () => {
    const run = async (mutate: () => void) => {
      mutate();
      return checkout("sub1");
    };
    // other dispatch holds the profile's reservation
    let res = await run(() => { grantOverrides = { dispatchId: "d9" }; dispatchOverrides = { dispatchId: "d9" }; });
    expect(res.body).toMatchObject({ ok: false, category: "stale_owner" });
    grantOverrides = {}; dispatchOverrides = {};
    // older generation in the binding
    bindings = [{ ...SUB, ownerGeneration: 5 }];
    handlers = build();
    res = await checkout("sub1");
    expect(res.body).toMatchObject({ ok: false, category: "stale_owner" });
    // missing snapshot
    handlers = server.createModelAuthHandlers({ ...(depsFrom()), ownership: { snapshot: () => undefined } });
    bindings = [SUB, KEYB];
    res = await checkout("sub1");
    expect(res.body).toMatchObject({ ok: false, category: "stale_owner" });
    // released
    dedup.getDb().prepare("UPDATE model_profile_reservations SET released_at = 1, recovery_status = 'released'").run();
    handlers = build();
    res = await checkout("sub1");
    expect(res.body).toMatchObject({ ok: false, category: "stale_owner" });
    expectNoLeak(res);
  });

  it("does not hand out a session while the owner is stopping", async () => {
    ownership.beginStop({ dispatchId: "d1", profileId: "sub1", generation: 1 });
    const res = await checkout("sub1");
    expect(res.body).toMatchObject({ ok: false, category: "recovery_required" });
  });

  it("maps resolver throws and secret-store errors to a static category", async () => {
    const throwing = server.createModelAuthHandlers({
      ...depsFrom(),
      credentials: { ...depsFrom().credentials, resolveProtectedSecret: () => { throw new Error(STORE_ERROR); } },
    });
    const res = await throwing.handle(req("checkout", { version: 1, profileId: "key1" }));
    expect(res.body).toEqual({ version: 1, ok: false, category: "persistence_failed" });
    expectNoLeak(res);
  });

  it("returns authentication_required when the protected secret is unset", async () => {
    secretValue = null;
    const res = await checkout("key1");
    expect(res.body).toMatchObject({ ok: false, category: "authentication_required" });
  });
});

describe("checkpoint", () => {
  it("stores state, acknowledges, and then serves it back", async () => {
    const res = await checkpoint(1);
    expect(res).toMatchObject({ status: 200, body: { version: 1, ok: true, profileId: "sub1", ownerGeneration: 1, stateSequence: 1 } });
    expect(JSON.stringify(res.body)).not.toContain(SESSION);
    const out = await checkout("sub1");
    expect(out.body).toMatchObject({ secret: { sessionData: `${SESSION}-1`, stateSequence: 1 } });
  });

  it("treats a duplicate as success and a stale or conflicting update as a failure that never overwrites", async () => {
    expect((await checkpoint(1)).status).toBe(200);
    expect((await checkpoint(2)).status).toBe(200);
    expect((await checkpoint(2)).status).toBe(200); // duplicate
    const stale = await checkpoint(1);
    expect(stale.body).toMatchObject({ ok: false, category: "stale_owner" });
    const conflict = await checkpoint(2, "different-payload");
    expect(conflict.body).toMatchObject({ ok: false, category: "stale_owner" });
    const gap = await checkpoint(9);
    expect(gap.body).toMatchObject({ ok: false, category: "stale_owner" });
    const out = await checkout("sub1");
    expect(out.body).toMatchObject({ secret: { sessionData: `${SESSION}-2`, stateSequence: 2 } });
    expectNoLeak(stale, []);
  });

  it("never acknowledges when persistence fails", async () => {
    storeWrap = { checkpoint: () => { throw new Error(STORE_ERROR); } };
    let res = await checkpoint(1);
    expect(res.body).toEqual({ version: 1, ok: false, category: "persistence_failed" });
    storeWrap = { checkpoint: () => ({ ok: false, category: "persistence_failed", reason: "write_failed" }) };
    res = await checkpoint(1);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ version: 1, ok: false, category: "persistence_failed" });
    expectNoLeak(res);
    storeWrap = {};
    const out = await checkout("sub1");
    expect(out.body).toMatchObject({ secret: { stateSequence: 0 } });
  });

  it("does not trust a mismatched success from the store", async () => {
    storeWrap = { checkpoint: () => ({ ok: true, profileId: "sub1", ownerGeneration: 1, stateSequence: 77, idempotent: false }) };
    const res = await checkpoint(1);
    expect(res.body).toMatchObject({ ok: false, category: "persistence_failed" });
  });

  it("rejects a generation that differs from the binding, an API-key profile, and unlisted profiles", async () => {
    const spy = checkpointSpy;
    for (const res of [await checkpoint(1, "x", 2), await checkpoint(1, "x", 1, "key1"), await checkpoint(1, "x", 1, "nope")]) {
      expect(res.body).toEqual({ version: 1, ok: false, category: "unauthorized" });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("rejects bindings that no longer match the grant context before touching the store", async () => {
    const spy = checkpointSpy;
    dispatchOverrides = { projectKey: "other" };
    handlers = build();
    const res = await checkpoint(1);
    expect(res.body).toMatchObject({ ok: false, category: "unauthorized" });
    expect(spy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("rejects checkpoints from a released or other-dispatch owner and allows a stopping owner", async () => {
    ownership.beginStop({ dispatchId: "d1", profileId: "sub1", generation: 1 });
    expect((await checkpoint(1)).status).toBe(200);
    dedup.getDb().prepare("UPDATE model_profile_reservations SET released_at = 1, recovery_status = 'released'").run();
    const res = await checkpoint(2);
    expect(res.body).toMatchObject({ ok: false, category: "stale_owner" });
  });
});

describe("finish", () => {
  it("acknowledges without releasing, stopping, or marking recovery", async () => {
    const spies = { releaseAfterTermination: vi.fn(), beginStop: vi.fn(), markRecoveryRequired: vi.fn(), releaseLaunchRejected: vi.fn() };
    const guarded = server.createModelAuthHandlers({ ...depsFrom(), ownership: { snapshot: ownership.snapshot, ...spies } as never });
    const res = await guarded.handle(req("finish", { version: 1, profileId: "sub1", handling: "completed" }));
    expect(res).toMatchObject({ status: 200, body: { version: 1, ok: true, acknowledged: true } });
    Object.values(spies).forEach((s) => expect(s).not.toHaveBeenCalled());
    expect(ownership.snapshot("sub1")?.state).toBe("running");
  });

  it("rejects release fields and unlisted profiles", async () => {
    let res = await handlers.handle(req("finish", { version: 1, profileId: "sub1", handling: "failed", release: true }));
    expect(res.status).toBe(400);
    res = await handlers.handle(req("finish", { version: 1, profileId: "nope", handling: "failed" }));
    expect(res.body).toMatchObject({ ok: false, category: "unauthorized" });
  });
});

describe("transport limits", () => {
  it("rejects wrong methods and routes, always with no-store", async () => {
    const wrongMethod = await handlers.handle(req("checkout", {}, { method: "GET" }));
    expect(wrongMethod.status).toBe(405);
    const wrongRoute = await handlers.handle({ ...req("checkout", {}), path: "/runner/model-auth/other" });
    expect(wrongRoute.status).toBe(404);
    for (const r of [wrongMethod, wrongRoute]) expect(r.headers["Cache-Control"]).toBe("no-store");
  });

  it("returns 413 for oversized bodies without parsing", async () => {
    const big = JSON.stringify({ version: 1, profileId: "key1", pad: "x".repeat(2000) });
    const res = await handlers.handle(req("checkout", big));
    expect(res.status).toBe(413);
    const declared = await handlers.handle(req("checkout", "{}", { contentLength: 100000 }));
    expect(declared.status).toBe(413);
    const checkpointBig = await handlers.handle(req("checkpoint", "x".repeat(5000)));
    expect(checkpointBig.status).toBe(413);
  });

  it("accepts a maximum-size session payload under the real checkpoint cap", async () => {
    const real = server.createModelAuthHandlers({ ...depsFrom(), maxCheckpointBodyBytes: undefined });
    const data = "é".repeat(60000);
    const res = await real.handle(req("checkpoint", { version: 1, profileId: "sub1", ownerGeneration: 1, stateSequence: 1, sessionData: data }));
    expect(res.status).toBe(200);
  });

  it("times out a stalled body and malformed JSON is a 400", async () => {
    async function* stall() { yield '{"version":1,'; await new Promise((r) => setTimeout(r, 500)); yield '"profileId":"key1"}'; }
    const res = await handlers.handle({ ...req("checkout", {}), body: stall() });
    expect(res.status).toBe(408);
    expect((await handlers.handle(req("checkout", "{not json"))).status).toBe(400);
  });

  it("does not let a failing logger change the outcome", async () => {
    const noisy = server.createModelAuthHandlers({ ...depsFrom(), log: () => { throw new Error(STORE_ERROR); } });
    const res = await noisy.handle(req("checkout", { version: 1, profileId: "key1" }));
    expect(res.status).toBe(200);
  });
});

describe("revalidation after the asynchronous body read", () => {
  /** A body whose read completes only after `mutate` has changed the persisted state. */
  const delayed = (body: unknown, mutate: () => void): AsyncIterable<string> => ({
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      mutate();
      yield JSON.stringify(body);
    },
  });
  const bodies = {
    checkout: { version: 1, profileId: "key1" },
    checkpoint: { version: 1, profileId: "sub1", ownerGeneration: 1, stateSequence: 1, sessionData: `${SESSION}-1` },
    finish: { version: 1, profileId: "key1" },
  } as const;
  const mutations: [string, () => void][] = [
    ["expiry", () => { nowValue = NOW + 60_000; }],
    ["lookup miss", () => { grantMissing = true; }],
    ["revocation", () => { grantOverrides = { revokedAt: nowValue }; }],
    ["snapshot change", () => { dispatchOverrides = { snapshotId: "other" }; }],
    ["project change", () => { dispatchOverrides = { projectKey: "other" }; }],
    ["backend change", () => { dispatchOverrides = { backend: "gha" }; }],
    ["dispatch change", () => { dispatchOverrides = { dispatchId: "other" }; }],
  ];

  for (const route of ["checkout", "checkpoint", "finish"] as const) {
    it.each(mutations)(`${route} is rejected after %s during the body read`, async (_name, mutate) => {
      const res = await handlers.handle(req(route, "", { body: delayed(bodies[route], mutate) }));
      expect([401, 403]).toContain(res.status);
      expect(res.body).toEqual({ version: 1, ok: false, category: "unauthorized" });
      expect(res.headers["Cache-Control"]).toBe("no-store");
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
      expect(checkpointSpy).not.toHaveBeenCalled();
      expectNoLeak(res);
    });
  }

  it("authenticates before and after the read, and serves an unchanged grant", async () => {
    const res = await handlers.handle(req("checkout", "", { body: delayed(bodies.checkout, () => undefined) }));
    expect(res.status).toBe(200);
    expect(lookupSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps an exact-owner final checkpoint for a recovery_required owner and stays idempotent", async () => {
    ownership.markRecoveryRequired({ dispatchId: "d1", profileId: "sub1", generation: 1 });
    const first = await checkpoint(1);
    expect(first.status).toBe(200);
    expect((await checkpoint(1)).status).toBe(200);
  });
});
