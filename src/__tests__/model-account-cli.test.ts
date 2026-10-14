import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as DedupModule from "../dedup.js";
import type * as CliModule from "../model-account-cli.js";
import { createModelSessionKeyProvider } from "../model-session-keys.js";
import { createModelSessionStore } from "../model-session-store.js";
import type { ModelSessionStore } from "../model-session-store.js";

const ACCESS = "SENTINEL-ACCESS-TOKEN-1";
const REFRESH = "SENTINEL-REFRESH-TOKEN-2";
const ID = "SENTINEL-ID-TOKEN-3";
const SECRET = "test-runner-token-secret";
const PROFILE = "chatgpt-main";

let dbPath: string;
let dedup: typeof DedupModule;
let cli: typeof CliModule;
let store: ModelSessionStore;
let out: string[];
let err: string[];
let requestRefresh: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let profile: { authMode: string; status: string } | null;

function record(over: Record<string, unknown> = {}) {
  return {
    version: 1, email: "op@example.com", issuer: "https://auth.openai.com", subject: "sub-123",
    clientId: "client_abcdefghijklmnop", extAgentHostId: "urn:uuid:laptop", idToken: ID, accessToken: ACCESS,
    refreshToken: REFRESH, tokenType: "Bearer", scopes: ["openid", "chatgpt.tokens.use.direct"],
    accessTokenExpiresAt: 1_000_000 + 3_600_000, earliestRefreshAt: null, savedAt: 1_000_000, ...over,
  };
}

function deps(stdin: string, env: NodeJS.ProcessEnv = { RUNNER_TOKEN_SECRET: SECRET }): CliModule.CliDeps {
  return {
    store: () => store,
    hostId: () => cli.orchestratorHostId(),
    planSequence: (id) => cli.latestPlanSequence(id, () => dedup.getDb()),
    getProfile: (id) => (profile && id === PROFILE ? ({ profileId: id, ...profile } as never) : null),
    requestRefresh: requestRefresh as never,
    readState: async () => ({ lastOutcome: "refreshed" }),
    fetch: fetchMock as never,
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
  dbPath = path.join(os.tmpdir(), `model-account-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  vi.resetModules();
  process.env.DEDUP_DB_PATH = dbPath;
  process.env.RUNNER_TOKEN_SECRET = SECRET;
  dedup = await import("../dedup.js");
  cli = await import("../model-account-cli.js");
  dedup.getDb();
  store = createModelSessionStore({
    keys: createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: SECRET }),
    verifyOwner: () => false,
    authorizeOperator: (op) => op === "model-account-cli",
    db: () => dedup.getDb(),
  });
  out = [];
  err = [];
  requestRefresh = vi.fn(async () => {});
  fetchMock = vi.fn();
  profile = { authMode: "codex-subscription", status: "active" };
});

afterEach(() => {
  dedup.closeDb();
  for (const s of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + s); } catch { /* ignore */ }
  }
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
    const other = createModelSessionStore({
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
  const discovery = () => new Response(JSON.stringify({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/jwks", revocation_endpoint: "https://auth.openai.com/revoke" }), { status: 200 });

  async function logoutWith(impl: (url: string) => Promise<Response>) {
    await run(["chatgpt-import", "--profile", PROFILE]);
    out = [];
    fetchMock.mockImplementation((url: string) => impl(String(url)));
    return run(["chatgpt-logout", "--profile", PROFILE]);
  }

  const cases: Array<[string, (url: string) => Promise<Response>, boolean]> = [
    ["confirmed", async (u) => (u.includes("openid-configuration") ? discovery() : new Response("", { status: 200 })), true],
    ["non-200", async (u) => (u.includes("openid-configuration") ? discovery() : new Response("", { status: 500 })), false],
    ["fetch throws", async () => { throw new Error(`net ${REFRESH}`); }, false],
    ["no revocation endpoint", async () => new Response(JSON.stringify({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/jwks" }), { status: 200 }), false],
  ];
  it.each(cases)("removes all tokens when revocation is %s", async (_n, impl, confirmed) => {
    expect(await logoutWith(impl)).toBe(0);
    const data = stored()!.data;
    for (const k of ["accessToken", "refreshToken", "idToken"]) expect(data).not.toHaveProperty(k);
    expect(data.email).toBe("op@example.com");
    expect(out.join("\n")).toContain(confirmed ? "revocation confirmed" : "revocation not confirmed");
    noLeak();
  });

  it("sends the refresh token only to the injected fetch", async () => {
    await logoutWith(cases[0]![1]);
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/revoke"))!;
    expect(String(call[1].body)).toContain(REFRESH);
  });
});
