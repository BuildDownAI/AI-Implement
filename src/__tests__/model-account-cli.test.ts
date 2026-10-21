import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChatGptPlanRecordV1 } from "../chatgpt-plan-token.js";
import type * as DedupModule from "../dedup.js";
import type * as CliModule from "../model-account-cli.js";
import type * as ProtectedSecretsModule from "../model-protected-secrets.js";
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
  ({ dedup, cli, protectedSecrets, sessionStore } = (await testDb({
    modules: {
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
