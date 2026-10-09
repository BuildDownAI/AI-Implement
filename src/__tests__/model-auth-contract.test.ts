import { describe, expect, it } from "vitest";
import {
  MAX_API_CREDENTIAL_LENGTH,
  MAX_SESSION_DATA_LENGTH,
  MODEL_AUTH_FAILURE_CATEGORIES,
  RESERVED_AUTH_MODES,
  SUBSCRIPTION_AUTH_MODES,
  isSubscriptionAuthMode,
  reservesModelAccount,
  checkCheckoutResponseAgainstBindings,
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
  authMode: "claude-subscription",
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
    it.each(["anthropic-api-key", "openai-api-key", "bedrock", "codex-subscription"])(
      "%s rejects any generation",
      (authMode) => {
        const base = { ...apiBinding, authMode };
        expect(parseModelAuthGrantBootstrap(grant({ bindings: [base] })).ok).toBe(true);
        for (const ownerGeneration of [1, 0, null]) {
          const r = parseModelAuthGrantBootstrap(grant({ bindings: [{ ...base, ownerGeneration }] }));
          expect(r.ok).toBe(false);
        }
      },
    );
    it("claude-subscription requires a positive integer", () => {
      const base = { ...subBinding };
      expect(parseModelAuthGrantBootstrap(grant({ bindings: [base] })).ok).toBe(true);
      for (const ownerGeneration of [undefined, 0, -1, 1.5, "1", Number.NaN]) {
        expect(parseModelAuthGrantBootstrap(grant({ bindings: [{ ...base, ownerGeneration }] })).ok).toBe(false);
      }
    });
    it("exposes the reservation class", () => {
      expect(RESERVED_AUTH_MODES).toEqual(["claude-subscription"]);
      expect(reservesModelAccount("claude-subscription")).toBe(true);
      expect(reservesModelAccount("codex-subscription")).toBe(false);
      expect(isSubscriptionAuthMode("codex-subscription")).toBe(true);
      expect([...SUBSCRIPTION_AUTH_MODES]).toEqual(["claude-subscription", "codex-subscription"]);
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
      version: 1, ok: true, profileId: "prof-sub", authMode: "claude-subscription", ownerGeneration: 3,
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

describe("chatgpt access token checkout secret", () => {
  const TOK = "SENTINEL-tok-123";
  const secret = { kind: "chatgpt-access-token", accessToken: TOK, expiresAt: 1_800_000_000_000 };
  const resp = (s: unknown = secret, extra: Record<string, unknown> = {}) => ({
    version: 1, ok: true, profileId: "prof-chat", authMode: "codex-subscription", secret: s, ...extra,
  });

  it("round-trips", () => {
    const r = parseModelAuthCheckoutResponse(resp());
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toEqual(resp());
  });

  it("rejects ownerGeneration and the session kind", () => {
    for (const ownerGeneration of [1, 0, null]) {
      expect(errorOf(parseModelAuthCheckoutResponse(resp(secret, { ownerGeneration })))).toContain("ownerGeneration");
    }
    const session = errorOf(parseModelAuthCheckoutResponse(resp({ kind: "session", sessionData: TOK, stateSequence: 0 })));
    expect(session).not.toContain(TOK);
    expect(parseModelAuthCheckoutResponse(resp({ kind: "api-key", apiKey: TOK })).ok).toBe(false);
  });

  it("rejects extras, missing fields, and bad bounds without echoing the token", () => {
    const bad: unknown[] = [
      { ...secret, refreshToken: TOK },
      { kind: secret.kind, accessToken: TOK },
      { kind: secret.kind, expiresAt: secret.expiresAt },
      { ...secret, accessToken: "" },
      { ...secret, accessToken: TOK + "x".repeat(MAX_API_CREDENTIAL_LENGTH) },
      { ...secret, accessToken: 5 },
      { ...secret, expiresAt: 0 },
      { ...secret, expiresAt: 1.5 },
      { ...secret, expiresAt: "1800000000000" },
      { ...secret, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const s of bad) expect(errorOf(parseModelAuthCheckoutResponse(resp(s)))).not.toContain(TOK);
    expect(parseModelAuthCheckoutResponse(resp({ ...secret, accessToken: "x".repeat(MAX_API_CREDENTIAL_LENGTH) })).ok).toBe(true);
  });

  it.each(["claude-subscription", "openai-api-key", "anthropic-api-key", "bedrock"])(
    "is rejected for %s",
    (authMode) => {
      const extra = authMode === "claude-subscription" ? { ownerGeneration: 3 } : {};
      const r = parseModelAuthCheckoutResponse(resp(secret, { authMode, ...extra }));
      expect(errorOf(r)).not.toContain(TOK);
    },
  );
});

describe("bedrock checkout secret", () => {
  const AKID = "AKIASYNTHETICKEY0001";
  const ASK = "synthetic-aws-secret-key-xyz";
  const TOKEN = "synthetic-session-token-abc";
  const bundle = { kind: "aws-bedrock", region: "us-east-1", accessKeyId: AKID, secretAccessKey: ASK };
  const resp = (secret: unknown, extra: Record<string, unknown> = {}) => ({
    version: 1, ok: true, profileId: "prof-bed", authMode: "bedrock", secret, ...extra,
  });

  it("round-trips with and without a session token", () => {
    for (const secret of [bundle, { ...bundle, sessionToken: TOKEN }]) {
      const input = resp(secret);
      const result = parseModelAuthCheckoutResponse(input);
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toEqual(input);
    }
  });

  it("rejects wrong discriminants and owner generation", () => {
    expect(parseModelAuthCheckoutResponse(resp({ kind: "api-key", apiKey: SECRET })).ok).toBe(false);
    expect(parseModelAuthCheckoutResponse(resp({ kind: "session", sessionData: SECRET, stateSequence: 0 })).ok).toBe(false);
    expect(parseModelAuthCheckoutResponse(resp(bundle, { ownerGeneration: 1 })).ok).toBe(false);
    for (const authMode of ["anthropic-api-key", "openai-api-key"]) {
      expect(parseModelAuthCheckoutResponse(resp(bundle, { authMode })).ok).toBe(false);
    }
    expect(
      parseModelAuthCheckoutResponse(resp(bundle, { authMode: "codex-subscription", ownerGeneration: 1 })).ok,
    ).toBe(false);
  });

  it("rejects malformed fields without echoing values", () => {
    const bad: unknown[] = [
      { ...bundle, extra: ASK },
      { ...bundle, region: "" },
      { ...bundle, region: "Not A Region" },
      { ...bundle, accessKeyId: "" },
      { ...bundle, accessKeyId: AKID + "x".repeat(200) },
      { ...bundle, secretAccessKey: ASK + "x".repeat(MAX_API_CREDENTIAL_LENGTH) },
      { ...bundle, sessionToken: TOKEN + "x".repeat(MAX_API_CREDENTIAL_LENGTH) },
      { ...bundle, sessionToken: "" },
      { ...bundle, sessionToken: 5 },
      { ...bundle, secretAccessKey: 5 },
      { kind: "aws-bedrock", region: "us-east-1", accessKeyId: AKID },
    ];
    for (const secret of bad) {
      const error = errorOf(parseModelAuthCheckoutResponse(resp(secret)));
      for (const v of [AKID, ASK, TOKEN]) expect(error).not.toContain(v);
    }
  });
});

describe("checkout binding check", () => {
  const bindings = [apiBinding, subBinding];
  const apiResp = { profileId: "prof-api", authMode: "openai-api-key" as const };
  const subResp = { profileId: "prof-sub", authMode: "claude-subscription" as const, ownerGeneration: 3 };
  const codexBinding: ModelAuthGrantBinding = {
    stage: "review",
    profileId: "prof-codex",
    profileRevision: 1,
    authMode: "codex-subscription",
  };
  const codexResp = { profileId: "prof-codex", authMode: "codex-subscription" as const };

  it("accepts codex with no generation on either side", () => {
    expect(checkCheckoutResponseAgainstBindings("prof-codex", codexResp, [codexBinding]).ok).toBe(true);
  });
  it("rejects a codex generation on the binding or the response", () => {
    expect(
      checkCheckoutResponseAgainstBindings("prof-codex", codexResp, [{ ...codexBinding, ownerGeneration: 3 }]).ok,
    ).toBe(false);
    expect(
      checkCheckoutResponseAgainstBindings("prof-codex", { ...codexResp, ownerGeneration: 3 }, [codexBinding]).ok,
    ).toBe(false);
  });

  it("passes on exact matches", () => {
    expect(checkCheckoutResponseAgainstBindings("prof-api", apiResp, bindings).ok).toBe(true);
    expect(checkCheckoutResponseAgainstBindings("prof-sub", subResp, bindings).ok).toBe(true);
  });

  it("fails on wrong profile, auth mode, or generation", () => {
    expect(checkCheckoutResponseAgainstBindings("prof-sub", apiResp, bindings).ok).toBe(false);
    expect(checkCheckoutResponseAgainstBindings("prof-none", { ...apiResp, profileId: "prof-none" }, bindings).ok).toBe(false);
    expect(checkCheckoutResponseAgainstBindings("prof-api", { ...apiResp, authMode: "bedrock" }, bindings).ok).toBe(false);
    expect(checkCheckoutResponseAgainstBindings("prof-sub", { ...subResp, authMode: "codex-subscription" }, bindings).ok).toBe(false);
    expect(checkCheckoutResponseAgainstBindings("prof-sub", { ...subResp, ownerGeneration: 4 }, bindings).ok).toBe(false);
    expect(checkCheckoutResponseAgainstBindings("prof-sub", { ...subResp, ownerGeneration: undefined }, bindings).ok).toBe(false);
    expect(checkCheckoutResponseAgainstBindings("prof-api", { ...apiResp, ownerGeneration: 1 }, bindings).ok).toBe(false);
  });

  it("fails on conflicting bindings", () => {
    const noGen = { ...subBinding, ownerGeneration: undefined };
    const strayGen = { ...apiBinding, ownerGeneration: 1 };
    expect(checkCheckoutResponseAgainstBindings("prof-sub", subResp, [noGen]).ok).toBe(false);
    expect(checkCheckoutResponseAgainstBindings("prof-api", { ...apiResp, ownerGeneration: 1 }, [strayGen]).ok).toBe(false);
  });
});

describe("checkpoint", () => {
  const req = { version: 1, profileId: "prof-sub", ownerGeneration: 3, stateSequence: 4, sessionData: SECRET };
  it("parses subscription checkpoints", () => {
    expect(parseModelAuthCheckpointRequest(req).ok).toBe(true);
    expect(parseModelAuthCheckpointRequest(req, [apiBinding, subBinding]).ok).toBe(true);
  });
  it("rejects codex, api-key, and bedrock bindings with the right message", () => {
    const codex: ModelAuthGrantBinding = { ...apiBinding, profileId: "prof-sub", authMode: "codex-subscription" };
    const expected = "checkpoint is not allowed for codex-subscription";
    expect(errorOf(parseModelAuthCheckpointRequest(req, [codex]))).toBe(expected);
    expect(errorOf(checkCheckpointAgainstBindings(req, [codex]))).toBe(expected);
    for (const authMode of ["openai-api-key", "anthropic-api-key", "bedrock"] as const) {
      expect(errorOf(checkCheckpointAgainstBindings(req, [{ ...codex, authMode }]))).toBe(
        "checkpoint is only valid for subscription bindings",
      );
    }
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
