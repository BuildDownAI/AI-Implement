import { describe, expect, it } from "vitest";
import {
  MAX_API_CREDENTIAL_LENGTH,
  MAX_SESSION_DATA_LENGTH,
  MODEL_AUTH_FAILURE_CATEGORIES,
  checkCheckpointAgainstBindings,
  checkSealedBinding,
  classifyCheckpointSequence,
  parseModelAuthCheckoutRequest,
  parseModelAuthCheckoutResponse,
  parseModelAuthCheckpointRequest,
  parseModelAuthCheckpointResponse,
  parseModelAuthFailureResponse,
  parseModelAuthFinishRequest,
  parseModelAuthFinishResponse,
  parseModelAuthGrantBootstrap,
  parseSealedModelAuthBootstrap,
  sealedBootstrapAad,
  toSafeGrantMetadata,
  toSafeModelAuthDiagnostic,
  type ModelAuthGrantBinding,
} from "../model-auth-contract.js";

const BEARER = "synthetic-bearer-" + "A".repeat(32);
const SECRET = "synthetic-secret-value-123";

const apiBinding: ModelAuthGrantBinding = {
  stage: "planning",
  profileId: "prof-api",
  profileRevision: 2,
  authMode: "openai-api-key",
};
const subBinding: ModelAuthGrantBinding = {
  stage: "implementation",
  profileId: "prof-sub",
  profileRevision: 1,
  authMode: "codex-subscription",
  ownerGeneration: 3,
};

function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    audience: "model-auth",
    grantId: "grant-1",
    dispatchId: "dispatch-1",
    snapshotId: "snap-1",
    projectKey: "proj",
    backend: "fly",
    expiresAt: 1_800_000_000_000,
    bearer: BEARER,
    bindings: [apiBinding, subBinding],
    ...overrides,
  };
}

function errorOf(result: { ok: boolean; error?: string }): string {
  expect(result.ok).toBe(false);
  return result.error ?? "";
}

describe("grant bootstrap", () => {
  it("parses a mixed API/subscription grant with several stages", () => {
    const r = parseModelAuthGrantBootstrap(grant());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.bindings).toHaveLength(2);
  });

  it("allows one profile on several stages with identical pinning", () => {
    const r = parseModelAuthGrantBootstrap(
      grant({ bindings: [apiBinding, { ...apiBinding, stage: "review" }] }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects inconsistent pinning of one profile and duplicate stage/profile", () => {
    expect(
      parseModelAuthGrantBootstrap(grant({ bindings: [apiBinding, { ...apiBinding, stage: "review", profileRevision: 9 }] })).ok,
    ).toBe(false);
    expect(parseModelAuthGrantBootstrap(grant({ bindings: [apiBinding, apiBinding] })).ok).toBe(false);
  });

  it.each([undefined, 0, 2, "1", null])("rejects version %s", (version) => {
    expect(parseModelAuthGrantBootstrap(grant({ version })).ok).toBe(false);
  });

  it.each(["runner-callback", "progress", "publication", undefined])("rejects audience %s", (audience) => {
    expect(errorOf(parseModelAuthGrantBootstrap(grant({ audience })))).toContain("audience");
  });

  it("rejects generic token shapes and non-objects", () => {
    expect(parseModelAuthGrantBootstrap({ token: BEARER, runId: "r1", audience: "progress" }).ok).toBe(false);
    expect(parseModelAuthGrantBootstrap({ version: 1, token: BEARER }).ok).toBe(false);
    for (const bad of [null, "x", 1, [], undefined]) expect(parseModelAuthGrantBootstrap(bad).ok).toBe(false);
  });

  it("names unknown fields without echoing values", () => {
    const e = errorOf(parseModelAuthGrantBootstrap(grant({ extra: SECRET })));
    expect(e).toContain("extra");
    expect(e).not.toContain(SECRET);
    const nested = errorOf(parseModelAuthGrantBootstrap(grant({ bindings: [{ ...apiBinding, key: SECRET }] })));
    expect(nested).toContain("key");
    expect(nested).not.toContain(SECRET);
  });

  it("rejects bad backend, ids, expiry, and bearer without echoing the bearer", () => {
    expect(parseModelAuthGrantBootstrap(grant({ backend: "k8s" })).ok).toBe(false);
    expect(parseModelAuthGrantBootstrap(grant({ dispatchId: "bad id!" })).ok).toBe(false);
    expect(parseModelAuthGrantBootstrap(grant({ expiresAt: 0 })).ok).toBe(false);
    const short = errorOf(parseModelAuthGrantBootstrap(grant({ bearer: "short-secret" })));
    expect(short).not.toContain("short-secret");
    expect(parseModelAuthGrantBootstrap(grant({ bearer: "a".repeat(300) })).ok).toBe(false);
    expect(parseModelAuthGrantBootstrap(grant({ bindings: [] })).ok).toBe(false);
  });

  describe("owner generation by auth mode", () => {
    it.each(["anthropic-api-key", "openai-api-key", "bedrock"])("%s rejects a generation", (authMode) => {
      const b = { ...apiBinding, authMode, ownerGeneration: 1 };
      expect(parseModelAuthGrantBootstrap(grant({ bindings: [b] })).ok).toBe(false);
    });
    it.each(["claude-subscription", "codex-subscription"])("%s requires a positive integer", (authMode) => {
      const base = { ...subBinding, authMode };
      expect(parseModelAuthGrantBootstrap(grant({ bindings: [base] })).ok).toBe(true);
      for (const ownerGeneration of [undefined, 0, -1, 1.5, "1", Number.NaN]) {
        expect(parseModelAuthGrantBootstrap(grant({ bindings: [{ ...base, ownerGeneration }] })).ok).toBe(false);
      }
    });
    it("rejects unsupported modes, stages, and revisions", () => {
      expect(parseModelAuthGrantBootstrap(grant({ bindings: [{ ...apiBinding, authMode: "oauth" }] })).ok).toBe(false);
      expect(parseModelAuthGrantBootstrap(grant({ bindings: [{ ...apiBinding, stage: "deploy" }] })).ok).toBe(false);
      for (const profileRevision of [0, -1, 1.2, "1"]) {
        expect(parseModelAuthGrantBootstrap(grant({ bindings: [{ ...apiBinding, profileRevision }] })).ok).toBe(false);
      }
    });
  });
});

describe("sealed Fly bootstrap", () => {
  const sealed = {
    version: 1,
    algorithm: "aes-256-gcm",
    dispatchId: "dispatch-1",
    backend: "fly",
    nonce: "A".repeat(16),
    ciphertext: "Zm9vYmFy",
    tag: "B".repeat(22),
  };
  it("parses and checks dispatch/backend binding", () => {
    const r = parseSealedModelAuthBootstrap(sealed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(checkSealedBinding(r.value, { dispatchId: "dispatch-1", backend: "fly" }).ok).toBe(true);
    expect(checkSealedBinding(r.value, { dispatchId: "dispatch-2", backend: "fly" }).ok).toBe(false);
    expect(checkSealedBinding(r.value, { dispatchId: "dispatch-1", backend: "gha" }).ok).toBe(false);
    expect(sealedBootstrapAad("dispatch-1", "fly")).not.toBe(sealedBootstrapAad("dispatch-2", "fly"));
  });
  it("rejects plaintext extras, bad shapes, and other backends", () => {
    expect(errorOf(parseSealedModelAuthBootstrap({ ...sealed, bearer: SECRET }))).not.toContain(SECRET);
    expect(parseSealedModelAuthBootstrap({ ...sealed, bearer: SECRET }).ok).toBe(false);
    expect(parseSealedModelAuthBootstrap({ ...sealed, version: 2 }).ok).toBe(false);
    expect(parseSealedModelAuthBootstrap({ ...sealed, backend: "gha" }).ok).toBe(false);
    expect(parseSealedModelAuthBootstrap({ ...sealed, algorithm: "none" }).ok).toBe(false);
    expect(parseSealedModelAuthBootstrap({ ...sealed, nonce: "short" }).ok).toBe(false);
    expect(parseSealedModelAuthBootstrap({ ...sealed, tag: "B".repeat(21) }).ok).toBe(false);
    expect(parseSealedModelAuthBootstrap({ ...sealed, ciphertext: "not base64!" }).ok).toBe(false);
    expect(parseSealedModelAuthBootstrap({ ...sealed, ciphertext: "A".repeat(70000) }).ok).toBe(false);
  });
});

describe("checkout", () => {
  it("accepts only a profile id", () => {
    expect(parseModelAuthCheckoutRequest({ version: 1, profileId: "prof-api" }).ok).toBe(true);
    expect(parseModelAuthCheckoutRequest({ version: 1, profileId: "prof-api", stage: "review" }).ok).toBe(false);
    expect(parseModelAuthCheckoutRequest({ version: 2, profileId: "prof-api" }).ok).toBe(false);
    expect(parseModelAuthCheckoutRequest({ version: 1, profileId: "../x" }).ok).toBe(false);
    expect(parseModelAuthCheckoutRequest("x").ok).toBe(false);
  });

  it("discriminates API credential and session responses by auth mode", () => {
    const api = {
      version: 1, ok: true, profileId: "prof-api", authMode: "openai-api-key",
      secret: { kind: "api-key", apiKey: SECRET },
    };
    expect(parseModelAuthCheckoutResponse(api).ok).toBe(true);
    const sub = {
      version: 1, ok: true, profileId: "prof-sub", authMode: "codex-subscription", ownerGeneration: 3,
      secret: { kind: "session", sessionData: SECRET, stateSequence: 0 },
    };
    expect(parseModelAuthCheckoutResponse(sub).ok).toBe(true);
    expect(parseModelAuthCheckoutResponse({ ...api, ownerGeneration: 1 }).ok).toBe(false);
    expect(parseModelAuthCheckoutResponse({ ...sub, ownerGeneration: undefined }).ok).toBe(false);
    expect(parseModelAuthCheckoutResponse({ ...sub, secret: api.secret }).ok).toBe(false);
    expect(parseModelAuthCheckoutResponse({ ...api, secret: sub.secret }).ok).toBe(false);
    expect(parseModelAuthCheckoutResponse({ ...api, secret: { kind: "api-key", apiKey: "k".repeat(MAX_API_CREDENTIAL_LENGTH + 1) } }).ok).toBe(false);
    const oversize = errorOf(
      parseModelAuthCheckoutResponse({ ...sub, secret: { ...sub.secret, sessionData: SECRET + "x".repeat(MAX_SESSION_DATA_LENGTH) } }),
    );
    expect(oversize).not.toContain(SECRET);
    expect(parseModelAuthCheckoutResponse({ ...api, extra: 1 }).ok).toBe(false);
  });
});

describe("checkpoint", () => {
  const req = { version: 1, profileId: "prof-sub", ownerGeneration: 3, stateSequence: 4, sessionData: SECRET };
  it("parses subscription checkpoints", () => {
    expect(parseModelAuthCheckpointRequest(req).ok).toBe(true);
    expect(parseModelAuthCheckpointRequest(req, [apiBinding, subBinding]).ok).toBe(true);
  });
  it("rejects API bindings, other generations, and unknown profiles", () => {
    expect(parseModelAuthCheckpointRequest({ ...req, profileId: "prof-api" }, [apiBinding, subBinding]).ok).toBe(false);
    expect(parseModelAuthCheckpointRequest({ ...req, ownerGeneration: 4 }, [subBinding]).ok).toBe(false);
    expect(checkCheckpointAgainstBindings({ profileId: "nope", ownerGeneration: 3 }, [subBinding]).ok).toBe(false);
  });
  it("rejects malformed sequence, generation, and data", () => {
    for (const stateSequence of [-1, 1.5, Number.NaN, "1", undefined]) {
      expect(parseModelAuthCheckpointRequest({ ...req, stateSequence }).ok).toBe(false);
    }
    expect(parseModelAuthCheckpointRequest({ ...req, stateSequence: 0 }).ok).toBe(true);
    for (const ownerGeneration of [0, -1, 1.5, "3", undefined]) {
      expect(parseModelAuthCheckpointRequest({ ...req, ownerGeneration }).ok).toBe(false);
    }
    expect(parseModelAuthCheckpointRequest({ ...req, sessionData: "" }).ok).toBe(false);
    const big = errorOf(parseModelAuthCheckpointRequest({ ...req, sessionData: SECRET + "x".repeat(MAX_SESSION_DATA_LENGTH) }));
    expect(big).not.toContain(SECRET);
    expect(parseModelAuthCheckpointRequest({ ...req, version: 2 }).ok).toBe(false);
    expect(parseModelAuthCheckpointRequest({ ...req, extra: 1 }).ok).toBe(false);
  });
  it("classifies sequences", () => {
    expect(classifyCheckpointSequence(undefined, 0)).toBe("accept");
    expect(classifyCheckpointSequence(4, 5)).toBe("accept");
    expect(classifyCheckpointSequence(4, 4)).toBe("replay");
    expect(classifyCheckpointSequence(4, 3)).toBe("stale");
  });
  it("parses checkpoint responses strictly", () => {
    const res = { version: 1, ok: true, profileId: "prof-sub", ownerGeneration: 3, stateSequence: 4 };
    expect(parseModelAuthCheckpointResponse(res).ok).toBe(true);
    expect(parseModelAuthCheckpointResponse({ ...res, sessionData: SECRET }).ok).toBe(false);
  });
});

describe("finish", () => {
  it("is an acknowledgement with no release or termination semantics", () => {
    expect(parseModelAuthFinishRequest({ version: 1, profileId: "p", handling: "completed" }).ok).toBe(true);
    for (const field of ["release", "released", "terminated", "stopped", "reservation", "ownerGeneration"]) {
      const e = errorOf(parseModelAuthFinishRequest({ version: 1, profileId: "p", handling: "completed", [field]: true }));
      expect(e).toContain(field);
    }
    expect(parseModelAuthFinishRequest({ version: 1, profileId: "p", handling: "released" }).ok).toBe(false);
    expect(parseModelAuthFinishResponse({ version: 1, ok: true, acknowledged: true }).ok).toBe(true);
    expect(parseModelAuthFinishResponse({ version: 1, ok: true, acknowledged: true, released: true }).ok).toBe(false);
    expect(parseModelAuthFinishResponse({ version: 1, ok: true }).ok).toBe(false);
  });
});

describe("failure categories", () => {
  it("is a closed set", () => {
    expect([...MODEL_AUTH_FAILURE_CATEGORIES].sort()).toEqual(
      ["authentication_required", "busy", "persistence_failed", "recovery_required", "stale_owner", "unauthorized"],
    );
    for (const category of MODEL_AUTH_FAILURE_CATEGORIES) {
      expect(parseModelAuthFailureResponse({ version: 1, ok: false, category }).ok).toBe(true);
    }
    expect(parseModelAuthFailureResponse({ version: 1, ok: false, category: "teapot" }).ok).toBe(false);
    expect(parseModelAuthFailureResponse({ version: 1, ok: false, category: "busy", detail: SECRET }).ok).toBe(false);
  });
});

describe("safe projections", () => {
  it("never contain the bearer or secret data", () => {
    const parsed = parseModelAuthGrantBootstrap(grant());
    if (!parsed.ok) throw new Error("fixture invalid");
    const safe = toSafeGrantMetadata(parsed.value);
    expect(JSON.stringify(safe)).not.toContain(BEARER);
    expect(Object.keys(safe)).not.toContain("bearer");
    const diag = toSafeModelAuthDiagnostic({ operation: "checkout", profileId: "prof-api", stage: "planning" });
    expect(diag).toEqual({ operation: "checkout", stage: "planning", profileId: "prof-api", status: "ok" });
    const failed = toSafeModelAuthDiagnostic({ operation: "checkpoint", profileId: "p", category: "stale_owner" });
    expect(failed.status).toBe("failed");
    expect(failed.category).toBe("stale_owner");
  });
});
