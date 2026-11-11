import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { format } from "node:util";
import type { ChatGptPlanRecordV1 } from "../chatgpt-plan-token.js";
import type * as DedupModule from "../dedup.js";
import type * as CliModule from "../model-account-cli.js";
import type * as ProtectedSecretsModule from "../model-protected-secrets.js";
import { DEFAULT_MODEL } from "../pipeline/default-model.js";
import { createModelSessionKeyProvider } from "../model-session-keys.js";
import type * as SessionStoreModule from "../model-session-store.js";
import type { ModelSessionStore } from "../model-session-store.js";
import { makeChatGptPlanRecord } from "./helpers/builders.js";
import { fakeFetch, type FakeFetch, type Routes } from "./helpers/fake-fetch.js";
import { testDb } from "./helpers/test-db.js";

const ACCESS = "SENTINEL-ACCESS-TOKEN-1";
const REFRESH = "SENTINEL-REFRESH-TOKEN-2";
const ID = "SENTINEL-ID-TOKEN-3";
const SECRET = "test-runner-token-secret";
const PROFILE = "chatgpt-main";
// The fields revoke reads from OpenAI's published OpenID configuration, at their real URLs.
const DISCOVERY = { issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/.well-known/jwks.json" };
const OPENAI_REVOKES: Routes = {
  "GET /.well-known/openid-configuration": { json: { ...DISCOVERY, revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" } },
  "POST /api/accounts/oauth/revoke": { status: 200 },
};

let accounts: typeof import("../agent-config-store.js");
let dedup: typeof DedupModule;
let cli: typeof CliModule;
let protectedSecrets: typeof ProtectedSecretsModule;
let sessionStore: typeof SessionStoreModule;
let store: ModelSessionStore;
let out: string[];
let err: string[];
let requestRefresh: ReturnType<typeof vi.fn>;
let openai: FakeFetch;
let profile: { authMode: string; status: string } | null;

// A record a laptop's sign-in saved, as `chatgpt-import` reads it from stdin.
function record(over: Partial<ChatGptPlanRecordV1> = {}) {
  return makeChatGptPlanRecord({
    email: "op@example.com", subject: "sub-123", clientId: "client_abcdefghijklmnop",
    idToken: ID, accessToken: ACCESS, refreshToken: REFRESH, savedAt: 1_000_000, ...over,
  });
}

function deps(stdin: string, env: NodeJS.ProcessEnv = { RUNNER_TOKEN_SECRET: SECRET }): CliModule.CliDeps {
  return {
    store: () => store,
    hostId: () => cli.orchestratorHostId(),
    planSequence: (id) => cli.latestPlanSequence(id, () => dedup.getDb()),
    getProfile: (id) => (profile && id === PROFILE ? ({ profileId: id, ...profile } as never) : null),
    secrets: () => protectedSecrets.createModelProtectedSecrets({ env, db: () => dedup.getDb() }),
    requestRefresh: requestRefresh as never,
    readState: async () => ({ lastOutcome: "refreshed" }),
    fetch: openai.fetch,
    readStdin: async () => stdin,
    now: () => 1_000_000,
    env,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  };
}

const stored = () => {
  const r = store.readPlanRecord(PROFILE);
  return r.ok ? { seq: r.stateSequence, data: JSON.parse(r.sessionData) } : null;
};
const noLeak = () => {
  const text = [...out, ...err].join("\n");
  for (const s of [ACCESS, REFRESH, ID]) expect(text).not.toContain(s);
};
const run = (argv: string[], stdin = JSON.stringify(record()), env?: NodeJS.ProcessEnv) =>
  cli.main(argv, deps(stdin, env));

beforeEach(async () => {
  ({ dedup, cli, protectedSecrets, sessionStore, accounts } = (await testDb({
    modules: {
      accounts: () => import("../agent-config-store.js"),
      dedup: () => import("../dedup.js"),
      cli: () => import("../model-account-cli.js"),
      protectedSecrets: () => import("../model-protected-secrets.js"),
      sessionStore: () => import("../model-session-store.js"),
    },
  })).modules);
  store = sessionStore.createModelSessionStore({
    keys: createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: SECRET }),
    verifyOwner: () => false,
    authorizeOperator: (op) => op === "model-account-cli",
    db: () => dedup.getDb(),
  });
  out = [];
  err = [];
  requestRefresh = vi.fn(async () => {});
  // Only logout reaches OpenAI. These are its answers when revocation succeeds; logoutWith replaces them per case.
  openai = fakeFetch(OPENAI_REVOKES);
  profile = { authMode: "codex-subscription", status: "active" };
});

describe("chatgpt-import", () => {
  it("stores the orchestrator host id, not the file's, and requests one refresh", async () => {
    expect(await run(["chatgpt-import", "--profile", PROFILE])).toBe(0);
    const hostId = (dedup.getDb().prepare("SELECT value FROM settings WHERE key = 'chatgpt_plan_host_id'").get() as { value: string }).value;
    expect(hostId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(stored()!.data.extAgentHostId).toBe(hostId);
    expect(requestRefresh).toHaveBeenCalledTimes(1);
    expect(requestRefresh).toHaveBeenCalledWith(PROFILE);
    noLeak();
    expect(await run(["chatgpt-import", "--profile", PROFILE])).toBe(0);
    expect(stored()!.data.extAgentHostId).toBe(hostId);
    expect(stored()!.seq).toBe(1);
  });

  it("replaces a row sealed under another RUNNER_TOKEN_SECRET", async () => {
    const other = sessionStore.createModelSessionStore({
      keys: createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: "another-secret" }),
      verifyOwner: () => false,
      authorizeOperator: (op) => op === "model-account-cli",
      db: () => dedup.getDb(),
    });
    expect(other.writePlanRecord({ profileId: PROFILE, expectedSequence: null, sessionData: "{}", operator: "model-account-cli" }).ok).toBe(true);
    expect(await run(["chatgpt-import", "--profile", PROFILE])).toBe(0);
    expect(stored()!.seq).toBe(1);
    expect(requestRefresh).toHaveBeenCalledTimes(1);
    noLeak();
  });

  it("replaces a corrupt row", async () => {
    await run(["chatgpt-import", "--profile", PROFILE]);
    dedup.getDb().prepare("UPDATE model_session_generations SET encrypted_session_state = zeroblob(8) WHERE profile_id = ?").run(PROFILE);
    expect(stored()).toBeNull();
    expect(await run(["chatgpt-import", "--profile", PROFILE])).toBe(0);
    expect(stored()!.seq).toBe(1);
  });

  it("never overwrites an existing host id row", async () => {
    dedup.getDb().exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    dedup.getDb().prepare("INSERT INTO settings (key, value) VALUES ('chatgpt_plan_host_id', 'urn:uuid:existing')").run();
    await run(["chatgpt-import", "--profile", PROFILE]);
    expect(stored()!.data.extAgentHostId).toBe("urn:uuid:existing");
  });

  const refusals: Array<[string, () => { stdin?: string; env?: NodeJS.ProcessEnv }, string?]> = [
    ["malformed JSON", () => ({ stdin: "{not json" })],
    ["bad shape", () => ({ stdin: JSON.stringify({ ...record(), version: 2 }) })],
    ["missing scope", () => ({ stdin: JSON.stringify(record({ scopes: ["openid"] })) })],
    ["unset secret", () => ({ env: {} }), "RUNNER_TOKEN_SECRET"],
    ["unknown profile", () => { profile = null; return {}; }],
    ["wrong auth mode", () => { profile = { authMode: "openai-api-key", status: "active" }; return {}; }],
    ["disabled profile", () => { profile = { authMode: "codex-subscription", status: "disabled" }; return {}; }],
    ["archived profile", () => { profile = { authMode: "codex-subscription", status: "archived" }; return {}; }],
  ];
  it.each(refusals)("refuses %s and writes nothing", async (_n, setup, msg) => {
    const { stdin, env } = setup();
    expect(await run(["chatgpt-import", "--profile", PROFILE], stdin, env)).toBe(1);
    expect(stored()).toBeNull();
    expect(requestRefresh).not.toHaveBeenCalled();
    if (msg) expect(err.join("\n")).toContain(msg);
    noLeak();
  });

  it("refuses a record on argv without reading stdin", async () => {
    const readStdin = vi.fn(async () => "");
    const d = { ...deps(""), readStdin };
    for (const argv of [
      ["chatgpt-import", "--profile", PROFILE, JSON.stringify(record())],
      ["chatgpt-import", "--profile", PROFILE, "--record", JSON.stringify(record())],
      ["chatgpt-import", JSON.stringify(record())],
    ]) {
      expect(await cli.main(argv, d)).toBe(2);
    }
    expect(readStdin).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    noLeak();
  });

  it("reports an import whose refresh request failed, with non-zero exit", async () => {
    requestRefresh.mockRejectedValue(new Error(`boom ${REFRESH}`));
    expect(await run(["chatgpt-import", "--profile", PROFILE])).toBe(1);
    expect(stored()).not.toBeNull();
    expect(out.join("\n")).toContain("refresh not requested");
    noLeak();
  });
});

describe("shared import (AII-1501)", () => {
  it("stores the same record whether the CLI or the pairing upload path imports it", async () => {
    expect(await run(["chatgpt-import", "--profile", PROFILE])).toBe(0);
    const viaCli = stored()!.data;
    const pairing = await import("../chatgpt-pairing.js");
    const result = await pairing.importChatGptRecord(PROFILE, { ...record() }, {
      store: () => store, hostId: () => cli.orchestratorHostId(), planSequence: (id) => cli.latestPlanSequence(id, () => dedup.getDb()),
      getProfile: deps("").getProfile, requestRefresh: requestRefresh as never, now: () => 1_000_000, operator: "model-account-cli",
    });
    expect(result.ok).toBe(true);
    expect(stored()!.data).toEqual(viaCli);
    expect(requestRefresh).toHaveBeenCalledTimes(2);
    noLeak();
  });
});

describe("chatgpt-status", () => {
  it("prints identity fields and no token", async () => {
    await run(["chatgpt-import", "--profile", PROFILE]);
    out = [];
    expect(await run(["chatgpt-status", "--profile", PROFILE])).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("op@example.com");
    expect(text).toContain("sub-123");
    expect(text).toContain("client_abc");
    expect(text).not.toContain("client_abcd");
    expect(text).toContain("Seconds left: 3600");
    expect(text).toContain("Last refresh outcome: refreshed");
    expect(text).toMatch(/Host id: urn:uuid:/);
    noLeak();
  });

  it("handles a signed-out record and a missing record", async () => {
    expect(await run(["chatgpt-status", "--profile", PROFILE])).toBe(1);
    await run(["chatgpt-import", "--profile", PROFILE]);
    await run(["chatgpt-logout", "--profile", PROFILE]);
    out = [];
    expect(await run(["chatgpt-status", "--profile", PROFILE])).toBe(0);
    expect(out.join("\n")).toContain("signed out");
    noLeak();
  });
});

describe("status and logout on retired or mismatched profiles", () => {
  it.each(["disabled", "archived"])("signs out and reports status for a %s profile", async (status) => {
    await run(["chatgpt-import", "--profile", PROFILE]);
    profile = { authMode: "codex-subscription", status };
    out = [];
    expect(await run(["chatgpt-status", "--profile", PROFILE])).toBe(0);
    expect(await run(["chatgpt-logout", "--profile", PROFILE])).toBe(0);
    const data = stored()!.data;
    for (const k of ["accessToken", "refreshToken", "idToken"]) expect(data).not.toHaveProperty(k);
    noLeak();
  });

  it.each(["chatgpt-status", "chatgpt-logout"])("%s refuses unknown and wrong-mode profiles", async (cmd) => {
    await run(["chatgpt-import", "--profile", PROFILE]);
    for (const p of [null, { authMode: "openai-api-key", status: "active" }]) {
      profile = p as typeof profile;
      expect(await run([cmd, "--profile", PROFILE])).toBe(1);
    }
    expect(stored()!.data).toHaveProperty("refreshToken");
    noLeak();
  });

  it("rejects profile ids the session store would reject", async () => {
    expect(await run(["chatgpt-status", "--profile", "a:b"])).toBe(2);
    expect(await run(["chatgpt-status", "--profile", ".a"])).toBe(2);
  });
});

describe("chatgpt-logout", () => {
  const discovery = OPENAI_REVOKES["GET /.well-known/openid-configuration"]!;

  async function logoutWith(routes: Routes) {
    await run(["chatgpt-import", "--profile", PROFILE]);
    out = [];
    openai = fakeFetch(routes);
    return run(["chatgpt-logout", "--profile", PROFILE]);
  }

  const cases: Array<[string, Routes, boolean]> = [
    ["confirmed", OPENAI_REVOKES, true],
    ["non-200", { "GET /.well-known/openid-configuration": discovery, "POST /api/accounts/oauth/revoke": { status: 500 } }, false],
    ["fetch throws", { "GET /.well-known/openid-configuration": () => { throw new Error(`net ${REFRESH}`); } }, false],
    ["no revocation endpoint", { "GET /.well-known/openid-configuration": { json: DISCOVERY } }, false],
  ];
  it.each(cases)("removes all tokens when revocation is %s", async (_n, routes, confirmed) => {
    expect(await logoutWith(routes)).toBe(0);
    const data = stored()!.data;
    for (const k of ["accessToken", "refreshToken", "idToken"]) expect(data).not.toHaveProperty(k);
    expect(data.email).toBe("op@example.com");
    expect(out.join("\n")).toContain(confirmed ? "revocation confirmed" : "revocation not confirmed");
    noLeak();
  });

  it("sends the refresh token only to the injected fetch", async () => {
    await logoutWith(cases[0]![1]);
    const call = openai.calls.find((c) => c.path === "/api/accounts/oauth/revoke")!;
    expect(call.body).toContain(REFRESH);
  });
});

describe("secret-import / secret-delete", () => {
  const REF = "model-account:k1";
  const KEY = "SENTINEL-API-KEY-4";
  const B = { region: "us-east-1", accessKeyId: "SENTINEL-AKID-5", secretAccessKey: "SENTINEL-SAK-6", sessionToken: "SENTINEL-ST-7" };
  const secrets = () => protectedSecrets.createModelProtectedSecrets({ env: { RUNNER_TOKEN_SECRET: SECRET }, db: () => dedup.getDb() });
  const rows = () => (dedup.getDb().prepare("SELECT COUNT(*) AS n FROM model_protected_secrets").get() as { n: number }).n;
  const leaks = () => {
    const text = [...out, ...err].join("\n");
    for (const s of [KEY, ...Object.values(B)]) expect(text).not.toContain(s);
  };

  it("round-trips an API key, replaces it, and deletes it", async () => {
    expect(await run(["secret-import", "--ref", REF], `${KEY}\n`)).toBe(0);
    expect(out).toEqual([`ref=${REF} secret-import ok`]);
    expect(secrets().resolve(REF)).toBe(KEY);
    expect(await run(["secret-import", "--ref", REF], "SENTINEL-API-KEY-NEW")).toBe(0);
    expect(secrets().resolve(REF)).toBe("SENTINEL-API-KEY-NEW");
    expect(await run(["secret-delete", "--ref", REF])).toBe(0);
    expect(secrets().resolve(REF)).toBeNull();
    expect(secrets().open(REF)).toEqual({ ok: false, code: "row_missing" });
    expect(await run(["secret-delete", "--ref", REF])).toBe(0);
    leaks();
  });

  it("imports a Bedrock bundle", async () => {
    expect(await run(["secret-import", "--ref", REF], JSON.stringify(B))).toBe(0);
    expect(secrets().resolve(REF)).toEqual(B);
    leaks();
  });

  it("refuses bad input without mutating stored values", async () => {
    await run(["secret-import", "--ref", REF], KEY);
    out = [];
    const cases: Array<[string[], string, NodeJS.ProcessEnv?]> = [
      [["secret-import", "--ref", "FOO"], KEY],
      [["secret-import", "--ref", "model-account:"], KEY],
      [["secret-import", "--ref", "model-account:UP"], KEY],
      [["secret-import", "--ref", `model-account:${"a".repeat(200)}`], KEY],
      [["secret-import", "--ref", "model-account:a/b"], KEY],
      [["secret-import", "--ref", REF], ""],
      [["secret-import", "--ref", REF], JSON.stringify({ region: B.region, accessKeyId: B.accessKeyId })],
      [["secret-import", "--ref", REF], JSON.stringify({ ...B, extra: "SENTINEL-EXTRA" })],
      [["secret-import", "--ref", REF], KEY, {}],
      [["secret-import", "--ref", REF], KEY, { RUNNER_TOKEN_SECRET: "" }],
    ];
    for (const [argv, stdin, env] of cases) {
      expect(await run(argv, stdin, env)).not.toBe(0);
    }
    expect(rows()).toBe(1);
    expect(secrets().resolve(REF)).toBe(KEY);
    leaks();
  });

  it("rejects values on argv with usage that echoes nothing", async () => {
    for (const argv of [["secret-import", "--ref", REF, KEY], ["secret-import", "--ref", REF, "--value", KEY], ["secret-import"], ["secret-delete", REF]]) {
      err = [];
      expect(await run(argv, KEY)).toBe(2);
      expect(err.join("\n")).toContain("usage:");
      expect(err.join("\n")).not.toContain(KEY);
    }
    expect(rows()).toBe(0);
  });

  it("prints only fixed text when the store throws", async () => {
    const d = deps(KEY);
    d.secrets = () => ({ ...secrets(), write: () => ({ ok: false, code: "write_failed" }), delete: () => ({ ok: false, code: "write_failed" }) });
    expect(await cli.main(["secret-import", "--ref", REF], d)).toBe(1);
    expect(await cli.main(["secret-delete", "--ref", REF], d)).toBe(1);
    leaks();
    d.secrets = () => { throw new Error(`boom ${KEY}`); };
    expect(await cli.main(["secret-import", "--ref", REF], d)).toBe(1);
    leaks();
  });
});


describe("importEnvironmentCredential", () => {
  const token = "SENTINEL-ENV-IMPORT";
  const base = { RUNNER_TOKEN_SECRET: SECRET, CLAUDE_CODE_OAUTH_TOKEN: token };
  it.each([
    ["missing", {}, 404],
    ["key unavailable", { CLAUDE_CODE_OAUTH_TOKEN: token }, 503],
    ["token", base, 201],
    ["both", { ...base, ANTHROPIC_API_KEY: "ignored-key" }, 201],
    ["key", { RUNNER_TOKEN_SECRET: SECRET, ANTHROPIC_API_KEY: token }, 201],
    ["repeat", base, 200],
    ["disabled", base, 409],
    ["other owner", base, 409],
    ["orphan", base, 409],
    ["incompatible", base, 409],
  ] as const)("%s", (state, env, status) => {
    const store = protectedSecrets.createModelProtectedSecrets({ env });
    const id = "adopted-env-claude-subscription";
    const ref = `model-account:${id}`;
    if (state === "repeat" || state === "disabled") cli.importEnvironmentCredential(base, store);
    if (state === "disabled") accounts.retireAccountProfile(id);
    if (state === "other owner") accounts.saveAccountProfileRevision({ profileId: "other", identity: "Other", revision: 1,
      agent: "claude", provider: "anthropic", authMode: "claude-subscription", metadata: { credentialRef: ref } });
    if (state === "orphan") store.write(ref, token);
    if (state === "incompatible") accounts.saveAccountProfileRevision({ profileId: id, identity: "Other", revision: 1,
      agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" });
    const snapshot = () => ["model_account_profiles", "model_account_profile_revisions", "model_protected_secrets", "stage_agent_config_revisions"]
      .map(table => dedup.getDb().prepare(`SELECT * FROM ${table}`).all());
    const before = snapshot();
    const write = vi.spyOn(store, "write");
    if (status >= 400) {
      try { cli.importEnvironmentCredential(env, store); throw new Error("expected refusal"); }
      catch (error) { expect(error).toBeInstanceOf(cli.EnvironmentCredentialError); expect(error).toMatchObject({ status });
        const expected = status === 404 ? "no model credential in the environment" : status === 503 ? "RUNNER_TOKEN_SECRET is not set; the encryption key derives from it" :
          state === "disabled" ? "adopted profile is disabled" : state === "incompatible" ? "adopted profile identifier is already in use" : "adopted credential reference is already in use";
        expect((error as Error).message).toBe(expected);
      }
    } else {
      const result = cli.importEnvironmentCredential(env, store);
      expect(result).toEqual({ profileId: `adopted-env-${state === "key" ? "anthropic-api-key" : "claude-subscription"}`,
        authMode: state === "key" ? "anthropic-api-key" : "claude-subscription", result: status === 200 ? "already-imported" : "created", keyIgnored: state === "both" });
      expect(accounts.getAccountProfile(result.profileId)?.identity).toBe("Adopted environment credential");
      expect(store.resolve(`model-account:${result.profileId}`)).toBe(token);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(snapshot())).not.toContain(token);
    }
    if (status !== 201) { expect(snapshot()).toEqual(before); expect(write).not.toHaveBeenCalled(); }
    expect(accounts.getOrchestratorDefaults()).toBeNull();
  });
  it.each(["missing", "undecryptable"])("does not rewrite a previously imported %s secret", failure => {
    cli.importEnvironmentCredential(base, protectedSecrets.createModelProtectedSecrets({ env: base }));
    const env = failure === "undecryptable" ? { ...base, RUNNER_TOKEN_SECRET: "rotated-secret" } : base;
    const store = protectedSecrets.createModelProtectedSecrets({ env });
    const ref = "model-account:adopted-env-claude-subscription";
    if (failure === "missing") store.delete(ref);
    const write = vi.spyOn(store, "write");
    expect(cli.importEnvironmentCredential(env, store).result).toBe("already-imported");
    expect(write).not.toHaveBeenCalled();
    expect(store.open(ref).ok).toBe(false);
  });

  it("sanitizes secret-bearing storage exceptions and rolls back the profile", () => {
    const store = protectedSecrets.createModelProtectedSecrets({ env: base });
    vi.spyOn(store, "write").mockImplementation(() => { throw new Error(`${token} model-account:adopted-env-claude-subscription`); });
    expect(() => cli.importEnvironmentCredential(base, store)).toThrow("could not import the environment credential");
    expect(accounts.listAccountProfiles()).toEqual([]);
    expect(accounts.getOrchestratorDefaults()).toBeNull();
  });

});

describe("adopt-env", () => {
  const captureLogs = () => (["log", "error", "warn", "info", "debug"] as const)
    .map(method => vi.spyOn(console, method));
  afterEach(() => vi.restoreAllMocks());

  const TOKEN = "SENTINEL-ADOPT-OAUTH";
  const KEY = "SENTINEL-ADOPT-API-KEY";
  const env = { RUNNER_TOKEN_SECRET: SECRET, CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
  const tables = ["model_account_profiles", "model_account_profile_revisions", "stage_agent_config_revisions", "model_protected_secrets"];
  const dump = () => tables.map(t => dedup.getDb().prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
  const adopt = (e: NodeJS.ProcessEnv = env) => run(["adopt-env"], "", e);
  const stages = (id: string) => Object.fromEntries(["planning", "implementation", "review"].map(s =>
    [s, { agent: "claude", provider: "anthropic", model: DEFAULT_MODEL, accountProfileId: id, invocationTimeoutMs: 5_400_000 }]));

  it.each(["claude-subscription", "anthropic-api-key"] as const)("accepts defaults with an ungranted %s profile", authMode => {
    accounts.saveAccountProfileRevision({ profileId: "ungranted", identity: "Ungrant", revision: 1, agent: "claude", provider: "anthropic", authMode });
    expect(() => accounts.setOrchestratorDefaults({ version: 1, mode: "configured", stages: stages("ungranted") })).not.toThrow();
    expect(dedup.getDb().prepare("SELECT * FROM stage_agent_config_revisions WHERE scope_kind = 'project'").all()).toEqual([]);
  });

  it.each([
    ["token", env, "claude-subscription", TOKEN],
    ["key", { RUNNER_TOKEN_SECRET: SECRET, ANTHROPIC_API_KEY: KEY }, "anthropic-api-key", KEY],
    ["both", { ...env, ANTHROPIC_API_KEY: KEY }, "claude-subscription", TOKEN],
  ] as const)("adopts %s and leaves a second run unchanged", async (kind, e, mode, value) => {
    const logs = captureLogs();
    expect(await adopt(e)).toBe(0);
    const id = `adopted-env-${mode}`;
    expect(accounts.listAccountProfiles()).toMatchObject([{ profileId: id, authMode: mode, revision: 1 }]);
    expect(accounts.getOrchestratorDefaults()?.config).toEqual({ version: 1, mode: "configured", stages: stages(id) });
    expect(protectedSecrets.createModelProtectedSecrets({ env: e }).resolve(`model-account:${id}`)).toBe(value);
    if (kind === "both") expect(out.join("\n")).toContain("ANTHROPIC_API_KEY ignored");
    const before = dump();
    const firstOutput = [...out, ...err];
    out = [];
    expect(await adopt({})).toBe(0);
    expect(dump()).toEqual(before);
    expect(out.join("\n")).toContain(id);
    expect(dedup.getDb().prepare("SELECT * FROM stage_agent_config_revisions WHERE scope_kind = 'project'").all()).toEqual([]);
    const output = JSON.stringify([firstOutput, out, err, logs.map(l => l.mock.calls)]);
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(KEY);
  });

  it.each([
    [{ RUNNER_TOKEN_SECRET: SECRET }, "no model credential in the environment"],
    [{ CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, "RUNNER_TOKEN_SECRET"],
  ])("refuses missing prerequisites without writes: %j", async (e, message) => {
    const before = dump();
    expect(await adopt(e)).toBe(1);
    expect(err.join("\n")).toContain(message);
    expect(dump()).toEqual(before);
  });

  it("replaces a legacy defaults row", async () => {
    accounts.setOrchestratorDefaults({ version: 1, mode: "legacy" });
    expect(await adopt()).toBe(0);
    expect(accounts.getOrchestratorDefaults()?.revision).toBe(2);
    expect(accounts.getOrchestratorDefaults()?.config.mode).toBe("configured");
  });

  it("reuses a compatible adopted profile without a revision", async () => {
    await adopt();
    accounts.setOrchestratorDefaults({ version: 1, mode: "legacy" });
    const profiles = dump().slice(0, 2);
    const secret = dump()[3];
    expect(await adopt()).toBe(0);
    expect(dump().slice(0, 2)).toEqual(profiles);
    expect(dump()[3]).toEqual(secret);
  });

  it.each(["missing", "undecryptable"])("repairs a %s secret before configuring legacy defaults", async failure => {
    expect(await adopt()).toBe(0);
    accounts.setOrchestratorDefaults({ version: 1, mode: "legacy" });
    const ref = "model-account:adopted-env-claude-subscription";
    const repairEnv = failure === "undecryptable" ? { ...env, RUNNER_TOKEN_SECRET: "rotated-secret" } : env;
    const secrets = protectedSecrets.createModelProtectedSecrets({ env: repairEnv });
    if (failure === "missing") expect(secrets.delete(ref).ok).toBe(true);
    expect(secrets.open(ref)).toMatchObject({ ok: false, code: failure === "missing" ? "row_missing" : "decrypt_failed" });
    const profiles = dump().slice(0, 2);
    expect(await adopt(repairEnv)).toBe(0);
    expect(secrets.resolve(ref)).toBe(TOKEN);
    expect(dump().slice(0, 2)).toEqual(profiles);
    expect(accounts.getOrchestratorDefaults()?.config).toEqual({ version: 1, mode: "configured", stages: stages("adopted-env-claude-subscription") });
    expect([...out, ...err].join("\n")).not.toContain(TOKEN);
  });

  it.each([false, true])("refuses disabled adoption even with configured defaults=%s", async configured => {
    await adopt();
    if (!configured) accounts.setOrchestratorDefaults({ version: 1, mode: "legacy" });
    accounts.retireAccountProfile("adopted-env-claude-subscription");
    const before = dump();
    expect(await adopt()).toBe(1);
    expect(err.join("\n")).toContain("adopted profile is disabled");
    expect(dump()).toEqual(before);
  });

  it("preserves existing configured defaults and reports their profile ids", async () => {
    accounts.saveAccountProfileRevision({ profileId: "existing", identity: "Existing", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" });
    accounts.setOrchestratorDefaults({ version: 1, mode: "configured", stages: stages("existing") });
    const before = dump();
    expect(await adopt()).toBe(0);
    expect(dump()).toEqual(before);
    expect(out.join("\n")).toContain("existing");
  });

  it.each([false, true])("rolls back storage failures without exposing exceptions (throws=%s)", async throws => {
    const logs = captureLogs();
    const d = deps("", env);
    const real = d.secrets;
    d.secrets = () => ({ ...real(), write: () => {
      if (throws) throw new Error(`${TOKEN} ${KEY}`);
      return { ok: false, code: "write_failed" };
    } });
    const before = dump();
    expect(await cli.main(["adopt-env"], d)).toBe(1);
    expect(dump()).toEqual(before);
    const output = [...out, ...err, ...logs.flatMap(log => log.mock.calls.map(call => format(...call)))].join("\n");
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(KEY);
  });

  it("exposes configured adopted stages through authenticated GET /api/agent-defaults", async () => {
    expect(await adopt()).toBe(0);
    const { createSession } = await import("../admin-session.js");
    const { handleAdminRequest } = await import("../admin.js");
    const token = createSession();
    let status = 0;
    let body = "";
    const response = {
      writeHead: (code: number) => { status = code; },
      end: (data: string) => { body = data; },
    };
    handleAdminRequest({ url: "/api/agent-defaults", method: "GET", headers: { authorization: `Bearer ${token}` } } as never,
      response as never, { adminAccessCode: "test" } as never, {} as never);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ configured: true, mode: "configured", stages: stages("adopted-env-claude-subscription") });
    expect(body).not.toContain(TOKEN);
  });

  it("refuses incompatible profile and orphaned secret collisions without writes", async () => {
    const id = "adopted-env-claude-subscription";
    const secrets = protectedSecrets.createModelProtectedSecrets({ env });
    expect(secrets.write(`model-account:${id}`, KEY).ok).toBe(true);
    let before = dump();
    expect(await adopt()).toBe(1);
    expect(dump()).toEqual(before);
    accounts.saveAccountProfileRevision({ profileId: id, identity: "Other", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" });
    before = dump();
    expect(await adopt()).toBe(1);
    expect(dump()).toEqual(before);
    expect(JSON.stringify([out, err])).not.toContain(KEY);
  });

  it("rejects arguments without echoing them", async () => {
    expect(await run(["adopt-env", TOKEN])).toBe(2);
    expect(err.join("\n")).not.toContain(TOKEN);
  });
});

describe("adopt-projects CLI", () => {
  it("opens production dry-run read-only before startup cleanup or migrations", async () => {
    const stage = { agent: "claude" as const, provider: "anthropic" as const, model: DEFAULT_MODEL, accountProfileId: "active", invocationTimeoutMs: 60000 };
    accounts.saveAccountProfileRevision({ profileId: "active", identity: "Active", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" });
    accounts.setOrchestratorDefaults({ version: 1, mode: "configured", stages: { planning: stage, implementation: stage, review: stage } });
    const db = dedup.getDb();
    db.exec("INSERT INTO admin_sessions (token, expires_at) VALUES ('expired', 1)");
    db.exec("INSERT INTO oauth_transactions (state, provider, code_verifier, nonce, redirect_to, created_at, expires_at) VALUES ('expired', 'test', 'verifier', 'nonce', '/', 1, 1)");
    // A normal first open recreates this index, exposing schema writes as well as cleanup.
    db.exec("DROP INDEX idx_runner_tokens_issue");
    const snapshot = (connection: ReturnType<typeof dedup.getDb>) => {
      const schema = connection.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
      const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
      return { schema, data: tables.map(({ name }) => connection.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()) };
    };
    const before = snapshot(db);
    dedup.closeDb();
    vi.resetModules();
    dedup = await import("../dedup.js");
    cli = await import("../model-account-cli.js");
    try {
      expect(await cli.main(["adopt-projects", "--dry-run"], deps(""))).toBe(0);
      expect(err).toEqual([]);
      expect(dedup.getDb().readonly).toBe(true);
      expect(snapshot(dedup.getDb())).toEqual(before);
    } finally {
      dedup.closeDb();
    }
  });
  it("carries models from the configured dispatch branch instead of GitHub's default", async () => {
    const config = await import("../config.js");
    const auth = await import("../github-app-auth.js");
    const runtime = await import("../model-auth-runtime.js");
    const stage = { agent: "claude" as const, provider: "anthropic" as const, model: DEFAULT_MODEL, accountProfileId: "active", invocationTimeoutMs: 60000 };
    accounts.saveAccountProfileRevision({ profileId: "active", identity: "Active", revision: 1, agent: "claude", provider: "anthropic", authMode: "anthropic-api-key" });
    accounts.setOrchestratorDefaults({ version: 1, mode: "configured", stages: { planning: stage, implementation: stage, review: stage } });
    const spies = [
      vi.spyOn(config, "getMappings").mockReturnValue({ A: { owner: "owner", repo: "repo", defaultBranch: "release/models", workflowFile: "implement.yml", executionMode: "fly-machines", planningEnabled: false } as import("../config.js").RepoMapping }),
      vi.spyOn(auth, "getScopedInstallationToken").mockResolvedValue({ token: "repo-token" } as Awaited<ReturnType<typeof auth.getScopedInstallationToken>>),
      vi.spyOn(runtime, "createAgentConfigAdminDeps").mockReturnValue({ inspectReadiness: async () => ({ status: "ready", profiles: [] }) } as unknown as ReturnType<typeof runtime.createAgentConfigAdminDeps>),
    ];
    const files = {
      ".ai-implement/config.yml": "models:\n  review: branch-review",
      "WORKFLOW.md": "---\nmodel: branch-implementation\n---\n",
      "PLANNING.md": "---\nmodel: branch-planning\n---\n",
    };
    const github = fakeFetch({ "GET /repos/owner/repo/git/ref/heads/release/models": { json: { object: { sha: "a".repeat(40) } } }, ...Object.fromEntries(Object.entries(files).map(([path, content]) => [
      `GET /repos/owner/repo/contents/${path}`,
      ({ url }: import("./helpers/fake-fetch.js").FetchCall) => ({ json: { type: "file", encoding: "base64", content: Buffer.from(url.searchParams.get("ref") === "a".repeat(40) ? content : "---\nmodel: github-default-model\n---\n").toString("base64") } }),
    ])) }).install();
    try {
      expect(await cli.main(["adopt-projects", "--project", "A"], deps(""))).toBe(0);
      expect(err).toEqual([]);
      expect(github.calls).toHaveLength(5);
      const revisions = github.calls.filter(call => call.url.pathname.includes("/git/ref/heads/"));
      expect(revisions.map(call => call.url.pathname)).toEqual(Array(2).fill("/repos/owner/repo/git/ref/heads/release/models"));
      const contents = github.calls.filter(call => call.url.pathname.includes("/contents/"));
      expect(contents).toHaveLength(3);
      expect(contents.every(call => call.url.searchParams.get("ref") === "a".repeat(40))).toBe(true);
      expect(github.calls[0]).toBe(revisions[0]);
      expect(github.calls[4]).toBe(revisions[1]);
      expect(accounts.getProjectStageConfig("A")?.config.stages).toEqual({
        planning: { model: "branch-planning" }, implementation: { model: "branch-implementation" }, review: { model: "branch-review" },
      });
      expect(out).toEqual(["A: adopted; planning=branch-planning (PLANNING.md); implementation=branch-implementation (WORKFLOW.md); review=branch-review (.ai-implement/config.yml)"]);
    } finally {
      spies.forEach(spy => spy.mockRestore());
    }
  });
  it("filters projects, previews without writes and prints every model source", async () => {
    const write = vi.fn();
    const mapping = { owner: "owner", repo: "repo", workflowFile: "implement.yml", executionMode: "fly-machines" } as import("../config.js").RepoMapping;
    const input = deps("");
    input.adoption = () => ({
      getDefaults: () => ({ config: { version: 1, mode: "configured", stages: { planning: { model: "default" }, implementation: { model: "default" }, review: { model: "default" } } } }),
      getMappings: () => ({ A: mapping, B: mapping }),
      getProject: () => null,
      fingerprint: () => "unchanged",
      runnerMode: () => "default",
      readRevision: async () => "a".repeat(40),
      readFile: async (_mapping, path) => path === ".ai-implement/config.yml" ? "models:\n  review: reviewer" : null,
      inspectReadiness: async () => ({ status: "ready", profiles: [] }),
      write,
    });
    expect(await cli.main(["adopt-projects", "--project", "B", "--dry-run"], input)).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(out).toEqual([`B: would adopt; planning=${DEFAULT_MODEL} (DEFAULT_MODEL); implementation=${DEFAULT_MODEL} (DEFAULT_MODEL); review=reviewer (.ai-implement/config.yml)`]);
  });
  it.each([["--unknown"], ["--project"], ["--dry-run", "--dry-run"], ["--project", "A", "--project", "B"]])("rejects invalid options %j", async (...args) => {
    expect(await cli.main(["adopt-projects", ...args], deps(""))).toBe(2);
    expect(err.join("\n")).toContain("usage:");
  });
  it("reports the defaults prerequisite", async () => {
    expect(await cli.main(["adopt-projects"], deps(""))).toBe(1);
    expect(err).toContain("adopt-projects failed: run adopt-env first");
  });
});
