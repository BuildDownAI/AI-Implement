import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type * as DedupModule from "../dedup.js";
import type * as PairingModule from "../chatgpt-pairing.js";
import { createModelSessionKeyProvider } from "../model-session-keys.js";
import { createModelSessionStore } from "../model-session-store.js";
import type { ModelSessionStore } from "../model-session-store.js";

const ACCESS = "SENTINEL-ACCESS-TOKEN-1";
const REFRESH = "SENTINEL-REFRESH-TOKEN-2";
const ID = "SENTINEL-ID-TOKEN-3";
const SECRET = "test-runner-token-secret";
const PROFILE = "chatgpt-main";
const OTHER = "chatgpt-other";
const T0 = 1_000_000;

let dbPath: string;
let dedup: typeof DedupModule;
let pairing: typeof PairingModule;
let store: ModelSessionStore;
let server: http.Server;
let base: string;
let now: number;
let profiles: Record<string, { authMode: string; status: string }>;
let requestRefresh: ReturnType<typeof vi.fn>;
let logs: string[];

function record(over: Record<string, unknown> = {}) {
  return {
    version: 1, email: "op@example.com", issuer: "https://auth.openai.com", subject: "sub-123",
    clientId: "client_abcdefghijklmnop", extAgentHostId: "urn:uuid:laptop", idToken: ID, accessToken: ACCESS,
    refreshToken: REFRESH, tokenType: "Bearer", scopes: ["openid", "chatgpt.tokens.use.direct"],
    accessTokenExpiresAt: T0 + 3_600_000, earliestRefreshAt: null, savedAt: T0, ...over,
  };
}

async function upload(code: string | null, body: string = JSON.stringify(record()), headers: Record<string, string> = {}, query = "") {
  const res = await fetch(`${base}/api/chatgpt-pairing/upload${query}`, {
    method: "POST",
    headers: { ...(code === null ? {} : { Authorization: `Bearer ${code}` }), ...headers },
    body,
  });
  return { status: res.status, text: await res.text() };
}

const mint = (profileId = PROFILE) => pairing.mintPairingCode(profileId, now).code;
const stored = () => {
  const r = store.readPlanRecord(PROFILE);
  return r.ok ? JSON.parse(r.sessionData) : null;
};
const codeRows = () => dedup.getDb().prepare("SELECT * FROM chatgpt_pairing_codes").all() as { code_hash: string; used_at: number | null }[];

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `chatgpt-pairing-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  vi.resetModules();
  process.env.DEDUP_DB_PATH = dbPath;
  process.env.RUNNER_TOKEN_SECRET = SECRET;
  dedup = await import("../dedup.js");
  pairing = await import("../chatgpt-pairing.js");
  dedup.getDb();
  const keys = createModelSessionKeyProvider({ RUNNER_TOKEN_SECRET: SECRET });
  const mk = () => createModelSessionStore({ keys, verifyOwner: () => false, authorizeOperator: (o) => o === pairing.PAIRING_OPERATOR, db: () => dedup.getDb() });
  store = mk();
  now = T0;
  profiles = { [PROFILE]: { authMode: "codex-subscription", status: "active" }, [OTHER]: { authMode: "codex-subscription", status: "active" } };
  requestRefresh = vi.fn(async () => {});
  logs = [];
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a) => { logs.push(a.join(" ")); });
  server = http.createServer((req, res) => {
    void pairing.handlePairingUpload(req, res, {
      env: process.env,
      now: () => now,
      import: {
        store: () => store,
        hostId: () => pairing.orchestratorHostId(),
        planSequence: (id) => pairing.latestPlanSequence(id),
        getProfile: (id) => (profiles[id] ? ({ profileId: id, ...profiles[id] } as never) : null),
        requestRefresh: requestRefresh as never,
        readState: async () => ({ lastOutcome: "refreshed" }),
        now: () => now,
        operator: pairing.PAIRING_OPERATOR,
      },
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  vi.restoreAllMocks();
  dedup.closeDb();
  for (const s of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + s); } catch { /* ignore */ }
  }
});

describe("pairing upload", () => {
  it("stores the record like chatgpt-import, with the orchestrator host id and one refresh", async () => {
    const code = mint();
    const r = await upload(code);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ email: "op@example.com", secondsLeft: 3600, lastRefresh: "refreshed" });
    expect(stored()).toEqual(record({ extAgentHostId: pairing.orchestratorHostId(), scopes: ["chatgpt.tokens.use.direct", "openid"] }));
    expect(requestRefresh).toHaveBeenCalledTimes(1);
    expect(requestRefresh).toHaveBeenCalledWith(PROFILE);
    expect(r.text).not.toMatch(/SENTINEL/);
  });

  it("works once, and the code is marked used", async () => {
    const code = mint();
    expect((await upload(code)).status).toBe(200);
    const seq = pairing.latestPlanSequence(PROFILE);
    expect((await upload(code)).status).toBe(401);
    expect(pairing.latestPlanSequence(PROFILE)).toBe(seq);
    expect(codeRows()[0].used_at).toBe(now);
  });

  it("lets exactly one of two concurrent uploads win", async () => {
    const code = mint();
    const statuses = (await Promise.all([upload(code), upload(code), upload(code)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 401, 401]);
    expect(requestRefresh).toHaveBeenCalledTimes(1);
  });

  it("answers one fixed 401 for unknown, expired, used, superseded, missing and non-bearer codes", async () => {
    const used = mint();
    await upload(used);
    const superseded = mint(OTHER);
    mint(OTHER);
    const expired = mint();
    now += pairing.PAIRING_TTL_MS;
    const bodies = new Set<string>();
    for (const r of [
      await upload("unknown-code"),
      await upload(expired),
      await upload(used),
      await upload(superseded),
      await upload(null),
      await upload(null, JSON.stringify(record()), { Authorization: `Basic ${expired}` }),
      await upload(null, JSON.stringify(record()), {}, `?code=${expired}`),
    ]) {
      expect(r.status).toBe(401);
      bodies.add(r.text);
    }
    expect(bodies.size).toBe(1);
    expect(requestRefresh).toHaveBeenCalledTimes(1);
  });

  it("is bound to its profile: a code for another profile writes only that profile", async () => {
    const code = mint(OTHER);
    expect((await upload(code)).status).toBe(200);
    expect(stored()).toBeNull();
    expect(pairing.latestPlanSequence(OTHER)).not.toBeNull();
  });

  it("a second mint invalidates the first and leaves other profiles alone", async () => {
    const first = mint();
    const otherCode = mint(OTHER);
    const second = mint();
    expect((await upload(first)).status).toBe(401);
    expect((await upload(second)).status).toBe(200);
    expect((await upload(otherCode)).status).toBe(200);
  });

  it.each([
    ["a wrong profile type", { authMode: "openai-api-key", status: "active" }],
    ["a disabled profile", { authMode: "codex-subscription", status: "disabled" }],
    ["an archived profile", { authMode: "codex-subscription", status: "archived" }],
  ])("writes nothing for %s at upload time, and the code is spent", async (_n, state) => {
    const code = mint();
    profiles[PROFILE] = state;
    const r = await upload(code);
    expect(r.status).toBe(403);
    expect(pairing.latestPlanSequence(PROFILE)).toBeNull();
    expect(requestRefresh).not.toHaveBeenCalled();
    expect(codeRows()[0].used_at).toBe(now);
  });

  it("writes nothing for a deleted profile", async () => {
    const code = mint();
    delete profiles[PROFILE];
    expect((await upload(code)).status).toBe(403);
    expect(pairing.latestPlanSequence(PROFILE)).toBeNull();
  });

  it("spends the code on invalid JSON, a non-object, a bad record and a missing scope, writing nothing", async () => {
    for (const body of ["{nope", "[1]", JSON.stringify({ version: 1 }), JSON.stringify(record({ scopes: ["openid"] }))]) {
      const code = mint();
      const r = await upload(code, body);
      expect(r.status).toBe(400);
      expect(r.text).not.toMatch(/SENTINEL/);
      expect(pairing.latestPlanSequence(PROFILE)).toBeNull();
      expect((await upload(code)).status).toBe(401);
    }
  });

  it("refuses an oversize body with 413 and spends the code", async () => {
    const code = mint();
    const r = await upload(code, JSON.stringify(record({ pad: "x".repeat(pairing.PAIRING_UPLOAD_MAX_BYTES) })));
    expect(r.status).toBe(413);
    expect(pairing.latestPlanSequence(PROFILE)).toBeNull();
    expect((await upload(code)).status).toBe(401);
    // A body just under the limit is read.
    const ok = mint();
    const small = JSON.stringify(record());
    expect((await upload(ok, small)).status).toBe(200);
  });

  it("stores the record and says the refresh was not requested when the request throws", async () => {
    requestRefresh.mockRejectedValue(new Error(`boom ${REFRESH}`));
    const r = await upload(mint());
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).lastRefresh).toBe("not requested");
    expect(stored()?.refreshToken).toBe(REFRESH);
    expect(r.text).not.toMatch(/SENTINEL/);
  });

  it("answers 503 without spending the code when RUNNER_TOKEN_SECRET is unset", async () => {
    const code = mint();
    delete process.env.RUNNER_TOKEN_SECRET;
    expect((await upload(code)).status).toBe(503);
    process.env.RUNNER_TOKEN_SECRET = SECRET;
    expect(codeRows()[0].used_at).toBeNull();
  });

  it("keeps only a SHA-256 hash and logs no code, token or record field", async () => {
    const codes = [mint(), mint(), mint()];
    await upload(codes[0]);
    await upload(codes[0]);
    await upload("garbage");
    await upload(codes[2], "{nope");
    for (const row of codeRows()) expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(codeRows()) + logs.join("\n");
    for (const c of codes) expect(dump).not.toContain(c);
    for (const s of [ACCESS, REFRESH, ID, "op@example.com", "garbage"]) expect(logs.join("\n")).not.toContain(s);
  });
});

describe("readPairingStatus", () => {
  const fake = (sessionData: string | null) => () => ({
    readPlanRecord: () => (sessionData === null ? { ok: false as const, reason: "no_state" } : { ok: true as const, sessionData }),
  }) as unknown as ModelSessionStore;

  it("reports email, seconds left and last refresh without tokens", async () => {
    const rec = JSON.stringify({ email: "op@example.com", refreshToken: REFRESH, accessToken: ACCESS, accessTokenExpiresAt: T0 + 90_000 });
    const s = await pairing.readPairingStatus(PROFILE, { store: fake(rec), readState: async () => ({ lastOutcome: "ok" }) as never, now: () => T0 });
    expect(s).toEqual({ connected: true, email: "op@example.com", secondsLeft: 90, lastRefresh: "ok" });
    expect(JSON.stringify(s)).not.toContain(REFRESH);
  });

  it("reports not connected when nothing is stored", async () => {
    const s = await pairing.readPairingStatus(PROFILE, { store: fake(null), now: () => T0 });
    expect(s).toEqual({ connected: false, email: null, secondsLeft: null, lastRefresh: "unknown" });
  });
});
