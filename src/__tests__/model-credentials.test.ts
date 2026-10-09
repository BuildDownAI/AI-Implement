import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as StoreModule from "../agent-config-store.js";
import type * as DedupModule from "../dedup.js";
import type * as CredModule from "../model-credentials.js";
import type { ModelSessionStore, SessionReadResult } from "../model-session-store.js";

let dbPath: string;
let store: typeof StoreModule;
let dedup: typeof DedupModule;
let cred: typeof CredModule;

const API_SENTINEL = "sk-synthetic-api-SENTINEL-0001";
const SESSION_SENTINEL = "synthetic-session-SENTINEL-0002";
const BEDROCK = { region: "us-east-1", accessKeyId: "AKIASYNTHETIC0001", secretAccessKey: "synthetic-secret-SENTINEL-0003" };

let secrets: Map<string, CredModule.ProtectedSecretValue>;
let resolverCalls: string[];
let readCalls: Array<[string, number]>;
let readResult: SessionReadResult;

function deps(extra: Partial<CredModule.ModelCredentialDeps> = {}): CredModule.ModelCredentialDeps {
  const sessionStore: ModelSessionStore = {
    read: (profileId, gen) => {
      readCalls.push([profileId, gen]);
      return readResult;
    },
    checkpoint: () => { throw new Error("unexpected checkpoint"); },
    importSession: () => { throw new Error("unexpected import"); },
  };
  return {
    sessionStore,
    resolveProtectedSecret: (ref) => {
      resolverCalls.push(ref);
      return secrets.get(ref);
    },
    ...extra,
  };
}

function save(over: Partial<StoreModule.SaveAccountProfileRevisionInput> = {}) {
  return store.saveAccountProfileRevision({
    profileId: "anth",
    identity: "Anth",
    revision: 1,
    agent: "claude",
    provider: "anthropic",
    authMode: "anthropic-api-key",
    allowedProjectKeys: ["AII"],
    metadata: { credentialRef: "model-account:anth" },
    ...over,
  });
}

const req = (over: Partial<CredModule.CredentialRequest> = {}): CredModule.CredentialRequest => ({
  projectKey: "AII",
  profileId: "anth",
  revision: 1,
  provider: "anthropic",
  authMode: "anthropic-api-key",
  ...over,
});

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `model-credentials-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  vi.resetModules();
  process.env.DEDUP_DB_PATH = dbPath;
  dedup = await import("../dedup.js");
  store = await import("../agent-config-store.js");
  cred = await import("../model-credentials.js");
  secrets = new Map([["model-account:anth", API_SENTINEL]]);
  resolverCalls = [];
  readCalls = [];
  readResult = { ok: true, profileId: "sub", ownerGeneration: 1, stateSequence: 7, sessionData: SESSION_SENTINEL };
});

afterEach(() => {
  dedup.closeDb();
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
});

describe("resolveModelCredential", () => {
  it("returns exactly one api-key secret", () => {
    save();
    const r = cred.resolveModelCredential(req(), deps());
    expect(r).toMatchObject({ ok: true, secret: { kind: "api-key", apiKey: API_SENTINEL } });
    if (r.ok) expect(Object.keys(r.secret).sort()).toEqual(["apiKey", "kind"]);
    expect(readCalls).toEqual([]);
  });

  it("returns an aws-bedrock bundle without a generic apiKey", () => {
    save({ profileId: "bed", agent: "claude", provider: "bedrock", authMode: "bedrock", metadata: { credentialRef: "model-account:bed" } });
    secrets.set("model-account:bed", BEDROCK);
    const r = cred.resolveModelCredential(req({ profileId: "bed", provider: "bedrock", authMode: "bedrock" }), deps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.secret).sort()).toEqual(["accessKeyId", "kind", "region", "secretAccessKey"]);
  });

  it("rejects a malformed bedrock bundle and a string for bedrock", () => {
    save({ profileId: "bed", provider: "bedrock", authMode: "bedrock", metadata: { credentialRef: "model-account:bed" } });
    const r0 = req({ profileId: "bed", provider: "bedrock", authMode: "bedrock" });
    secrets.set("model-account:bed", API_SENTINEL);
    expect(cred.resolveModelCredential(r0, deps())).toMatchObject({ ok: false, code: "secret_invalid" });
    secrets.set("model-account:bed", { ...BEDROCK, region: "nope" });
    expect(cred.resolveModelCredential(r0, deps())).toMatchObject({ ok: false, code: "secret_invalid" });
  });

  it("rebinds subscription state to the authorized generation and keeps the stored sequence", () => {
    save({ profileId: "sub", agent: "claude", provider: "anthropic", authMode: "claude-subscription", metadata: {} });
    const r = cred.resolveModelCredential(
      req({ profileId: "sub", provider: "anthropic", authMode: "claude-subscription", ownerGeneration: 3 }),
      deps(),
    );
    expect(r).toMatchObject({ ok: true, ownerGeneration: 3, secret: { kind: "session", sessionData: SESSION_SENTINEL, stateSequence: 7 } });
    expect(readCalls).toEqual([["sub", 3]]);
    expect(resolverCalls).toEqual([]);
  });

  it("requires an owner generation for subscriptions before reading", () => {
    save({ profileId: "sub", agent: "claude", provider: "anthropic", authMode: "claude-subscription", metadata: {} });
    const r = cred.resolveModelCredential(req({ profileId: "sub", provider: "anthropic", authMode: "claude-subscription" }), deps());
    expect(r).toMatchObject({ ok: false, category: "stale_owner" });
    expect(readCalls).toEqual([]);
  });

  it("maps session store failures to categories without leaking the reason", () => {
    save({ profileId: "sub", agent: "claude", provider: "anthropic", authMode: "claude-subscription", metadata: {} });
    const sub = req({ profileId: "sub", provider: "anthropic", authMode: "claude-subscription", ownerGeneration: 1 });
    for (const [category, reason] of [["stale_owner", "stale_generation"], ["recovery_required", "no_state"], ["authentication_required", "key_unavailable"]] as const) {
      readResult = { ok: false, category, reason };
      const r = cred.resolveModelCredential(sub, deps());
      expect(r).toMatchObject({ ok: false, category, code: "session_unavailable" });
      expect(JSON.stringify(r)).not.toContain(reason);
    }
  });

  it("never lets a codex subscription yield an api key, nor an api profile read sessions", () => {
    save({ profileId: "sub", agent: "claude", provider: "anthropic", authMode: "claude-subscription", metadata: { credentialRef: "model-account:anth" } });
    const r = cred.resolveModelCredential(req({ profileId: "sub", provider: "openai", authMode: "openai-api-key", ownerGeneration: 1 }), deps());
    expect(r).toMatchObject({ ok: false, code: "account_mismatch" });
    expect(resolverCalls).toEqual([]);
    expect(readCalls).toEqual([]);
  });

  it("denies another project, without touching secrets", () => {
    save();
    const r = cred.resolveModelCredential(req({ projectKey: "OTHER" }), deps());
    expect(r).toMatchObject({ ok: false, category: "unauthorized", code: "project_not_permitted" });
    expect(resolverCalls).toEqual([]);
  });

  it("denies a disabled permission, disabled profile and archived profile", () => {
    save({ allowedProjectKeys: [] });
    expect(cred.resolveModelCredential(req(), deps())).toMatchObject({ ok: false, code: "project_not_permitted" });
    save({ revision: 2 });
    store.retireAccountProfile("anth", "disabled");
    expect(cred.resolveModelCredential(req({ revision: 2 }), deps())).toMatchObject({ ok: false, code: "profile_disabled" });
    store.retireAccountProfile("anth", "archived");
    expect(cred.resolveModelCredential(req({ revision: 2 }), deps())).toMatchObject({ ok: false, code: "profile_disabled" });
    expect(resolverCalls).toEqual([]);
  });

  it("fails redacted for missing profile, revision, reference and secret", () => {
    expect(cred.resolveModelCredential(req(), deps())).toMatchObject({ ok: false, code: "profile_not_found" });
    save({ metadata: {} });
    expect(cred.resolveModelCredential(req(), deps())).toMatchObject({ ok: false, code: "reference_missing" });
    expect(cred.resolveModelCredential(req({ revision: 9 }), deps())).toMatchObject({ ok: false, code: "profile_not_found" });
    save({ revision: 2 });
    secrets.clear();
    const r = cred.resolveModelCredential(req({ revision: 2 }), deps());
    expect(r).toMatchObject({ ok: false, category: "authentication_required", code: "secret_unavailable" });
    expect(Object.keys(r).sort()).toEqual(["category", "code", "ok"]);
  });

  it.each(["RUN_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "ANTHROPIC_API_KEY", "RUN_PUBLICATION_TOKEN", "model-account:", "model-account:../x", "vault/claude-main"])(
    "rejects out-of-namespace reference %s before lookup",
    (ref) => {
      save({ metadata: { credentialRef: ref } });
      secrets.set(ref, API_SENTINEL);
      const r = cred.resolveModelCredential(req(), deps());
      expect(r).toMatchObject({ ok: false, code: "reference_rejected" });
      expect(resolverCalls).toEqual([]);
      expect(JSON.stringify(r)).not.toContain("RUN_TOKEN");
    },
  );

  it("honors an explicit registry", () => {
    save();
    expect(cred.resolveModelCredential(req(), deps({ allowedRefs: new Set(["model-account:other"]) }))).toMatchObject({ code: "reference_rejected" });
    expect(cred.resolveModelCredential(req(), deps({ allowedRefs: new Set(["model-account:anth"]) })).ok).toBe(true);
  });

  it("pins the prepared revision despite newer revisions", () => {
    save();
    save({ revision: 2, metadata: { credentialRef: "model-account:anth-v2" } });
    secrets.set("model-account:anth-v2", "sk-v2");
    const r = cred.resolveModelCredential(req({ revision: 1 }), deps());
    expect(r).toMatchObject({ ok: true, revision: 1, secret: { apiKey: API_SENTINEL } });
    expect(resolverCalls).toEqual(["model-account:anth"]);
  });

  it("does not leak errors thrown by the resolver", () => {
    save();
    const r = cred.resolveModelCredential(req(), deps({ resolveProtectedSecret: () => { throw new Error(`boom ${API_SENTINEL}`); } }));
    expect(r).toMatchObject({ ok: false, code: "secret_unavailable" });
    expect(JSON.stringify(r)).not.toContain("boom");
  });
});

describe("getCredentialStatus", () => {
  it("contains no secret material for any mode", () => {
    save();
    save({ profileId: "bed", provider: "bedrock", authMode: "bedrock", metadata: { credentialRef: "model-account:bed" } });
    save({ profileId: "sub", agent: "claude", provider: "anthropic", authMode: "claude-subscription", metadata: { credentialRef: "model-account:sub" } });
    secrets.set("model-account:bed", BEDROCK);
    const requests = [
      req(),
      req({ profileId: "bed", provider: "bedrock", authMode: "bedrock" }),
      req({ profileId: "sub", provider: "anthropic", authMode: "claude-subscription", ownerGeneration: 1 }),
      req({ projectKey: "OTHER" }),
      req({ profileId: "missing" }),
    ];
    for (const r of requests) {
      const json = JSON.stringify(cred.getCredentialStatus(r, deps()));
      for (const banned of [API_SENTINEL, SESSION_SENTINEL, "SENTINEL", "credentialRef", "sessionData", "model-account:", "AKIA"]) {
        expect(json).not.toContain(banned);
      }
    }
    expect(resolverCalls).toEqual([]);
    expect(readCalls).toEqual([]);
  });

  it("reports usable and denial states", () => {
    save();
    expect(cred.getCredentialStatus(req(), deps())).toMatchObject({ usable: true, referenceConfigured: true, projectPermitted: true, failure: null });
    expect(cred.getCredentialStatus(req({ projectKey: "OTHER" }), deps())).toMatchObject({
      usable: false,
      projectPermitted: false,
      failure: { code: "project_not_permitted" },
    });
    expect(cred.getCredentialStatus(req({ authMode: "bedrock" }), deps())).toMatchObject({ usable: false, matchesRequest: false });
  });
});
